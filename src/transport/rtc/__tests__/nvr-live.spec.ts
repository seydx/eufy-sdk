import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPortalHeader, PortalLinkType } from "../portal-packet.js";
import type { RtcSession } from "../session.js";
import { RtcCommandRouter, type RtcLiveRoute } from "../command-router.js";

/** Synthetic complete HEVC access unit with frame geometry. */
function video(stamp = 0) {
  const bytes = Buffer.from("000000012601af0e", "hex");
  const body = Buffer.alloc(22 + bytes.length);
  body.writeUInt32LE(bytes.length);
  body[4] = 1;
  body[5] = 1;
  body.writeUInt16LE(3840, 10);
  body.writeUInt16LE(2160, 12);
  body.writeUInt32LE(stamp, 14);
  bytes.copy(body, 22);
  return Buffer.concat([buildPortalHeader(1300, body.length, 101, 1), body]);
}
function audio(type = 2, stamp = 0) {
  const body = Buffer.alloc(20);
  body.writeUInt32LE(4);
  body[5] = type;
  body.writeUInt32LE(stamp, 8);
  body.fill(0xd5, 16);
  return Buffer.concat([buildPortalHeader(1301, body.length, 101, 1), body]);
}
class Session extends EventEmitter {
  isConnected = false;
  connect = vi.fn(async () => {
    this.isConnected = true;
    this.emit("connected");
  });
  sendCommand = vi.fn((_packet: Buffer) => true);
  sendRaw = vi.fn((_packet: Buffer) => true);
  close = vi.fn(() => {
    this.isConnected = false;
    this.emit("close");
  });
}
const route: RtcLiveRoute = {
  stationSn: "T8000P0000000000",
  cameraSn: "T8000P0000000001",
  channel: 3,
  attached: true,
  signalingMode: "call",
  iceTransportPolicy: "all",
};
const routers: RtcCommandRouter[] = [];
afterEach(() => {
  routers.splice(0).forEach((r) => r.close());
  vi.useRealTimers();
});
function router() {
  const sessions: Session[] = [];
  const media = new RtcCommandRouter({
    identity: () => ({ authToken: "synthetic", userId: "synthetic", gtoken: "synthetic" }),
    shard: () => "eu-pr",
    createSession: () => {
      const s = new Session();
      sessions.push(s);
      return s as unknown as RtcSession;
    },
  });
  routers.push(media);
  return { media, sessions };
}

describe("independent NVR media lifetime", () => {
  it("delivers both observed audio codecs and refuses truncated or unknown audio", async () => {
    const { media, sessions } = router();
    const consumer = await media.nvrMediaProviderFor(route, [0]).live();
    const sound = vi.fn();
    consumer.on("audio", sound);
    sessions[0]!.emit("mediaData", audio(0));
    sessions[0]!.emit("mediaData", audio(2));
    sessions[0]!.emit("mediaData", audio(7));
    sessions[0]!.emit("mediaData", audio(0).subarray(0, -1));
    expect(sound.mock.calls.map(([frame]) => frame.codec)).toEqual(["aac-lc", "g711a"]);
    consumer.stop();
  });
  it("stamps video and audio with the source timestamp of their media headers", async () => {
    const { media, sessions } = router();
    const consumer = await media.nvrMediaProviderFor(route, [0]).live();
    const frames = vi.fn();
    const sound = vi.fn();
    consumer.on("video", frames);
    consumer.on("audio", sound);
    sessions[0]!.emit("mediaData", video(0x8000_0001));
    sessions[0]!.emit("mediaData", audio(0, 0x8000_0021));
    expect(frames.mock.calls[0]![0].sourceTimestamp).toBe(0x8000_0001);
    expect(sound.mock.calls[0]![0].sourceTimestamp).toBe(0x8000_0021);
    consumer.stop();
  });
  it("shares one camera while keeping another camera independent", async () => {
    vi.useFakeTimers();
    const { media, sessions } = router();
    const primary = media.nvrMediaProviderFor(route, [0]);
    const a = await primary.live();
    const shared = await primary.live();
    const other = await media.nvrMediaProviderFor({ ...route, cameraSn: "T8000P0000000002", channel: 4 }, [0]).live();
    expect(sessions).toHaveLength(2);
    const requests = sessions.map((s) => JSON.parse(s.sendCommand.mock.calls[0]![0].subarray(16).toString()));
    expect(requests.map((r) => r.cmd)).toEqual([1003, 1003]);
    expect(requests.map((r) => r.payload.chn_list[0])).toEqual([
      { index: 0, chn: 3, sensor: 0, isUps: 0, isClicked: true },
      { index: 0, chn: 4, sensor: 0, isUps: 0, isClicked: true },
    ]);
    expect(requests.map((r) => r.payload.audio_chn)).toEqual([3, 4]);
    const aFrames = vi.fn();
    const fixedFrames = vi.fn();
    const sound = vi.fn();
    a.on("video", aFrames);
    other.on("video", fixedFrames);
    a.on("audio", sound);
    sessions[0]!.emit("mediaData", video());
    sessions[0]!.emit("mediaData", audio());
    expect(aFrames).toHaveBeenCalledOnce();
    expect(fixedFrames).not.toHaveBeenCalled();
    expect(sound).toHaveBeenCalledOnce();
    a.stop();
    shared.stop();
    await vi.advanceTimersByTimeAsync(8001);
    expect(sessions[0]!.close).toHaveBeenCalledOnce();
    expect(sessions[1]!.close).not.toHaveBeenCalled();
    other.stop();
  });
  it("rejects an already-aborted call before opening a session", async () => {
    const { media, sessions } = router();
    const single = media.nvrMediaProviderFor(route, [0]);
    await expect(single.live({ signal: AbortSignal.abort() })).rejects.toThrow();
    expect(sessions).toHaveLength(0);
  });
  it("propagates a rejected start, closes that session and permits a fresh attempt", async () => {
    const { media, sessions } = router();
    const camera = media.nvrMediaProviderFor(route, [0]);
    const first = await camera.live();
    const error = vi.fn();
    first.on("error", error);
    const payload = Buffer.alloc(4);
    payload.writeInt32LE(-2);
    sessions[0]!.emit(
      "commandData",
      Buffer.concat([buildPortalHeader(1350, 4, 255, 1, 1), payload]),
      PortalLinkType.COMMAND,
    );
    expect(error).toHaveBeenCalledOnce();
    expect(sessions[0]!.close).toHaveBeenCalledOnce();
    const retry = await camera.live();
    expect(sessions).toHaveLength(2);
    retry.stop();
  });
});
