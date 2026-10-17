/**
 * Tuya `et=3` body crypto.
 *
 * `et=3` encrypts the request `postData` and the reply `result` with the same per-request key and the
 * same layout: each is a base64 AES-128-GCM blob instead of a JSON string. This module derives that key,
 * seals a request body and opens a reply.
 *
 * Blob layout: `nonce(12) ‖ ciphertext ‖ tag(16)`, no AAD, 12-byte GCM nonce, 16-byte tag. The
 * plaintext is gzip-compressed when it carries the gzip magic (`1f 8b`).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { resolveSignKey } from "./sign.js";

/**
 * The per-request AES-128 key, `getEncryptoKey(requestId, ecode)`: take the lowercase hex of
 * `HMAC-SHA256(key = requestId, msg = K[+ "_" + ecode])`, keep the first 16 hex characters, and use
 * those characters as 16 ASCII bytes. `K` is the app HMAC key ({@link resolveSignKey}).
 *
 * `ecode` is the session's per-login encryption code (`User.ecode`, read from the decrypted
 * `login.reg` reply). `ecode === null` selects the pre-session variant `msg = K` used to open the
 * `token.get` and `login.reg` replies themselves, before any `ecode` is known.
 */
export function deriveBodyKey(requestId: string, ecode: string | null): Buffer {
  const k = resolveSignKey();
  const msg = ecode === null ? k : `${k}_${ecode}`;
  const hex = createHmac("sha256", requestId).update(msg, "utf-8").digest("hex");
  return Buffer.from(hex.slice(0, 16), "ascii");
}

/**
 * Encrypt an `et=3` request `postData`: AES-128-GCM under a random 12-byte nonce, laid out
 * `nonce(12) ‖ ciphertext ‖ tag(16)` then base64 — the inverse of {@link decryptReply}, keyed by the
 * same {@link deriveBodyKey}. No AAD. The request is signed over this blob.
 */
export function encryptBody(key: Buffer, json: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(json, "utf-8")), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64");
}

/**
 * Decrypt an `et=3` reply `result`: base64 → AES-128-GCM-decrypt-verify (`nonce = blob[0:12]`,
 * `tag = blob[-16:]`, ciphertext between), gunzip when the plaintext is gzip-framed, and return the
 * plaintext JSON string. Throws when the blob is too short or the GCM tag fails to authenticate.
 */
export function decryptReply(key: Buffer, resultB64: string): string {
  const blob = Buffer.from(resultB64, "base64");
  if (blob.length < 12 + 16) {
    throw new Error("tuya et=3 reply too short to hold a 12-byte nonce + 16-byte tag");
  }
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(12, blob.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const text = plain.length >= 2 && plain[0] === 0x1f && plain[1] === 0x8b ? gunzipSync(plain) : plain;
  return text.toString("utf-8");
}
