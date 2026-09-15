/**
 * Anker **Solix** capability surface. Solix is a separate ecosystem — its own Anker account, backend
 * and product catalog — so it keeps its own capability id union rather than joining eufy's `Capability`
 * / `Codec` unions, and detection is by Anker catalog CATEGORY + product-code prefix (see
 * {@link detectSolixCapabilities}) rather than eufy param ids.
 *
 * What it shares is the `members` engine: the one feature with a readable wire declares ONE `members`
 * table, and its property schema, evidence gate and typed surface all derive from it through
 * `members.ts` (`bindMembers` / `Surface`), exactly as a eufy capability does.
 *
 * @module model/capabilities/solix
 */
import type { Members, Surface } from "./members.js";

/** Every capability a Solix device may carry. Solix's OWN union (not eufy's `Capability`). */
export type SolixCapability =
  | "identity"
  | "firmware"
  | "connectivity"
  | "energyMeter"
  | "battery"
  | "solarInput"
  | "acOutput"
  | "evCharger"
  | "charger"
  | "cooler";

/**
 * The `energyMeter` surface, declared once. Only the ONE confirmed tag→name binding is a member:
 * `meterVoltageL1` (ff09 tag `0xAC`), confirmed against a live single-phase frame. The evidence gate
 * (`bindMembers`) installs its getter only once a frame carrying tag `0xAC` has landed and answers
 * `undefined` before.
 *
 * The meter reports many more quantities (per-line power/current/voltage, totals, import/export energy),
 * but their tag→name bindings are a structural inference not yet pinned to a known-load capture. Rather
 * than assert a name that could mislabel a live float, those stay reachable raw as `channel_<hex>` from
 * the device's telemetry (a static members table cannot enumerate dynamic hex tags); each is promoted to
 * a member here, one line, as a capture confirms its binding.
 *
 * @internal — the declaration `SolixEnergyMeterReads` derives from; exported (like the eufy `*_MEMBERS`
 * tables) so it is a known symbol, but excluded from the rendered API reference.
 */
export const SOLIX_ENERGY_METER_MEMBERS = {
  /**
   * Line-1 voltage (V), ff09 tag `0xAC` — the ONE confirmed meter binding, matched against a live
   * single-phase frame (a nominal mains voltage). Read-only; the evidence gate installs its getter only
   * once a frame carrying `0xAC` has landed, so it is absent (not a fabricated `0`) until then.
   */
  meterVoltageL1: {
    param: 0xac,
    type: "number",
    kind: "scalar",
    unit: "V",
    provenance: "verified",
    description: "Meter line-1 voltage (V) — ff09 tag 0xAC, confirmed against a live single-phase frame.",
  },
} as const satisfies Members;

/** Bound `energyMeter` reads (the members-derived half of `dev.energyMeter()`). Read-only. */
export type SolixEnergyMeterReads = Surface<typeof SOLIX_ENERGY_METER_MEMBERS>;

/**
 * The capabilities each Anker catalog category implies. Category is a detection SIGNAL (like eufy's
 * `deviceTypes`), not the model's identity — a device still resolves `energyMeter` from its product code
 * even though its category is "Accessory", which is why that category maps to nothing on its own.
 * Unlisted categories contribute nothing here.
 */
export const CATEGORY_CAPABILITIES: Readonly<Record<string, readonly SolixCapability[]>> = {
  "Portable Power Station": ["battery", "acOutput", "solarInput"],
  "Plug-in Home Battery": ["battery", "solarInput", "acOutput", "energyMeter"],
  "Powered Cooler": ["battery", "cooler"],
  "Power Bank": ["battery"],
  "Smart EV Charger": ["evCharger"],
  Charger: ["charger"],
  Accessory: [],
};

/** Product-code prefixes known to be grid/energy meters (detects `energyMeter` regardless of category). */
export const SOLIX_METER_MODELS: readonly string[] = ["AE1X0"];

/**
 * Product-code prefixes for the grid-tie Solarbank / home-battery family (detects `battery` +
 * `solarInput` regardless of category): A1790 = Solarbank E1600 gen-1, A17C* = Solarbank 2 / 3.
 */
export const SOLARBANK_MODELS: readonly string[] = ["A1790", "A17C"];

/** The minimum device shape {@link detectSolixCapabilities} reads. */
export interface SolixDetectionInput {
  product_code: string;
  device_sw_version?: string;
  wifi_online?: boolean;
  wifi_name?: string;
  rssi?: string | number;
}

/**
 * Resolve a Solix device's capability set from its record fields, catalog category, and product-code
 * prefix — the Solix analogue of eufy's `detectCapabilities`, kept Solix-scoped so eufy detection is
 * untouched. `identity` is universal; the rest are OR-ed evidence.
 */
export function detectSolixCapabilities(rec: SolixDetectionInput, category?: string): Set<SolixCapability> {
  const caps = new Set<SolixCapability>(["identity"]);
  if (rec.device_sw_version) caps.add("firmware");
  if (rec.wifi_online !== undefined || rec.rssi != null || rec.wifi_name) caps.add("connectivity");
  for (const c of (category && CATEGORY_CAPABILITIES[category]) || []) caps.add(c);
  if (SOLIX_METER_MODELS.some((m) => rec.product_code?.startsWith(m))) caps.add("energyMeter");
  if (SOLARBANK_MODELS.some((m) => rec.product_code?.startsWith(m))) {
    caps.add("battery");
    caps.add("solarInput");
  }
  return caps;
}
