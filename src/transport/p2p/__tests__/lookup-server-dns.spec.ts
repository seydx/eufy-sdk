import dgram from "node:dgram";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RequestMessageType, hasHeader } from "../codec.js";

/**
 * A lookup server named by hostname is resolved once per connect, in the background, and every lookup and relay
 * datagram after that goes to the resolved address. A datagram sent to a hostname costs a `dns.lookup` on the
 * threadpool HTTP requests resolve on too.
 */
const resolve4 = vi.fn(async (_host: string): Promise<string[]> => ["127.0.0.1"]);
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  resolve4: (host: string) => resolve4(host),
}));

const { P2PSession } = await import("../p2p-session.js");

const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

async function peer(): Promise<dgram.Socket> {
  const socket = dgram.createSocket("udp4");
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  return socket;
}

async function elapse(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    await vi.advanceTimersByTimeAsync(100);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("lookup servers named by hostname", () => {
  it("are resolved once per connect, and the lookups go to the resolved address", async () => {
    const cloud = await peer();
    let lookups = 0;
    cloud.on("message", (msg) => {
      if (hasHeader(msg, RequestMessageType.LOOKUP_WITH_KEY) || hasHeader(msg, RequestMessageType.LOOKUP_WITH_KEY2))
        lookups++;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const session = new P2PSession({
      stationSn: STATION_SN,
      p2pDid: P2P_DID,
      dskKey: "0".repeat(20),
      cloudAddresses: [{ host: "p2p-lookup.invalid", port: cloud.address().port }],
      noBroadcast: true,
    });
    session.on("error", () => undefined);
    try {
      await session.connect();
      await elapse(5_000);
      expect(resolve4.mock.calls.map(([host]) => host)).toEqual(["p2p-lookup.invalid"]);
      expect(lookups).toBeGreaterThan(10);
    } finally {
      vi.useRealTimers();
      await session.close();
      cloud.close();
    }
  }, 20_000);

  /** The lookups start without waiting on DNS, so a slow resolver cannot hold back the LAN lookup or the connect deadline. */
  it("starts the lookups while a hostname is still resolving", async () => {
    resolve4.mockImplementationOnce(() => new Promise<string[]>(() => undefined));
    const session = new P2PSession({
      stationSn: STATION_SN,
      p2pDid: P2P_DID,
      dskKey: "0".repeat(20),
      cloudAddresses: [{ host: "p2p-lookup.invalid", port: 32100 }],
      noBroadcast: true,
    });
    session.on("error", () => undefined);
    const internals = session as unknown as { lookupTimer?: unknown; connectTimer?: unknown };
    try {
      await session.connect();
      expect(internals.lookupTimer).toBeDefined();
      expect(internals.connectTimer).toBeDefined();
    } finally {
      await session.close();
    }
  });
});
