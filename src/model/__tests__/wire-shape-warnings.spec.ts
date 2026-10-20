import { describe, expect, it, vi } from "vitest";
import { Device } from "../device.js";
import type { Logger } from "../../core/logger.js";
import type { CommandSink } from "../../core/contracts.js";

/**
 * Two params whose wire value is not the number the dictionary used to declare, so each refresh logged
 * a numeric-mismatch warning. 1298 (`aiDetectType`) arrives as a bare bitmask on a camera and as a JSON
 * object carrying it under `ai_detect_type` behind an NVR-class hub; clean-line DP 155 (`direction`)
 * carries a direction word. The payloads below are synthetic.
 */

const spy = (): { logger: Logger; warn: ReturnType<typeof vi.fn> } => {
  const warn = vi.fn();
  return { logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }, warn };
};

const noopSink: CommandSink = { dispatch: async () => undefined };

const camera = (wire: string | number, logger: Logger): Device => {
  const dev = Device.fromRecord("T8000P0000000000", { deviceType: 9, model: "T8114" }, logger);
  dev.applyParams({ 1298: wire });
  dev.bindActions({ channel: 0, codec: "camera", paramIds: new Set([1298]) }, noopSink);
  return dev;
};

describe("aiDetectType (1298) in both wire shapes", () => {
  it("reads the bitmask out of the JSON object form, without a warning", () => {
    const { logger, warn } = spy();
    const wire = JSON.stringify({
      ai_detect_type: 0x3000b,
      ai_switch: 1,
      ai_notification: 0,
      ai_use_global: 0,
      channel: 2,
    });

    const dev = camera(wire, logger);

    expect(dev.motion?.()?.aiDetectType).toBe(0x3000b);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["a cloud string", "196623"],
    ["a P2P number", 0x3000f],
  ])("reads the bare bitmask (%s)", (_label, wire) => {
    const { logger, warn } = spy();

    expect(camera(wire, logger).motion?.()?.aiDetectType).toBe(0x3000f);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("clean-line direction (DP 155)", () => {
  it("stores the direction word as a string, without a warning", () => {
    const { logger, warn } = spy();
    const dev = Device.fromRecord("T2351VAC", { model: "T2351", params: { 155: "Brake" } }, logger);

    expect(dev.getProperty("direction")?.value).toBe("Brake");
    expect(warn).not.toHaveBeenCalled();
  });
});
