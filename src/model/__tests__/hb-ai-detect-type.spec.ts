import { describe, expect, it, vi } from "vitest";
import { Device } from "../device.js";
import type { Logger } from "../../core/logger.js";
import type { CloudRecord } from "../types.js";

/**
 * Param 1299 (`hbAiDetectType`) answers in two shapes. A camera sends a bare `1`; a HomeBase S1 Pro
 * (T9000) sends a JSON envelope. Declared as a number, the envelope tripped the numeric check and warned
 * on every poll. JSON-decoded, each shape is kept as what it is and neither is a mismatch.
 */

const spy = (): { logger: Logger; warn: ReturnType<typeof vi.fn> } => {
  const warn = vi.fn();
  return { logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }, warn };
};

const ENVELOPE = '{"ai_switch":1,"smart_detection":196623,"devlist":[{"channel":0,"smart_detection":3}]}';

const station = (wire: string): CloudRecord => ({ deviceType: 0, model: "T9000", params: { 1299: wire } });

describe("hbAiDetectType (1299)", () => {
  it("keeps a station's JSON envelope as an object, without a warning", () => {
    const { logger, warn } = spy();
    const dev = Device.fromRecord("T9000P0000000001", station(ENVELOPE), logger);

    expect(dev.getProperty("hbAiDetectType")?.value).toEqual({
      ai_switch: 1,
      smart_detection: 196623,
      devlist: [{ channel: 0, smart_detection: 3 }],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["a cloud string", "1"],
    ["a P2P number", 1],
  ])("decodes a camera's scalar (%s) to the number 1", (_label, wire) => {
    const { logger, warn } = spy();
    const dev = Device.fromRecord("T8114P0000000001", { deviceType: 9, model: "T8114" }, logger);

    dev.applyParams({ 1299: wire });

    expect(dev.getProperty("hbAiDetectType")?.value).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
