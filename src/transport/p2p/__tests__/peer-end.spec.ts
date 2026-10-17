import dgram from "node:dgram";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { frameMessage, ResponseMessageType } from "../codec.js";
import { P2PSession } from "../p2p-session.js";

/** A real loopback peer; no production endpoint or mocked socket receive path. */
async function peer(host = "127.0.0.1") {
  const socket = dgram.createSocket("udp4");
  socket.bind(0, host);
  await once(socket, "listening");
  return socket;
}

/** Connect through an actual CAM_ID datagram, then retain the observed client source port. */
async function connectedPeer() {
  const remote = await peer();
  const session = new P2PSession({ stationSn: "T8000P0000000000", p2pDid: "XXXXXXX-000000-XXXXX", noBroadcast: true });
  session.on("error", () => undefined);
  await session.connect();
  const clientPort = (session as unknown as { socket: dgram.Socket }).socket.address().port;
  const connected = once(session, "connect");
  remote.send(frameMessage(ResponseMessageType.CAM_ID), clientPort, "127.0.0.1");
  await connected;
  return { remote, session, clientPort };
}

describe("peer-ended P2P sessions over UDP", () => {
  it("closes promptly when the selected peer sends END", async () => {
    const { remote, session, clientPort } = await connectedPeer();
    try {
      const closed = vi.fn();
      session.on("close", closed);
      remote.send(frameMessage(ResponseMessageType.END), clientPort, "127.0.0.1");
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce(), { timeout: 500, interval: 5 });
      expect(session.isConnected).toBe(false);
    } finally {
      await session.close();
      remote.close();
    }
  });

  it("ignores another source port's END before accepting the selected peer's END", async () => {
    const { remote, session, clientPort } = await connectedPeer();
    const foreignPort = await peer();
    try {
      foreignPort.send(frameMessage(ResponseMessageType.END), clientPort, "127.0.0.1");
      await delay(80);
      expect(session.isConnected).toBe(true);
      const closed = vi.fn();
      session.on("close", closed);
      remote.send(frameMessage(ResponseMessageType.END), clientPort, "127.0.0.1");
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce(), { timeout: 500, interval: 5 });
    } finally {
      await session.close();
      remote.close();
      foreignPort.close();
    }
  });

  it("ignores a delayed END from the previous connection after reconnecting to a new peer", async () => {
    const { remote: oldPeer, session } = await connectedPeer();
    const currentPeer = await peer();
    try {
      await session.close();
      await session.connect();
      const port = (session as unknown as { socket: dgram.Socket }).socket.address().port;
      const connected = once(session, "connect");
      currentPeer.send(frameMessage(ResponseMessageType.CAM_ID), port, "127.0.0.1");
      await connected;
      oldPeer.send(frameMessage(ResponseMessageType.END), port, "127.0.0.1");
      await delay(80);
      expect(session.isConnected).toBe(true);
      const closed = vi.fn();
      session.on("close", closed);
      currentPeer.send(frameMessage(ResponseMessageType.END), port, "127.0.0.1");
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce(), { timeout: 500, interval: 5 });
    } finally {
      await session.close();
      oldPeer.close();
      currentPeer.close();
    }
  });
});
