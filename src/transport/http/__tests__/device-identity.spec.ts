import { describe, expect, it } from "vitest";

import { MemorySessionStore, type PersistedSession } from "../../../core/store.js";
import { MegaHttpClient } from "../mega-client.js";

const storedSession = (extra: Partial<PersistedSession>): PersistedSession => ({
  userId: "u",
  authToken: "t",
  region: "us-pr",
  openudid: "STORED-UDID",
  shareKey: "00".repeat(16),
  keyIdent: "00".repeat(16),
  tokenExpiresAt: 0,
  savedAt: Date.now(),
  ...extra,
});

describe("device identity resolution", () => {
  it("reuses a stored phoneModel / mediaUserAgent instead of regenerating", () => {
    const store = new MemorySessionStore();
    store.save(storedSession({ phoneModel: "STORED-Model", mediaUserAgent: "STORED-UA" }));
    const c = new MegaHttpClient({ email: "a@b.c", password: "x", store }) as unknown as {
      phoneModel: string;
      mediaUserAgent: string;
      openudid: string;
    };
    expect(c.phoneModel).toBe("STORED-Model");
    expect(c.mediaUserAgent).toBe("STORED-UA");
    expect(c.openudid).toBe("STORED-UDID");
  });

  it("generates a stable identity from openudid when nothing is stored", () => {
    const mk = () =>
      new MegaHttpClient({ email: "a@b.c", password: "x", store: new MemorySessionStore() }) as unknown as {
        phoneModel: string;
      };
    expect(mk().phoneModel).toBe(mk().phoneModel); // deterministic from the (email-derived) openudid
  });

  it("explicit config wins over both stored and generated", () => {
    const store = new MemorySessionStore();
    store.save(storedSession({ phoneModel: "STORED-Model", mediaUserAgent: "STORED-UA" }));
    const c = new MegaHttpClient({
      email: "a@b.c",
      password: "x",
      store,
      phoneModel: "EXPLICIT",
      mediaUserAgent: "EXPLICIT-UA",
    }) as unknown as { phoneModel: string; mediaUserAgent: string };
    expect(c.phoneModel).toBe("EXPLICIT");
    expect(c.mediaUserAgent).toBe("EXPLICIT-UA");
  });
});

describe("acting account name", () => {
  const name = (cfg: { email?: string; accountName?: string }) =>
    new MegaHttpClient({ email: "someone+tag@example.com", password: "x", store: new MemorySessionStore(), ...cfg })
      .accountName;

  it("defaults to the login email's local-part", () => {
    expect(name({})).toBe("someone+tag");
  });

  it("falls back to the whole string when the email has no @", () => {
    expect(name({ email: "someone" })).toBe("someone");
  });

  it("a configured name wins over the email", () => {
    expect(name({ accountName: "Front Desk" })).toBe("Front Desk");
  });

  it("trims a configured name, and treats a blank one as unset", () => {
    expect(name({ accountName: "  Front Desk  " })).toBe("Front Desk");
    expect(name({ accountName: "   " })).toBe("someone+tag");
    expect(name({ accountName: "" })).toBe("someone+tag");
  });
});
