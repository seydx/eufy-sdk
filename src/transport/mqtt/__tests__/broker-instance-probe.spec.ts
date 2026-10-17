import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextClient } from "./lazy-engine.js";
import { EventEmitter } from "node:events";

/**
 * `probeBrokerInstance`'s dial shape — no real socket: `mqtt.connect` is mocked to return a bare
 * EventEmitter standing in for mqtt.js's `MqttClient`. The probe presents the account's client
 * certificate to whatever answers the candidate IP, so what matters here is that it verifies the
 * instance rather than accepting any certificate. The identity policy itself is covered in
 * `bare-ip-tls.spec.ts`.
 */
const fakeClients: Array<
  EventEmitter & {
    end: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  }
> = [];
const connectOptsSeen: any[] = [];

vi.mock("mqtt", () => ({
  default: {
    connect: vi.fn((...args: any[]) => {
      connectOptsSeen.push(typeof args[0] === "string" ? args[1] : args[0]);
      const client = new EventEmitter() as EventEmitter & {
        end: ReturnType<typeof vi.fn>;
        subscribe: ReturnType<typeof vi.fn>;
      };
      client.end = vi.fn();
      client.subscribe = vi.fn((_topic: string, _opts: unknown, cb: (e: Error | null, g: unknown) => void) =>
        cb(null, [{ topic: _topic, qos: 1 }]),
      );
      fakeClients.push(client);
      return client;
    }),
  },
}));

const { probeBrokerInstance } = await import("../broker-discovery.js");

const CREDS = {
  hostname: "aiot-mqtt-us.example.invalid",
  certificate_pem: "cert",
  private_key: "key",
  aws_root_ca1_pem: "ca",
};

describe("probeBrokerInstance", () => {
  beforeEach(() => {
    fakeClients.length = 0;
    connectOptsSeen.length = 0;
  });

  it("verifies the instance it dials, checking the certificate against the broker hostname", async () => {
    const p = probeBrokerInstance("198.51.100.7", CREDS, { clientId: "probe-1", topic: "a/res" });
    (await nextClient(fakeClients)).emit("connect");
    await p;

    const opts = connectOptsSeen[0];
    expect(opts.host).toBe("198.51.100.7");
    expect(opts.rejectUnauthorized).toBe(true);
    expect(opts.servername).toBe(CREDS.hostname);
    expect(typeof opts.checkServerIdentity).toBe("function");
    expect(opts.ca).toBe(CREDS.aws_root_ca1_pem);
  });

  it("records a denied SUBACK's return code, which mqtt.js reports as an error beside the SUBACK", async () => {
    const p = probeBrokerInstance("198.51.100.7", CREDS, { clientId: "probe-1", topic: "a/res" });
    const client = await nextClient(fakeClients);
    client.subscribe.mockImplementationOnce(
      (topic: string, _opts: unknown, cb: (e: Error | null, g: unknown, packet: unknown) => void) =>
        cb(new Error("Subscribe error: Unspecified error"), [{ topic, qos: 1 }], { cmd: "suback", granted: [0x80] }),
    );
    client.emit("connect");

    expect(await p).toMatchObject({ granted: false, grantedQos: 0x80, error: "Subscribe error: Unspecified error" });
  });
});
