import { describe, it, expect, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";

/**
 * `getStationFaces` resolves which station and which account id, and hands the rest to
 * `P2PSession.readDatabase` — which owns assembling the reply and is specced with the transport.
 * These cover the facade's own half: the station key, the admin id the station refuses the query
 * without, and the session having to exist.
 */
const STATION = "T8010P0000000000";

const ROWS = [
  { person_id: 1, name: "Alex", relation: "1" },
  { person_id: 2, name: "stranger1", relation: "0" },
];

function harness(opts: { adminUserId?: string; session?: { readDatabase: unknown } | null } = {}) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x" });
  const readDatabase = vi.fn().mockResolvedValue(ROWS);
  const session = opts.session === undefined ? { readDatabase } : opts.session;

  const internals = eufy as unknown as {
    registry: { list: () => unknown[] };
    p2p: {
      stationKeyOf: (sn: string) => string;
      ensureStation: (sn: string, signal?: AbortSignal) => Promise<void>;
      getSessions: () => Map<string, unknown>;
    };
  };
  vi.spyOn(internals.registry, "list").mockReturnValue([
    { sn: STATION, raw: { member: { admin_user_id: opts.adminUserId ?? "ADMIN-0000" } } },
  ]);
  internals.p2p = {
    stationKeyOf: (sn: string) => sn,
    ensureStation: async () => undefined,
    getSessions: () => new Map(session ? [[STATION, session]] : []),
  };
  return { eufy, readDatabase };
}

describe("getStationFaces", () => {
  it("reads person_basic_info scoped to the station's admin id", async () => {
    const { eufy, readDatabase } = harness();
    expect((await eufy.getStationFaces(STATION)).map((f) => f.name)).toEqual(["Alex", "stranger1"]);
    expect(readDatabase).toHaveBeenCalledWith(
      "person_basic_info",
      expect.objectContaining({ accountId: "ADMIN-0000" }),
    );
  });

  it("passes the caller's bound and signal through", async () => {
    const control = new AbortController();
    const { eufy, readDatabase } = harness();
    await eufy.getStationFaces(STATION, { timeoutMs: 500, signal: control.signal });
    expect(readDatabase).toHaveBeenCalledWith(
      "person_basic_info",
      expect.objectContaining({ timeoutMs: 500, signal: control.signal }),
    );
  });

  it("refuses a station whose record states no admin id, rather than querying with none", async () => {
    // A wrong or absent account id is answered `-104` by the station, which looks like silence.
    const { eufy, readDatabase } = harness({ adminUserId: "" });
    await expect(eufy.getStationFaces(STATION)).rejects.toThrow(/admin_user_id/);
    expect(readDatabase).not.toHaveBeenCalled();
  });

  it("refuses when the station has no session to ask", async () => {
    const { eufy } = harness({ session: null });
    await expect(eufy.getStationFaces(STATION)).rejects.toThrow(/no P2P session/);
  });

  it("keeps the station's own placeholder names and its extra columns", async () => {
    // `stranger<n>` is what the station calls a face nobody has named, and the schema is the
    // station's — naming or trimming either is the caller's decision, not this read's.
    const { eufy } = harness();
    const faces = await eufy.getStationFaces(STATION);
    expect(faces.map((f) => f.name)).toContain("stranger1");
    expect(faces[0]).toMatchObject({ person_id: 1, relation: "1" });
  });
});
