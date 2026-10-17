import {
  deriveTuyaAccount,
  deriveTuyaPassword,
  isoToDialCode,
  tuyaUsername,
  resolveCountryCode,
  TUYA_PASSWORD_KEY,
  TUYA_PASSWORD_IV,
} from "../account.js";

describe("Tuya account derivation", () => {
  it("prefixes the eufy user id for the username", () => {
    expect(tuyaUsername("12345")).toBe("eh-12345");
  });

  it("key and iv are the fixed 16-byte AES vectors", () => {
    expect(TUYA_PASSWORD_KEY).toHaveLength(16);
    expect(TUYA_PASSWORD_IV).toHaveLength(16);
    expect(TUYA_PASSWORD_KEY.toString("hex")).toBe("244e6d8a56ac879124432d8b6cbca2c4");
    expect(TUYA_PASSWORD_IV.toString("hex")).toBe("772456f2a7664cf3392c3597e93e5747");
  });

  it("derives the password as uppercase-hex AES-128-CBC-NoPadding (golden vectors)", () => {
    // "eh-12345" is 8 chars → leading-zero-padded to 16 before the cipher.
    expect(deriveTuyaPassword("12345")).toBe("7E47F843AA735A651009E482905388B3");
    // "eh-1234567890abcdef" is 19 chars → padded to 32 (two blocks).
    expect(deriveTuyaPassword("1234567890abcdef")).toBe(
      "40B9941CB7740BAEFC22D226666A4CD19542C8F67924B41E872430B0FE116E0D",
    );
  });

  it("password is deterministic (same id → same password)", () => {
    expect(deriveTuyaPassword("42")).toBe(deriveTuyaPassword("42"));
  });

  it("password length is a multiple of 32 hex chars (16-byte blocks)", () => {
    expect(deriveTuyaPassword("12345").length % 32).toBe(0);
    expect(deriveTuyaPassword("1234567890abcdef").length % 32).toBe(0);
  });

  it("isoToDialCode maps common ISO codes to their E.164 dial code", () => {
    expect(isoToDialCode("GB")).toBe("44");
    expect(isoToDialCode("DE")).toBe("49");
    expect(isoToDialCode("NL")).toBe("31");
    expect(isoToDialCode("US")).toBe("1");
    expect(isoToDialCode("AU")).toBe("61");
    expect(isoToDialCode("CN")).toBe("86");
    expect(isoToDialCode("SG")).toBe("65");
  });

  it("isoToDialCode is case-insensitive and returns undefined for unknown codes", () => {
    expect(isoToDialCode("de")).toBe("49");
    expect(isoToDialCode("Gb")).toBe("44");
    expect(isoToDialCode("XX")).toBeUndefined();
  });

  it("resolveCountryCode: explicit phoneCode > ISO code > region fallback", () => {
    expect(resolveCountryCode("49")).toBe("49"); // explicit phoneCode
    expect(resolveCountryCode("  33 ")).toBe("33"); // trimmed phoneCode
    expect(resolveCountryCode(undefined, "EU", "DE")).toBe("49"); // ISO beats EU→44
    expect(resolveCountryCode(undefined, undefined, "SG")).toBe("65"); // ISO, no region
    expect(resolveCountryCode(undefined, "EU")).toBe("44"); // region fallback (no ISO)
    expect(resolveCountryCode(undefined, "eu-pr")).toBe("44"); // real shard string — split before compare
    expect(resolveCountryCode(undefined, "us-pr")).toBe("1"); // us-pr → "US" → fallback "1"
    expect(resolveCountryCode("", "CN")).toBe("86"); // empty phoneCode → region
    expect(resolveCountryCode(undefined, "US")).toBe("1");
    expect(resolveCountryCode()).toBe("1");
  });

  it("deriveTuyaAccount assembles username + password + countryCode", () => {
    const acct = deriveTuyaAccount("12345", "44");
    expect(acct).toEqual({
      username: "eh-12345",
      password: "7E47F843AA735A651009E482905388B3",
      countryCode: "44",
    });
  });

  it("deriveTuyaAccount defaults countryCode to '1' without a phoneCode", () => {
    expect(deriveTuyaAccount("12345").countryCode).toBe("1");
  });
});
