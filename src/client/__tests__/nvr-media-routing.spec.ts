import { afterEach, describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../core/types.js";
import { LiveSnapshotUnavailableError } from "../../core/contracts.js";
import { EufyMega } from "../eufy-mega.js";
import { RtcSession } from "../../transport/rtc/session.js";

const HUB = "T8000P0000000000";
const CAMERA = "T8000P0000000001";

/** Synthetic cloud records retain the category, product name and parent channel used in production. */
function fixture(model: string, name: string) {
  const client = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
  });
  const internals = client as any;
  internals.registry.devices = [
    {
      sn: HUB,
      model: "T8N00",
      name: "Synthetic NVR S4",
      category: "eufy_security",
      deviceClass: "station",
      api: "mega",
      realtime: "p2p",
      raw: { member: { admin_user_id: "synthetic-admin" } },
    },
    {
      sn: CAMERA,
      model,
      name,
      category: "eufy_security",
      deviceClass: "camera",
      api: "mega",
      realtime: "p2p",
      stationSn: HUB,
      channel: 3,
      params: {},
      raw: { parent_sn: HUB, device_channel: 3 },
    },
  ] as EufyDevice[];
  vi.spyOn(internals.mega, "getDeviceParamList").mockResolvedValue({ params: [] });
  vi.spyOn(internals.mega, "rtcIdentity").mockReturnValue({
    authToken: "synthetic",
    userId: "synthetic",
    gtoken: "synthetic",
  });
  const p2p = vi.spyOn(internals.p2p, "mediaProviderFor");
  return { client, internals, p2p };
}

afterEach(() => vi.restoreAllMocks());

describe("public NVR camera media binding", () => {
  it.each(["unknown-model", "missing-channel", "different-station"])(
    "does not admit %s to NVR media",
    async (scenario) => {
      const { client, internals } = fixture("T8P00", "Synthetic PoE Cam E40");
      const records = internals.registry.devices as EufyDevice[];
      if (scenario === "unknown-model") records[1]!.model = "T0000";
      if (scenario === "missing-channel") records[1]!.raw = { parent_sn: HUB };
      if (scenario === "different-station") records[0]!.model = "T8010";
      const provider = vi.spyOn(internals.rtc, "nvrMediaProviderFor");
      await client.getDevice(CAMERA);
      expect(provider).not.toHaveBeenCalled();
      internals.rtc.close();
    },
  );
  it("preserves cancellation and login failures from the public snapshot caller", async () => {
    const { client, internals } = fixture("T8P00", "Synthetic PoE Cam E40");
    const device = await client.getDevice(CAMERA);
    const reason = new Error("synthetic cancellation");
    await expect(device.camera?.()?.snapshotLive?.({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    vi.mocked(internals.mega.rtcIdentity).mockReturnValue(undefined);
    await expect(device.camera?.()?.snapshotLive?.()).rejects.toThrow("not logged in");
    await expect(device.camera?.()?.snapshotLive?.()).rejects.not.toBeInstanceOf(LiveSnapshotUnavailableError);
    internals.rtc.close();
  });
  it.each([
    ["T8E00", 0],
    ["T8P00", 0],
  ] as const)("starts %s through its public camera capability with sensor %s", async (model, sensor) => {
    vi.spyOn(RtcSession.prototype, "connect").mockImplementation(async function (this: RtcSession) {
      this.emit("connected");
    });
    const sent = vi.spyOn(RtcSession.prototype, "sendCommand").mockReturnValue(true);
    const { client, internals, p2p } = fixture(
      model,
      `Synthetic PoE ${model === "T8E00" ? "Bullet PTZ Cam S4" : "Cam E40"}`,
    );
    try {
      const device = await client.getDevice(CAMERA);
      const stream = await device.camera?.()?.live?.();
      expect(stream).toBeDefined();
      expect(sent).toHaveBeenCalledOnce();
      const packet = sent.mock.calls[0]![0];
      expect(JSON.parse(packet.subarray(16).toString())).toMatchObject({
        cmd: 1003,
        payload: { chn_list: [{ index: 0, chn: 3, sensor }], audio_chn: 3 },
      });
      expect(p2p).not.toHaveBeenCalled();
      stream?.stop();
    } finally {
      internals.rtc.close();
    }
  });

  it.each([
    ["T8E00", "Synthetic PoE Bullet PTZ Cam S4"],
    ["T8P00", "Synthetic PoE Cam E40"],
  ])("binds %s media without falling through to the unreachable P2P provider", async (model, name) => {
    const { client, p2p } = fixture(model, name);
    const device = await client.getDevice(CAMERA);
    expect(device.camera?.()?.live).toBeTypeOf("function");
    expect(device.camera?.()?.openReadable).toBeTypeOf("function");
    expect(p2p).not.toHaveBeenCalled();
  });
});
