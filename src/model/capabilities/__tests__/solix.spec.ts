import { describe, expect, it } from "vitest";

import { SOLIX_ENERGY_METER_MEMBERS, detectSolixCapabilities } from "../solix.js";
import { propertiesOf } from "../members.js";

/**
 * The Solix capability surface: one `members` table for the single feature with a confirmed readable
 * wire, and category/prefix detection for the rest. These lock the members-derived schema and detection.
 */
describe("Solix capability surface", () => {
  it("the energyMeter schema derives from its members table: only the confirmed meterVoltageL1 (0xAC)", () => {
    const props = propertiesOf(SOLIX_ENERGY_METER_MEMBERS);
    expect(props).toHaveLength(1);
    const v = props[0];
    expect(v.name).toBe("meterVoltageL1");
    expect(v.paramType).toBe(0xac);
    expect(v.type).toBe("number");
    expect(v.provenance).toBe("verified");
    expect(v.writable).toBe(false);
  });

  it("detects capabilities from catalog category + product-code prefix (identity always present)", () => {
    // A smart meter (AE1X0 prefix) → energyMeter, regardless of its "Accessory" category.
    const meter = detectSolixCapabilities({ product_code: "AE1X0EXAMPLE00001" }, "Accessory");
    expect(meter.has("energyMeter")).toBe(true);
    expect(meter.has("identity")).toBe(true);
    expect(meter.has("battery")).toBe(false);

    // A Solarbank (A17C prefix) → battery + solarInput.
    const sb = detectSolixCapabilities({ product_code: "A17C1TESTSERIAL" });
    expect(sb.has("battery")).toBe(true);
    expect(sb.has("solarInput")).toBe(true);

    // A portable power station by category → battery + acOutput + solarInput.
    const ps = detectSolixCapabilities({ product_code: "A1782X" }, "Portable Power Station");
    expect([...ps].sort()).toEqual(["acOutput", "battery", "identity", "solarInput"]);

    // firmware/connectivity gate on record fields.
    const withFields = detectSolixCapabilities({ product_code: "A1782X", device_sw_version: "1.0", wifi_online: true });
    expect(withFields.has("firmware")).toBe(true);
    expect(withFields.has("connectivity")).toBe(true);
  });
});
