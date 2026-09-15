import { describe, it, expect } from "vitest";
import { Device, UNKNOWN_PARAM_PREFIX } from "../index.js";
import type { CloudRecord } from "../index.js";

/**
 * A read a device's own gate withheld, and the other door it used to answer.
 *
 * The param dictionary names ids for a whole namespace, and a capability names the same ids for the
 * devices that carry the read — so both name 1101 `battery`, and they disagree only about which device it
 * describes. A mains camera reports 1101 as a sentinel and `notMainsCamera` withholds the typed read; the
 * dictionary then published the same value under the same name, so a caller could not tell it from a
 * charge a device really answered.
 *
 * A capability that never resolved withholds nothing, and its params keep their dictionary name: a
 * reading that arrives before its capability is still the device's own, and a later record widens onto it.
 */
describe("a read withheld by a resolved capability's own gate", () => {
  /** A mains camera: reports 1101 as a sentinel, which is what makes `battery` resolve at all. */
  const mains: CloudRecord = { deviceType: 9, model: "T8425P0000000000", params: { 1101: "100" } };
  /** A battery camera on the same params. */
  const cell: CloudRecord = { deviceType: 9, model: "T8114P0000000000", params: { 1101: "88" } };

  it("takes the passthrough rather than the dictionary name the gate refused", () => {
    const dev = Device.fromRecord("T8425P0000000000", mains);

    expect(dev.capabilities).toContain("battery");
    expect(dev.getProperty("battery")).toBeUndefined();
    expect(dev.getProperty(`${UNKNOWN_PARAM_PREFIX}1101`)?.value).toBe("100");
    expect(dev.battery?.()?.level).toBeUndefined();
  });

  it("answers the same read on a device whose gate allows it", () => {
    const dev = Device.fromRecord("T8114P0000000000", cell);

    expect(dev.getProperty("battery")?.value).toBe(88);
    expect(dev.getProperty(`${UNKNOWN_PARAM_PREFIX}1101`)).toBeUndefined();
  });

  it("keeps the dictionary name where no resolved capability claims the param", () => {
    const dev = Device.fromRecord("T8114P0000000000", cell);

    // 1019 is `enableHdr` in the security dictionary and no capability claims it: nothing decided
    // against it, so the loose read still answers.
    expect(dev.applyParams({ 1019: "1" })).toEqual(["enableHdr"]);
  });
});
