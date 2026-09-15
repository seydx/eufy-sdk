/**
 * A minimal client for the Anker Solix power-station cloud, driven by the SAME account login the
 * eufy client uses.
 *
 * Why this is separate from the eufy device client: Solix shares Anker's `algo_ecdh` passport (so
 * {@link prepareKeyExchange} / {@link encryptLoginPassword} / {@link signRequest} are reused verbatim
 * for the login handshake) but exposes a different device backend — its own `app-name`, host, and
 * bootstrap key (`SOLIX_APP_NAME`, `SOLIX_DEFAULT_API_HOST`, {@link SOLIX_LOCAL_KEY_HEX}) —
 * and its authenticated resource reads are PLAIN JSON, carrying only the auth token and a
 * `gtoken = md5(user_id)`, with no per-request encryption or signature. This client therefore does
 * the encrypted passport handshake to obtain a token, then makes plain authenticated reads.
 *
 * This is the wire client (transport layer): it returns the vendor's typed JSON as received. Building
 * those records into capability-driven `SolixDevice` models is the model layer's job — see
 * `discoverSolixDevices()` — so the two stay decorrelated (transport never imports model).
 */
import {
  decryptBody,
  encryptBody,
  encryptLoginPassword,
  finishKeyExchange,
  genId,
  gtoken,
  md5Hex,
  nowSec,
  prepareKeyExchange,
  signRequest,
  SOLIX_LOCAL_KEY_HEX,
  tokenNotExpired,
  type SessionEntry,
  type SessionStore,
  type SolixDeviceRecord,
  type SolixProductCategory,
} from "../../core/index.js";
import type { SecureMqttCredentials } from "../mqtt/secure-mqtt.js";

import { SOLIX_APP_NAME, SOLIX_DEFAULT_API_HOST, SOLIX_ENDPOINTS, SOLIX_ESTIMATE_HOST } from "./solix-constants.js";

/** The vendor envelope every Solix endpoint answers with (`data` shape varies per endpoint). */
interface SolixEnvelope<T = unknown> {
  code: number;
  msg: string;
  data?: T;
}

/** An authenticated Solix session — the token + the derived `gtoken` + the resolved API host. */
export interface SolixSession {
  authToken: string;
  userId: string;
  /** `md5(user_id)` — sent as the `gtoken` header on every authenticated read. */
  gtoken: string;
  /** The regional API host the account resolved to (e.g. the EU shard). */
  apiHost: string;
  /** Unix seconds; 0 when the server did not supply one. */
  tokenExpiresAt: number;
}

/**
 * Outcome of {@link SolixClient.login}. `2fa` mirrors the eufy passport: the server sent a code and
 * the client holds a limited token — call {@link SolixClient.submitVerifyCode} to finish.
 */
export type SolixLoginResult = { status: "ok"; session: SolixSession } | { status: "2fa"; method: string };

/** Options for {@link SolixClient}. */
export interface SolixClientOptions {
  email: string;
  password: string;
  /** ISO-3166 alpha-2; defaults to "US". Sent as `country` and `ab`. */
  countryCode?: string;
  /** Override the API host (skips domain-estimate). Defaults to estimate → `SOLIX_DEFAULT_API_HOST`. */
  apiHost?: string;
  /** App version reported to the cloud. */
  appVersion?: string;
  /**
   * Stable per-install device id (UUID). The auth token is bound to it, and a shifting id looks like
   * a new device each run and re-triggers 2FA. Defaults to a deterministic id derived from the email
   * (stable across runs); a store's saved id wins over this.
   */
  openudid?: string;
  /** Persist the token + device id so a dedicated account logs in once and reuses it until expiry. */
  store?: SolixSessionStore;
  /** Injected fetch (for tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** What {@link SolixSessionStore} holds: the stable device id and (once logged in) the session. */
export interface SolixPersisted {
  openudid: string;
  session?: SolixSession;
}

/**
 * A place to persist a Solix session across process runs — the core {@link SessionStore} parameterised on
 * the Solix record shape, so `FileSessionStore` serves it as-is. The device id survives token expiry (so
 * the account keeps seeing the same device and does not re-prompt 2FA), and a live session is reused
 * until it expires.
 */
export type SolixSessionStore = SessionStore<SolixPersisted>;

/** A Solix session is usable if it has a token that isn't (near-)expired (core's 300s skew rule). */
function solixSessionFresh(s: SolixSession | undefined): s is SolixSession {
  return !!s?.authToken && tokenNotExpired(s.tokenExpiresAt);
}

/** Format 32 hex chars as a UUID (8-4-4-4-12) — used to derive a stable openudid from the email. */
const uuidFromHex = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

/**
 * Login + read client for one Anker account's Solix devices. Construct with the account
 * credentials, `await login()`, then read {@link getDevices} / {@link getSites} / {@link
 * getUserMqttInfo}. Not tied to any host runtime.
 */
export class SolixClient {
  private readonly email: string;
  private readonly password: string;
  private readonly country: string;
  private readonly appVersion: string;
  private readonly doFetch: typeof fetch;
  private readonly store?: SolixSessionStore;
  private readonly openudid: string;
  private apiHost: string;
  private session_?: SolixSession;
  /** Carried between {@link login} and {@link submitVerifyCode} while a 2FA code is outstanding. */
  private pending2fa?: { limitedToken: string; userId: string; geoKey?: string };

  /**
   * Resolve the device id (explicit → stored → deterministic from the email, so it is stable and does
   * not re-trigger 2FA) and adopt a stored session that has not expired, so a warm start skips the
   * handshake. An explicit `opts.apiHost` outranks a stored session's host in both cases: it is an
   * override that also skips domain-estimate, and every read goes through `this.apiHost`.
   */
  constructor(opts: SolixClientOptions) {
    this.email = opts.email;
    this.password = opts.password;
    this.country = (opts.countryCode ?? "US").toUpperCase();
    this.appVersion = opts.appVersion ?? "3.23.0";
    this.doFetch = opts.fetchImpl ?? fetch;
    this.apiHost = opts.apiHost ?? SOLIX_DEFAULT_API_HOST;
    this.store = opts.store;
    const saved = this.store?.load();
    this.openudid = opts.openudid ?? saved?.openudid ?? uuidFromHex(md5Hex(`anker-solix:${opts.email}`));
    if (saved?.session && solixSessionFresh(saved.session)) {
      this.session_ = saved.session;
      this.apiHost = opts.apiHost ?? saved.session.apiHost;
    }
  }

  /** Persist the current device id (+ session, if any) when a store is configured. */
  private persist(): void {
    this.store?.save({ openudid: this.openudid, session: this.session_ });
  }

  /** The authenticated session, once {@link login} has resolved to `ok`. */
  get session(): SolixSession | undefined {
    return this.session_;
  }

  /**
   * Headers for the login/key-exchange path, which carry the device id. Authenticated resource reads
   * must NOT send `openudid` — the gateway rejects a token-bearing read that also carries a device id
   * (`401 token error`) — so those use {@link baseHeaders} directly.
   */
  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return this.baseHeaders({ openudid: this.openudid, "x-terminal-id": this.openudid, ...extra });
  }

  /** Base headers common to every Solix request. */
  private baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      "app-name": SOLIX_APP_NAME,
      "model-type": "PHONE",
      "os-type": "android",
      "os-version": "36",
      "app-version": this.appVersion,
      country: this.country,
      timezone: "GMT+00:00",
      language: "en",
      "user-agent": "ktor-client",
      accept: "application/json",
      ...extra,
    };
  }

  /** One request path for every Solix call (GET or POST) — always parses through the non-JSON guard. */
  private async send(
    method: "GET" | "POST",
    host: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<SolixEnvelope> {
    const res = await this.doFetch(`https://${host}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as SolixEnvelope;
    } catch {
      throw new Error(`Solix ${path} → HTTP ${res.status}, non-JSON: ${text.slice(0, 120)}`);
    }
  }

  /** POST helper for the login/key-exchange path (which builds its own bespoke headers per request). */
  private post(host: string, path: string, body: string, headers: Record<string, string>): Promise<SolixEnvelope> {
    return this.send("POST", host, path, headers, body);
  }

  /** Resolve the regional API host via domain-estimate (best-effort; keeps the default on failure). */
  private async estimateHost(): Promise<void> {
    try {
      const env = await this.post(
        SOLIX_ESTIMATE_HOST,
        SOLIX_ENDPOINTS.estimateDomain,
        JSON.stringify({ ab: this.country, mode: 1 }),
        this.baseHeaders(),
      );
      const domain = (env.data as { domain?: string } | undefined)?.domain;
      if (domain) this.apiHost = domain;
    } catch {
      /* keep the default host */
    }
  }

  /** Do the localKey-bootstrapped ECDH key exchange and return the negotiated session key. */
  private async keyExchange(): Promise<SessionEntry> {
    const prep = prepareKeyExchange(SOLIX_LOCAL_KEY_HEX);
    const env = await this.post(
      this.apiHost,
      SOLIX_ENDPOINTS.keyExchange,
      JSON.stringify({ client_public_key: prep.encryptedClientPublicKey }),
      this.authHeaders(prep.headers),
    );
    const spk = (env.data as { server_public_key?: string } | undefined)?.server_public_key;
    if (env.code !== 0 || !spk) throw new Error(`Solix key/exchange failed (${env.code}): ${env.msg}`);
    return finishKeyExchange(prep, spk);
  }

  /** Build the encrypted, signed `/passport/login` request body + headers for the negotiated key. */
  private async postLogin(kx: SessionEntry, verifyCode?: string, limitedToken?: string): Promise<SolixEnvelope> {
    const { clientPublicKeyHex, encryptedPassword } = encryptLoginPassword(this.password);
    const bodyObj: Record<string, unknown> = {
      email: this.email,
      password: encryptedPassword,
      ab: this.country,
      client_secret_info: { public_key: clientPublicKeyHex },
      answer: "",
      captcha_id: "",
      verify_code: verifyCode ?? "",
      login_id: "",
    };
    const encBody = encryptBody(JSON.stringify(bodyObj), kx.shareKey);
    const ts = nowSec();
    const once = genId();
    return this.post(
      this.apiHost,
      SOLIX_ENDPOINTS.login,
      encBody,
      this.authHeaders({
        "x-encryption-info": "algo_ecdh",
        "x-key-ident": kx.keyIdent,
        "x-request-ts": ts,
        "x-request-once": once,
        "x-signature": signRequest(kx.shareKey, ts, once, encBody),
        ...(limitedToken ? { "x-auth-token": limitedToken } : {}),
      }),
    );
  }

  /**
   * Turn a decrypted `/passport/login` payload into an `ok`/`2fa` result, establishing the session on
   * `ok`. The passport marks a pending 2FA with a non-empty `fa_info.info`, and empties it once the code
   * has been satisfied.
   */
  private classifyLogin(data: Record<string, unknown>, isVerify: boolean): SolixLoginResult {
    const userId = (data.ap_cloud_user_id ?? data.user_id) as string | undefined;
    const authToken = data.auth_token as string | undefined;
    if (!userId || !authToken)
      throw new Error(`Solix login returned no session: ${JSON.stringify(data).slice(0, 160)}`);
    const faInfo = (data.fa_info ?? {}) as { info?: string };
    if (!isVerify && faInfo.info) {
      this.pending2fa = { limitedToken: authToken, userId, geoKey: data.geo_key as string | undefined };
      return { status: "2fa", method: "code sent by the passport" };
    }
    this.pending2fa = undefined;
    this.session_ = {
      authToken,
      userId,
      gtoken: gtoken(userId),
      apiHost: this.apiHost,
      tokenExpiresAt: Number(data.token_expires_at ?? 0) || 0,
    };
    this.persist();
    return { status: "ok", session: this.session_ };
  }

  /** Decrypt a login envelope's `data` (base64 `IV(16)||AES-128-CBC`, keyed by the share key). */
  private decryptLogin(env: SolixEnvelope, kx: SessionEntry): Record<string, unknown> {
    if (typeof env.data !== "string") throw new Error(`Solix login (${env.code}): ${env.msg}`);
    return JSON.parse(decryptBody(env.data, kx.shareKey).toString("utf-8")) as Record<string, unknown>;
  }

  /**
   * Authenticate with the account credentials. Resolves to `ok` with a {@link SolixSession}, or `2fa`
   * when the passport sent a code — then call {@link submitVerifyCode}. A session that is already fresh
   * (adopted from a store) is answered without a handshake.
   */
  async login(): Promise<SolixLoginResult> {
    if (solixSessionFresh(this.session_)) {
      return { status: "ok", session: this.session_ };
    }
    await this.estimateHost();
    const kx = await this.keyExchange();
    const env = await this.postLogin(kx);
    return this.classifyLogin(this.decryptLogin(env, kx), false);
  }

  /** Complete a `2fa` login with the code the passport sent. */
  async submitVerifyCode(code: string): Promise<SolixLoginResult> {
    if (!this.pending2fa) throw new Error("no 2FA login is pending");
    const kx = await this.keyExchange();
    const env = await this.postLogin(kx, code, this.pending2fa.limitedToken);
    return this.classifyLogin(this.decryptLogin(env, kx), true);
  }

  /**
   * One authenticated PLAIN read for both GET and POST endpoints (no per-request encryption; carries
   * the auth token + `gtoken` only). Routes through {@link send} so every read keeps the non-JSON guard.
   */
  private async authed<T = unknown>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    if (!this.session_) throw new Error("not authenticated — call login() first");
    const env = await this.send(
      method,
      this.apiHost,
      path,
      this.baseHeaders({ gtoken: this.session_.gtoken, "x-auth-token": this.session_.authToken }),
      body ? JSON.stringify(body) : undefined,
    );
    if (env.code !== 0) throw new Error(`Solix ${path} failed (${env.code}): ${env.msg}`);
    return (env.data ?? null) as T;
  }

  /**
   * The account's bound Solix devices (flat list; may be empty when devices live under sites). The
   * gateway's JSON is asserted to {@link SolixDeviceRecord} here, at the one trust boundary — every field
   * beyond `device_sn`/`product_code` is optional on the record, so a caller reads them defensively.
   */
  async getDevices(): Promise<SolixDeviceRecord[]> {
    const data = await this.authed<{ data?: unknown[] } | unknown[]>(
      "POST",
      SOLIX_ENDPOINTS.getRelateAndBindDevices,
      {},
    );
    return (Array.isArray(data) ? data : (data?.data ?? [])) as SolixDeviceRecord[];
  }

  /** The account's sites (systems); devices are typically grouped under a site. */
  async getSites(): Promise<unknown[]> {
    const data = await this.authed<{ site_list?: unknown[] }>("POST", SOLIX_ENDPOINTS.getSiteList, {});
    return data?.site_list ?? [];
  }

  /** Per-user AWS-IoT MQTT credentials (cert/key/endpoint/thing) for the real-time device plane. */
  async getUserMqttInfo(): Promise<SecureMqttCredentials> {
    return this.authed<SecureMqttCredentials>("POST", SOLIX_ENDPOINTS.getUserMqttInfo, {});
  }

  /**
   * The pairable-product catalog (categories → products). This is Anker's product registry, not the
   * account's devices — fetch it to label a discovered device's model code with a marketing name and
   * category. Pair with {@link buildModelIndex}. It is a live endpoint, so it stays current without a
   * baked-in table.
   */
  async getProductCatalog(): Promise<SolixProductCategory[]> {
    return (await this.authed<SolixProductCategory[]>("GET", SOLIX_ENDPOINTS.productCategories)) ?? [];
  }
}
