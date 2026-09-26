import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextClient } from "./lazy-engine.js";
import { EventEmitter } from "node:events";

/**
 * `SecureMqtt.connect()`'s lifecycle around a failed/never-established connection — no real socket:
 * `mqtt.connect` is mocked to return a bare EventEmitter standing in for mqtt.js's `MqttClient`, with
 * an `end` spy so we can assert cleanup without a live broker.
 */
const fakeClients: Array<EventEmitter & { end: ReturnType<typeof vi.fn> }> = [];
const connectOptsSeen: any[] = [];

vi.mock("mqtt", () => ({
  default: {
    connect: vi.fn((...args: any[]) => {
      const opts = typeof args[0] === "string" ? args[1] : args[0];
      connectOptsSeen.push(opts);
      const client = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
      client.end = vi.fn();
      fakeClients.push(client);
      return client;
    }),
  },
}));

const { SecureMqtt } = await import("../secure-mqtt.js");

const CREDS = {
  endpoint_addr: "aiot-mqtt-us.anker.com",
  certificate_pem: "cert",
  private_key: "key",
  aws_root_ca1_pem: "ca",
  thing_name: "u123-eufy_security",
};

describe("SecureMqtt.connect — reconnect lifecycle", () => {
  beforeEach(() => {
    fakeClients.length = 0;
    connectOptsSeen.length = 0;
  });

  it("a connect that never establishes ends the client instead of leaving it to auto-reconnect forever", async () => {
    const m = new SecureMqtt({ credentials: CREDS, instanceIp: "198.51.100.7" });
    m.on("error", () => {}); // SecureMqtt re-emits — a real caller always listens (e.g. ensureSecurityMqttFor)
    const p = m.connect();
    const client = await nextClient(fakeClients);
    client.emit("error", new Error("ECONNREFUSED"));

    await expect(p).rejects.toThrow("ECONNREFUSED");
    expect(client.end).toHaveBeenCalledWith(true);
  });

  it("a post-connect error (already established) does NOT end the client — the persistent transport keeps reconnecting", async () => {
    const m = new SecureMqtt({ credentials: CREDS });
    m.on("error", () => {});
    const p = m.connect();
    const client = await nextClient(fakeClients);
    client.emit("connect");
    await p;

    client.emit("error", new Error("dropped"));
    expect(client.end).not.toHaveBeenCalled();
  });

  it("defaults reconnectPeriod to 5000 (persistent) unless the caller overrides it", async () => {
    const m = new SecureMqtt({ credentials: CREDS });
    const p = m.connect();
    (await nextClient(fakeClients)).emit("connect");
    await p;
    expect(connectOptsSeen[0].reconnectPeriod).toBe(5000);
  });

  it("a one-shot caller (reconnectPeriod:0) gets that value passed straight through to mqtt.connect", async () => {
    const m = new SecureMqtt({ credentials: CREDS, instanceIp: "198.51.100.7", reconnectPeriod: 0 });
    const p = m.connect();
    (await nextClient(fakeClients)).emit("connect");
    await p;
    expect(connectOptsSeen[0].reconnectPeriod).toBe(0);
  });

  it("verifies the server on a pinned-instance dial, checking the certificate against the hostname", async () => {
    const m = new SecureMqtt({ credentials: CREDS, instanceIp: "198.51.100.7" });
    const p = m.connect();
    (await nextClient(fakeClients)).emit("connect");
    await p;

    const opts = connectOptsSeen[0];
    expect(opts.host).toBe("198.51.100.7");
    expect(opts.rejectUnauthorized).toBe(true);
    expect(opts.servername).toBe(CREDS.endpoint_addr);
    expect(typeof opts.checkServerIdentity).toBe("function");
    expect(opts.ca).toBe(CREDS.aws_root_ca1_pem);
  });

  describe("one connection per instance", () => {
    it("joins an in-flight connect instead of opening a second client under the same id", async () => {
      const m = new SecureMqtt({ credentials: CREDS });
      const first = m.connect();
      const second = m.connect();
      (await nextClient(fakeClients)).emit("connect");
      await Promise.all([first, second]);
      expect(fakeClients).toHaveLength(1);
    });

    it("reuses an established connection on a later connect()", async () => {
      const m = new SecureMqtt({ credentials: CREDS });
      const p = m.connect();
      (await nextClient(fakeClients)).emit("connect");
      await p;
      await m.connect();
      expect(fakeClients).toHaveLength(1);
    });

    it("retries with a fresh client after a connect that failed", async () => {
      const m = new SecureMqtt({ credentials: CREDS, instanceIp: "198.51.100.7" });
      m.on("error", () => {});
      const failed = m.connect();
      (await nextClient(fakeClients)).emit("error", new Error("ECONNREFUSED"));
      await expect(failed).rejects.toThrow("ECONNREFUSED");

      const retry = m.connect();
      (await nextClient(fakeClients, 1)).emit("connect");
      await retry;
      expect(fakeClients).toHaveLength(2);
    });

    it("opens a new client after an explicit disconnect()", async () => {
      const m = new SecureMqtt({ credentials: CREDS });
      const p = m.connect();
      const client = await nextClient(fakeClients);
      Object.assign(client, { endAsync: vi.fn(async () => {}) });
      client.emit("connect");
      await p;
      await m.disconnect();

      const again = m.connect();
      (await nextClient(fakeClients, 1)).emit("connect");
      await again;
      expect(fakeClients).toHaveLength(2);
    });
  });
});
