import { describe, expect, it } from "vitest";
import { SharedLiveSource } from "../shared-live-source.js";
import { H264, H265, h264Sps, h265Sps, streamFactory, unit, videoFrame } from "./live-source-fixtures.js";
import type { LiveVideoConfig, LiveVideoFrame } from "../../../core/contracts.js";

/**
 * A wired camera reconfigures its live source repeatedly within one session, measured on five models and
 * on both codecs: 2 to 9 coded-geometry changes per 25-60 s, oscillating rather than only ramping. An
 * H.264 encoder cannot change input geometry mid-stream, so a consumer adapting the source to a fixed
 * output has to rebuild on every change — and without an announcement its only recourse is to retain the
 * previous frame's dimensions and diff every frame against them.
 *
 * The announcement is per CONSUMER rather than per source, because a consumer does not necessarily
 * receive the frame on which the source saw the change: it may join mid-session or cross its queue
 * bound and resynchronise onto a later IDR. Both cases hand it media
 * of a configuration it was never told about, so the comparison has to be against what THIS consumer was
 * last given.
 */
const { pps: PPS, idr: IDR, delta: DELTA } = H264;

const SPS_720 = h264Sps({ widthMbs: 80, heightMapUnits: 45 });
const SPS_1080 = h264Sps({ widthMbs: 120, heightMapUnits: 68, crop: { bottom: 4 } });
const SPS_540 = h264Sps({ widthMbs: 60, heightMapUnits: 34, crop: { bottom: 2 } });

const keyframe = (sps: readonly number[]) => videoFrame(unit(sps, PPS, IDR), { keyframe: true });
const delta = () => videoFrame(unit(DELTA), { keyframe: false });

/**
 * A source and a way to push frames into whatever stream it currently holds.
 *
 * The push is resolved per call, because the source builds its stream on the FIRST attach and rebuilds it
 * after a teardown — so there is no one stream a spec could hold on to.
 */
function sourceWithStream(over: { maxQueue?: number; lingerMs?: number } = {}) {
  const { makeStream, streams } = streamFactory();
  const source = new SharedLiveSource({ makeStream, ...over });
  const video = (frame: LiveVideoFrame) => streams[streams.length - 1]!.video(frame);
  return { source, video };
}

/** Attach and record every configuration announced to this consumer, in delivery order. */
function watch(source: SharedLiveSource) {
  const announced: LiveVideoConfig[] = [];
  const frames: number[] = [];
  const consumer = source.attach();
  consumer.on("video-config", (config) => announced.push(config));
  consumer.on("video", (frame) => frames.push(frame.data.length));
  return { consumer, announced, frames };
}

/**
 * Yield across asynchronous subscription setup.
 *
 * The prime is deferred to a microtask so it lands after the caller's `video` listener is in place, which
 * means a joining consumer is told its configuration on the turn after it attaches — never in the same
 * synchronous block. A caller reaches that point by awaiting `live()`, so no real frame can overtake it;
 * a spec pushing frames by hand has to wait where a caller would.
 */
const settle = (): Promise<void> => Promise.resolve();

describe("live video configuration announcement", () => {
  it("announces the configuration of the first frame a consumer receives", () => {
    const { source, video } = sourceWithStream();
    const watcher = watch(source);
    video(keyframe(SPS_720));
    expect(watcher.announced).toEqual([{ codec: "h264", width: 1280, height: 720 }]);
    watcher.consumer.detach();
  });

  it("announces each change once, not once per frame", () => {
    const { source, video } = sourceWithStream();
    const watcher = watch(source);
    video(keyframe(SPS_720));
    video(delta());
    video(delta());
    video(keyframe(SPS_1080));
    video(delta());
    video(keyframe(SPS_1080));
    expect(watcher.announced).toEqual([
      { codec: "h264", width: 1280, height: 720 },
      { codec: "h264", width: 1920, height: 1080 },
    ]);
    watcher.consumer.detach();
  });

  it("announces a configuration ahead of the frame that carries it", () => {
    const { source, video } = sourceWithStream();
    const order: string[] = [];
    const consumer = source.attach();
    consumer.on("video-config", (config) => order.push(`config ${config.width}`));
    consumer.on("video", () => order.push("frame"));
    video(keyframe(SPS_720));
    video(keyframe(SPS_1080));
    expect(order).toEqual(["config 1280", "frame", "config 1920", "frame"]);
    consumer.detach();
  });

  it("announces the frame header's report while no parameter sets state a geometry", () => {
    const { source, video } = sourceWithStream();
    const watcher = watch(source);
    video(videoFrame(unit(IDR), { keyframe: true, width: 1600, height: 1200 }));
    video(videoFrame(unit(DELTA), { keyframe: false, width: 1600, height: 1200 }));
    expect(watcher.announced).toEqual([{ codec: "h264", width: 1600, height: 1200 }]);
    expect(watcher.frames).toHaveLength(2);
    watcher.consumer.detach();
  });

  it("announces the parameter sets' geometry over the header once they state one", () => {
    const { source, video } = sourceWithStream();
    const watcher = watch(source);
    video(videoFrame(unit(IDR), { keyframe: true, width: 640, height: 360 }));
    video(videoFrame(unit(SPS_1080, PPS, IDR), { keyframe: true, width: 640, height: 360 }));
    expect(watcher.announced).toEqual([
      { codec: "h264", width: 640, height: 360 },
      { codec: "h264", width: 1920, height: 1080 },
    ]);
    watcher.consumer.detach();
  });

  it("announces a codec change at an unchanged geometry", () => {
    const { source, video } = sourceWithStream();
    const watcher = watch(source);
    video(keyframe(SPS_1080));
    video(videoFrame(unit(H265.vps, h265Sps({ widthLuma: 1920, heightLuma: 1080 }), H265.pps, H265.idr)));
    expect(watcher.announced).toEqual([
      { codec: "h264", width: 1920, height: 1080 },
      { codec: "h265", width: 1920, height: 1080 },
    ]);
    watcher.consumer.detach();
  });

  it("announces to a late consumer only when its next live keyframe arrives", async () => {
    const { source, video } = sourceWithStream();
    const first = watch(source);
    video(keyframe(SPS_1080));
    const late = watch(source);
    await settle();
    expect(late.announced).toEqual([]);
    video(keyframe(SPS_1080));
    expect(late.announced).toEqual([{ codec: "h264", width: 1920, height: 1080 }]);
    first.consumer.detach();
    late.consumer.detach();
  });

  it("announces to every consumer independently of what its peers were told", async () => {
    const { source, video } = sourceWithStream();
    const first = watch(source);
    video(keyframe(SPS_720));
    const second = watch(source);
    await settle();
    video(keyframe(SPS_1080));
    expect(first.announced).toEqual([
      { codec: "h264", width: 1280, height: 720 },
      { codec: "h264", width: 1920, height: 1080 },
    ]);
    expect(second.announced).toEqual([{ codec: "h264", width: 1920, height: 1080 }]);
    first.consumer.detach();
    second.consumer.detach();
  });

  /**
   * A consumer that crosses its bound drops its backlog and resynchronises at the next IDR, so the frame
   * carrying the change can be one of the frames it never received. The announcement has to come with the
   * media it actually gets, or the encoder it rebuilt would be the wrong one and nothing would say so.
   */
  it("announces a change a consumer only learns of after dropping its backlog", () => {
    const { source, video } = sourceWithStream({ maxQueue: 2 });
    const watcher = watch(source);
    video(keyframe(SPS_720));
    watcher.consumer.pause();
    video(keyframe(SPS_1080));
    video(delta());
    video(delta());
    video(delta());
    expect(watcher.consumer.awaitingKeyframe).toBe(true);
    watcher.consumer.resume();
    video(keyframe(SPS_540));
    expect(watcher.announced).toEqual([
      { codec: "h264", width: 1280, height: 720 },
      { codec: "h264", width: 960, height: 540 },
    ]);
    watcher.consumer.detach();
  });

  it("announces a change that arrives while the consumer is paused, when it drains", () => {
    const { source, video } = sourceWithStream();
    const watcher = watch(source);
    video(keyframe(SPS_720));
    watcher.consumer.pause();
    video(keyframe(SPS_1080));
    expect(watcher.announced).toHaveLength(1);
    watcher.consumer.resume();
    expect(watcher.announced).toEqual([
      { codec: "h264", width: 1280, height: 720 },
      { codec: "h264", width: 1920, height: 1080 },
    ]);
    watcher.consumer.detach();
  });

  it("carries the configuration on the timed feed a recording egress reads", () => {
    const { source, video } = sourceWithStream();
    const consumer = source.attach();
    const configs: (LiveVideoConfig | undefined)[] = [];
    consumer.onMedia((item) => configs.push(item.kind === "video" ? item.config : undefined));
    video(keyframe(SPS_720));
    video(keyframe(SPS_1080));
    expect(configs).toEqual([
      { codec: "h264", width: 1280, height: 720 },
      { codec: "h264", width: 1920, height: 1080 },
    ]);
    consumer.detach();
  });

  it("announces nothing to a consumer of a rebuilt stream until that stream states a configuration", () => {
    const { source, video } = sourceWithStream({ lingerMs: 0 });
    const first = watch(source);
    video(keyframe(SPS_720));
    first.consumer.detach();
    const second = watch(source);
    second.consumer.detach();
    expect(second.announced).toEqual([]);
  });
});
