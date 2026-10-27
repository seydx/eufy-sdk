import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  fakeFfmpeg,
  H264,
  jpegOf,
  nalTypes,
  streamFactory,
  unit,
  videoFrame,
  type FfmpegOutcome,
} from "./live-source-fixtures.js";

/**
 * `snapshotLive` must hand the decoder a burst it can decode alone. A decoder given slices whose SPS/PPS
 * were announced earlier in the stream refuses them with `non-existing PPS 0 referenced`, and a collected
 * burst routinely starts after the only announcement — the first keyframe is skipped by default, and a
 * consumer joining a warm source never saw it.
 *
 * `../ffmpeg.js` is mocked so the exact bytes handed to the decoder are observable. Asserting only the
 * resolved image would not pin this: a burst that happens to carry its own parameter sets decodes with or
 * without priming, so the property under test is the bytes, not the outcome.
 */
const { sps: SPS, pps: PPS, idr: IDR } = H264;

/** The image the faked encoder returns, at a geometry deliberately unlike the frames'. */
const JPEG = jpegOf(1280, 720);

let outcome: FfmpegOutcome = { stdout: JPEG };
const ffmpeg = fakeFfmpeg(() => outcome);

vi.mock("../../ffmpeg.js", () => ({ spawnFfmpeg: (args: string[]) => ffmpeg.spawnFfmpeg(args) }));

const { captureSnapshotFromShared } = await import("../media.js");
const { SharedLiveSource } = await import("../shared-live-source.js");
const { LiveSnapshotUnavailableError } = await import("../../../core/contracts.js");

const frame = (data: Buffer, over = {}) => videoFrame(data, over);

/** A source already warm with a watcher, as a snapshot normally finds it. */
function warmSource() {
  const { makeStream, streams } = streamFactory();
  const source = new SharedLiveSource({ makeStream });
  const watcher = source.attach();
  return { source, stream: streams[0], watcher };
}

/** The bytes the decoder was handed on run `n`. */
const decodedAt = (n: number) => ffmpeg.runs[n].stdin;
const argvAt = (n: number) => ffmpeg.runs[n].args;

describe("captureSnapshotFromShared — decoder priming", () => {
  beforeEach(() => {
    ffmpeg.runs.length = 0;
    outcome = { stdout: JPEG };
  });

  it.each([false, true])(
    "captures the first live keyframe with the default window (watcher detached: %s)",
    async (detached) => {
      vi.useFakeTimers();
      const { source, stream, watcher } = warmSource();
      stream.video(frame(unit(SPS, PPS, IDR)));
      if (detached) watcher.detach();
      expect(source.state).toBe(detached ? "lingering" : "live");
      const capture = captureSnapshotFromShared(source);
      try {
        await vi.advanceTimersByTimeAsync(1500);
        expect(ffmpeg.runs).toHaveLength(0);
        stream.video(frame(unit(IDR)));
        stream.video(frame(unit(H264.delta), { keyframe: false }));
        await vi.advanceTimersByTimeAsync(1499);
        expect(ffmpeg.runs).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect((await capture).jpeg).toEqual(JPEG);
        expect(ffmpeg.runs).toHaveLength(1);
        expect(nalTypes(decodedAt(0))).toEqual([0x67, 0x68, 0x65, 0x41]);
      } finally {
        source.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("primes a burst whose parameter sets were announced before it with those sets", async () => {
    const { source, stream, watcher } = warmSource();
    const announcement = frame(unit(SPS, PPS, IDR));
    const bareIdr = frame(unit(IDR));
    stream.video(announcement);
    stream.video(bareIdr);

    const capture = captureSnapshotFromShared(source, { timeoutMs: 1000, skipKeyframes: 0, collectMs: 0 });
    stream.video(bareIdr);
    const snapshot = await capture;

    expect(snapshot.jpeg).toEqual(JPEG);
    expect(nalTypes(decodedAt(0))).toEqual([0x67, 0x68, 0x65]);
    watcher.detach();
  });

  it("primes a burst that carries only an SPS — the literal missing-PPS case", async () => {
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));
    const spsOnly = frame(unit(SPS, IDR));
    stream.video(spsOnly);

    const capture = captureSnapshotFromShared(source, { timeoutMs: 1000, skipKeyframes: 0, collectMs: 0 });
    stream.video(spsOnly);
    await capture;

    expect(nalTypes(decodedAt(0))).toEqual([0x67, 0x68, 0x67, 0x65]);
    watcher.detach();
  });

  it("re-announces sets a self-contained burst already carried, which a decoder ignores", async () => {
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));

    const capture = captureSnapshotFromShared(source, { timeoutMs: 1000, skipKeyframes: 0, collectMs: 0 });
    stream.video(frame(unit(SPS, PPS, IDR)));
    await capture;

    expect(nalTypes(decodedAt(0))).toEqual([0x67, 0x68, 0x67, 0x68, 0x65]);
    watcher.detach();
  });

  it("never substitutes another codec's parameter sets for the burst's own", async () => {
    const { source, stream, watcher } = warmSource();
    const h264Announcement = frame(unit(SPS, PPS, IDR));
    const h265BareIdr = {
      keyframe: true,
      width: 1920,
      height: 1080,
      codec: "h265" as const,
      data: unit([0x26, 0x01, 0xaf]),
    };
    stream.video(h264Announcement);
    stream.video(h265BareIdr);

    const capture = captureSnapshotFromShared(source, { timeoutMs: 1000, skipKeyframes: 0, collectMs: 0 });
    stream.video(h265BareIdr);
    await capture;

    expect(nalTypes(decodedAt(0))).toEqual([0x26]);
    watcher.detach();
  });

  it("pins the JPEG-range pixel format, which the encoder requires regardless of negotiation", async () => {
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));

    const capture = captureSnapshotFromShared(source, { timeoutMs: 1000, skipKeyframes: 0, collectMs: 0 });
    stream.video(frame(unit(SPS, PPS, IDR)));
    await capture;

    expect(argvAt(0)).toContain("yuvj420p");
    expect(argvAt(0).indexOf("-pix_fmt")).toBe(argvAt(0).indexOf("yuvj420p") - 1);
    watcher.detach();
  });

  /**
   * The dimensions describe the IMAGE, so the image is their source of truth.
   *
   * The frame header's resolution is whichever frame started the capture, and a stream that reconfigures
   * mid-burst leaves it describing something the returned bytes contradict — measured live at 2304x1296
   * reported against a 1280x720 JPEG, on a camera whose burst carried three configurations. A caller
   * sizing a buffer or caching by resolution has no way to detect that short of parsing the JPEG itself.
   */
  it("reports the dimensions of the image it produced, not the frame header's", async () => {
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR), { width: 2304, height: 1296 }));
    stream.video(frame(unit(IDR), { width: 2304, height: 1296 }));

    const capture = captureSnapshotFromShared(source, { timeoutMs: 1000, skipKeyframes: 0, collectMs: 0 });
    stream.video(frame(unit(IDR), { width: 2304, height: 1296 }));
    const snapshot = await capture;

    expect(snapshot).toMatchObject({ width: 1280, height: 720 });
    watcher.detach();
  });

  /** A progressive still and a 3-component baseline one differ in marker, not in where the geometry sits. */
  it("reads the geometry of any baseline or progressive frame header", async () => {
    outcome = {
      stdout: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x02, 0x00, 0x03, 0x20])]),
    };
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));

    const capture = captureSnapshotFromShared(source, { timeoutMs: 1000, skipKeyframes: 0, collectMs: 0 });
    stream.video(frame(unit(SPS, PPS, IDR)));
    const snapshot = await capture;

    expect(snapshot).toMatchObject({ width: 800, height: 512 });
    watcher.detach();
  });

  /**
   * An encoder may pad with any number of `0xff` fill bytes before a marker, and the standalone markers
   * carry no length to skip by. A walk that gets either wrong jumps by a garbage length and reports a
   * perfectly good image as having no geometry.
   */
  it("reads the geometry past fill bytes and a length-less marker", async () => {
    const geometry = jpegOf(640, 480);
    outcome = {
      stdout: Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xd0, 0xff, 0xff, 0xff]), // SOI, a restart marker, then fill
        geometry.subarray(2),
      ]),
    };
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));

    const capture = captureSnapshotFromShared(source, { timeoutMs: 1000, skipKeyframes: 0, collectMs: 0 });
    stream.video(frame(unit(SPS, PPS, IDR)));
    expect(await capture).toMatchObject({
      width: 640,
      height: 480,
    });
    watcher.detach();
  });

  /**
   * An image with no frame header describes no geometry, and answering with the frame's would reinstate
   * exactly the disagreement this reports. It is the burst's outcome, so it carries the burst's reason.
   */
  it("refuses bytes carrying no frame header rather than falling back to the frame's", async () => {
    outcome = { stdout: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));

    const capture = captureSnapshotFromShared(source, { timeoutMs: 1000, skipKeyframes: 0, collectMs: 0 });
    stream.video(frame(unit(SPS, PPS, IDR)));
    const error = await capture.catch((e) => e);

    expect(error).toBeInstanceOf(LiveSnapshotUnavailableError);
    expect(error.reason).toBe("undecodable-burst");
    watcher.detach();
  });
});

describe("captureSnapshotFromShared — typed reasons", () => {
  beforeEach(() => {
    ffmpeg.runs.length = 0;
    outcome = { stdout: JPEG };
  });

  it("calls a burst the decoder refused retryable, so a rate-limited caller tries again", async () => {
    outcome = { exitCode: 69, stderr: "[h264 @ 0x0] non-existing PPS 0 referenced" };
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));

    const capture = captureSnapshotFromShared(source, { timeoutMs: 1000, skipKeyframes: 0, collectMs: 0 });
    stream.video(frame(unit(SPS, PPS, IDR)));
    const error = await capture.catch((e) => e);

    expect(error).toBeInstanceOf(LiveSnapshotUnavailableError);
    expect(error.reason).toBe("undecodable-burst");
    expect(error.retryable).toBe(true);
    watcher.detach();
  });

  it("calls an unrunnable decoder NOT retryable — no burst will ever fix a missing binary", async () => {
    outcome = { spawnError: "spawn ffmpeg ENOENT" };
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));

    const capture = captureSnapshotFromShared(source, { timeoutMs: 1000, skipKeyframes: 0, collectMs: 0 });
    stream.video(frame(unit(SPS, PPS, IDR)));
    const error = await capture.catch((e) => e);

    expect(error).toBeInstanceOf(LiveSnapshotUnavailableError);
    expect(error.reason).toBe("decoder-unavailable");
    expect(error.retryable).toBe(false);
    watcher.detach();
  });

  it("calls a burst that never arrived retryable, and names that as the reason", async () => {
    const { source, watcher } = warmSource();

    const error = await captureSnapshotFromShared(source, { timeoutMs: 20 }).catch((e) => e);

    expect(error).toBeInstanceOf(LiveSnapshotUnavailableError);
    expect(error.reason).toBe("no-keyframe");
    expect(error.retryable).toBe(true);
    watcher.detach();
  });

  it("keeps the decoder's own diagnostics on the error, so the cause is not swallowed", async () => {
    outcome = { exitCode: 69, stderr: "[h264 @ 0x0] non-existing PPS 0 referenced" };
    const { source, stream, watcher } = warmSource();
    stream.video(frame(unit(SPS, PPS, IDR)));

    const capture = captureSnapshotFromShared(source, { timeoutMs: 1000, skipKeyframes: 0, collectMs: 0 });
    stream.video(frame(unit(SPS, PPS, IDR)));
    const error = await capture.catch((e) => e);

    expect(error.message).toContain("non-existing PPS 0 referenced");
    watcher.detach();
  });
});
