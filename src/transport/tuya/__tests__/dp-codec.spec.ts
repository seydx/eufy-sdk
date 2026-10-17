import { describe, it, expect, vi } from "vitest";
import { parseTuyaDpEvent, TuyaDpRouter } from "../dp-codec.js";
import type { TuyaDpInbound } from "../../../core/contracts.js";

describe("parseTuyaDpEvent", () => {
  it("parses a valid string-keyed DP map to numeric keys", () => {
    expect(parseTuyaDpEvent({ "104": 80, "106": 0 })).toEqual({ 104: 80, 106: 0 });
  });

  it("passes through boolean values", () => {
    expect(parseTuyaDpEvent({ "2": true, "101": false })).toEqual({ 2: true, 101: false });
  });

  it("passes through string values", () => {
    expect(parseTuyaDpEvent({ "15": "standby", "102": "Standard" })).toEqual({
      15: "standby",
      102: "Standard",
    });
  });

  it("handles a mix of value types", () => {
    expect(parseTuyaDpEvent({ "2": true, "104": 75, "15": "cleaning" })).toEqual({
      2: true,
      104: 75,
      15: "cleaning",
    });
  });

  it("returns null for null input", () => {
    expect(parseTuyaDpEvent(null)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseTuyaDpEvent("string")).toBeNull();
    expect(parseTuyaDpEvent(42)).toBeNull();
    expect(parseTuyaDpEvent(true)).toBeNull();
  });

  it("returns null for an array", () => {
    expect(parseTuyaDpEvent(["a", "b"])).toBeNull();
  });

  it("returns null for an empty object", () => {
    expect(parseTuyaDpEvent({})).toBeNull();
  });

  it("returns null when a key is not a positive integer string", () => {
    expect(parseTuyaDpEvent({ "0": 1 })).toBeNull();
    expect(parseTuyaDpEvent({ "-1": 1 })).toBeNull();
    expect(parseTuyaDpEvent({ "1.5": 1 })).toBeNull();
    expect(parseTuyaDpEvent({ notAnInt: 1 })).toBeNull();
  });

  it("returns null when a value is null", () => {
    expect(parseTuyaDpEvent({ "104": null })).toBeNull();
  });

  it("returns null when a value is an object", () => {
    expect(parseTuyaDpEvent({ "104": { nested: true } })).toBeNull();
  });

  it("returns null when a value is an array", () => {
    expect(parseTuyaDpEvent({ "104": [1, 2] })).toBeNull();
  });
});

describe("TuyaDpRouter", () => {
  it("delivers parsed DPs to the registered listener", () => {
    const router = new TuyaDpRouter();
    const onDps = vi.fn();
    const listener: TuyaDpInbound = { onDps };
    router.setListener(listener);
    router.deliver("T8000P0000000000", { "104": 80, "106": 0 });
    expect(onDps).toHaveBeenCalledWith("T8000P0000000000", { 104: 80, 106: 0 });
  });

  it("drops a malformed payload without calling the listener", () => {
    const router = new TuyaDpRouter();
    const onDps = vi.fn();
    router.setListener({ onDps });
    router.deliver("T8000P0000000000", null);
    router.deliver("T8000P0000000000", { "0": 1 });
    expect(onDps).not.toHaveBeenCalled();
  });

  it("does nothing when no listener is registered", () => {
    const router = new TuyaDpRouter();
    expect(() => router.deliver("T8000P0000000000", { "104": 80 })).not.toThrow();
  });

  it("replaces an existing listener when setListener is called again", () => {
    const router = new TuyaDpRouter();
    const first = vi.fn();
    const second = vi.fn();
    router.setListener({ onDps: first });
    router.setListener({ onDps: second });
    router.deliver("T8000P0000000000", { "2": true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("T8000P0000000000", { 2: true });
  });
});
