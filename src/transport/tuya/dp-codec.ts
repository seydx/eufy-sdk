/**
 * Inbound Tuya DP parsing and routing for eufy Home/Clean (`eufy_home_tuya`) devices.
 *
 * {@link parseTuyaDpEvent} validates a Tuya cloud DP map and normalises it to a numeric-keyed record.
 * {@link TuyaDpRouter} delivers the result to the registered {@link TuyaDpInbound} listener so the
 * capability layer can consume Tuya state through the same typed getters as AIoT.
 */
import type { TuyaDpInbound } from "../../core/contracts.js";

/**
 * Validate and convert a raw ThingClips DP callback payload to a numeric-keyed record.
 *
 * The callback delivers `{ "<dpId>": <value>, … }` with string keys and typed values; this
 * normalises the keys to positive integer DP ids. Unrecognised keys (non-positive-integer, non-scalar
 * values) are skipped rather than rejecting the whole map — the same defensive posture as
 * {@link parseAiotDpReport}. Returns `null` only when the input is not a non-empty object or when no
 * valid DP entry was found.
 */
export function parseTuyaDpEvent(payload: unknown): Record<number, boolean | number | string> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const result: Record<number, boolean | number | string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!/^[1-9]\d*$/.test(key)) continue;
    if (typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string") continue;
    result[Number(key)] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Routes validated inbound Tuya DP events to the registered {@link TuyaDpInbound} listener.
 *
 * Mirrors the AIoT MQTT inbound path: the transport owns parsing; the capability layer owns
 * semantics. A malformed or empty payload is silently dropped; the listener sees only
 * successfully parsed DP maps.
 */
export class TuyaDpRouter {
  private listener: TuyaDpInbound | undefined;

  /** Register the inbound listener. Replaces any previously registered one. */
  setListener(listener: TuyaDpInbound): void {
    this.listener = listener;
  }

  /**
   * Parse `dps` and, if valid, deliver it to the registered listener for `sn`.
   * Silently drops malformed or empty payloads.
   */
  deliver(sn: string, dps: unknown): void {
    const parsed = parseTuyaDpEvent(dps);
    if (parsed === null || this.listener === undefined) return;
    this.listener.onDps(sn, parsed);
  }
}
