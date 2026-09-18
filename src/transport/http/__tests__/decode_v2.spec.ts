import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decode as jpegDecode } from "jpeg-js";
import { decodeImageV2, isV2Image } from "../decodeImageV2.js";
import { normalizePushImage } from "../decodeImageV1.js";

/** Every fixture is FULLY SYNTHETIC (no captured device data / real serials). Regenerate with `scripts/dev/gen_v2_fixture.py <w> <h> <out.b64> [quality] [subsampling]`. */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) => Buffer.from(readFileSync(join(FIXTURE_DIR, name), "utf-8"), "base64");
const v2Blob = readFixture("v2_thumbnail_176x144.b64");
/** Synthetic non-ladder geometry (264×200 was never a rung on the old coarse ladder). */
const v2Blob264 = readFixture("v2_thumbnail_264x200.b64");

/** Read a baseline JPEG's SOF0 dimensions, to check the reconstructed geometry. */
function jpegSize(jpeg: Buffer): { width: number; height: number } {
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  return { height: (jpeg[sof + 5] << 8) | jpeg[sof + 6], width: (jpeg[sof + 7] << 8) | jpeg[sof + 8] };
}

/** Per-channel range and mean of a decoded RGBA image. */
function channels(img: { width: number; height: number; data: Uint8Array }) {
  const n = img.width * img.height;
  return [0, 1, 2].map((channel) => {
    let min = 255;
    let max = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = img.data[i * 4 + channel]!;
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
    }
    return { min, max, mean: sum / n };
  });
}

/**
 * The picture the fixture was built from.
 *
 * A synthetic fixture's head is a PLAIN baseline JPEG (the generator does not obfuscate it), so the
 * original image is right there to compare a reconstruction against — which is a stronger statement
 * than a pinned number: the reconstruction is not merely stable, it reproduces the source.
 */
function original(blob: Buffer) {
  return jpegDecode(blob.subarray(blob.indexOf(Buffer.from([0xff, 0xd8]))), { useTArray: true });
}

describe("decodeImageV2 (keyless v2_eufysecurity)", () => {
  it("recognises a v2 blob and rejects v1/other/near-miss prefixes", () => {
    expect(isV2Image(v2Blob)).toBe(true);
    expect(isV2Image(Buffer.from("eufysecurity:T8:CODE:xxxx"))).toBe(false);
    expect(isV2Image(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(isV2Image(Buffer.from("v2_eufysecurityX:garbage"))).toBe(false);
  });

  it("reconstructs a decodable JPEG at the original geometry", () => {
    const jpeg = decodeImageV2(v2Blob);
    expect(jpeg).not.toBeNull();
    expect(jpeg!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpegSize(jpeg!)).toEqual({ width: 176, height: 144 });
  });

  it("recovers an off-ladder geometry from a synthetic blob (264×200)", () => {
    const jpeg = decodeImageV2(v2Blob264);
    expect(jpeg).not.toBeNull();
    expect(jpeg!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpeg!.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(jpegSize(jpeg!)).toEqual({ width: 264, height: 200 });
  });

  it("recovers 4:2:0 chroma subsampling, whose MCU is 16×16 rather than 8×8", () => {
    const jpeg = decodeImageV2(readFixture("v2_thumbnail_320x240_420.b64"));
    expect(jpeg).not.toBeNull();
    expect(jpegSize(jpeg!)).toEqual({ width: 320, height: 240 });
    // 0x22 luma sampling factors in the reconstructed SOF0 — a 4:4:4 header would read 0x11 and the
    // picture would be scrambled rather than merely mis-sized.
    const sof = jpeg!.indexOf(Buffer.from([0xff, 0xc0]));
    expect(jpeg![sof + 11]).toBe(0x22);
  });

  it("returns null for a non-v2 blob", () => {
    expect(decodeImageV2(Buffer.from("not a v2 image"))).toBeNull();
  });

  it("returns null when the plaintext tail is not there to splice onto", () => {
    expect(decodeImageV2(Buffer.from("v2_eufysecurity:T8000TEST00000002:0000000000:no jpeg here"))).toBeNull();
  });

  it("returns null rather than a scrambled picture when the scan is truncated mid-MCU", () => {
    expect(decodeImageV2(v2Blob.subarray(0, v2Blob.length - 400))).toBeNull();
  });

  it("normalizePushImage routes a v2 blob through the decoder", () => {
    const out = normalizePushImage(v2Blob);
    expect(out.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpegSize(out)).toEqual({ width: 176, height: 144 });
  });

  it("normalizePushImage leaves non-wrapped media unchanged", () => {
    const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(normalizePushImage(plain)).toBe(plain);
  });
});

describe("decodeImageV2 reproduces the source picture", () => {
  for (const { file, width, height } of [
    { file: "v2_thumbnail_176x144.b64", width: 176, height: 144 },
    { file: "v2_thumbnail_264x200.b64", width: 264, height: 200 },
    { file: "v2_thumbnail_320x240_420.b64", width: 320, height: 240 },
  ]) {
    it(`matches the original image's tones for ${file}`, () => {
      const blob = readFixture(file);
      const out = decodeImageV2(blob);
      expect(out).not.toBeNull();
      const got = jpegDecode(out!, { useTArray: true });
      expect({ width: got.width, height: got.height }).toEqual({ width, height });

      // Within a point of the source on every channel: the scan is the camera's own, so the only thing
      // a reconstruction can get wrong is the tables it reads that scan through.
      const before = channels(original(blob));
      const after = channels(got);
      for (let channel = 0; channel < 3; channel++) {
        expect(after[channel]!.mean).toBeCloseTo(before[channel]!.mean, 0);
        expect(after[channel]!.min).toBeLessThanOrEqual(8);
        expect(after[channel]!.max).toBeGreaterThanOrEqual(247);
      }
    });
  }
});

describe("decodeImageV2 contrast recovery (the lost quant tables)", () => {
  /**
   * The camera's quant tables go with the encrypted head, so the reconstruction reads the scan through
   * substitute tables — and a thumbnail encoded well below their quality decodes washed out ("foggy").
   * This fixture is quality 30 against a reference table of 85: spliced as-is it spans about 103..152
   * of the 0..255 range. The decoder measures that and rewrites the DQT, which is a contrast correction
   * that costs a header rather than a re-encoded picture.
   */
  it("opens a low-quality thumbnail back up to the source's range", () => {
    const blob = readFixture("v2_thumbnail_176x144_q30.b64");
    const out = decodeImageV2(blob);
    expect(out).not.toBeNull();

    const before = channels(original(blob));
    const after = channels(jpegDecode(out!, { useTArray: true }));
    for (let channel = 0; channel < 3; channel++) {
      expect(after[channel]!.max - after[channel]!.min).toBeGreaterThan(240);
      // Within two points of the source's mean. Not to the decimal: the recovered stretch names a
      // quality (31 for this fixture's 30), and the tables at that quality are not the camera's own.
      expect(Math.abs(after[channel]!.mean - before[channel]!.mean)).toBeLessThan(2);
    }
  });

  it("leaves a thumbnail that already spans the range alone", () => {
    const jpeg = decodeImageV2(v2Blob)!;
    // Quality 85 tables, unmodified: the DQT is the reference one, not a stretched one.
    const dqt = jpeg.indexOf(Buffer.from([0xff, 0xdb]));
    expect(jpeg[dqt + 5]).toBe(5); // Annex-K luma DC (16) scaled to quality 85
  });
});
