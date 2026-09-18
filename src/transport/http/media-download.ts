import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { MediaFailure, MediaFailureReason } from "../media-failure.js";

const MEDIA_DOWNLOAD_TIMEOUT_MS = 15_000;
const MEDIA_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
const EUFY_MEDIA_HOST = /^security-app(?:-(?:eu|ie))?\.eufylife\.com$/;
const EUFY_OBJECT_HOST =
  /^zhixin-security-[a-z0-9]+(?:-[a-z0-9]+)*\.s3(?:\.[a-z]{2}(?:-[a-z0-9]+)+-\d)?\.amazonaws\.com$/;

const BLOCKED_ADDRESSES = new BlockList();
BLOCKED_ADDRESSES.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED_ADDRESSES.addSubnet("10.0.0.0", 8, "ipv4");
BLOCKED_ADDRESSES.addSubnet("100.64.0.0", 10, "ipv4");
BLOCKED_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_ADDRESSES.addSubnet("172.16.0.0", 12, "ipv4");
BLOCKED_ADDRESSES.addSubnet("192.168.0.0", 16, "ipv4");
BLOCKED_ADDRESSES.addSubnet("224.0.0.0", 4, "ipv4");
BLOCKED_ADDRESSES.addAddress("::", "ipv6");
BLOCKED_ADDRESSES.addAddress("::1", "ipv6");
BLOCKED_ADDRESSES.addSubnet("fc00::", 7, "ipv6");
BLOCKED_ADDRESSES.addSubnet("fe80::", 10, "ipv6");

type ResolveHost = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

/**
 * A media download that produced no bytes, tagged with WHY in {@link MediaFailureReason}'s closed
 * vocabulary.
 *
 * The message is deliberately uninformative: it is what a caller sees by default, and a media URL is a
 * credential. The tag rides alongside it, so a cache logging a failure can name `http-status 404`
 * without quoting anything the response or the URL said.
 */
class MediaDownloadError extends Error implements MediaFailure {
  readonly mediaFailure: MediaFailureReason;
  readonly status?: number;

  constructor(message: string, mediaFailure: MediaFailureReason, status?: number) {
    super(message);
    this.name = "MediaDownloadError";
    this.mediaFailure = mediaFailure;
    if (status !== undefined) this.status = status;
  }
}

/** Tag a failure OUTSIDE the transfer itself — the push-image decoder refusing bytes that did arrive. @internal */
export function mediaFailureError(message: string, reason: MediaFailureReason, cause?: unknown): Error {
  const error = new MediaDownloadError(message, reason);
  if (cause !== undefined) (error as { cause?: unknown }).cause = cause;
  return error;
}

/** Signals rejection of the active Eufy session without exposing response content. @internal */
export class MediaDownloadAuthenticationError extends Error {}

/** Parse a media URL and enforce its HTTPS authority and exact host allowlist. */
function allowedMediaUrl(value: string, hostPattern: RegExp, reason: MediaFailureReason): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaDownloadError("Media download rejected", reason);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    isIP(url.hostname) !== 0 ||
    !hostPattern.test(url.hostname)
  ) {
    throw new MediaDownloadError("Media download rejected", reason);
  }
  return url;
}

/** Reject a permitted hostname when DNS resolves it to any non-public destination. */
async function assertPublicResolution(url: URL, resolveHost: ResolveHost, signal: AbortSignal): Promise<void> {
  let addresses: readonly { address: string; family: number }[];
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    addresses = await Promise.race([resolveHost(url.hostname), aborted]);
  } catch {
    throw new MediaDownloadError("Media download rejected", "address-not-public");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) => {
      const type = family === 6 ? "ipv6" : family === 4 ? "ipv4" : undefined;
      return type === undefined || BLOCKED_ADDRESSES.check(address, type);
    })
  ) {
    throw new MediaDownloadError("Media download rejected", "address-not-public");
  }
}

const resolveHost: ResolveHost = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** Read a response incrementally while enforcing both declared and observed body size. */
async function readMediaBody(response: Response): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && BigInt(contentLength) > BigInt(MEDIA_DOWNLOAD_MAX_BYTES)) {
    throw new MediaDownloadError("Media download rejected", "too-large");
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MEDIA_DOWNLOAD_MAX_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new MediaDownloadError("Media download rejected", "too-large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytes);
}

/**
 * Download one bounded push-media resource, following at most one allowlisted object-store redirect.
 * Authentication headers are sent only to the original Eufy media host.
 * @internal
 */
export async function downloadMediaResource(
  url: string,
  authenticatedHeaders: RequestInit["headers"],
  fetchImpl: typeof fetch = fetch,
  resolver: ResolveHost = resolveHost,
): Promise<Buffer> {
  const original = allowedMediaUrl(url, EUFY_MEDIA_HOST, "url-not-allowed");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);

  try {
    await assertPublicResolution(original, resolver, controller.signal);
    const originalResponse = await fetchImpl(original, {
      redirect: "manual",
      signal: controller.signal,
      headers: authenticatedHeaders,
    });
    if (originalResponse.status >= 300 && originalResponse.status < 400) {
      const location = originalResponse.headers.get("location");
      if (!location) throw new MediaDownloadError("Media download rejected", "redirect-not-allowed");
      const target = allowedMediaUrl(location, EUFY_OBJECT_HOST, "redirect-not-allowed");
      await assertPublicResolution(target, resolver, controller.signal);
      const redirectedResponse = await fetchImpl(target, { redirect: "manual", signal: controller.signal });
      if (redirectedResponse.status >= 300 && redirectedResponse.status < 400) {
        throw new MediaDownloadError("Media download rejected", "redirect-not-allowed");
      }
      if (redirectedResponse.status !== 200) {
        throw new MediaDownloadError("Media download failed", "http-status", redirectedResponse.status);
      }
      return await readMediaBody(redirectedResponse);
    }
    if (originalResponse.status === 401 || originalResponse.status === 403) {
      throw new MediaDownloadAuthenticationError("Media authentication failed");
    }
    if (originalResponse.status !== 200) {
      throw new MediaDownloadError("Media download failed", "http-status", originalResponse.status);
    }
    return await readMediaBody(originalResponse);
  } catch (error) {
    if (controller.signal.aborted) throw new MediaDownloadError("Media download timed out", "timeout");
    if (error instanceof MediaDownloadAuthenticationError) throw error;
    if (error instanceof MediaDownloadError) throw error;
    throw new MediaDownloadError("Media download failed", "network");
  } finally {
    clearTimeout(timeout);
  }
}
