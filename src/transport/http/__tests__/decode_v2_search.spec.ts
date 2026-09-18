import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The reconstruction's COST, which the output specs cannot see.
 *
 * Those specs check that the right picture comes out, and would still pass if it were reached by
 * decoding every frame on a ladder and re-encoding the result. It once was, and the bill was a
 * memory-capped caller's whole budget: recovering a 176×144 thumbnail meant ~30 candidate decodes and
 * one `jpeg-js` encode, and measured RSS moved **45 MB per thumbnail and did not come back** (glibc
 * keeps the arenas). An embedded host that allows an app tens of megabytes over its idle footprint
 * killed it on the first detection push that carried a thumbnail.
 *
 * Both halves of that bill are properties of this module, so both are pinned here:
 *   - the geometry search decodes NOTHING — it reads the entropy scan (`jpeg-scan.ts`);
 *   - the answer is the camera's own scan under a rewritten header, so nothing is ever re-encoded.
 *
 * Counting `jpeg-js` calls rather than timing or sampling RSS: the property is "this module decodes one
 * frame and encodes none", which is exact, where a stopwatch or an allocator on a shared CI host is not.
 */
vi.mock("jpeg-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jpeg-js")>();
  return { ...actual, decode: vi.fn(actual.decode), encode: vi.fn(actual.encode) };
});

const { decode, encode } = await import("jpeg-js");
const { decodeImageV2 } = await import("../decodeImageV2.js");

/** Every fixture is FULLY SYNTHETIC (no captured device data / real serials). */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) => Buffer.from(readFileSync(join(FIXTURE_DIR, name), "utf-8"), "base64");

describe("v2 reconstruction cost", () => {
  beforeEach(() => {
    vi.mocked(decode).mockClear();
    vi.mocked(encode).mockClear();
  });

  it.each([
    "v2_thumbnail_176x144.b64",
    "v2_thumbnail_264x200.b64",
    "v2_thumbnail_320x240_420.b64",
    "v2_thumbnail_176x144_q30.b64",
  ])("decodes one frame and encodes none (%s)", (fixture) => {
    expect(decodeImageV2(readFixture(fixture))).not.toBeNull();

    // One decode: the probe that proves the spliced JPEG decodes and measures the contrast correction.
    expect(vi.mocked(decode)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(encode)).not.toHaveBeenCalled();
  });

  it("decodes nothing at all when no geometry explains the scan", () => {
    const blob = readFixture("v2_thumbnail_176x144.b64");
    expect(decodeImageV2(blob.subarray(0, blob.length - 400))).toBeNull();
    expect(vi.mocked(decode)).not.toHaveBeenCalled();
  });
});
