import { decode as jpegDecode, encode as jpegEncode } from "jpeg-js";
import { decodeImageV2 } from "../decodeImageV2.js";

/**
 * A v2 blob whose encrypted prefix also covers the chroma Huffman tables, so the plaintext starts at
 * a DRI segment followed by the SOS rather than at the DC-chroma DHT.
 *
 * FULLY SYNTHETIC: the scan comes from a `jpeg-js` encode of a gradient built here (standard Annex-K
 * tables, 4:4:4, no DRI of its own), and the "encrypted" prefix is seeded pseudo-random bytes.
 */
const WIDTH = 160;
const HEIGHT = 120;

const DC_CHROMA = Buffer.from([0xff, 0xc4, 0x00, 0x1f, 0x01]);
const DRI_ZERO = Buffer.from([0xff, 0xdd, 0x00, 0x04, 0x00, 0x00]);
const SOS = Buffer.from([0xff, 0xda, 0x00, 0x0c]);

/** A picture with continuous rows, so the geometry search has a right answer to find. */
function picture(): Buffer {
  const data = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const at = (y * WIDTH + x) * 4;
      data[at] = Math.round((x * 255) / (WIDTH - 1));
      data[at + 1] = Math.round((y * 255) / (HEIGHT - 1));
      data[at + 2] = Math.round(((x + y) * 255) / (WIDTH + HEIGHT - 2));
      data[at + 3] = 255;
    }
  }
  return data;
}

/** Seeded bytes standing in for the encrypted prefix; never contains the DC-chroma marker. */
function garbage(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  expect(out.indexOf(DC_CHROMA)).toBe(-1);
  return out;
}

/** `v2_eufysecurity:` + an opaque prefix + a DRI(0) segment + the encoded picture's SOS and scan. */
function driBlob(prefix: Buffer): Buffer {
  const jpeg = Buffer.from(jpegEncode({ width: WIDTH, height: HEIGHT, data: picture() }, 85).data);
  const scan = jpeg.subarray(jpeg.indexOf(SOS));
  return Buffer.concat([Buffer.from("v2_eufysecurity:"), prefix, DRI_ZERO, scan]);
}

describe("decodeImageV2 with the chroma tables in the encrypted prefix", () => {
  it("reconstructs a decodable JPEG at the original geometry from a tail that starts at DRI", () => {
    const out = decodeImageV2(driBlob(garbage(600, 1)));
    expect(out).not.toBeNull();
    expect(out!.includes(Buffer.concat([DRI_ZERO, SOS]))).toBe(true);
    const image = jpegDecode(out!, { useTArray: true });
    expect({ width: image.width, height: image.height }).toEqual({ width: WIDTH, height: HEIGHT });
  });

  it("cuts at the last 3-component SOS, ignoring DRI/SOS decoys in the encrypted prefix", () => {
    const decoy = Buffer.concat([
      garbage(200, 2),
      Buffer.from([0xff, 0xdd]),
      garbage(100, 3),
      DRI_ZERO,
      garbage(50, 4),
      DRI_ZERO,
      Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03]),
      garbage(200, 5),
    ]);
    const blob = driBlob(decoy);
    const out = decodeImageV2(blob);
    expect(out).not.toBeNull();
    const image = jpegDecode(out!, { useTArray: true });
    expect({ width: image.width, height: image.height }).toEqual({ width: WIDTH, height: HEIGHT });

    const broken = driBlob(garbage(600, 1));
    broken[broken.lastIndexOf(SOS) + 4] = 0x01;
    expect(broken.indexOf(DC_CHROMA)).toBe(-1);
    expect(decodeImageV2(broken)).toBeNull();
  });
});
