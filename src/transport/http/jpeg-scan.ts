/**
 * A baseline-JPEG entropy scanner that decodes no pixels.
 *
 * The v2 thumbnail decoder next door has to discover a frame geometry its blob does not state, and the
 * only evidence is the plaintext entropy-coded scan: how many MCUs it carries, and whether it carries
 * them under a given chroma subsampling. A JPEG decoder answers that — it throws on a frame the scan
 * does not fill — and charges a full set of component and output buffers for each question.
 *
 * That bill is fatal for a caller under a hard memory cap. Each `jpeg-js` decode churns roughly a
 * megabyte of typed arrays, glibc keeps the arenas rather than handing them back, and a search asking
 * the question of every candidate geometry costs tens of megabytes per thumbnail — permanently, and
 * more than an embedded host gives an app in total.
 *
 * This module asks the same question by walking the Huffman-coded coefficients and throwing them away:
 * no IDCT, no component planes, no output image. What it keeps is one number per MCU — the DC
 * coefficient of its luma block(s), i.e. that block's average brightness — which is all the geometry
 * search needs to tell a sheared row apart from a continuous one. Allocation is a single `Int32Array`
 * of MCU count, and the walk is linear in the scan's length.
 *
 * Baseline sequential only (SOF0), which is what the v2 tail is: no progressive refinement, no
 * arithmetic coding. Restart markers are tolerated — the scan resynchronises and resets its DC
 * predictors, exactly as a decoder would.
 *
 * @module transport/http/jpeg-scan
 */

/** A Huffman table in the spec's decode form (F.2.2.3): per code length, the code range and its values. */
interface HuffmanTable {
  /** `mincode[l]` — smallest code of length `l`; index 1..16. */
  minCode: Int32Array;
  /** `maxcode[l]` — largest code of length `l`, or -1 when no code has that length; index 1..16. */
  maxCode: Int32Array;
  /** `valptr[l]` — where length `l`'s values start in {@link values}; index 1..16. */
  valPtr: Int32Array;
  /** The DHT segment's value bytes, in canonical order. */
  values: Uint8Array;
}

/** What one component contributes to an MCU: its blocks, and the tables they are coded with. */
interface ScanComponent {
  /** Horizontal sampling factor — blocks of this component per MCU row. */
  h: number;
  /** Vertical sampling factor — block rows of this component per MCU. */
  v: number;
  dc: HuffmanTable;
  ac: HuffmanTable;
  /** The running DC predictor; reset at every restart interval. */
  pred: number;
}

/** What the scan carried, under one subsampling hypothesis. */
export interface EntropyScan {
  /** Complete MCUs decoded before the data ran out. */
  mcus: number;
  /**
   * Mean luma DC per MCU, in scan order — a thumbnail of the picture at MCU resolution.
   *
   * Quantized units (the quant tables are lost with the v2 head), so the values are a scale of their
   * own. Differences between neighbours are what the geometry search reads, and those survive.
   */
  luma: Int32Array;
  /**
   * Whether the scan ended where a whole MCU ended, with nothing but the EOI marker left.
   *
   * The discriminator between hypotheses: a wrong one reads a block with the wrong Huffman table,
   * diverges, and either dies mid-MCU or stops with data still ahead of it. Only the subsampling the
   * encoder used walks the scan to its last byte on an MCU boundary.
   */
  complete: boolean;
}

/** Marker bytes, as the second byte of an `FF xx` pair. */
const DHT = 0xc4;
const SOS = 0xda;
const DRI = 0xdd;
const RST_FIRST = 0xd0;
const RST_LAST = 0xd7;

/** Luma sampling factors [h, v] per subsampling id: 0 = 4:4:4, 1 = 4:2:2, 2 = 4:2:0. Chroma is always 1×1. */
const LUMA_SAMPLING: Record<number, [number, number]> = { 0: [1, 1], 1: [2, 1], 2: [2, 2] };

/** Thrown to unwind out of the bit reader when the entropy data ends or a hypothesis diverges. */
class ScanEnd extends Error {}

/** Parse every table in a DHT segment (`FF C4` included) into `class<<4 | id` → table. */
function readHuffmanTables(segment: Uint8Array, into: Map<number, HuffmanTable>): void {
  const end = 2 + ((segment[2]! << 8) | segment[3]!);
  let at = 4;
  while (at < end) {
    const id = segment[at]!;
    const counts = segment.subarray(at + 1, at + 17);
    let total = 0;
    for (const count of counts) total += count;
    const values = segment.slice(at + 17, at + 17 + total);

    const minCode = new Int32Array(17);
    const maxCode = new Int32Array(17).fill(-1);
    const valPtr = new Int32Array(17);
    let code = 0;
    let index = 0;
    for (let length = 1; length <= 16; length++) {
      const count = counts[length - 1]!;
      if (count > 0) {
        valPtr[length] = index;
        minCode[length] = code;
        code += count;
        index += count;
        maxCode[length] = code - 1;
      }
      code <<= 1;
    }
    into.set(id, { minCode, maxCode, valPtr, values });
    at += 17 + total;
  }
}

/** A bit reader over entropy-coded data: unstuffs `FF 00`, resynchronises on RSTn, ends at any other marker. */
class BitReader {
  /** Byte offset of the next byte to read. */
  position: number;
  private bits = 0;
  private count = 0;
  /** Set when the reader stepped over a restart marker — the caller resets its DC predictors. */
  restarted = false;

  private readonly data: Uint8Array;

  constructor(data: Uint8Array, start: number) {
    this.data = data;
    this.position = start;
  }

  /** The offset the last whole byte ended at — what "how much of the scan did this consume" reads. */
  get consumed(): number {
    return this.position;
  }

  readBit(): number {
    if (this.count === 0) {
      if (this.position >= this.data.length) throw new ScanEnd("out of data");
      let byte = this.data[this.position++]!;
      if (byte === 0xff) {
        const next = this.data[this.position];
        if (next === 0x00) {
          this.position++;
        } else if (next !== undefined && next >= RST_FIRST && next <= RST_LAST) {
          this.position++;
          this.restarted = true;
          if (this.position >= this.data.length) throw new ScanEnd("out of data");
          byte = this.data[this.position++]!;
          if (byte === 0xff) throw new ScanEnd("marker after restart");
        } else {
          this.position--;
          throw new ScanEnd("marker");
        }
      }
      this.bits = byte;
      this.count = 8;
    }
    this.count--;
    return (this.bits >> this.count) & 1;
  }

  /** Read `length` bits, most significant first. */
  readBits(length: number): number {
    let value = 0;
    for (let i = 0; i < length; i++) value = (value << 1) | this.readBit();
    return value;
  }

  /** Drop the current byte's remaining bits — what a restart interval boundary does. */
  align(): void {
    this.count = 0;
  }
}

/** Decode one Huffman-coded value (spec F.16). */
function decodeHuffman(reader: BitReader, table: HuffmanTable): number {
  let code = reader.readBit();
  for (let length = 1; length <= 16; length++) {
    if (table.maxCode[length]! >= 0 && code <= table.maxCode[length]!) {
      return table.values[table.valPtr[length]! + code - table.minCode[length]!]!;
    }
    code = (code << 1) | reader.readBit();
  }
  throw new ScanEnd("no huffman code of any length");
}

/** Sign-extend a `length`-bit magnitude into a signed coefficient (spec F.12). */
function extend(value: number, length: number): number {
  return value < 1 << (length - 1) ? value - (1 << length) + 1 : value;
}

/**
 * Decode one 8×8 block, keeping only its DC coefficient.
 *
 * The 63 AC coefficients are read and dropped: their bits have to be walked to reach the next block,
 * but nothing downstream wants them — this scanner never inverse-transforms anything.
 */
function decodeBlock(reader: BitReader, component: ScanComponent): number {
  const dcLength = decodeHuffman(reader, component.dc);
  if (dcLength > 16) throw new ScanEnd("dc magnitude out of range");
  component.pred += dcLength === 0 ? 0 : extend(reader.readBits(dcLength), dcLength);

  let k = 1;
  while (k < 64) {
    const rs = decodeHuffman(reader, component.ac);
    const size = rs & 15;
    const run = rs >> 4;
    if (size === 0) {
      if (run !== 15) break;
      k += 16;
    } else {
      k += run;
      if (k > 63) throw new ScanEnd("ac coefficient index out of range");
      reader.readBits(size);
      k++;
    }
  }
  return component.pred;
}

/**
 * Walk the plaintext tail's scan under one subsampling hypothesis.
 *
 * `extraTables` carries the DHT segments that are NOT in the tail — for a v2 thumbnail, the standard
 * luma tables the reconstructed header supplies, since only the chroma ones survive in plaintext.
 * Returns null when the tail is not a baseline scan at all (no SOS, missing tables).
 *
 * The walk stops at the first byte it cannot read as this hypothesis's next block, and the result is
 * `complete` only when that happened on an MCU boundary with nothing but a marker left. The DC array
 * grows as the scan turns out to be long rather than being sized from the scan's byte length: a wrong
 * hypothesis dies after a handful of MCUs, and provisioning three whole-scan arrays to discover that is
 * the kind of allocation this module exists to avoid.
 */
export function scanEntropy(
  tail: Uint8Array,
  subsampling: number,
  extraTables: readonly Uint8Array[],
): EntropyScan | null {
  const tables = new Map<number, HuffmanTable>();
  for (const segment of extraTables) readHuffmanTables(segment, tables);

  let at = 0;
  let restartInterval = 0;
  let scanStart = -1;
  let assignments: { id: number; dc: number; ac: number }[] = [];
  while (at + 3 < tail.length) {
    if (tail[at] !== 0xff) return null;
    const marker = tail[at + 1]!;
    const length = (tail[at + 2]! << 8) | tail[at + 3]!;
    if (marker === DHT) {
      readHuffmanTables(tail.subarray(at, at + 2 + length), tables);
    } else if (marker === DRI) {
      restartInterval = (tail[at + 4]! << 8) | tail[at + 5]!;
    } else if (marker === SOS) {
      const count = tail[at + 4]!;
      assignments = [];
      for (let i = 0; i < count; i++) {
        const id = tail[at + 5 + i * 2]!;
        const tableByte = tail[at + 6 + i * 2]!;
        assignments.push({ id, dc: tableByte >> 4, ac: tableByte & 15 });
      }
      scanStart = at + 2 + length;
      break;
    }
    at += 2 + length;
  }
  if (scanStart < 0 || assignments.length !== 3) return null;

  const [lumaH, lumaV] = LUMA_SAMPLING[subsampling] ?? LUMA_SAMPLING[0]!;
  const components: ScanComponent[] = [];
  for (const [index, assignment] of assignments.entries()) {
    const dc = tables.get(assignment.dc);
    const ac = tables.get(0x10 | assignment.ac);
    if (!dc || !ac) return null;
    components.push({ h: index === 0 ? lumaH : 1, v: index === 0 ? lumaV : 1, dc, ac, pred: 0 });
  }

  const reader = new BitReader(tail, scanStart);
  let luma = new Int32Array(1024);
  const lumaBlocks = lumaH * lumaV;
  let mcus = 0;
  let consumed = reader.consumed;
  let complete = false;
  try {
    for (;;) {
      if (restartInterval > 0 && mcus > 0 && mcus % restartInterval === 0) {
        reader.align();
        for (const component of components) component.pred = 0;
      }
      if (reader.restarted) {
        reader.restarted = false;
        for (const component of components) component.pred = 0;
      }
      let lumaSum = 0;
      for (const component of components) {
        for (let block = 0; block < component.h * component.v; block++) {
          const dc = decodeBlock(reader, component);
          if (component === components[0]) lumaSum += dc;
        }
      }
      if (mcus === luma.length) {
        const grown = new Int32Array(luma.length * 2);
        grown.set(luma);
        luma = grown;
      }
      luma[mcus] = Math.round(lumaSum / lumaBlocks);
      mcus++;
      consumed = reader.consumed;
      if (consumed >= tail.length) {
        complete = true;
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof ScanEnd)) throw error;
    complete = tail.length - consumed <= 2;
  }
  return { mcus, luma: luma.subarray(0, mcus), complete };
}
