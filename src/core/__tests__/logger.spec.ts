import { ConsoleLogger, noopLogger, type Logger, type LogLevel } from "../logger.js";
import { MegaHttpClient } from "../../transport/http/mega-client.js";
import type { PersistedSession, SessionStore } from "../store.js";

/** A spy logger: records every call as [level, message, ...args]. */
function spyLogger(): Logger & { calls: Array<[LogLevel, string, unknown[]]> } {
  const calls: Array<[LogLevel, string, unknown[]]> = [];
  return {
    calls,
    debug: (m, ...a) => calls.push(["debug", m, a]),
    info: (m, ...a) => calls.push(["info", m, a]),
    warn: (m, ...a) => calls.push(["warn", m, a]),
    error: (m, ...a) => calls.push(["error", m, a]),
  };
}

describe("ConsoleLogger", () => {
  const levels: LogLevel[] = ["debug", "info", "warn", "error"];

  it("at the default level (debug) forwards every level to the matching console method", () => {
    const log = new ConsoleLogger();
    const spies = {
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
    try {
      for (const l of levels) log[l](`[t] ${l}`, 1);
      expect(spies.debug).toHaveBeenCalledWith("[t] debug", 1);
      expect(spies.info).toHaveBeenCalledWith("[t] info", 1);
      expect(spies.warn).toHaveBeenCalledWith("[t] warn", 1);
      expect(spies.error).toHaveBeenCalledWith("[t] error", 1);
    } finally {
      for (const s of Object.values(spies)) s.mockRestore();
    }
  });

  it('gates below minLevel: new ConsoleLogger("warn") drops debug/info, keeps warn/error', () => {
    const log = new ConsoleLogger("warn");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
      expect(debug).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("w");
      expect(error).toHaveBeenCalledWith("e");
    } finally {
      [debug, info, warn, error].forEach((s) => s.mockRestore());
    }
  });
});

describe("noopLogger", () => {
  it("swallows every level without throwing and returns undefined", () => {
    for (const l of ["debug", "info", "warn", "error"] as const) {
      expect(noopLogger[l]("x", 1, 2)).toBeUndefined();
    }
  });
});

describe("logger injection", () => {
  it("a component routes its diagnostics to the injected logger (MegaHttpClient session restore)", () => {
    const session: PersistedSession = {
      userId: "u-0000",
      accountUserId: "u-0000",
      authToken: "tok",
      region: "eu-pr",
      openudid: "0000000000000000",
      shareKey: "0".repeat(32),
      keyIdent: "0".repeat(32),
      tokenExpiresAt: 0, // 0 = unknown → treated as valid (no expiry check)
      savedAt: 0,
    };
    const store: SessionStore = { load: () => session, save: () => {}, clear: () => {} };
    const logger = spyLogger();

    // Constructing with a valid persisted session hits the restore path, which logs at debug.
    new MegaHttpClient({ email: "a@b.co", password: "x", region: "eu-pr", store, logger });

    const restored = logger.calls.find(([lvl, msg]) => lvl === "debug" && msg.includes("restored persisted session"));
    expect(restored, `expected a debug log, got ${JSON.stringify(logger.calls)}`).toBeTruthy();
  });
});
