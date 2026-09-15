/**
 * Decoder tests for the Solix telemetry layer, using a REAL ff09 param frame captured live from a
 * Smart Meter Gen 2 (AE1X0) over AWS-IoT MQTT — deterministic, offline, no network.
 */
import { describe, expect, it } from "vitest";

import {
  buildFf09Request,
  decodeSolixParamFrame,
  extractFf09Payload,
  readSolixChannel,
  solixReadings,
} from "../solix-mqtt.js";

// Captured from dt/anker_power/AE1X0/AE1X0EXAMPLE00001/param_info (grid idle; voltage ~237.5 V).
const FRAME_HEX =
  "ff09a00003010f0405a10134a2120041453158304558414d504c453030303031a3020100a6050309000001" +
  "a8050500000000a9050500000000aa050500000000ab050500000000ac050500806d43ad050500000000" +
  "ae050500000000af050500000000b0050500000000b1050500000000b2050500000000b3050500000000" +
  "b4050500000000b5050500000000b6050500000000b7050500000000b802010344";
const FRAME = Buffer.from(FRAME_HEX, "hex");

describe("Solix MQTT param decoding", () => {
  it("parses the ff09 frame's serial and TLV fields", () => {
    const frame = decodeSolixParamFrame(FRAME)!;
    expect(frame.deviceSn).toBe("AE1X0EXAMPLE00001");
    expect(frame.fields.has(0xac)).toBe(true);
    expect(frame.fields.get(0xa1)).toEqual(Buffer.from([0x34]));
  });

  it("rejects a non-ff09 buffer", () => {
    expect(decodeSolixParamFrame(Buffer.from("deadbeef", "hex"))).toBeNull();
  });

  it("reads a float32 channel from a type-0x05 value", () => {
    const ch = readSolixChannel(Buffer.from("0500806d43", "hex"))!;
    expect(ch.type).toBe(0x05);
    expect(ch.float).toBeCloseTo(237.5, 1);
  });

  it("names only the confirmed tag (0xac = meterVoltageL1) and emits every float tag as channel_<hex>", () => {
    const values = solixReadings(decodeSolixParamFrame(FRAME)!);
    expect(values.meterVoltageL1).toBeCloseTo(237.5, 1);
    expect(values["channel_ac"]).toBeCloseTo(237.5, 1);
    // idle channels read 0 and surface raw as channel_<hex>...
    expect(values["channel_a8"]).toBe(0);
    // ...but their inferred name is NOT asserted on the wire until a capture confirms the binding.
    expect(values.meterPowerL1).toBeUndefined();
    // a6 is a non-float type (0x03) → excluded from readings
    expect(values["channel_a6"]).toBeUndefined();
  });

  it("extracts the ff09 payload from the {head, payload:{data}} MQTT envelope", () => {
    const envelope = { head: { cmd: 16 }, payload: JSON.stringify({ device_sn: "x", data: FRAME.toString("base64") }) };
    const buf = extractFf09Payload(envelope)!;
    expect(buf.equals(FRAME)).toBe(true);
    expect(decodeSolixParamFrame(buf)!.deviceSn).toBe("AE1X0EXAMPLE00001");
  });
});

// XOR-of-all-bytes == 0 iff the trailing checksum equals the XOR of every preceding byte — the ff09
// convention. Proven against the two live-captured requestDeviceInfo `data` frames.
const xorAll = (b: Buffer): number => b.reduce((a, x) => a ^ x, 0);

describe("Solix requestDeviceInfo ff09 request builder", () => {
  // From cmd/anker_power/AE1X0/<sn>/req, payload.data (base64), captured live. The fe-nonce carries a
  // unix timestamp at frame offset 14 ('info') / 24 ('realtime'), just before the trailing XOR byte.
  const infoCaptured = Buffer.from("/wkTAAMADwBAoQEi/gSau6NqOQ==", "base64");
  const realtimeCaptured = Buffer.from("/wkdAAMADwBXoQEiogIBAaMDAiwB/gUDmrujag0=", "base64");

  it("the checksum convention matches the real captured arming frames", () => {
    expect(xorAll(infoCaptured)).toBe(0); // trailing byte IS the XOR of all the rest
    expect(xorAll(realtimeCaptured)).toBe(0);
    expect(infoCaptured.subarray(0, 2).toString("hex")).toBe("ff09");
    expect(infoCaptured.readUInt16LE(2)).toBe(infoCaptured.length); // declared len = total bytes
  });

  it("rebuilds the captured arming frames byte-for-byte at their captured timestamps", () => {
    // Inject each capture's own timestamp so the only variable is fixed → full byte-equality settles
    // that the builder reproduces the real frames exactly (not just length/checksum/tag presence).
    expect(buildFf09Request("info", infoCaptured.readUInt32LE(14)).equals(infoCaptured)).toBe(true);
    expect(buildFf09Request("realtime", realtimeCaptured.readUInt32LE(24)).equals(realtimeCaptured)).toBe(true);
  });

  it("builds a well-formed 'info' request (a1=0x22, valid ff09 + checksum)", () => {
    const f = buildFf09Request("info");
    expect(f.subarray(0, 2).toString("hex")).toBe("ff09");
    expect(f.readUInt16LE(2)).toBe(f.length); // len field = total frame bytes
    expect(f.length).toBe(19); // same size as the captured 'info' frame
    expect(xorAll(f)).toBe(0); // checksum valid
    expect(f.includes(Buffer.from([0xa1, 0x01, 0x22]))).toBe(true); // request-type tag
  });

  it("builds a well-formed 'realtime' request (extra a2/a3 params)", () => {
    const f = buildFf09Request("realtime");
    expect(f.subarray(0, 2).toString("hex")).toBe("ff09");
    expect(f.readUInt16LE(2)).toBe(f.length);
    expect(f.length).toBe(29); // same size as the captured 'realtime' frame
    expect(xorAll(f)).toBe(0);
    expect(f.includes(Buffer.from([0xa1, 0x01, 0x22]))).toBe(true);
    expect(f.includes(Buffer.from([0xa2, 0x02, 0x01, 0x01]))).toBe(true);
    expect(f.includes(Buffer.from([0xa3, 0x03, 0x02, 0x2c, 0x01]))).toBe(true);
  });
});
