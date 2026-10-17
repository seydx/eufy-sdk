/**
 * Tuya / Thingclips account derivation for a eufy login.
 *
 * The eufy app does NOT exchange a server credential with Tuya. Instead it deterministically
 * derives a Tuya username + password from the eufy account's numeric user id and logs into the
 * Tuya cloud with them (auto-registering that Tuya user on first login). The derivation is the
 * app's `TuyaAccountUtils` under its production (`MP`) environment, which selects the `eh-` prefix:
 *
 *   username = "eh-" + eufyUserId
 *   password = UPPERCASE-HEX( AES-128-CBC-NoPadding( pad16("eh-"+eufyUserId, '0'), KEY, IV ) )
 *
 * where the plaintext is **leading**-zero-padded ('0', 0x30) up to the next multiple of 16 bytes
 * (the app builds the string in `padStart` order — zeros first, string after — wire-confirmed), and
 * KEY / IV are the fixed vectors below.
 */
import { createCipheriv } from "node:crypto";

/**
 * Username/plaintext prefix the app prepends to the eufy user id. The production app uses `eh-`;
 * `eufyhome-` is the prefix of its QA environment only.
 */
export const TUYA_USERNAME_PREFIX = "eh-";

/** AES-128-CBC key used to derive the Tuya password (16 bytes). */
export const TUYA_PASSWORD_KEY = Buffer.from([
  0x24, 0x4e, 0x6d, 0x8a, 0x56, 0xac, 0x87, 0x91, 0x24, 0x43, 0x2d, 0x8b, 0x6c, 0xbc, 0xa2, 0xc4,
]);

/** AES-128-CBC IV used to derive the Tuya password (16 bytes). */
export const TUYA_PASSWORD_IV = Buffer.from([
  0x77, 0x24, 0x56, 0xf2, 0xa7, 0x66, 0x4c, 0xf3, 0x39, 0x2c, 0x35, 0x97, 0xe9, 0x3e, 0x57, 0x47,
]);

/** The Tuya username for a eufy user id (`"eh-" + eufyUserId`). */
export function tuyaUsername(eufyUserId: string): string {
  return TUYA_USERNAME_PREFIX + eufyUserId;
}

/**
 * Pad a UTF-8 string with LEADING '0' (0x30) characters up to the next multiple of 16 bytes.
 * A string whose length is already a multiple of 16 is returned unchanged (NO extra full block —
 * this is character padding to satisfy the no-padding cipher, not PKCS#7).
 * Leading-zero order wire-confirmed from the V6 app.
 */
function zeroPadTo16(s: string): Buffer {
  const buf = Buffer.from(s, "utf-8");
  const rem = buf.length % 16;
  if (rem === 0) return buf;
  return Buffer.concat([Buffer.from("0".repeat(16 - rem), "utf-8"), buf]);
}

/**
 * Derive the Tuya password for a eufy user id:
 * `UPPERCASE-HEX( AES-128-CBC-NoPadding( pad16("eh-"+eufyUserId), KEY, IV ) )`.
 * Deterministic (fixed KEY/IV) — the same user id always yields the same password.
 */
export function deriveTuyaPassword(eufyUserId: string): string {
  const cipher = createCipheriv("aes-128-cbc", TUYA_PASSWORD_KEY, TUYA_PASSWORD_IV);
  cipher.setAutoPadding(false); // input is pre-padded to a 16-byte multiple with '0' chars
  const ct = Buffer.concat([cipher.update(zeroPadTo16(tuyaUsername(eufyUserId))), cipher.final()]);
  return ct.toString("hex").toUpperCase();
}

/**
 * ISO 3166-1 alpha-2 → E.164 numeric dial code for the eufy device markets.
 * Used by {@link isoToDialCode} and {@link resolveCountryCode}.
 */
const ISO_TO_DIAL: Readonly<Record<string, string>> = {
  // Europe
  AT: "43",
  BE: "32",
  BG: "359",
  CH: "41",
  CY: "357",
  CZ: "420",
  DE: "49",
  DK: "45",
  EE: "372",
  ES: "34",
  FI: "358",
  FR: "33",
  GB: "44",
  GR: "30",
  HR: "385",
  HU: "36",
  IE: "353",
  IT: "39",
  LT: "370",
  LU: "352",
  LV: "371",
  MT: "356",
  NL: "31",
  NO: "47",
  PL: "48",
  PT: "351",
  RO: "40",
  RS: "381",
  SE: "46",
  SI: "386",
  SK: "421",
  UA: "380",
  // Americas
  AR: "54",
  BR: "55",
  CA: "1",
  CL: "56",
  CO: "57",
  MX: "52",
  PE: "51",
  US: "1",
  // Asia-Pacific
  AU: "61",
  HK: "852",
  ID: "62",
  IN: "91",
  JP: "81",
  KR: "82",
  MY: "60",
  NZ: "64",
  PH: "63",
  SG: "65",
  TH: "66",
  TW: "886",
  VN: "84",
  // China (own Tuya region)
  CN: "86",
  // Middle East / Africa
  AE: "971",
  EG: "20",
  IL: "972",
  NG: "234",
  RU: "7",
  SA: "966",
  TR: "90",
  ZA: "27",
};

/**
 * Map an ISO 3166-1 alpha-2 country code (e.g. `"GB"`, `"DE"`) to its E.164 numeric dial code.
 * Covers the main eufy device markets. Returns `undefined` for unlisted codes — callers fall back
 * to the region-based heuristic.
 */
export function isoToDialCode(iso: string): string | undefined {
  return ISO_TO_DIAL[iso.toUpperCase().trim()];
}

/**
 * Resolve the Tuya `countryCode` login field. Priority:
 *  1. `phoneCode` — an explicit numeric dial code (e.g. `"49"`) when the caller already has one.
 *  2. `isoCode` — an ISO 3166-1 alpha-2 code (e.g. `"DE"` from `MegaClientConfig.countryCode`) looked up
 *     via {@link isoToDialCode}. Covers the full eufy market range, so a German user on the EU
 *     shard correctly receives `"49"` rather than the coarse region fallback's `"44"`.
 *  3. `region` — coarse mega shard prefix fallback: `"EU"`→`"44"`, `"CN"`→`"86"`, else `"1"`.
 */
export function resolveCountryCode(phoneCode?: string, region?: string, isoCode?: string): string {
  if (phoneCode && phoneCode.trim() !== "") return phoneCode.trim();
  if (isoCode) {
    const dial = isoToDialCode(isoCode);
    if (dial) return dial;
  }
  switch ((region ?? "").split("-")[0].toUpperCase()) {
    case "EU":
      return "44";
    case "CN":
      return "86";
    default:
      return "1";
  }
}

/** A derived Tuya login identity — everything needed to call the uid token/password login actions. */
export interface TuyaAccount {
  /** `"eh-" + eufyUserId`. */
  username: string;
  /** AES-derived password (uppercase hex). See {@link deriveTuyaPassword}. */
  password: string;
  /** Tuya `countryCode` field. See {@link resolveCountryCode}. */
  countryCode: string;
}

/**
 * Derive the full {@link TuyaAccount} (username + password + countryCode) for a eufy user id.
 * `phoneCode` is the eufy account's phone country code; when omitted the countryCode defaults to
 * "1" (see {@link resolveCountryCode} for the region-based fallback).
 */
export function deriveTuyaAccount(eufyUserId: string, phoneCode?: string): TuyaAccount {
  return {
    username: tuyaUsername(eufyUserId),
    password: deriveTuyaPassword(eufyUserId),
    countryCode: resolveCountryCode(phoneCode),
  };
}
