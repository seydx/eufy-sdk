import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanEntropy } from "../jpeg-scan.js";

/** Every fixture is FULLY SYNTHETIC (no captured device data / real serials). */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) => Buffer.from(readFileSync(join(FIXTURE_DIR, name), "utf-8"), "base64");

/** The first plaintext byte of a v2 tail — the standard DC-chrominance Huffman table. */
const DC_CHROMA = Buffer.from([0xff, 0xc4, 0x00, 0x1f, 0x01]);
const tailOf = (blob: Buffer) => blob.subarray(blob.indexOf(DC_CHROMA));

/**
 * The luma Huffman tables, which a v2 tail does NOT carry — they go with the encrypted head, and the
 * reconstruction supplies the standard ones (Annex K.3). Same segments the decoder splices in.
 */
const DHT_DC_LUMA = Buffer.from("ffc4001f0000010501010101010100000000000000000102030405060708090a0b", "hex");
const DHT_AC_LUMA = Buffer.from(
  "ffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c1" +
    "1552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768" +
    "696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7" +
    "c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa",
  "hex",
);
const LUMA_TABLES = [DHT_DC_LUMA, DHT_AC_LUMA];

const scan = (blob: Buffer, subsampling: number) => scanEntropy(tailOf(blob), subsampling, LUMA_TABLES);

describe("scanEntropy", () => {
  it("counts the MCUs a 4:4:4 scan carries, and nothing else completes", () => {
    const blob = readFixture("v2_thumbnail_176x144.b64");
    // 176×144 at 4:4:4 is 22×18 MCUs of 8×8.
    expect(scan(blob, 0)).toMatchObject({ mcus: 396, complete: true });
    expect(scan(blob, 1)!.complete).toBe(false);
    expect(scan(blob, 2)!.complete).toBe(false);
  });

  it("counts the MCUs a 4:2:0 scan carries, and nothing else completes", () => {
    const blob = readFixture("v2_thumbnail_320x240_420.b64");
    // 320×240 at 4:2:0 is 20×15 MCUs of 16×16.
    expect(scan(blob, 2)).toMatchObject({ mcus: 300, complete: true });
    expect(scan(blob, 0)!.complete).toBe(false);
    expect(scan(blob, 1)!.complete).toBe(false);
  });

  it("reports one luma DC per MCU, in scan order", () => {
    const result = scan(readFixture("v2_thumbnail_176x144.b64"), 0)!;
    expect(result.luma).toHaveLength(result.mcus);
    // A real picture, not a constant: the fixture is a gradient, so neighbouring MCUs differ.
    expect(new Set(result.luma).size).toBeGreaterThan(10);
  });

  it("stops where a truncated scan stops, without throwing and without claiming completeness", () => {
    const blob = readFixture("v2_thumbnail_176x144.b64");
    const cut = scan(blob.subarray(0, blob.length - 400), 0)!;
    expect(cut.complete).toBe(false);
    expect(cut.mcus).toBeGreaterThan(0);
    expect(cut.mcus).toBeLessThan(396);
  });

  it("answers null for bytes that are not a baseline scan", () => {
    expect(scanEntropy(Buffer.from("no jpeg here at all"), 0, LUMA_TABLES)).toBeNull();
    // A tail whose Huffman tables are missing cannot be walked either.
    expect(scanEntropy(tailOf(readFixture("v2_thumbnail_176x144.b64")), 0, [])).toBeNull();
  });
});
