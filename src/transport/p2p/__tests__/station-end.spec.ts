import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";

/**
 * A station that ends its connection with `END` has left: the session closes, so nothing re-attaches to it.
 *
 * Only the connected address can end the connection. An `END` from anywhere else, or one arriving before the
 * handshake, is not about this session.
 */
const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";
const STATION = { host: "203.0.113.1", port: 32100 };
const END = Buffer.from([0xf1, 0xf0, 0x00, 0x00]);

function session(connected = true) {
  const built = new P2PSession({
    stationSn: STATION_SN,
    p2pDid: P2P_DID,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const internals = built as unknown as {
    connectAddress?: { host: string; port: number };
    connected: boolean;
    closed: boolean;
    socket?: { send: ReturnType<typeof vi.fn>; close: (done: () => void) => void };
    send: (addr: { host: string; port: number }, type: Buffer, payload?: Buffer) => void;
    onMessage: (msg: Buffer, rinfo: { address: string; port: number }) => void;
  };
  internals.socket = { send: vi.fn(), close: (done) => done() };
  internals.connectAddress = { ...STATION };
  internals.connected = connected;
  const send = vi.spyOn(internals, "send");
  const closed = vi.fn();
  built.on("close", closed);
  return { internals, send, closed };
}

describe("a station ending its connection", () => {
  it("closes the session and emits close", async () => {
    const { internals, closed } = session();
    internals.onMessage(END, { address: STATION.host, port: STATION.port });
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(internals.closed).toBe(true);
    expect(internals.connected).toBe(false);
  });

  it("sends no END back to a station that has already left", async () => {
    const { internals, send, closed } = session();
    internals.onMessage(END, { address: STATION.host, port: STATION.port });
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(send.mock.calls.filter(([, type]) => (type as Buffer).equals(END.subarray(0, 2)))).toEqual([]);
  });

  it("ignores an END from an address the session is not connected to", async () => {
    const { internals, closed } = session();
    internals.onMessage(END, { address: "203.0.113.2", port: STATION.port });
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    expect(internals.closed).toBe(false);
  });

  it("ignores an END before the handshake completed", async () => {
    const { internals, closed } = session(false);
    internals.onMessage(END, { address: STATION.host, port: STATION.port });
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
  });
});
