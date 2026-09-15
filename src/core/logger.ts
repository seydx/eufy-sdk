/**
 * Pluggable diagnostics logging.
 *
 * The SDK emits internal diagnostics through a {@link Logger} a host supplies — so its logs flow
 * into the host's own pipeline (tslog, winston, pino, …) with real log levels, instead of a hard-wired
 * `console`. No logger supplied → {@link noopLogger} swallows everything (silent by default).
 *
 * The interface is a STRUCTURAL 4-level sink (`debug`/`info`/`warn`/`error`), shaped to match
 * `console`, tslog, and winston natively; pino (object-first) plugs in via a one-line adapter:
 * `{ logger: { debug: (m, ...a) => pino.debug(a[0] ?? {}, m), … } }`.
 */

/** Severity levels, low → high. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Host-pluggable diagnostics sink. Pass one as `logger` when constructing `EufyMega`; the
 * SDK calls the matching level method with a `[subsystem]`-prefixed message and optional args.
 *
 * @example
 * ```ts
 * // A custom sink (or pass a tslog / winston instance directly — they already match this shape):
 * const eufy = new EufyMega({
 *   email,
 *   password,
 *   logger: { debug: (m, ...a) => myLog.debug(m, ...a), info: () => {}, warn: console.warn, error: console.error },
 * });
 * ```
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Discards everything. The default when no `logger` is supplied — the SDK is silent. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Built-in {@link Logger} that writes to `console`, gated by a minimum level. `new ConsoleLogger()`
 * turns on all diagnostics; `new ConsoleLogger("warn")` shows only warnings and errors. Each level maps
 * to the matching `console` method.
 *
 * @example
 * ```ts
 * const eufy = new EufyMega({ email, password, logger: new ConsoleLogger() });        // verbose
 * const quiet = new EufyMega({ email, password, logger: new ConsoleLogger("warn") }); // warn + error only
 * ```
 */
export class ConsoleLogger implements Logger {
  constructor(private readonly minLevel: LogLevel = "debug") {}

  private enabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.minLevel];
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.enabled("debug")) console.debug(message, ...args);
  }
  info(message: string, ...args: unknown[]): void {
    if (this.enabled("info")) console.info(message, ...args);
  }
  warn(message: string, ...args: unknown[]): void {
    if (this.enabled("warn")) console.warn(message, ...args);
  }
  error(message: string, ...args: unknown[]): void {
    if (this.enabled("error")) console.error(message, ...args);
  }
}
