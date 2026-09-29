// Pure-JS synchronous digests for the crypto polyfill (Web Crypto has no sync API).

import { sha384 as nobleSha384, sha512 as nobleSha512 } from "@noble/hashes/sha512";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { sha1 as nobleSha1 } from "@noble/hashes/sha1";
import { md5 as nobleMd5 } from "@noble/hashes/legacy";
import { hmac as nobleHmac } from "@noble/hashes/hmac";

export interface StreamingDigest {
  update(data: Uint8Array): unknown;
  digest(): Uint8Array;
}

function nobleHashFor(alg: string) {
  switch (alg) {
    case "SHA-1": return nobleSha1;
    case "SHA-256": return nobleSha256;
    case "SHA-384": return nobleSha384;
    case "SHA-512": return nobleSha512;
    case "MD5": return nobleMd5;
    default: return null;
  }
}

/** Incremental hasher for the SHA family and MD5, or null for other algorithms. */
export function createStreamingDigest(alg: string): StreamingDigest | null {
  const hash = nobleHashFor(alg);
  return hash ? hash.create() : null;
}

/** Incremental HMAC over the same hashes, or null for other algorithms. */
export function createStreamingHmac(alg: string, key: Uint8Array): StreamingDigest | null {
  const hash = nobleHashFor(alg);
  return hash ? nobleHmac.create(hash, key) : null;
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
    case "MD5": return nobleMd5(data);
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
