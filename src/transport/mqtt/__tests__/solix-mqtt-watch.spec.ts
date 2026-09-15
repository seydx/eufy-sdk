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

class FakeSecureMqtt extends EventEmitter {
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
