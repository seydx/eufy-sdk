/**
 * Behavioural tests for `SolixMqtt.watch()` — the SUBACK grant check and the stable, storage-free
 * mqttUuid. `SecureMqtt` is mocked with a fake whose `subscribe()` returns a controllable grant list
 * (AWS IoT drops a scope-denied filter rather than erroring), and whose `publish()` is recorded so we
 * can read back the app-shaped `head.client_id`. No network, deterministic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

let granted: string[] = [];
const published: Array<{ topic: string; body: string }> = [];
let lastTransport: FakeSecureMqtt | undefined;

class FakeSecureMqtt extends EventEmitter {
  constructor() {
    super();
    lastTransport = this;
  }
  async connect(): Promise<void> {}
  async subscribe(topics: string[]): Promise<string[]> {
    // Return only the topics currently granted (intersection), mirroring SecureMqtt.subscribe which
    // silently drops scope-denied filters.
    return topics.filter((t) => granted.includes(t));
  }
  async publish(topic: string, body: string): Promise<void> {
    published.push({ topic, body: String(body) });
  }
  async disconnect(): Promise<void> {}
}

vi.mock("../secure-mqtt.js", () => ({ SecureMqtt: FakeSecureMqtt }));

const { SolixMqtt } = await import("../solix-mqtt.js");
const { solixDeviceTopics } = await import("../topics.js");

const CREDS = {
  endpoint_addr: "aiot-mqtt.anker.com",
  certificate_pem: "cert",
  private_key: "key",
  aws_root_ca1_pem: "ca",
  thing_name: "u1-anker_power",
  app_name: "anker_power",
  user_id: "0000000000000000000000000000000000000001",
} as any;

const DEVICE = { device_sn: "AE1X0EXAMPLE00001", product_code: "AE1X0" };
const topicsFor = () => solixDeviceTopics("anker_power", DEVICE.product_code, DEVICE.device_sn);

describe("SolixMqtt.watch — SUBACK grant check", () => {
  beforeEach(() => {
    granted = [];
    published.length = 0;
  });

  it("throws when the telemetry topic is scope-denied (would arm but never deliver a reading)", async () => {
    granted = [topicsFor().cmdRes]; // paramInfo NOT granted
    const mqtt = new SolixMqtt({ mqttInfo: CREDS, armIntervalMs: 0 });
    mqtt.on("error", () => {});
    await expect(mqtt.watch(DEVICE)).rejects.toThrow(/param_info/);
  });

  it("resolves when the telemetry topic is granted", async () => {
    granted = [topicsFor().paramInfo, topicsFor().cmdRes];
    const mqtt = new SolixMqtt({ mqttInfo: CREDS, armIntervalMs: 0 });
    mqtt.on("error", () => {});
    await expect(mqtt.watch(DEVICE)).resolves.toBeUndefined();
    await mqtt.close();
  });
});

describe("SolixMqtt — deviceSn resolution", () => {
  beforeEach(() => {
    granted = [];
    published.length = 0;
    lastTransport = undefined;
  });

  // Minimal valid ff09 frame carrying a3 (SOC) but NO a2 serial — the device-info frame's shape.
  function socFrame(soc: number): Buffer {
    const body = Buffer.from([0x03, 0x01, 0x0f, 0x04, 0x05, 0xa1, 0x01, 0x34, 0xa3, 0x02, 0x01, soc]);
    const f = Buffer.alloc(body.length + 5);
    f[0] = 0xff;
    f[1] = 0x09;
    f.writeUInt16LE(f.length, 2);
    body.copy(f, 4);
    let xor = 0;
    for (let i = 0; i < f.length - 1; i++) xor ^= f[i]!;
    f[f.length - 1] = xor;
    return f;
  }

  it("resolves a serial-less frame to the watched device of its product code", async () => {
    const AE103 = { device_sn: "AE103EXAMPLE0001", product_code: "AE103" };
    granted = [
      solixDeviceTopics("anker_power", AE103.product_code, AE103.device_sn).paramInfo,
      solixDeviceTopics("anker_power", AE103.product_code, AE103.device_sn).cmdRes,
    ];
    const mqtt = new SolixMqtt({ mqttInfo: CREDS, armIntervalMs: 0 });
    mqtt.on("error", () => {});
    await mqtt.watch(AE103);
    const readings: Array<{ deviceSn: string; values: Record<string, number> }> = [];
    mqtt.on("reading", (r) => readings.push(r));
    // A frame with no a2 serial, on a topic whose 4th segment ("res") is NOT the device serial.
    lastTransport!.emit("message", { topic: "cmd/anker_power/AE103/res", raw: socFrame(12) });
    expect(readings).toHaveLength(1);
    expect(readings[0]!.deviceSn).toBe(AE103.device_sn); // resolved by product code, not the "res" segment
    expect(readings[0]!.values.batterySoc).toBe(12);
    await mqtt.close();
  });
});

describe("SolixMqtt — stable, storage-free mqttUuid", () => {
  beforeEach(() => {
    granted = [];
    published.length = 0;
  });

  it("derives the same broker client_id across restarts for the same user (no persistence)", async () => {
    granted = [topicsFor().paramInfo, topicsFor().cmdRes];
    const clientIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const mqtt = new SolixMqtt({ mqttInfo: CREDS, armIntervalMs: 1 });
      mqtt.on("error", () => {});
      await mqtt.watch(DEVICE);
      const armFrame = published.find((p) => p.topic === topicsFor().req)!;
      clientIds.push(JSON.parse(armFrame.body).head.client_id);
      await mqtt.close();
      published.length = 0;
    }
    // The trailing connect-time timestamp differs; the mqttUuid segment must not.
    const uuidOf = (id: string) => id.split("-").slice(3, -1).join("-");
    expect(uuidOf(clientIds[0]!)).toBe(uuidOf(clientIds[1]!));
    expect(uuidOf(clientIds[0]!)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("SolixMqtt — app control read-back on /req", () => {
  const AE = { device_sn: "AK7DEXAMPLE000001", product_code: "AE103" };
  const t = () => solixDeviceTopics("anker_power", AE.product_code, AE.device_sn);

  // Build a cmd-17 (0x68) command frame `… a1 01 22 <tag> 02 01 <value>` with a valid XOR — the shape the
  // app publishes on /req and buildDisplayTimeoutFrame emits (a4 = ambient light, a5 = display timeout).
  function cmd68(tag: number, value: number): Buffer {
    const body = Buffer.from([0x03, 0x00, 0x0f, 0x00, 0x68, 0xa1, 0x01, 0x22, tag, 0x02, 0x01, value & 0xff]);
    const frame = Buffer.alloc(body.length + 5);
    frame[0] = 0xff;
    frame[1] = 0x09;
    frame.writeUInt16LE(frame.length, 2);
    body.copy(frame, 4);
    let xor = 0;
    for (let i = 0; i < frame.length - 1; i++) xor ^= frame[i]!;
    frame[frame.length - 1] = xor;
    return frame;
  }

  async function watched(): Promise<{ mqtt: any; readings: any[] }> {
    granted = [t().paramInfo, t().cmdRes, t().req];
    const mqtt = new SolixMqtt({ mqttInfo: CREDS, armIntervalMs: 0 });
    mqtt.on("error", () => {});
    await mqtt.watch(AE);
    const readings: any[] = [];
    mqtt.on("reading", (r: any) => readings.push(r));
    return { mqtt, readings };
  }

  beforeEach(() => {
    granted = [];
    published.length = 0;
  });

  it("reads an app ambient-light toggle from an a4 command (inverted) into a reading", async () => {
    const { readings } = await watched();
    lastTransport!.emit("message", { topic: t().req, raw: cmd68(0xa4, 0x00) }); // 0 = on (inverted)
    expect(readings.at(-1).values).toEqual({ ambientLightOn: 1 });
    expect(readings.at(-1).deviceSn).toBe(AE.device_sn);
    lastTransport!.emit("message", { topic: t().req, raw: cmd68(0xa4, 0x01) }); // 1 = off
    expect(readings.at(-1).values).toEqual({ ambientLightOn: 0 });
  });

  it("reads an app display-timeout change from an a5 command into a reading", async () => {
    const { readings } = await watched();
    lastTransport!.emit("message", { topic: t().req, raw: cmd68(0xa5, 6) }); // 30m = index 6
    expect(readings.at(-1).values).toEqual({ displayTimeoutIndex: 6 });
  });

  it("ignores /req traffic that isn't a 0x68 command (e.g. an arming poll)", async () => {
    const { readings } = await watched();
    const arm = cmd68(0xa4, 0x00);
    arm[8] = 0x40; // not a 0x68 setting command → dropped before decode
    lastTransport!.emit("message", { topic: t().req, raw: arm });
    expect(readings).toHaveLength(0);
  });
});
