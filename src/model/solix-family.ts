/**
 * Anker **Solix** product-family classification — the single home for the one question "what product
 * family is this Solix device?" (power station, Solarbank, smart meter, power bank, cooler, EV charger,
 * charger). It is the Solix analogue of eufy's `device-family.ts` `isHomeBase()`: a set of PURE,
 * param-agnostic predicates over the device's product code + catalog category, answering family
 * membership only.
 *
 * Classification is not capability resolution. A family answers "what kind of thing is this" — the
 * grouping question a caller asks to sort a site's devices ("give me the power stations") or to badge
 * one in a UI. What the device can *do* (its `SolixCapability` set, its telemetry surface) is resolved
 * separately in `capabilities/solix.ts` `detectSolixCapabilities`. Keeping the two apart is what lets a
 * caller classify a device without dragging its whole capability model along, exactly as `isHomeBase()`
 * is separate from what a HomeBase can do.
 *
 * The model-code prefix sets are REUSED from the capability module ({@link SOLARBANK_MODELS},
 * {@link SOLIX_METER_MODELS}) rather than duplicated: those are pure classification data (product-code
 * prefixes, no wire ids), so they are the single source of truth this module reads to answer
 * `isSolixSolarbank` / `isSolixSmartMeter`. The remaining families are read from the Anker catalog
 * category, the same detection signal `detectSolixCapabilities` consumes.
 *
 * @module model/solix-family
 */
import { SOLARBANK_MODELS, SOLIX_METER_MODELS } from "./capabilities/solix.js";

/**
 * A Solix device's product family — the normalized "what kind of thing is this" answer, decorrelated
 * from the Anker catalog's marketing category strings. `unknown` when neither the product code nor the
 * category identifies a family (never a guess).
 */
export type SolixProductFamily =
  | "powerStation" // Portable Power Station (SOLIX F-series)
  | "solarbank" // grid-tie Solarbank / plug-in home battery
  | "smartMeter" // grid CT / smart energy meter (AE1X0)
  | "powerBank" // portable power bank
  | "cooler" // powered cooler with a battery
  | "evCharger" // smart EV charger
  | "charger" // charger
  | "unknown";

/** The pure evidence a family decision reads: the product code, and the catalog category when resolved. */
export interface SolixFamilyInput {
  /** SKU / model code, e.g. `A1782`, `AE103`, `AE1X0`. */
  product_code: string;
  /** Anker catalog category, when a catalog resolved one (e.g. `"Portable Power Station"`). */
  category?: string;
}

/**
 * The catalog categories that map one-to-one onto a family, for the codes a prefix set does not cover.
 * "Plug-in Home Battery" is intentionally NOT here: the solarbank family owns its own category check in
 * {@link isSolixSolarbank}, which {@link solixProductFamily} consults directly — stating that mapping
 * here too would be a second source of the same truth. The category strings are the trimmed form (the
 * catalog's trailing whitespace is normalised at ingest in `buildModelIndex`), so exact keys match.
 */
const CATEGORY_FAMILY: Readonly<Record<string, SolixProductFamily>> = {
  "Portable Power Station": "powerStation",
  "Power Bank": "powerBank",
  "Powered Cooler": "cooler",
  "Smart EV Charger": "evCharger",
  Charger: "charger",
};

const hasPrefix = (code: string | undefined, prefixes: readonly string[]): boolean =>
  !!code && prefixes.some((p) => code.startsWith(p));

/** Grid-tie Solarbank / plug-in home battery family (by product code, catalog-independent). */
export const isSolixSolarbank = (input: SolixFamilyInput): boolean =>
  hasPrefix(input.product_code, SOLARBANK_MODELS) || input.category === "Plug-in Home Battery";

/** Smart energy meter / grid-CT family (by product code, catalog-independent). */
export const isSolixSmartMeter = (input: SolixFamilyInput): boolean =>
  hasPrefix(input.product_code, SOLIX_METER_MODELS);

/** Portable Power Station (SOLIX F-series) family — resolved from the catalog category. */
export const isSolixPowerStation = (input: SolixFamilyInput): boolean => input.category === "Portable Power Station";

/**
 * Resolve a Solix device's {@link SolixProductFamily} by consulting the family predicates first (they are
 * catalog-independent, so a device classifies even before a catalog is fetched), then the catalog
 * category for the families that have no prefix set yet. Returns `"unknown"` when neither identifies one —
 * never a guess, mirroring `device-family.ts` returning `false` on an unknown device type.
 *
 * The meter is checked before the Solarbank: both can present a battery-ish catalog category, but the
 * meter's `AE1X0` prefix is unambiguous and a meter is never a Solarbank. The Solarbank case reuses
 * {@link isSolixSolarbank} (prefix OR the home-battery category) rather than re-testing the prefix here,
 * so the two never drift.
 */
export function solixProductFamily(input: SolixFamilyInput): SolixProductFamily {
  if (isSolixSmartMeter(input)) return "smartMeter";
  if (isSolixSolarbank(input)) return "solarbank";
  return (input.category ? CATEGORY_FAMILY[input.category] : undefined) ?? "unknown";
}
