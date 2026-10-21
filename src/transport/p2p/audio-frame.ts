import type { AudioCodec } from "../../core/contracts.js";

export const CMD_AUDIO_FRAME = 1301;
/** Length of the audio frame header before the payload. */
export const AUDIO_HEADER_LEN = 0x10;
/** Byte offset of the codec id between the frame-size and frame-number fields. */
export const AUDIO_TYPE_OFFSET = 0x05;
/** Byte offset of the source timestamp (u32 LE, the video header's clock) in the audio frame header. */
export const AUDIO_TIMESTAMP_OFFSET = 0x08;

/**
 * Codec ids the station puts at {@link AUDIO_TYPE_OFFSET}, as the v6 app maps them
 * (`AudioReader.AAC_LC = 0`, `G711A = 2`, `AAC_ELD = 7`).
 *
 * The app's `PCM_SILENCE = -1` is absent on purpose: it is not a wire value. The app injects it
 * itself when a stream produces no audio at all, to feed its decoder silence.
 */
export const AUDIO_CODECS: Readonly<Record<number, AudioCodec>> = { 0: "aac-lc", 2: "g711a", 7: "aac-eld" };
