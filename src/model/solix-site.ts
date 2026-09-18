/**
 * A capability-driven model for an Anker Solix **site** — the account's home energy system, the "My
 * Home" the app shows. A site is the Solix analogue of a eufy HomeBase in its GROUPING role: it is the
 * system that member devices belong to, so it is what a caller reaches for to ask "what's in this
 * system" and to sort the members by family ({@link SolixSite.powerStations} / {@link solarbanks} /
 * {@link smartMeters}) or by capability ({@link SolixSite.withCapability}).
 *
 * A site is a *grouping*, not a device: it carries no telemetry of its own. Its members are full
 * {@link SolixDevice} models (each with its own capabilities + live telemetry), resolved by
 * {@link discoverSolixSites} from the site record's member list joined to the account's device records.
 * The realtime SYSTEM aggregate the app draws (instantaneous battery SoC + solar + grid flow) is not
 * modelled here: it has no confirmed, stable read surface for the current device generation, and this
 * layer does not fabricate a getter for a value it cannot ground — a caller reads each member device's
 * telemetry instead.
 */
import { SolixDevice, resolveSolixCatalog, type SolixDeviceReader } from "./solix-device.js";
import type { SolixProductFamily } from "./solix-family.js";
import type { SolixCapability } from "./capabilities/solix.js";
import type { SolixDeviceRecord, SolixProductCategory, SolixSiteRecord } from "../core/solix-types.js";

/**
 * The minimum a client must offer to discover an account's SITES against — {@link SolixDeviceReader}
 * (the device + catalog reads {@link discoverSolixDevices} already composes) plus the site read.
 * Structural (not `SolixClient`) so the model layer never imports the transport client: the hard
 * `transport ⊥ model` rule forbids it, and a structural shape needs no import.
 */
export interface SolixSiteReader extends SolixDeviceReader {
  getSites(): Promise<SolixSiteRecord[]>;
}

/** Options for {@link SolixSite} / {@link discoverSolixSites} — the same catalog the device model takes. */
export interface SolixSiteOptions {
  catalog?: SolixProductCategory[];
}

/**
 * A discovered Solix site with its member devices resolved to {@link SolixDevice} models. Build one
 * directly from a record + members, or discover an account's sites with {@link discoverSolixSites}.
 */
export class SolixSite {
  readonly id: string;
  /** Friendly site name (e.g. "My Home"), or the site id when the record carries none. */
  readonly name: string;
  /** Anker's site-type discriminator (e.g. 20 for a Solarbank-anchored home system), when present. */
  readonly powerSiteType?: number;
  readonly record: SolixSiteRecord;
  readonly devices: SolixDevice[];

  constructor(record: SolixSiteRecord, devices: SolixDevice[]) {
    this.record = record;
    this.id = record.site_id;
    this.name = record.site_name || record.site_id;
    this.powerSiteType = record.power_site_type;
    this.devices = devices;
  }

  /** The member device with this serial, if it belongs to the site. */
  device(serial: string): SolixDevice | undefined {
    return this.devices.find((d) => d.serial === serial);
  }

  /** Member devices of a given product {@link SolixProductFamily} — the grouping accessor. */
  withFamily(family: SolixProductFamily): SolixDevice[] {
    return this.devices.filter((d) => d.family === family);
  }

  /** Member devices that carry a given capability (e.g. every `battery` in the system). */
  withCapability(capability: SolixCapability): SolixDevice[] {
    return this.devices.filter((d) => d.has(capability));
  }

  /** The Solarbank / plug-in home-battery members of the system. */
  solarbanks(): SolixDevice[] {
    return this.withFamily("solarbank");
  }

  /** The smart-meter (grid-CT) members of the system. */
  smartMeters(): SolixDevice[] {
    return this.withFamily("smartMeter");
  }

  /** The portable power-station members of the system. */
  powerStations(): SolixDevice[] {
    return this.withFamily("powerStation");
  }
}

/**
 * Discover an account's Solix sites as {@link SolixSite} groupings of capability-driven
 * {@link SolixDevice} members — the site analogue of {@link discoverSolixDevices}. Composes three wire
 * reads (the sites, the account's device records, the product catalog) entirely model-side, so the
 * transport client is passed structurally and the layers stay decorrelated.
 *
 * A site member is resolved to its FULL device record from `getDevices()` when the account lists one
 * (so the member carries firmware/connectivity + telemetry identity); a member the flat device list
 * omits is built from the site entry alone (serial + product code + name), so the system is never
 * missing a device it declares.
 */
export async function discoverSolixSites(client: SolixSiteReader, opts: SolixSiteOptions = {}): Promise<SolixSite[]> {
  const [sites, records, catalog] = await Promise.all([
    client.getSites(),
    client.getDevices(),
    resolveSolixCatalog(client, opts),
  ]);
  const bySerial = new Map(records.map((r) => [r.device_sn, r]));
  return sites.map((site) => {
    const members = (site.site_device_list ?? []).map((entry) => {
      const record: SolixDeviceRecord = bySerial.get(entry.device_sn) ?? {
        device_sn: entry.device_sn,
        product_code: entry.device_model,
        device_name: entry.device_name,
      };
      return new SolixDevice(record, { catalog });
    });
    return new SolixSite(site, members);
  });
}
