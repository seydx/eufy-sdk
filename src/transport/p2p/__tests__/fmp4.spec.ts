import { Fmp4Muxer } from "../fmp4.js";
import type { LiveAudioFrame, LiveVideoFrame, VideoCodec } from "../../../core/contracts.js";

const SC4 = Buffer.from([0, 0, 0, 1]);
function annexb(...nals: Buffer[]): Buffer {
  return Buffer.concat(nals.flatMap((n) => [SC4, n]));
}

const H264_SPS = Buffer.from([0x67, 0x42, 0xc0, 0x1e, 0xaa, 0xbb]);
const H264_PPS = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
const H264_IDR = Buffer.from([0x65, 0x88, 0x84, 0x00, 0x11, 0x22]);
const H264_P = Buffer.from([0x21, 0x9a, 0x00, 0x33]);

const H265_VPS = Buffer.from([0x40, 0x01, 0x0c, 0x01]);
const H265_SPS = Buffer.from([0x42, 0x01, 0x01, 0x22]);
const H265_PPS = Buffer.from([0x44, 0x01, 0xc0]);
const H265_IDR = Buffer.from([0x26, 0x01, 0xaf, 0xff]);

function kf(codec: VideoCodec): LiveVideoFrame {
  const data = codec === "h265" ? annexb(H265_VPS, H265_SPS, H265_PPS, H265_IDR) : annexb(H264_SPS, H264_PPS, H264_IDR);
  return { keyframe: true, width: 1280, height: 720, codec, data };
}
function delta(codec: VideoCodec): LiveVideoFrame {
  return {
    keyframe: false,
    width: 1280,
    height: 720,
    codec,
    data: annexb(codec === "h265" ? Buffer.from([0x02, 1]) : H264_P),
  };
}

/** Walk the top-level MP4 box list of a buffer → [{type, start, size}]. */
function boxes(buf: Buffer): { type: string; start: number; size: number }[] {
  const out: { type: string; start: number; size: number }[] = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    const size = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    if (size < 8) break;
    out.push({ type, start: o, size });
    o += size;
  }
  return out;
}

/** Recursively find the first box of `type` anywhere in the buffer (container-agnostic scan). */
function findBox(buf: Buffer, type: string): Buffer | undefined {
  const t = Buffer.from(type, "ascii");
  const idx = buf.indexOf(t);
  if (idx < 4) return undefined;
  const start = idx - 4;
  const size = buf.readUInt32BE(start);
  return buf.subarray(start, start + size);
}

function countType(buf: Buffer, type: string): number {
  const needle = Buffer.from(type, "ascii");
  let count = 0;
  let offset = 0;
  while ((offset = buf.indexOf(needle, offset)) >= 0) {
    count++;
    offset += needle.length;
  }
  return count;
}

function boxesOfType(buf: Buffer, type: string): Buffer[] {
  const found: Buffer[] = [];
  const needle = Buffer.from(type, "ascii");
  let offset = 0;
  while ((offset = buf.indexOf(needle, offset)) >= 4) {
    const start = offset - 4;
    found.push(buf.subarray(start, start + buf.readUInt32BE(start)));
    offset += needle.length;
  }
  return found;
}

function adts(payload: Buffer, frequencyIndex = 8, channels = 1): Buffer {
  const length = payload.length + 7;
  return Buffer.concat([
    Buffer.from([
      0xff,
      0xf1,
      0x40 | (frequencyIndex << 2) | ((channels >> 2) & 0x01),
      ((channels & 0x03) << 6) | ((length >> 11) & 0x03),
      (length >> 3) & 0xff,
      ((length & 0x07) << 5) | 0x1f,
      0xfc,
    ]),
    payload,
  ]);
}

function audio(codec: "aac-lc", payload: Buffer): LiveAudioFrame {
  return { codec, data: adts(payload) };
}

/** A synthetic AudioSpecificConfig, distinct from any the SDK attaches, so a spec sees where `esds` takes it from. */
const ELD_CONFIG = Buffer.from([0xf8, 0xf0, 0x21, 0x0a, 0x00, 0xbc, 0x00]);

function eld(payload: Buffer): LiveAudioFrame {
  return { codec: "aac-eld", data: payload, config: ELD_CONFIG };
}

describe("Fmp4Muxer H.264", () => {
  it("emits an init segment (ftyp+moov) on the first keyframe with an avcC embedding the SPS", () => {
    const mux = new Fmp4Muxer();
    const out = mux.push(kf("h264"));
    expect(out?.init).toBeDefined();
    const top = boxes(out!.init!).map((b) => b.type);
    expect(top).toEqual(["ftyp", "moov"]);
    const avcc = findBox(out!.init!, "avcC");
    expect(avcc).toBeDefined();
    // avcC body carries the SPS bytes verbatim
    expect(avcc!.includes(H264_SPS)).toBe(true);
    expect(avcc!.includes(H264_PPS)).toBe(true);
    // sample entry is avc1
    expect(findBox(out!.init!, "avc1")).toBeDefined();
  });

  it("opens a media fragment (moof+mdat) on the next keyframe past the fragment length", () => {
    const mux = new Fmp4Muxer({ fragmentSeconds: 0 }); // any keyframe is a boundary
    mux.push(kf("h264")); // init
    mux.push(delta("h264"));
    const out = mux.push(kf("h264")); // closes fragment 1
    expect(out?.data.length).toBeGreaterThan(0);
    const top = boxes(out!.data).map((b) => b.type);
    expect(top).toEqual(["moof", "mdat"]);
  });

  it("rewrites Annex-B start codes to AVCC length prefixes in the mdat", () => {
    const mux = new Fmp4Muxer({ fragmentSeconds: 0 });
    mux.push(kf("h264"));
    const frag = mux.flush()!;
    const mdat = findBox(frag.data, "mdat")!;
    // first sample: [u32 len][nal…] — no Annex-B start code present
    expect(mdat.subarray(8, 12).equals(SC4)).toBe(false);
    const firstLen = mdat.readUInt32BE(8);
    expect(firstLen).toBe(H264_SPS.length); // first NAL is the SPS
    expect(mdat.subarray(12, 12 + firstLen).equals(H264_SPS)).toBe(true);
  });

  it("does not emit before the first keyframe", () => {
    const mux = new Fmp4Muxer();
    expect(mux.push(delta("h264"))).toBeUndefined();
  });
});

describe("Fmp4Muxer H.265", () => {
  it("builds an hvcC with hvc1 sample entry and VPS/SPS/PPS arrays", () => {
    const mux = new Fmp4Muxer();
    const out = mux.push(kf("h265"));
    expect(out?.init).toBeDefined();
    expect(findBox(out!.init!, "hvc1")).toBeDefined();
    const hvcc = findBox(out!.init!, "hvcC")!;
    expect(hvcc.includes(H265_VPS)).toBe(true);
    expect(hvcc.includes(H265_SPS)).toBe(true);
    expect(hvcc.includes(H265_PPS)).toBe(true);
  });
});

describe("Fmp4Muxer audio", () => {
  it("adds an AAC-LC mp4a/esds track and strips ADTS framing from media samples", () => {
    const mux = new Fmp4Muxer({ audio: true, fragmentSeconds: 0 });
    const payload = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    expect(mux.push(kf("h264"), 1000)).toBeUndefined();
    const init = mux.pushAudio(audio("aac-lc", payload), 1000);
    expect(findBox(init!.init!, "mp4a")).toBeDefined();
    expect(findBox(init!.init!, "esds")).toBeDefined();

    mux.push(delta("h264"), 1067);
    expect(mux.pushAudio(audio("aac-lc", Buffer.from([0x55, 0x66])), 1064)).toBeUndefined();
    const out = mux.push(kf("h264"), 1134)!;
    expect(countType(out.data, "traf")).toBe(2);
    const mdat = findBox(out.data, "mdat")!;
    expect(mdat.includes(payload)).toBe(true);
    expect(mdat.includes(Buffer.from([0x55, 0x66]))).toBe(true);
    expect(mdat.includes(Buffer.from([0xff, 0xf1]))).toBe(false);
  });

  it("describes AAC-ELD with the frame's decoder config and keeps the raw access unit as the sample", () => {
    const mux = new Fmp4Muxer({ audio: true, fragmentSeconds: 0 });
    mux.push(kf("h264"), 1000);
    const payload = Buffer.from([0x73, 0x69, 0xa0, 0x4a, 0x52]);
    const init = mux.pushAudio(eld(payload), 1000)!;
    expect(findBox(init.init!, "esds")!.includes(ELD_CONFIG)).toBe(true);
    const out = mux.push(kf("h264"), 1100)!;
    expect(findBox(out.data, "mdat")!.includes(payload)).toBe(true);
  });

  it("uses 480 samples for the final AAC-ELD sample in a fragment", () => {
    const mux = new Fmp4Muxer({ audio: true, fragmentSeconds: 0 });
    mux.push(kf("h264"), 1000);
    mux.pushAudio(eld(Buffer.from([1, 2, 3])), 1000);
    const out = mux.push(kf("h264"), 1100)!;
    expect(boxesOfType(out.data, "trun")[1].readUInt32BE(20)).toBe(480);
  });

  it("falls back to video-only when ADTS declares an unsupported sample rate", () => {
    const mux = new Fmp4Muxer({ audio: true });
    expect(mux.push(kf("h264"), 1000)).toBeUndefined();
    const frame = { codec: "aac-lc", data: adts(Buffer.from([1, 2, 3]), 4) } satisfies LiveAudioFrame;
    const init = mux.pushAudio(frame, 1000);
    expect(init?.init).toBeDefined();
    expect(findBox(init!.init!, "mp4a")).toBeUndefined();
  });

  it("continues video-only when the declared AAC profile changes", () => {
    const mux = new Fmp4Muxer({ audio: true, fragmentSeconds: 0 });
    mux.push(kf("h264"), 1000);
    mux.pushAudio(audio("aac-lc", Buffer.from([1])), 1000);
    expect(() => mux.pushAudio(eld(Buffer.from([2])), 1032)).not.toThrow();
    const out = mux.push(kf("h264"), 1100)!;
    expect(countType(out.data, "traf")).toBe(1);
  });

  it("falls back to a video-only init when the source codec cannot be represented as mp4a", () => {
    const mux = new Fmp4Muxer({ audio: true });
    mux.pushAudio({ codec: "g711a", data: Buffer.from([1, 2, 3]) }, 1000);
    const init = mux.push(kf("h264"), 1000)!;
    expect(init.init).toBeDefined();
    expect(findBox(init.init!, "mp4a")).toBeUndefined();
  });

  it("uses capture timestamps rather than synchronous push time for video durations", () => {
    const mux = new Fmp4Muxer({ fragmentSeconds: 0 });
    mux.push(kf("h264"), 1000);
    mux.push(delta("h264"), 1100);
    const out = mux.push(kf("h264"), 1200)!;
    const trun = findBox(out.data, "trun")!;
    expect(trun.readUInt32BE(20)).toBe(9000);
    expect(trun.readUInt32BE(32)).toBe(9000);
  });

  it("aligns audio decode time and preserves a missing-frame gap from capture timestamps", () => {
    const mux = new Fmp4Muxer({ audio: true, fragmentSeconds: 0 });
    mux.push(kf("h264"), 1000);
    mux.pushAudio(audio("aac-lc", Buffer.from([1])), 1064);
    mux.pushAudio(audio("aac-lc", Buffer.from([2])), 1192);
    const out = mux.push(kf("h264"), 1256)!;
    const decodeTimes = boxesOfType(out.data, "tfdt");
    expect(decodeTimes[1].readBigUInt64BE(12)).toBe(1024n);
    const runs = boxesOfType(out.data, "trun");
    expect(runs[1].readUInt32BE(20)).toBe(2048);
    expect(runs[1].readUInt32BE(32)).toBe(1024);
  });

  it("realigns the first audio sample after a fragment boundary", () => {
    const mux = new Fmp4Muxer({ audio: true, fragmentSeconds: 0 });
    mux.push(kf("h264"), 1000);
    mux.pushAudio(audio("aac-lc", Buffer.from([1])), 1000);
    mux.push(kf("h264"), 1100);
    mux.pushAudio(audio("aac-lc", Buffer.from([2])), 1300);
    const out = mux.push(kf("h264"), 1400)!;
    const decodeTimes = boxesOfType(out.data, "tfdt");
    expect(decodeTimes[1].readBigUInt64BE(12)).toBe(4800n);
  });
});

/** ISO/IEC 14496-12 boxes that carry child boxes rather than a payload. */
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "edts", "moof", "traf", "dinf"]);

/**
 * Every structural defect a parser would reject, found by walking the tree the way a parser does:
 * a child that runs past its parent, a box that does not fill its parent exactly, and a `trun` whose
 * declared size disagrees with the per-sample fields its own `tr_flags` promise.
 *
 * A sample table is sized from `tr_flags` alone, so a flag the body never writes is unrecoverable: the
 * parser reads 4 bytes per sample past the end of the run and loses the whole fragment.
 */
function structuralDefects(buf: Buffer, start = 0, end = buf.length, path = ""): string[] {
  const defects: string[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const at = `${path}/${type}`;
    if (size < 8) {
      defects.push(`${at} declares size ${size}`);
      return defects;
    }
    if (offset + size > end) {
      defects.push(`${at} runs ${offset + size - end} bytes past its parent`);
      return defects;
    }
    if (type === "trun") {
      const flags = buf.readUIntBE(offset + 9, 3);
      const sampleCount = buf.readUInt32BE(offset + 12);
      const perSample =
        (flags & 0x000100 ? 4 : 0) +
        (flags & 0x000200 ? 4 : 0) +
        (flags & 0x000400 ? 4 : 0) +
        (flags & 0x000800 ? 4 : 0);
      const required = 16 + (flags & 0x000001 ? 4 : 0) + (flags & 0x000004 ? 4 : 0) + sampleCount * perSample;
      if (size !== required) {
        defects.push(
          `${at} declares size ${size} but tr_flags 0x${flags.toString(16).padStart(6, "0")} over ` +
            `${sampleCount} samples require ${required}`,
        );
      }
    }
    if (CONTAINERS.has(type)) {
      defects.push(...structuralDefects(buf, offset + 8, offset + size, at));
    }
    offset += size;
  }
  if (offset !== end) {
    defects.push(`${path} leaves ${end - offset} trailing bytes its children do not cover`);
  }
  return defects;
}

describe("Fmp4Muxer box structure", () => {
  it("declares a trun size that matches the per-sample fields its own flags promise", () => {
    const mux = new Fmp4Muxer({ audio: true, fragmentSeconds: 0 });
    mux.push(kf("h264"), 1000);
    mux.pushAudio(audio("aac-lc", Buffer.from([1, 2, 3])), 1000);
    mux.push(delta("h264"), 1100);
    const fragment = mux.push(kf("h264"), 1200)!;
    const runs = boxesOfType(fragment.data, "trun");
    expect(runs.length).toBe(2);
    for (const run of runs) {
      const flags = run.readUIntBE(9, 3);
      expect(flags & 0x000800).toBe(0);
      expect(run.readUInt32BE(0)).toBe(20 + run.readUInt32BE(12) * 12);
    }
  });

  it("nests every box inside its parent with no overread and no trailing bytes", () => {
    const mux = new Fmp4Muxer({ audio: true, fragmentSeconds: 0 });
    mux.push(kf("h264"), 1000);
    const init = mux.pushAudio(audio("aac-lc", Buffer.from([1, 2, 3])), 1000)!;
    mux.push(delta("h264"), 1100);
    const fragment = mux.push(kf("h264"), 1200)!;
    expect(structuralDefects(init.init!)).toEqual([]);
    expect(structuralDefects(fragment.data)).toEqual([]);
  });

  it("keeps an H.265 fragment structurally valid", () => {
    const mux = new Fmp4Muxer({ fragmentSeconds: 0 });
    const init = mux.push(kf("h265"), 1000)!;
    const fragment = mux.push(kf("h265"), 1100)!;
    expect(structuralDefects(init.init!)).toEqual([]);
    expect(structuralDefects(fragment.data)).toEqual([]);
  });
});
