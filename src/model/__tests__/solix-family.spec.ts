/**
 * Solix product-family classification tests — pure, offline, deterministic. Classification keys off the
 * product code (catalog-independent) and the catalog category, never a guess.
 */
import { describe, expect, it } from "vitest";

import { solixProductFamily, isSolixPowerStation, isSolixSolarbank, isSolixSmartMeter } from "../solix-family.js";

describe("solixProductFamily", () => {
  it("classifies the smart meter (AE1X0) by product code, catalog-independent", () => {
    expect(solixProductFamily({ product_code: "AE1X0" })).toBe("smartMeter");
    expect(isSolixSmartMeter({ product_code: "AE1X0EXAMPLE00001" })).toBe(true);
    // The meter is never a Solarbank, even though its category can read battery-ish.
    expect(isSolixSolarbank({ product_code: "AE1X0" })).toBe(false);
  });

  it("classifies a Solarbank by its product-code prefix", () => {
    expect(solixProductFamily({ product_code: "A17C1" })).toBe("solarbank"); // Solarbank 2
    expect(solixProductFamily({ product_code: "A1790" })).toBe("solarbank"); // Solarbank E1600 gen-1
    expect(isSolixSolarbank({ product_code: "A17C1" })).toBe(true);
  });

  it("classifies a power station from the catalog category (SOLIX F-series)", () => {
    expect(solixProductFamily({ product_code: "A1782", category: "Portable Power Station" })).toBe("powerStation");
    expect(isSolixPowerStation({ product_code: "A1782", category: "Portable Power Station" })).toBe(true);
    // Without the category the F-series code alone has no prefix set → unknown, never a guess.
    expect(solixProductFamily({ product_code: "A1782" })).toBe("unknown");
  });

  it("maps the remaining catalog categories onto their families", () => {
    expect(solixProductFamily({ product_code: "X", category: "Plug-in Home Battery" })).toBe("solarbank");
    expect(solixProductFamily({ product_code: "X", category: "Power Bank" })).toBe("powerBank");
    expect(solixProductFamily({ product_code: "X", category: "Powered Cooler" })).toBe("cooler");
    expect(solixProductFamily({ product_code: "X", category: "Smart EV Charger" })).toBe("evCharger");
    expect(solixProductFamily({ product_code: "X", category: "Charger" })).toBe("charger");
  });

  it("returns unknown when neither the code nor the category identifies a family", () => {
    expect(solixProductFamily({ product_code: "ZZZ" })).toBe("unknown");
    expect(solixProductFamily({ product_code: "ZZZ", category: "Accessory" })).toBe("unknown");
  });
});
