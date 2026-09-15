/**
 * Anker Solix vendor-JSON record shapes — the cross-layer contract between the transport client (which
 * RETURNS them off the wire) and the model layer (which resolves them into `SolixDevice`). They live in
 * `core` for the same reason the command/media boundary does: the hard `transport ⊥ model` rule forbids
 * either layer importing the other, so a type both need is neither's to own.
 *
 * @module core/solix-types
 */

/** A discovered Solix device record, as returned by `SolixClient.getDevices()`. */
export interface SolixDeviceRecord {
  device_sn: string;
  product_code: string;
  device_name?: string;
  alias_name?: string;
  device_sw_version?: string;
  wifi_online?: boolean;
  wifi_name?: string;
  rssi?: string | number;
  [k: string]: unknown;
}

/** One product in the pairable-product catalog. Extra vendor fields (images, guides) are preserved. */
export interface SolixProduct {
  /** SKU / model code, e.g. `A1782`. */
  product_code: string;
  /** Marketing name, e.g. `SOLIX F3000`. */
  name: string;
  /** Variant/sub-model codes under this product, when present. */
  p_codes?: unknown[];
  [k: string]: unknown;
}

/** A catalog category (e.g. "Portable Power Station") and its products. */
export interface SolixProductCategory {
  name: string;
  products: SolixProduct[];
  [k: string]: unknown;
}
