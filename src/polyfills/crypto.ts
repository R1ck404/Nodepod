// Crypto polyfill using Web Crypto API with synchronous fallbacks

import { scrypt as nobleScrypt } from "@noble/hashes/scrypt";
import { Buffer } from "./buffer";
import { EventEmitter } from "./events";
import { digestSync, hmacSync, createStreamingDigest, type StreamingDigest } from "./sync-digest";
import { bytesToHex } from "../helpers/byte-encoding";

function normalizeAlg(name: string): string {
  const upper = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  switch (upper) {
    case "SHA1":
      return "SHA-1";
    case "SHA256":
      return "SHA-256";
    case "SHA384":
      return "SHA-384";
    case "SHA512":
      return "SHA-512";
    case "MD5":
      return "MD5";
    default:
      return name;
  }
}

function hashOutputSize(alg: string): number {
  if (alg.includes("512")) return 64;
  if (alg.includes("384")) return 48;
  if (alg.includes("1") || alg === "SHA-1") return 20;
  return 32;
}

function joinChunks(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

function formatOutput(raw: Uint8Array, enc?: string): string | Buffer {
  if (enc === "hex") {
    return bytesToHex(raw);
  }
  if (enc === "base64") {
    return btoa(String.fromCharCode(...raw));
  }
  return Buffer.from(raw);
}

function toUpdateChunk(input: string | Buffer | Uint8Array, enc?: string): Buffer {
  if (typeof input === "string") {
    return Buffer.from(input, (enc as BufferEncoding) || "utf8");
  }
  return Buffer.from(input);
}

export function randomBytes(count: number): Buffer {
  const arr = new Uint8Array(count);
  crypto.getRandomValues(arr);
  return Buffer.from(arr);
}

export function randomFillSync(
  target: Uint8Array | Buffer,
  start?: number,
  size?: number,
): Uint8Array | Buffer {
  const off = start || 0;
  const len = size !== undefined ? size : target.length - off;
  if (off < 0 || len < 0 || off + len > target.length) {
    throw new RangeError(
      `The value of "offset" (${off}) + "size" (${len}) is out of range. It must be >= 0 && <= ${target.length}.`,
    );
  }
  const view = new Uint8Array(target.buffer, target.byteOffset + off, len);
  crypto.getRandomValues(view);
  return target;
}

export function randomUUID(): string {
  return crypto.randomUUID();
}

export function randomInt(lo: number, hi?: number): number {
  if (hi === undefined) {
    hi = lo;
    lo = 0;
  }
  const span = hi - lo;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return lo + (buf[0] % span);
}

export function getRandomValues<T extends ArrayBufferView>(arr: T): T {
  return crypto.getRandomValues(arr);
}

export interface Hash {
  update(input: string | Buffer | Uint8Array, enc?: string): Hash;
  digestAsync(enc?: string): Promise<string | Buffer>;
  digest(enc?: string): string | Buffer;
}
interface HashConstructor {
  new (alg: string): Hash;
  (this: any, alg: string): void;
  prototype: any;
}
export const Hash = function Hash(this: any, alg: string) {
  if (!this) return;
  this._alg = normalizeAlg(alg);
  this._parts = [];
  // SHA-1/2 hash incrementally: every update is consumed immediately, so the
  // input needs no defensive copy and digest() needs no join
  this._stream = createStreamingDigest(this._alg) as StreamingDigest | null;
} as unknown as HashConstructor;

Hash.prototype.update = function update(input: string | Buffer | Uint8Array, enc?: string): any {
  if (input == null) {
    throw new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ' + String(input));
  }
  if (this._stream) {
    if (this._digested) {
      const err = new Error("Digest already called") as Error & { code: string };
      err.code = "ERR_CRYPTO_HASH_FINALIZED";
      throw err;
    }
    if (typeof input === "string") {
      this._stream.update(Buffer.from(input, (enc as BufferEncoding) || "utf8"));
    } else if (input instanceof Uint8Array) {
      this._stream.update(input);
    } else {
      this._stream.update(toUpdateChunk(input, enc));
    }
    return this;
  }
  this._parts.push(toUpdateChunk(input, enc));
  return this;
};

// the streaming hasher finalizes once; repeat digests reuse its result the
// way the buffered implementation always allowed
function streamDigest(h: any): Uint8Array {
  if (!h._digested) h._digested = h._stream.digest();
  return h._digested;
}

Hash.prototype.digestAsync = async function digestAsync(enc?: string): Promise<string | Buffer> {
  if (this._stream) return formatOutput(streamDigest(this), enc);
  const merged = joinChunks(this._parts);
  const ab = new Uint8Array(merged).buffer as ArrayBuffer;
  const hashed = await crypto.subtle.digest(this._alg, ab);
  return formatOutput(new Uint8Array(hashed), enc);
};

Hash.prototype.digest = function digest(enc?: string): string | Buffer {
  if (this._stream) return formatOutput(streamDigest(this), enc);
  const merged = joinChunks(this._parts);
  const hashed = digestSync(this._alg, merged);
  return formatOutput(hashed, enc);
};

export function createHash(alg: string): Hash {
  return new Hash(alg);
}

// one-shot hash (Node.js 20.12+ API)
export function hash(
  algorithm: string,
  data: string | Buffer | Uint8Array,
  outputEncoding?: string,
): string | Buffer {
  const h = createHash(algorithm);
  h.update(data);
  return h.digest(outputEncoding);
}

export interface Hmac {
  update(input: string | Buffer | Uint8Array, enc?: string): Hmac;
  digestAsync(enc?: string): Promise<string | Buffer>;
  digest(enc?: string): string | Buffer;
}
interface HmacConstructor {
  new (alg: string, secret: string | Buffer): Hmac;
  (this: any, alg: string, secret: string | Buffer): void;
  prototype: any;
}
export const Hmac = function Hmac(this: any, alg: string, secret: string | Buffer) {
  if (!this) return;
  this._alg = normalizeAlg(alg);
  this._key = typeof secret === "string" ? Buffer.from(secret) : secret;
  this._parts = [];
} as unknown as HmacConstructor;

Hmac.prototype.update = function update(input: string | Buffer | Uint8Array, enc?: string): any {
  if (input == null) {
    throw new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ' + String(input));
  }
  this._parts.push(toUpdateChunk(input, enc));
  return this;
};

Hmac.prototype.digestAsync = async function digestAsync(enc?: string): Promise<string | Buffer> {
  const merged = joinChunks(this._parts);
  const keyBuf = new Uint8Array(this._key).buffer as ArrayBuffer;
  const dataBuf = new Uint8Array(merged).buffer as ArrayBuffer;
  const importedKey = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: this._alg },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", importedKey, dataBuf);
  return formatOutput(new Uint8Array(sig), enc);
};

Hmac.prototype.digest = function digest(enc?: string): string | Buffer {
  const merged = joinChunks(this._parts);
  const keyBytes = new Uint8Array(this._key);
  const result = hmacSync(this._alg, keyBytes, merged);
  return formatOutput(result, enc);
};

export function createHmac(alg: string, secret: string | Buffer): Hmac {
  return new Hmac(alg, secret);
}

type BinaryInput = string | Buffer | Uint8Array;

export function pbkdf2(
  password: BinaryInput,
  salt: BinaryInput,
  rounds: number,
  keyLen: number,
  hashName: string,
  cb: (err: Error | null, key: Buffer) => void,
): void {
  pbkdf2Async(password, salt, rounds, keyLen, hashName)
    .then((k) => cb(null, k))
    .catch((e) => cb(e, Buffer.alloc(0)));
}

async function pbkdf2Async(
  password: BinaryInput,
  salt: BinaryInput,
  rounds: number,
  keyLen: number,
  hashName: string,
): Promise<Buffer> {
  const pwBuf = typeof password === "string" ? Buffer.from(password) : password;
  const saltBuf = typeof salt === "string" ? Buffer.from(salt) : salt;
  const pwAb = new Uint8Array(pwBuf).buffer as ArrayBuffer;
  const saltAb = new Uint8Array(saltBuf).buffer as ArrayBuffer;

  const baseKey = await crypto.subtle.importKey("raw", pwAb, "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltAb,
      iterations: rounds,
      hash: normalizeAlg(hashName),
    },
    baseKey,
    keyLen * 8,
  );
  return Buffer.from(bits);
}

export function pbkdf2Sync(
  password: BinaryInput,
  salt: BinaryInput,
  rounds: number,
  keyLen: number,
  hashName: string,
): Buffer {
  const pwBuf = typeof password === "string" ? Buffer.from(password) : password;
  const saltBuf = typeof salt === "string" ? Buffer.from(salt) : salt;
  const alg = normalizeAlg(hashName);
  const blockSize = hashOutputSize(alg);
  const blockCount = Math.ceil(keyLen / blockSize);
  const derived = new Uint8Array(blockCount * blockSize);

  for (let bIdx = 1; bIdx <= blockCount; bIdx++) {
    const bNumBytes = new Uint8Array(4);
    bNumBytes[0] = (bIdx >>> 24) & 0xff;
    bNumBytes[1] = (bIdx >>> 16) & 0xff;
    bNumBytes[2] = (bIdx >>> 8) & 0xff;
    bNumBytes[3] = bIdx & 0xff;

    const saltPlusIdx = new Uint8Array(saltBuf.length + 4);
    saltPlusIdx.set(saltBuf);
    saltPlusIdx.set(bNumBytes, saltBuf.length);

    const pwBytes = new Uint8Array(pwBuf);
    let u = hmacSync(alg, pwBytes, saltPlusIdx);
    const accum = new Uint8Array(u);

    for (let r = 1; r < rounds; r++) {
      u = hmacSync(alg, pwBytes, u);
      for (let j = 0; j < accum.length; j++) accum[j] ^= u[j];
    }
    derived.set(accum, (bIdx - 1) * blockSize);
  }

  return Buffer.from(derived.slice(0, keyLen));
}

export interface ScryptOptions {
  N?: number;
  r?: number;
  p?: number;
  maxmem?: number;
}

export function scrypt(
  password: BinaryInput,
  salt: BinaryInput,
  keyLen: number,
  opts: ScryptOptions | undefined | ((err: Error | null, key: Buffer) => void),
  cb?: (err: Error | null, key: Buffer) => void,
): void {
  let options: ScryptOptions | undefined;
  let callback: (err: Error | null, key: Buffer) => void;
  if (typeof opts === "function") {
    callback = opts;
  } else {
    options = opts;
    callback = cb!;
  }
  try {
    const result = scryptSync(password, salt, keyLen, options);
    setTimeout(() => callback(null, result), 0);
  } catch (e) {
    setTimeout(() => callback(e as Error, Buffer.alloc(0)), 0);
  }
}

export function scryptSync(
  password: BinaryInput,
  salt: BinaryInput,
  keyLen: number,
  opts?: ScryptOptions,
): Buffer {
  const pw =
    typeof password === "string" ? new TextEncoder().encode(password) : new Uint8Array(password);
  const saltBytes =
    typeof salt === "string" ? new TextEncoder().encode(salt) : new Uint8Array(salt);
  const N = opts?.N ?? 16384;
  const r = opts?.r ?? 8;
  const p = opts?.p ?? 1;
  const out = nobleScrypt(pw, saltBytes, {
    N,
    r,
    p,
    dkLen: keyLen,
    maxmem: opts?.maxmem,
  });
  return Buffer.from(out);
}

type KeyMaterial =
  | string
  | Buffer
  | KeyObject
  | { key: string | Buffer; passphrase?: string };

interface KeyDetails {
  raw: Uint8Array | CryptoKey;
  alg?: string;
  kind: "public" | "private" | "secret";
  fmt: "pem" | "der" | "jwk" | "raw";
}

function extractKey(source: KeyMaterial): KeyDetails {
  if (source instanceof KeyObject) {
    return {
      raw: (source as any)._data,
      alg: (source as any)._alg,
      kind: (source as any)._kind,
      fmt: "raw",
    };
  }
  if (typeof source === "object" && "key" in source) {
    return extractKey(source.key);
  }

  const text = typeof source === "string" ? source : source.toString();
  if (text.includes("-----BEGIN")) {
    const isPriv = text.includes("PRIVATE");
    const isPub = text.includes("PUBLIC");
    const b64 = text
      .replace(/-----BEGIN [^-]+-----/, "")
      .replace(/-----END [^-]+-----/, "")
      .replace(/\s/g, "");
    const bytes = Buffer.from(atob(b64));
    let alg: string | undefined;
    if (text.includes("RSA")) alg = "RSA-SHA256";
    else if (text.includes("EC")) alg = "ES256";
    else if (text.includes("ED25519")) alg = "Ed25519";
    return {
      raw: bytes,
      alg,
      kind: isPriv ? "private" : isPub ? "public" : "secret",
      fmt: "pem",
    };
  }

  const keyBytes = typeof source === "string" ? Buffer.from(source) : source;
  return { raw: keyBytes, kind: "secret", fmt: "raw" };
}

function syncSign(_alg: string, _data: Uint8Array, _keyInfo: KeyDetails): Buffer {
  throw new Error(
    "crypto: synchronous sign/verify is not supported in the browser polyfill; use the async Web Crypto path",
  );
}

function syncVerify(
  _alg: string,
  _data: Uint8Array,
  _keyInfo: KeyDetails,
  _sig: Uint8Array,
): boolean {
  throw new Error(
    "crypto: synchronous sign/verify is not supported in the browser polyfill; use the async Web Crypto path",
  );
}

export function sign(
  alg: string | null | undefined,
  data: Buffer | Uint8Array,
  key: KeyMaterial,
  cb?: (err: Error | null, sig: Buffer) => void,
): Buffer | void {
  const info = extractKey(key);
  const algorithm = alg || info.alg || "SHA-256";
  if (cb) {
    try {
      cb(null, syncSign(algorithm, data, info));
    } catch (e) {
      cb(e as Error, null as unknown as Buffer);
    }
    return;
  }
  return syncSign(algorithm, data, info);
}

export function verify(
  alg: string | null | undefined,
  data: Buffer | Uint8Array,
  key: KeyMaterial,
  sig: Buffer | Uint8Array,
  cb?: (err: Error | null, ok: boolean) => void,
): boolean | void {
  const info = extractKey(key);
  const algorithm = alg || info.alg || "SHA-256";
  if (cb) {
    try {
      cb(null, syncVerify(algorithm, data, info, sig));
    } catch (e) {
      cb(e as Error, false);
    }
    return;
  }
  return syncVerify(algorithm, data, info, sig);
}

export interface SignStream extends EventEmitter {
  update(input: string | Buffer | Uint8Array, enc?: string): SignStream;
  sign(privKey: KeyMaterial, outEnc?: string): Buffer | string;
}
interface SignStreamConstructor {
  new (alg: string): SignStream;
  (this: any, alg: string): void;
  prototype: any;
}
export const SignStream = function SignStream(this: any, alg: string) {
  if (!this) return;
  EventEmitter.call(this);
  this._alg = alg;
  this._parts = [];
} as unknown as SignStreamConstructor;

Object.setPrototypeOf(SignStream.prototype, EventEmitter.prototype);

SignStream.prototype.update = function update(input: string | Buffer | Uint8Array, _enc?: string): any {
  this._parts.push(typeof input === "string" ? Buffer.from(input) : input);
  return this;
};

SignStream.prototype.sign = function sign(privKey: KeyMaterial, outEnc?: string): Buffer | string {
  const merged = joinChunks(this._parts);
  const info = extractKey(privKey);
  const raw = syncSign(this._alg, merged, info);
  if (outEnc === "base64") return btoa(String.fromCharCode(...raw));
  if (outEnc === "hex")
    return Array.from(raw)
      .map((b: number) => b.toString(16).padStart(2, "0"))
      .join("");
  return raw;
};

export interface VerifyStream extends EventEmitter {
  update(input: string | Buffer | Uint8Array, enc?: string): VerifyStream;
  verify(pubKey: KeyMaterial, sig: Buffer | string, sigEnc?: string): boolean;
}
interface VerifyStreamConstructor {
  new (alg: string): VerifyStream;
  (this: any, alg: string): void;
  prototype: any;
}
export const VerifyStream = function VerifyStream(this: any, alg: string) {
  if (!this) return;
  EventEmitter.call(this);
  this._alg = alg;
  this._parts = [];
} as unknown as VerifyStreamConstructor;

Object.setPrototypeOf(VerifyStream.prototype, EventEmitter.prototype);

VerifyStream.prototype.update = function update(input: string | Buffer | Uint8Array, _enc?: string): any {
  this._parts.push(typeof input === "string" ? Buffer.from(input) : input);
  return this;
};

VerifyStream.prototype.verify = function verify(pubKey: KeyMaterial, sig: Buffer | string, sigEnc?: string): boolean {
  const merged = joinChunks(this._parts);
  const info = extractKey(pubKey);
  let sigBuf: Buffer;
  if (typeof sig === "string") {
    if (sigEnc === "base64") sigBuf = Buffer.from(atob(sig));
    else if (sigEnc === "hex")
      sigBuf = Buffer.from(sig.match(/.{2}/g)!.map((h: string) => parseInt(h, 16)));
    else sigBuf = Buffer.from(sig);
  } else {
    sigBuf = sig;
  }
  return syncVerify(this._alg, merged, info, sigBuf);
};

export function createSign(alg: string): SignStream {
  return new SignStream(alg);
}
export function createVerify(alg: string): VerifyStream {
  return new VerifyStream(alg);
}

export function createCipheriv(
  _alg: string,
  _key: BinaryInput,
  _iv: BinaryInput | null,
): any {
  throw new Error("createCipheriv is not supported in the browser polyfill");
}

export function createDecipheriv(
  _alg: string,
  _key: BinaryInput,
  _iv: BinaryInput | null,
): any {
  throw new Error("createDecipheriv is not supported in the browser polyfill");
}

export interface KeyObject {
  readonly type: string;
  readonly asymmetricKeyType: string | undefined;
  readonly symmetricKeySize: number | undefined;
  export(opts?: { type?: string; format?: string }): Buffer | string;
}
interface KeyObjectConstructor {
  new (kind: "public" | "private" | "secret", data: CryptoKey | Uint8Array, alg?: string): KeyObject;
  (this: any, kind: "public" | "private" | "secret", data: CryptoKey | Uint8Array, alg?: string): void;
  prototype: any;
}
export const KeyObject = function KeyObject(
  this: any,
  kind: "public" | "private" | "secret",
  data: CryptoKey | Uint8Array,
  alg?: string,
) {
  if (!this) return;
  this._kind = kind;
  this._data = data;
  this._alg = alg;
} as unknown as KeyObjectConstructor;

Object.defineProperty(KeyObject.prototype, "type", {
  get: function (this: any) { return this._kind; },
  configurable: true,
});

Object.defineProperty(KeyObject.prototype, "asymmetricKeyType", {
  get: function (this: any) {
    if (this._kind === "secret") return undefined;
    if (this._alg?.includes("RSA")) return "rsa";
    if (this._alg?.includes("EC") || this._alg?.includes("ES")) return "ec";
    if (this._alg?.includes("Ed")) return "ed25519";
    return undefined;
  },
  configurable: true,
});

Object.defineProperty(KeyObject.prototype, "symmetricKeySize", {
  get: function (this: any) {
    if (this._kind !== "secret") return undefined;
    return this._data instanceof Uint8Array ? this._data.length : undefined;
  },
  configurable: true,
});

KeyObject.prototype.export = function exportKey(_opts?: { type?: string; format?: string }): Buffer | string {
  if (this._data instanceof Uint8Array) return Buffer.from(this._data);
  throw new Error("Cannot synchronously export a CryptoKey");
};

export function createSecretKey(key: Buffer | string, enc?: string): KeyObject {
  const buf =
    typeof key === "string" ? Buffer.from(key, enc as BufferEncoding) : key;
  return new KeyObject("secret", buf);
}

export function createPublicKey(key: KeyMaterial): KeyObject {
  const info = extractKey(key);
  return new KeyObject("public", info.raw as Uint8Array, info.alg);
}

export function createPrivateKey(key: KeyMaterial): KeyObject {
  const info = extractKey(key);
  return new KeyObject("private", info.raw as Uint8Array, info.alg);
}

export function timingSafeEqual(
  a: Buffer | Uint8Array,
  b: Buffer | Uint8Array,
): boolean {
  if (a.length !== b.length) {
    const err = new RangeError(
      "Input buffers must have the same byte length",
    ) as RangeError & { code?: string };
    err.code = "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH";
    throw err;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function getCiphers(): string[] {
  // createCipheriv/createDecipheriv are unsupported — do not advertise AES
  return [];
}

export function getHashes(): string[] {
  return ["sha1", "sha256", "sha384", "sha512"];
}

export const constants = {
  SSL_OP_ALL: 0,
  RSA_PKCS1_PADDING: 1,
  RSA_PKCS1_OAEP_PADDING: 4,
  RSA_PKCS1_PSS_PADDING: 6,
};

export function generateKeySync(
  type: string,
  options?: { length?: number },
): KeyObject {
  const len = options?.length || 32;
  const key = randomBytes(len);
  return createSecretKey(key);
}

export function generateKeyPairSync(
  _type: string,
  _options?: {
    modulusLength?: number;
    namedCurve?: string;
    publicKeyEncoding?: { type?: string; format?: string };
    privateKeyEncoding?: { type?: string; format?: string };
  },
): { publicKey: KeyObject | string; privateKey: KeyObject | string } {
  throw new Error(
    "crypto.generateKeyPairSync is not supported in the browser polyfill (no RSA/EC key generation)",
  );
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let val = 0n;
  for (let i = 0; i < bytes.length; i++) val = (val << 8n) | BigInt(bytes[i]);
  return val;
}

function bigIntToBytes(n: bigint, size?: number): Buffer {
  if (n < 0n) throw new Error("negative bigint");
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let buf = Buffer.from(hex, "hex");
  if (size !== undefined) {
    if (buf.length > size) buf = buf.subarray(buf.length - size);
    else if (buf.length < size) {
      const padded = Buffer.alloc(size);
      buf.copy(padded, size - buf.length);
      buf = padded;
    }
  }
  return buf;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** Miller–Rabin probable-prime test (deterministic for sizes we generate). */
function isProbablePrime(n: bigint, rounds = 16): boolean {
  if (n < 2n) return false;
  if (n === 2n || n === 3n) return true;
  if ((n & 1n) === 0n) return false;
  const small = [3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n];
  for (const p of small) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s++;
  }
  const nBits = n.toString(16).length * 4;
  for (let i = 0; i < rounds; i++) {
    let a: bigint;
    do {
      const rb = randomBytes(Math.ceil(nBits / 8) + 1);
      a = bytesToBigInt(rb) % (n - 3n) + 2n;
    } while (a < 2n || a >= n - 1n);
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let cont = false;
    for (let r = 1; r < s; r++) {
      x = modPow(x, 2n, n);
      if (x === n - 1n) {
        cont = true;
        break;
      }
    }
    if (!cont) return false;
  }
  return true;
}

function randomOddBigInt(bits: number): bigint {
  const byteLen = Math.ceil(bits / 8);
  const bytes = randomBytes(byteLen);
  bytes[0]! |= 0x80;
  if (bits % 8 !== 0) {
    bytes[0]! &= (1 << (bits % 8)) - 1;
    bytes[0]! |= 1 << ((bits % 8) - 1);
  }
  bytes[bytes.length - 1]! |= 0x01;
  return bytesToBigInt(bytes);
}

export function generatePrimeSync(
  size: number,
  options?: { bigint?: boolean; safe?: boolean },
): Buffer | bigint {
  if (size < 2) throw new RangeError("size must be at least 2");
  const safe = !!options?.safe;
  for (;;) {
    const candidate = randomOddBigInt(size);
    if (!isProbablePrime(candidate)) continue;
    // safe prime: p and (p-1)/2 are both prime
    if (safe && !isProbablePrime((candidate - 1n) / 2n)) continue;
    if (options?.bigint) return candidate;
    return bigIntToBytes(candidate, Math.ceil(size / 8));
  }
}

export function generatePrime(
  size: number,
  options: { bigint?: boolean; safe?: boolean } | undefined,
  cb: (err: Error | null, prime: Buffer | bigint) => void,
): void {
  try {
    const result = generatePrimeSync(size, options);
    setTimeout(() => cb(null, result), 0);
  } catch (e) {
    setTimeout(() => cb(e as Error, Buffer.alloc(0)), 0);
  }
}

export function checkPrimeSync(
  candidate: Buffer | bigint,
  options?: { checks?: number },
): boolean {
  const n =
    typeof candidate === "bigint" ? candidate : bytesToBigInt(new Uint8Array(candidate));
  return isProbablePrime(n, options?.checks ?? 16);
}

export function checkPrime(
  candidate: Buffer | bigint,
  optionsOrCb?:
    | { checks?: number }
    | ((err: Error | null, result: boolean) => void),
  cb?: (err: Error | null, result: boolean) => void,
): void {
  let options: { checks?: number } | undefined;
  let callback: (err: Error | null, result: boolean) => void;
  if (typeof optionsOrCb === "function") {
    callback = optionsOrCb;
  } else {
    options = optionsOrCb;
    callback = cb!;
  }
  try {
    const result = checkPrimeSync(candidate, options);
    setTimeout(() => callback(null, result), 0);
  } catch (e) {
    setTimeout(() => callback(e as Error, false), 0);
  }
}

export function randomFill(
  buf: Uint8Array | Buffer,
  offsetOrCb: number | ((err: Error | null, buf: Uint8Array | Buffer) => void),
  sizeOrCb?: number | ((err: Error | null, buf: Uint8Array | Buffer) => void),
  cb?: (err: Error | null, buf: Uint8Array | Buffer) => void,
): void {
  let offset = 0;
  let size = buf.length;
  let callback = cb;

  if (typeof offsetOrCb === "function") {
    callback = offsetOrCb;
  } else {
    offset = offsetOrCb;
    if (typeof sizeOrCb === "function") {
      callback = sizeOrCb;
      size = buf.length - offset;
    } else if (sizeOrCb !== undefined) {
      size = sizeOrCb;
    } else {
      size = buf.length - offset;
    }
  }

  try {
    randomFillSync(buf, offset, size);
    if (callback) setTimeout(() => callback!(null, buf), 0);
  } catch (e) {
    if (callback) setTimeout(() => callback!(e as Error, buf), 0);
  }
}

export function hkdfSync(
  hashAlg: string,
  ikm: BinaryInput,
  salt: BinaryInput,
  info: BinaryInput,
  keyLen: number,
): Buffer {
  const saltBuf =
    typeof salt === "string" ? Buffer.from(salt) : Buffer.from(salt);
  const ikmBuf = typeof ikm === "string" ? Buffer.from(ikm) : Buffer.from(ikm);
  const infoBuf =
    typeof info === "string" ? Buffer.from(info) : Buffer.from(info);

  const prk = createHmac(hashAlg, saltBuf).update(ikmBuf).digest() as Buffer;

  const hashLen = prk.length;
  const n = Math.ceil(keyLen / hashLen);
  const okm = Buffer.alloc(n * hashLen);
  let prev = Buffer.alloc(0);

  for (let i = 0; i < n; i++) {
    const input = Buffer.concat([prev, infoBuf, Buffer.from([i + 1])]);
    prev = Buffer.from(createHmac(hashAlg, prk).update(input).digest() as Uint8Array);
    prev.copy(okm, i * hashLen);
  }

  return okm.slice(0, keyLen);
}

export function hkdf(
  hashAlg: string,
  ikm: BinaryInput,
  salt: BinaryInput,
  info: BinaryInput,
  keyLen: number,
  cb: (err: Error | null, derivedKey: Buffer) => void,
): void {
  try {
    const result = hkdfSync(hashAlg, ikm, salt, info, keyLen);
    setTimeout(() => cb(null, result), 0);
  } catch (e) {
    setTimeout(() => cb(e as Error, Buffer.alloc(0)), 0);
  }
}

/** Well-known MODP primes (hex) from RFC 2409 / RFC 3526. */
const DH_GROUPS: Record<string, { prime: string; generator: number }> = {
  modp1: {
    // 768-bit
    prime:
      "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74" +
      "020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437" +
      "4FE1356D6D51C245E485B576625E7EC6F44C42E9A63A3620FFFFFFFFFFFFFFFF",
    generator: 2,
  },
  modp2: {
    // 1024-bit
    prime:
      "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74" +
      "020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437" +
      "4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
      "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF",
    generator: 2,
  },
  modp5: {
    // 1536-bit
    prime:
      "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74" +
      "020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437" +
      "4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
      "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05" +
      "98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB" +
      "9ED529077096966D670C354E4ABC9804F1746C08CA237327FFFFFFFFFFFFFFFF",
    generator: 2,
  },
  modp14: {
    // 2048-bit
    prime:
      "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74" +
      "020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437" +
      "4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
      "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05" +
      "98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB" +
      "9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
      "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718" +
      "3995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF",
    generator: 2,
  },
};

function makeDiffieHellman(prime: bigint, generator: bigint): any {
  const primeBytes = bigIntToBytes(prime);
  let priv: bigint | null = null;
  let pub: bigint | null = null;

  const dh: any = {
    generateKeys(encoding?: string) {
      const bits = primeBytes.length * 8;
      do {
        priv = bytesToBigInt(randomBytes(Math.ceil(bits / 8)));
      } while (priv <= 1n || priv >= prime - 1n);
      pub = modPow(generator, priv, prime);
      const out = bigIntToBytes(pub, primeBytes.length);
      return encoding === "hex" ? out.toString("hex") : out;
    },
    computeSecret(other: Buffer | Uint8Array | string, inEnc?: string, outEnc?: string) {
      if (priv === null) throw new Error("No private key; call generateKeys() or setPrivateKey() first");
      const otherBytes =
        typeof other === "string"
          ? Buffer.from(other, (inEnc as BufferEncoding) || "hex")
          : Buffer.from(other);
      const peer = bytesToBigInt(otherBytes);
      const secret = modPow(peer, priv, prime);
      const out = bigIntToBytes(secret, primeBytes.length);
      return outEnc === "hex" ? out.toString("hex") : out;
    },
    getPrime(encoding?: string) {
      return encoding === "hex" ? primeBytes.toString("hex") : Buffer.from(primeBytes);
    },
    getGenerator(encoding?: string) {
      const g = bigIntToBytes(generator);
      return encoding === "hex" ? g.toString("hex") : g;
    },
    getPublicKey(encoding?: string) {
      if (pub === null) throw new Error("No public key");
      const out = bigIntToBytes(pub, primeBytes.length);
      return encoding === "hex" ? out.toString("hex") : out;
    },
    getPrivateKey(encoding?: string) {
      if (priv === null) throw new Error("No private key");
      const out = bigIntToBytes(priv);
      return encoding === "hex" ? out.toString("hex") : out;
    },
    setPublicKey(key: Buffer | Uint8Array | string, encoding?: string) {
      const bytes =
        typeof key === "string" ? Buffer.from(key, (encoding as BufferEncoding) || "hex") : Buffer.from(key);
      pub = bytesToBigInt(bytes);
    },
    setPrivateKey(key: Buffer | Uint8Array | string, encoding?: string) {
      const bytes =
        typeof key === "string" ? Buffer.from(key, (encoding as BufferEncoding) || "hex") : Buffer.from(key);
      priv = bytesToBigInt(bytes);
      pub = modPow(generator, priv, prime);
    },
  };
  return dh;
}

export function getDiffieHellman(groupName: string): any {
  const group = DH_GROUPS[groupName.toLowerCase()];
  if (!group) {
    throw new Error(`Unknown Diffie-Hellman group: ${groupName}`);
  }
  return makeDiffieHellman(BigInt("0x" + group.prime), BigInt(group.generator));
}

export function createDiffieHellman(
  sizeOrPrime: number | Buffer,
  generator?: number | Buffer,
): any {
  if (typeof sizeOrPrime === "number") {
    // Generate a prime of the given bit size (expensive for large sizes)
    const prime = generatePrimeSync(sizeOrPrime, { bigint: true }) as bigint;
    const g =
      generator === undefined
        ? 2n
        : typeof generator === "number"
          ? BigInt(generator)
          : bytesToBigInt(Buffer.from(generator));
    return makeDiffieHellman(prime, g);
  }
  const prime = bytesToBigInt(Buffer.from(sizeOrPrime));
  const g =
    generator === undefined
      ? 2n
      : typeof generator === "number"
        ? BigInt(generator)
        : bytesToBigInt(Buffer.from(generator));
  return makeDiffieHellman(prime, g);
}

export function createECDH(_curveName: string): any {
  throw new Error(
    "crypto.createECDH is not supported in the browser polyfill (no elliptic-curve implementation)",
  );
}

export function getCurves(): string[] {
  return ["P-256", "P-384", "P-521", "secp256k1"];
}

export function setFips(_mode: number): void {}
export function getFips(): number {
  return 0;
}

export function secureHeapUsed(): { total: number; min: number; used: number } {
  return { total: 0, min: 0, used: 0 };
}

export const webcrypto = globalThis.crypto;

export default {
  randomBytes,
  randomFill,
  randomFillSync,
  randomUUID,
  randomInt,
  getRandomValues,
  createHash,
  hash,
  createHmac,
  createSign,
  createVerify,
  createCipheriv,
  createDecipheriv,
  sign,
  verify,
  pbkdf2,
  pbkdf2Sync,
  scrypt,
  scryptSync,
  hkdf,
  hkdfSync,
  timingSafeEqual,
  getCiphers,
  getHashes,
  getCurves,
  constants,
  KeyObject,
  createSecretKey,
  createPublicKey,
  createPrivateKey,
  generateKeySync,
  generateKeyPairSync,
  generatePrimeSync,
  generatePrime,
  checkPrimeSync,
  checkPrime,
  createDiffieHellman,
  getDiffieHellman,
  createECDH,
  setFips,
  getFips,
  secureHeapUsed,
  webcrypto,
  Hash,
  Hmac,
};
