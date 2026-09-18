/**
 * SolixSite discovery + grouping tests. `discoverSolixSites` is exercised against a STRUCTURAL fake of
 * the wire client (never the real `SolixClient`), which is what proves the model↔transport decorrelation
 * — a fake would be impossible to write if the model imported the transport. Offline, deterministic.
 */
import { describe, expect, it } from "vitest";

import { SolixSite, discoverSolixSites, type SolixSiteReader } from "../solix-site.js";
import type { SolixDeviceRecord, SolixProductCategory, SolixSiteRecord } from "../../core/solix-types.js";

const CATALOG: SolixProductCategory[] = [
  { name: "Plug-in Home Battery", products: [{ product_code: "AE103", name: "Solarbank 4 E5000 Pro" }] },
  { name: "Accessory", products: [{ product_code: "AE1X0", name: "Smart Meter Gen 2" }] },
  { name: "Portable Power Station", products: [{ product_code: "A1782", name: "SOLIX F3000" }] },
];

const SOLARBANK: SolixDeviceRecord = {
  device_sn: "SB0000000000EXAMPLE",
  product_code: "AE103",
  device_name: "Solarbank 4 E5000 Pro",
  device_sw_version: "V1.2.3",
  wifi_online: true,
};
const METER: SolixDeviceRecord = {
  device_sn: "MTR000000000EXAMPLE",
  product_code: "AE1X0",
  device_name: "Smart Meter Gen 2",
};

const SITE: SolixSiteRecord = {
  site_id: "site-0001",
  site_name: "My Home",
  power_site_type: 20,
  site_device_list: [
    { device_sn: SOLARBANK.device_sn, device_model: "AE103", device_name: "Solarbank 4 E5000 Pro", device_type: 3 },
    { device_sn: METER.device_sn, device_model: "AE1X0", device_name: "Smart Meter Gen 2", device_type: 6 },
  ],
};

/** A structural stand-in for the transport SolixClient — discoverSolixSites never imports it. */
const reader: SolixSiteReader = {
  getSites: async (): Promise<SolixSiteRecord[]> => [SITE],
  getDevices: async (): Promise<SolixDeviceRecord[]> => [SOLARBANK, METER],
  getProductCatalog: async (): Promise<SolixProductCategory[]> => CATALOG,
};

describe("discoverSolixSites", () => {
  it("resolves a site's identity and its member devices", async () => {
    const [site] = await discoverSolixSites(reader);
    expect(site.id).toBe("site-0001");
    expect(site.name).toBe("My Home");
    expect(site.powerSiteType).toBe(20);
    expect(site.devices.map((d) => d.serial).sort()).toEqual([METER.device_sn, SOLARBANK.device_sn].sort());
  });

  it("groups members by product family (the HomeBase-like grouping)", async () => {
    const [site] = await discoverSolixSites(reader);
    expect(site.solarbanks().map((d) => d.serial)).toEqual([SOLARBANK.device_sn]);
    expect(site.smartMeters().map((d) => d.serial)).toEqual([METER.device_sn]);
    expect(site.powerStations()).toEqual([]);
  });

  it("groups members by capability, and looks one up by serial", async () => {
    const [site] = await discoverSolixSites(reader);
    // Only the Solarbank carries `battery`; the meter does not (a Plug-in Home Battery also carries a
    // built-in `energyMeter`, so battery is the cleaner discriminator between the two members).
    expect(site.withCapability("battery").map((d) => d.serial)).toEqual([SOLARBANK.device_sn]);
    expect(site.device(SOLARBANK.device_sn)?.identity().name).toBe("Solarbank 4 E5000 Pro");
    expect(site.device("nope")).toBeUndefined();
  });

  it("resolves a member from its full device record (carries firmware), not just the site entry", async () => {
    const [site] = await discoverSolixSites(reader);
    // The Solarbank's firmware is on the flat device record, not the site entry — a member resolved from
    // the site entry alone would lack it, so this proves the join to getDevices().
    expect(site.device(SOLARBANK.device_sn)?.firmware()).toEqual({ version: "V1.2.3" });
  });

  it("still includes a declared member the flat device list omits (built from the site entry alone)", async () => {
    const partial: SolixSiteReader = { ...reader, getDevices: async () => [METER] }; // Solarbank missing from the flat list
    const [site] = await discoverSolixSites(partial);
    const sb = site.device(SOLARBANK.device_sn);
    expect(sb).toBeDefined();
    expect(sb!.productCode).toBe("AE103");
    expect(sb!.identity().name).toBe("Solarbank 4 E5000 Pro"); // still catalog-resolved
  });

  it("constructs directly from a record + members without discovery", () => {
    const site = new SolixSite({ site_id: "s2" }, []);
    expect(site.id).toBe("s2");
    expect(site.name).toBe("s2"); // falls back to the id when the record names none
    expect(site.devices).toEqual([]);
  });
});
