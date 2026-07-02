// Crypto polyfill using Web Crypto API with synchronous fallbacks

import { Buffer } from "./buffer";
import { EventEmitter } from "./events";
import { digestSync, hmacSync } from "./sync-digest";

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
    return Array.from(raw)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  if (enc === "base64") {
    return btoa(String.fromCharCode(...raw));
  }
  return Buffer.from(raw);
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
} as unknown as HashConstructor;

Hash.prototype.update = function update(input: string | Buffer | Uint8Array, enc?: string): any {
  if (input == null) {
    throw new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ' + String(input));
  }
  let chunk: Buffer;
  if (typeof input === "string") {
    chunk = enc === "base64" ? Buffer.from(atob(input)) : Buffer.from(input);
  } else {
    chunk = Buffer.from(input);
  }
  this._parts.push(chunk);
  return this;
};

Hash.prototype.digestAsync = async function digestAsync(enc?: string): Promise<string | Buffer> {
  const merged = joinChunks(this._parts);
  const ab = new Uint8Array(merged).buffer as ArrayBuffer;
  const hashed = await crypto.subtle.digest(this._alg, ab);
  return formatOutput(new Uint8Array(hashed), enc);
};

Hash.prototype.digest = function digest(enc?: string): string | Buffer {
  const merged = joinChunks(this._parts);
  const hashed = digestSync(this._alg, new Uint8Array(merged));
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

Hmac.prototype.update = function update(input: string | Buffer | Uint8Array, _enc?: string): any {
  if (input == null) {
    throw new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ' + String(input));
  }
  const chunk = typeof input === "string" ? Buffer.from(input) : input;
  this._parts.push(chunk);
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

export function scrypt(
  password: BinaryInput,
  salt: BinaryInput,
  keyLen: number,
  _opts: unknown,
  cb: (err: Error | null, key: Buffer) => void,
): void {
  try {
    const result = scryptSync(password, salt, keyLen);
    setTimeout(() => cb(null, result), 0);
  } catch (e) {
    setTimeout(() => cb(e as Error, Buffer.alloc(0)), 0);
  }
}

export function scryptSync(
  password: BinaryInput,
  salt: BinaryInput,
  keyLen: number,
  _opts?: unknown,
): Buffer {
  return pbkdf2Sync(password, salt, 16384, keyLen, "sha256");
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
    return this._data instanceof Uint8Array ? this._data.length * 8 : undefined;
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
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function getCiphers(): string[] {
  return ["aes-128-cbc", "aes-256-cbc", "aes-128-gcm", "aes-256-gcm"];
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
  type: string,
  options?: {
    modulusLength?: number;
    namedCurve?: string;
    publicKeyEncoding?: { type?: string; format?: string };
    privateKeyEncoding?: { type?: string; format?: string };
  },
): { publicKey: KeyObject | string; privateKey: KeyObject | string } {
  const size = (options?.modulusLength || 2048) / 8;
  const privBytes = randomBytes(size);
  const pubBytes = randomBytes(size);
  const privKey = new KeyObject("private", privBytes, type);
  const pubKey = new KeyObject("public", pubBytes, type);

  const pubEnc = options?.publicKeyEncoding;
  const privEnc = options?.privateKeyEncoding;

  return {
    publicKey:
      pubEnc?.format === "pem"
        ? `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...pubBytes))}\n-----END PUBLIC KEY-----`
        : pubKey,
    privateKey:
      privEnc?.format === "pem"
        ? `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...privBytes))}\n-----END PRIVATE KEY-----`
        : privKey,
  };
}

export function generatePrimeSync(
  size: number,
  _options?: { bigint?: boolean; safe?: boolean },
): Buffer | bigint {
  const bytes = randomBytes(Math.ceil(size / 8));
  bytes[0] |= 0x80;
  bytes[bytes.length - 1] |= 0x01;
  if (_options?.bigint) {
    let val = BigInt(0);
    for (let i = 0; i < bytes.length; i++) {
      val = (val << BigInt(8)) | BigInt(bytes[i]);
    }
    return val;
  }
  return bytes;
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

export function checkPrimeSync(_candidate: Buffer | bigint): boolean {
  return true; // stub
}

export function checkPrime(
  candidate: Buffer | bigint,
  cb: (err: Error | null, result: boolean) => void,
): void {
  setTimeout(() => cb(null, checkPrimeSync(candidate)), 0);
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
    } else if (sizeOrCb !== undefined) {
      size = sizeOrCb;
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

export function getDiffieHellman(_groupName: string): any {
  return {
    generateKeys: () => randomBytes(256),
    computeSecret: (_other: Buffer) => randomBytes(32),
    getPrime: () => randomBytes(256),
    getGenerator: () => Buffer.from([2]),
    getPublicKey: () => randomBytes(256),
    getPrivateKey: () => randomBytes(256),
    setPublicKey: () => {},
    setPrivateKey: () => {},
  };
}

export function createDiffieHellman(
  _sizeOrPrime: number | Buffer,
  _generator?: number | Buffer,
): any {
  return getDiffieHellman("modp14");
}

export function createECDH(_curveName: string): any {
  return {
    generateKeys: (_enc?: string, _fmt?: string) => randomBytes(65),
    computeSecret: (_other: Buffer) => randomBytes(32),
    getPublicKey: (_enc?: string, _fmt?: string) => randomBytes(65),
    getPrivateKey: (_enc?: string) => randomBytes(32),
    setPublicKey: () => {},
    setPrivateKey: () => {},
  };
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
