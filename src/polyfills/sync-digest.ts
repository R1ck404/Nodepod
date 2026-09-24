// Pure-JS synchronous digests for the crypto polyfill (Web Crypto has no sync API).

import { sha384 as nobleSha384, sha512 as nobleSha512 } from "@noble/hashes/sha512";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { sha1 as nobleSha1 } from "@noble/hashes/sha1";

export interface StreamingDigest {
  update(data: Uint8Array): unknown;
  digest(): Uint8Array;
}

/** Incremental hasher for the SHA family, or null for other algorithms. */
export function createStreamingDigest(alg: string): StreamingDigest | null {
  switch (alg) {
    case "SHA-1": return nobleSha1.create();
    case "SHA-256": return nobleSha256.create();
    case "SHA-384": return nobleSha384.create();
    case "SHA-512": return nobleSha512.create();
    default: return null;
  }
}

function md5(data: Uint8Array): Uint8Array {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const bitLen = data.length * 8;
  const padLen = ((56 - ((data.length + 1) % 64)) + 64) % 64;
  const padded = new Uint8Array(data.length + 1 + padLen + 8);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  for (let off = 0; off < padded.length; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (B & C) | (~B & D); g = i; }
      else if (i < 32) { f = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { f = C ^ (B | ~D); g = (7 * i) % 16; }
      f = (f + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((f << S[i]) | (f >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}

function sha512(data: Uint8Array, truncate384: boolean): Uint8Array {
  return truncate384 ? nobleSha384(data) : nobleSha512(data);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function digestSync(alg: string, data: Uint8Array): Uint8Array {
  switch (alg) {
    case "SHA-1": return nobleSha1(data);
    case "SHA-256": return nobleSha256(data);
    case "SHA-384": return sha512(data, true);
    case "SHA-512": return sha512(data, false);
    case "MD5": return md5(data);
    default:
      throw new Error(`crypto: synchronous digest for "${alg}" is not supported in the browser polyfill`);
  }
}

export function hmacSync(alg: string, key: Uint8Array, data: Uint8Array): Uint8Array {
  const blockSize = alg === "SHA-384" || alg === "SHA-512" ? 128 : 64;
  let k = key.length > blockSize ? digestSync(alg, key) : key;
  const keyPad = new Uint8Array(blockSize);
  keyPad.set(k);
  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = keyPad[i] ^ 0x36;
    opad[i] = keyPad[i] ^ 0x5c;
  }
  const inner = digestSync(alg, concatBytes(ipad, data));
  return digestSync(alg, concatBytes(opad, inner));
}
