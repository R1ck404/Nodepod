// Zlib polyfill using pako for deflate/inflate/gzip + optional brotli-wasm

import { Buffer } from "./buffer.js";
import { Transform } from "./stream.js";
import { CDN_BROTLI_WASM, cdnImport } from "../constants/cdn-urls.js";
import pako from "pako";
import { getRegistry } from "../helpers/event-loop.js";


export type BrotliEngine = {
  compress: (input: Uint8Array) => Uint8Array;
  decompress: (input: Uint8Array) => Uint8Array;
};

let brotliInstance: BrotliEngine | null = null;
let brotliLoading: Promise<BrotliEngine | null> | null = null;

async function loadBrotli(): Promise<BrotliEngine | null> {
  // Strategy 1 — CDN import (browser / Nodepod runtime).
  // cdnImport uses `new Function` to hide from the bundler.
  // The pkg.web variant exports init() as default + compress/decompress
  // as named exports. init() fetches the co-located .wasm binary.
  try {
    const mod = await cdnImport(CDN_BROTLI_WASM);
    if (typeof mod.default === "function") {
      // pkg.web: call init() to load WASM, then use named exports
      await mod.default();
      brotliInstance = { compress: mod.compress, decompress: mod.decompress };
    } else {
      // fallback: default is a promise or already the engine
      brotliInstance = (await mod.default) as BrotliEngine;
    }
    return brotliInstance;
  } catch { /* CDN unreachable or not in browser */ }

  // Strategy 2 — Node.js CJS require (vitest / server / SSR).
  // Uses a standard dynamic import so it works in contexts where
  // `new Function`-based import doesn't (e.g. vitest VM).
  try {
    const { createRequire } = await import(/* @vite-ignore */ "node:module");
    const { cwd } = await import(/* @vite-ignore */ "node:process");
    const req = createRequire(cwd() + "/package.json");
    const pkg = req("brotli-wasm");
    brotliInstance = pkg as unknown as BrotliEngine;
    return brotliInstance;
  } catch { /* not in Node.js or package not installed */ }

  return null;
}

async function ensureBrotli(): Promise<BrotliEngine | null> {
  if (brotliInstance) return brotliInstance;
  // If a previous attempt already resolved to null, allow a retry —
  // the environment may not have been ready yet (e.g. eager preload
  // ran before the module system was fully initialised).
  if (brotliLoading) {
    const prev = await brotliLoading;
    if (prev) return prev;
  }
  const loadHandle = getRegistry().register("WASMWork");
  brotliLoading = loadBrotli().finally(() => loadHandle.close());
  return brotliLoading;
}

// Pure JS brotli decompressor (no WASM, no Node APIs), the sync fallback.
// Loaded on first use: the decoder decompresses its 120KB static dictionary
// when it is evaluated, which cost every process worker ~10ms at boot for a
// path that almost never runs. The bundler inlines the module behind this
// require() and only evaluates it when the call executes.
declare const require: (id: string) => unknown;
let brotliJsDecompress: ((input: Uint8Array) => Uint8Array | null) | null = null;

/** Pure JS brotli decompressor, used as sync fallback when WASM isn't ready. */
function brotliDecompressJs(input: Uint8Array): Uint8Array {
  if (!brotliJsDecompress) {
    brotliJsDecompress = require("brotli/decompress") as (input: Uint8Array) => Uint8Array | null;
  }
  const result = brotliJsDecompress(Buffer.from(input));
  if (!result) throw new Error("Brotli JS decompression failed");
  return new Uint8Array(result);
}

/**
 * Pre-load the brotli WASM engine so that synchronous functions
 * (`brotliCompressSync`, `brotliDecompressSync`) and brotli streams
 * work without having to call an async variant first.
 *
 * Resolves to `true` when the engine is ready, `false` if loading failed.
 */
export async function preloadBrotli(): Promise<boolean> {
  return (await ensureBrotli()) !== null;
}

// Brotli WASM no longer loads at bundle import (it cost ~1MB of download +
// an instance for apps that never touch brotli). The script engine calls
// preloadBrotli() when user code first require()s "zlib", preserving the
// old "kicked off early, usually ready by first sync call" semantics.
// Async APIs and brotliDecompressSync (pure-JS fallback) work regardless.


type CompressCallback = (err: Error | null, result: Buffer) => void;

// Node zlib options that pako understands under the same names
interface ZlibOptions {
  level?: number;
  windowBits?: number;
  memLevel?: number;
  strategy?: number;
  dictionary?: ArrayBufferView | ArrayBuffer;
  chunkSize?: number;
}

function toBytes(input: unknown): Uint8Array {
  if (typeof input === "string") return Buffer.from(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  const err = new TypeError(
    'The "buffer" argument must be of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer.',
  ) as TypeError & { code: string };
  err.code = "ERR_INVALID_ARG_TYPE";
  throw err;
}

function pakoOptions(opts: unknown): Record<string, unknown> | undefined {
  if (!opts || typeof opts !== "object") return undefined;
  const o = opts as ZlibOptions;
  const out: Record<string, unknown> = {};
  if (o.level !== undefined) out.level = o.level;
  if (o.windowBits !== undefined) out.windowBits = o.windowBits;
  if (o.memLevel !== undefined) out.memLevel = o.memLevel;
  if (o.strategy !== undefined) out.strategy = o.strategy;
  if (o.chunkSize !== undefined) out.chunkSize = o.chunkSize;
  if (o.dictionary !== undefined) out.dictionary = toBytes(o.dictionary);
  return out;
}

// pako throws message strings for corrupt input; Node throws Errors with a
// zlib code
function zlibError(e: unknown): Error {
  if (e instanceof Error) return e;
  const err = new Error(String(e)) as Error & { code: string; errno: number };
  err.code = "Z_DATA_ERROR";
  err.errno = -3;
  return err;
}

// gzip or zlib-wrapped deflate, by the header (zlib.unzip)
function unzipBytes(data: Uint8Array, opts?: Record<string, unknown>): Uint8Array {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b
    ? pako.ungzip(data, opts)
    : pako.inflate(data, opts);
}

type PakoOp = (data: Uint8Array, opts?: Record<string, unknown>) => Uint8Array;

function runSync(op: PakoOp, input: unknown, opts: unknown): Buffer {
  const data = toBytes(input);
  try {
    return Buffer.from(op(data, pakoOptions(opts)));
  } catch (e) {
    throw zlibError(e);
  }
}

// Node's one-shot callback APIs: (input[, options], callback), and the
// callback always runs asynchronously, never inside the call
function runAsync(op: PakoOp, input: unknown, optsOrCb: unknown, cb: unknown): void {
  const callback = (typeof optsOrCb === "function" ? optsOrCb : cb) as CompressCallback | undefined;
  if (typeof callback !== "function") {
    const err = new TypeError('The "callback" argument must be of type function') as TypeError & { code: string };
    err.code = "ERR_INVALID_ARG_TYPE";
    throw err;
  }
  const opts = typeof optsOrCb === "function" ? undefined : optsOrCb;
  let result: Buffer | null = null;
  let error: Error | null = null;
  try {
    result = runSync(op, input, opts);
  } catch (e) {
    error = zlibError(e);
  }
  const opHandle = getRegistry().register("WASMWork");
  queueMicrotask(() => {
    try {
      if (error) callback(error, undefined as unknown as Buffer);
      else callback(null, result!);
    } finally {
      opHandle.close();
    }
  });
}

const opGzip: PakoOp = (d, o) => pako.gzip(d, o);
const opGunzip: PakoOp = (d, o) => pako.ungzip(d, o);
const opDeflate: PakoOp = (d, o) => pako.deflate(d, o);
const opInflate: PakoOp = (d, o) => pako.inflate(d, o);
const opDeflateRaw: PakoOp = (d, o) => pako.deflateRaw(d, o);
const opInflateRaw: PakoOp = (d, o) => pako.inflateRaw(d, o);
const opUnzip: PakoOp = (d, o) => unzipBytes(d, o);

export function gzip(input: Buffer | string, optsOrCb?: ZlibOptions | CompressCallback, cb?: CompressCallback): void {
  runAsync(opGzip, input, optsOrCb, cb);
}

export function gunzip(input: Buffer, optsOrCb?: ZlibOptions | CompressCallback, cb?: CompressCallback): void {
  runAsync(opGunzip, input, optsOrCb, cb);
}

export function deflate(input: Buffer | string, optsOrCb?: ZlibOptions | CompressCallback, cb?: CompressCallback): void {
  runAsync(opDeflate, input, optsOrCb, cb);
}

export function inflate(input: Buffer, optsOrCb?: ZlibOptions | CompressCallback, cb?: CompressCallback): void {
  runAsync(opInflate, input, optsOrCb, cb);
}

export function deflateRaw(input: Buffer | string, optsOrCb?: ZlibOptions | CompressCallback, cb?: CompressCallback): void {
  runAsync(opDeflateRaw, input, optsOrCb, cb);
}

export function inflateRaw(input: Buffer, optsOrCb?: ZlibOptions | CompressCallback, cb?: CompressCallback): void {
  runAsync(opInflateRaw, input, optsOrCb, cb);
}

export function unzip(input: Buffer, optsOrCb?: ZlibOptions | CompressCallback, cb?: CompressCallback): void {
  runAsync(opUnzip, input, optsOrCb, cb);
}

export function unzipSync(input: Buffer, opts?: ZlibOptions): Buffer {
  return runSync(opUnzip, input, opts);
}

// zlib.crc32(data[, value]): CRC-32 (IEEE), continuing from `value`
let crcTable: Uint32Array | null = null;
export function crc32(data: string | ArrayBufferView, value = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  const bytes = toBytes(data);
  let crc = (value ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}


export function brotliCompress(
  input: Buffer | string,
  optsOrCb: unknown,
  cb?: CompressCallback,
): void {
  const callback =
    typeof optsOrCb === "function" ? (optsOrCb as CompressCallback) : cb!;
  const opHandle = getRegistry().register("WASMWork");
  const finish = (err: Error | null, result: Buffer): void => {
    try {
      callback(err, result);
    } finally {
      opHandle.close();
    }
  };
  ensureBrotli()
    .then((engine) => {
      if (!engine) {
        finish(new Error("Brotli WASM is not available"), Buffer.alloc(0));
        return;
      }
      try {
        const data = typeof input === "string" ? Buffer.from(input) : input;
        const out = engine.compress(new Uint8Array(data));
        finish(null, Buffer.from(out));
      } catch (e) {
        finish(e as Error, Buffer.alloc(0));
      }
    })
    .catch((e) => finish(e as Error, Buffer.alloc(0)));
}

export function brotliDecompress(
  input: Buffer,
  optsOrCb: unknown,
  cb?: CompressCallback,
): void {
  const callback =
    typeof optsOrCb === "function" ? (optsOrCb as CompressCallback) : cb!;
  const opHandle = getRegistry().register("WASMWork");
  const finish = (err: Error | null, result: Buffer): void => {
    try {
      callback(err, result);
    } finally {
      opHandle.close();
    }
  };
  ensureBrotli()
    .then((engine) => {
      if (!engine) {
        finish(new Error("Brotli WASM is not available"), Buffer.alloc(0));
        return;
      }
      try {
        const out = engine.decompress(new Uint8Array(input));
        finish(null, Buffer.from(out));
      } catch (e) {
        finish(e as Error, Buffer.alloc(0));
      }
    })
    .catch((e) => finish(e as Error, Buffer.alloc(0)));
}


export function gzipSync(input: Buffer | string, opts?: ZlibOptions): Buffer {
  return runSync(opGzip, input, opts);
}

export function gunzipSync(input: Buffer, opts?: ZlibOptions): Buffer {
  return runSync(opGunzip, input, opts);
}

export function deflateSync(input: Buffer | string, opts?: ZlibOptions): Buffer {
  return runSync(opDeflate, input, opts);
}

export function inflateSync(input: Buffer, opts?: ZlibOptions): Buffer {
  return runSync(opInflate, input, opts);
}

export function deflateRawSync(input: Buffer | string, opts?: ZlibOptions): Buffer {
  return runSync(opDeflateRaw, input, opts);
}

export function inflateRawSync(input: Buffer, opts?: ZlibOptions): Buffer {
  return runSync(opInflateRaw, input, opts);
}

export function brotliCompressSync(
  input: Buffer | string,
  _opts?: unknown,
): Buffer {
  if (!brotliInstance) {
    throw new Error(
      "Brotli WASM not loaded yet. Use async brotliCompress() or await preloadBrotli() first.",
    );
  }
  const data = typeof input === "string" ? Buffer.from(input) : input;
  return Buffer.from(brotliInstance.compress(new Uint8Array(data)));
}

export function brotliDecompressSync(input: Buffer, _opts?: unknown): Buffer {
  if (brotliInstance) {
    return Buffer.from(brotliInstance.decompress(new Uint8Array(input)));
  }
  // Pure JS fallback when WASM isn't ready yet
  return Buffer.from(brotliDecompressJs(new Uint8Array(input)));
}

// pako v2 may call onEnd synchronously during push(), moving chunks->result
function drainEngine(engine: { chunks: Uint8Array[]; result?: Uint8Array | null }): Buffer | null {
  if (engine.chunks && engine.chunks.length > 0) {
    const chunks = engine.chunks.splice(0);
    if (chunks.length === 1) return Buffer.from(chunks[0]);
    let total = 0;
    for (const c of chunks) total += c.length;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    return Buffer.from(merged);
  }
  if (engine.result && engine.result.length > 0) {
    const buf = Buffer.from(engine.result);
    engine.result = null;
    return buf;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  ZlibTransform (base)                                               */
/* ------------------------------------------------------------------ */

export interface ZlibTransform extends Transform {
  _opts: any;
  bytesWritten: number;
  _handle: { close: () => void };
  close(cb?: () => void): void;
  flush(cb?: (err: Error | null) => void): void;
  reset(): void;
  params(_level: number, _strategy: number, cb?: (err: Error | null) => void): void;
  _processChunk(chunk: Buffer | Uint8Array, flushFlag: number): Buffer | null;
}

interface ZlibTransformConstructor {
  new (opts?: any): ZlibTransform;
  (this: any, opts?: any): void;
  prototype: any;
}

const ZlibTransform = function ZlibTransform(this: any, opts?: any) {
  if (!this) return;
  Transform.call(this);
  this._opts = opts || {};
  this.bytesWritten = 0;
  this._handle = { close: () => {} };
} as unknown as ZlibTransformConstructor;

Object.setPrototypeOf(ZlibTransform.prototype, Transform.prototype);

ZlibTransform.prototype.close = function close(cb?: () => void): void {
  this.destroy();
  if (cb) queueMicrotask(cb);
};

ZlibTransform.prototype.flush = function flush(
  kindOrCb?: number | ((err: Error | null) => void),
  cb?: (err: Error | null) => void,
): void {
  const callback = typeof kindOrCb === "function" ? kindOrCb : cb;
  try {
    const engine = this._engine as { push?: (data: Uint8Array, mode?: boolean | number) => void; err?: number; msg?: string; result?: Uint8Array | null } | undefined;
    if (engine && typeof engine.push === "function") {
      // Z_SYNC_FLUSH-style: push empty with finish=false to emit buffered output
      engine.push(new Uint8Array(0), false);
      if (engine.err) {
        const err = new Error(engine.msg || "zlib flush error");
        if (callback) queueMicrotask(() => callback(err));
        return;
      }
      const out = drainEngine(engine as any);
      if (out && out.length > 0 && typeof this.push === "function") {
        this.push(out);
      }
    }
    if (callback) queueMicrotask(() => callback(null));
  } catch (e) {
    if (callback) queueMicrotask(() => callback(e as Error));
  }
};

ZlibTransform.prototype.reset = function reset(): void {
};

ZlibTransform.prototype.params = function params(
  _level: number,
  _strategy: number,
  cb?: (err: Error | null) => void,
): void {
  if (cb) queueMicrotask(() => cb(null));
};

// used by next/dist/compiled/tar's ZlibBase.write() for sync decompression
ZlibTransform.prototype._processChunk = function _processChunk(
  chunk: Buffer | Uint8Array,
  flushFlag: number,
): Buffer | null {
  let result: Buffer | null = null;
  this._transform(
    chunk,
    "buffer",
    ((err?: Error | null, data?: any) => {
      if (err) throw err;
      if (data) result = Buffer.from(data);
    }) as any,
  );
  // If Z_FINISH (4), also flush
  if (flushFlag === 4) {
    this._flush(((err?: Error | null, data?: any) => {
      if (err) throw err;
      if (data) {
        result = result
          ? Buffer.concat([result, Buffer.from(data)])
          : Buffer.from(data);
      }
    }) as any);
  }
  return result;
};

/* ------------------------------------------------------------------ */
/*  Gzip                                                                */
/* ------------------------------------------------------------------ */

export interface Gzip extends ZlibTransform {
  _engine: pako.Deflate;
}

interface GzipConstructor {
  new (opts?: any): Gzip;
  (this: any, opts?: any): void;
  prototype: any;
}

export const Gzip = function Gzip(this: any, opts?: any) {
  if (!this) return;
  ZlibTransform.call(this, opts);
  this._engine = new pako.Deflate({ ...(opts || {}), gzip: true });
} as unknown as GzipConstructor;

Object.setPrototypeOf(Gzip.prototype, ZlibTransform.prototype);

Gzip.prototype._transform = function _transform(
  chunk: any,
  _enc: string,
  done: (err: Error | null, data?: any) => void,
): void {
  try {
    this._engine.push(chunk, false);
    if (this._engine.err) {
      done(new Error(this._engine.msg || "Gzip error"));
      return;
    }
    const out = drainEngine(this._engine as any);
    done(null, out ?? undefined);
  } catch (e) {
    done(e as Error);
  }
};

Gzip.prototype._flush = function _flush(
  done: (err: Error | null, data?: any) => void,
): void {
  try {
    this._engine.push(new Uint8Array(0), true);
    const out = drainEngine(this._engine as any);
    done(null, out ?? undefined);
  } catch (e) {
    done(e as Error);
  }
};

/* ------------------------------------------------------------------ */
/*  Gunzip                                                              */
/* ------------------------------------------------------------------ */

export interface Gunzip extends ZlibTransform {
  _engine: pako.Inflate;
}

interface GunzipConstructor {
  new (opts?: any): Gunzip;
  (this: any, opts?: any): void;
  prototype: any;
}

export const Gunzip = function Gunzip(this: any, opts?: any) {
  if (!this) return;
  ZlibTransform.call(this, opts);
  // Node gunzip always expects a gzip header. pako only auto-adds +32 when
  // windowBits is omitted; an explicit windowBits:15 would stay zlib-only.
  const baseBits = opts?.windowBits ?? 15;
  this._engine = new pako.Inflate({
    ...(opts || {}),
    windowBits: baseBits + 16,
  });
} as unknown as GunzipConstructor;

Object.setPrototypeOf(Gunzip.prototype, ZlibTransform.prototype);

Gunzip.prototype._transform = function _transform(
  chunk: any,
  _enc: string,
  done: (err: Error | null, data?: any) => void,
): void {
  try {
    this._engine.push(chunk, false);
    if (this._engine.err) {
      done(new Error(this._engine.msg || "Gunzip error"));
      return;
    }
    const out = drainEngine(this._engine as any);
    done(null, out ?? undefined);
  } catch (e) {
    done(e as Error);
  }
};

Gunzip.prototype._flush = function _flush(
  done: (err: Error | null, data?: any) => void,
): void {
  try {
    this._engine.push(new Uint8Array(0), true);
    const out = drainEngine(this._engine as any);
    done(null, out ?? undefined);
  } catch (e) {
    done(e as Error);
  }
};

/* ------------------------------------------------------------------ */
/*  Deflate                                                             */
/* ------------------------------------------------------------------ */

export interface Deflate extends ZlibTransform {
  _engine: pako.Deflate;
}

interface DeflateConstructor {
  new (opts?: any): Deflate;
  (this: any, opts?: any): void;
  prototype: any;
}

export const Deflate = function Deflate(this: any, opts?: any) {
  if (!this) return;
  ZlibTransform.call(this, opts);
  this._engine = new pako.Deflate({ ...(opts || {}) });
} as unknown as DeflateConstructor;

Object.setPrototypeOf(Deflate.prototype, ZlibTransform.prototype);

Deflate.prototype._transform = function _transform(
  chunk: any,
  _enc: string,
  done: (err: Error | null, data?: any) => void,
): void {
  try {
    this._engine.push(chunk, false);
    if (this._engine.err) {
      done(new Error(this._engine.msg || "Deflate error"));
      return;
    }
    const out = drainEngine(this._engine as any);
    done(null, out ?? undefined);
  } catch (e) {
    done(e as Error);
  }
};

Deflate.prototype._flush = function _flush(
  done: (err: Error | null, data?: any) => void,
): void {
  try {
    this._engine.push(new Uint8Array(0), true);
    const out = drainEngine(this._engine as any);
    done(null, out ?? undefined);
  } catch (e) {
    done(e as Error);
  }
};

/* ------------------------------------------------------------------ */
/*  Inflate                                                             */
/* ------------------------------------------------------------------ */

export interface Inflate extends ZlibTransform {
  _engine: pako.Inflate;
}

interface InflateConstructor {
  new (opts?: any): Inflate;
  (this: any, opts?: any): void;
  prototype: any;
}

export const Inflate = function Inflate(this: any, opts?: any) {
  if (!this) return;
  ZlibTransform.call(this, opts);
  this._engine = new pako.Inflate({ ...(opts || {}) });
} as unknown as InflateConstructor;

Object.setPrototypeOf(Inflate.prototype, ZlibTransform.prototype);

Inflate.prototype._transform = function _transform(
  chunk: any,
  _enc: string,
  done: (err: Error | null, data?: any) => void,
): void {
  try {
    this._engine.push(chunk, false);
    if (this._engine.err) {
      done(new Error(this._engine.msg || "Inflate error"));
      return;
    }
    const out = drainEngine(this._engine as any);
    done(null, out ?? undefined);
  } catch (e) {
    done(e as Error);
  }
};

Inflate.prototype._flush = function _flush(
  done: (err: Error | null, data?: any) => void,
): void {
  try {
    this._engine.push(new Uint8Array(0), true);
    const out = drainEngine(this._engine as any);
    done(null, out ?? undefined);
  } catch (e) {
    done(e as Error);
  }
};

/* ------------------------------------------------------------------ */
/*  DeflateRaw                                                          */
/* ------------------------------------------------------------------ */

export interface DeflateRaw extends ZlibTransform {
  _engine: pako.Deflate;
}

interface DeflateRawConstructor {
  new (opts?: any): DeflateRaw;
  (this: any, opts?: any): void;
  prototype: any;
}

export const DeflateRaw = function DeflateRaw(this: any, opts?: any) {
  if (!this) return;
  ZlibTransform.call(this, opts);
  this._engine = new pako.Deflate({ ...(opts || {}), raw: true });
} as unknown as DeflateRawConstructor;

Object.setPrototypeOf(DeflateRaw.prototype, ZlibTransform.prototype);

DeflateRaw.prototype._transform = function _transform(
  chunk: any,
  _enc: string,
  done: (err: Error | null, data?: any) => void,
): void {
  try {
    this._engine.push(chunk, false);
    if (this._engine.err) {
      done(new Error(this._engine.msg || "DeflateRaw error"));
      return;
    }
    const out = drainEngine(this._engine as any);
    done(null, out ?? undefined);
  } catch (e) {
    done(e as Error);
  }
};

DeflateRaw.prototype._flush = function _flush(
  done: (err: Error | null, data?: any) => void,
): void {
  try {
    this._engine.push(new Uint8Array(0), true);
    const out = drainEngine(this._engine as any);
    done(null, out ?? undefined);
  } catch (e) {
    done(e as Error);
  }
};

/* ------------------------------------------------------------------ */
/*  InflateRaw                                                          */
/* ------------------------------------------------------------------ */

export interface InflateRaw extends ZlibTransform {
  _engine: pako.Inflate;
}

interface InflateRawConstructor {
  new (opts?: any): InflateRaw;
  (this: any, opts?: any): void;
  prototype: any;
}

export const InflateRaw = function InflateRaw(this: any, opts?: any) {
  if (!this) return;
  ZlibTransform.call(this, opts);
  this._engine = new pako.Inflate({ ...(opts || {}), raw: true });
} as unknown as InflateRawConstructor;

Object.setPrototypeOf(InflateRaw.prototype, ZlibTransform.prototype);

InflateRaw.prototype._transform = function _transform(
  chunk: any,
  _enc: string,
  done: (err: Error | null, data?: any) => void,
): void {
  try {
    this._engine.push(chunk, false);
    if (this._engine.err) {
      done(new Error(this._engine.msg || "InflateRaw error"));
      return;
    }
    const out = drainEngine(this._engine as any);
    done(null, out ?? undefined);
  } catch (e) {
    done(e as Error);
  }
};

InflateRaw.prototype._flush = function _flush(
  done: (err: Error | null, data?: any) => void,
): void {
  try {
    this._engine.push(new Uint8Array(0), true);
    const out = drainEngine(this._engine as any);
    done(null, out ?? undefined);
  } catch (e) {
    done(e as Error);
  }
};

/* ------------------------------------------------------------------ */
/*  Unzip                                                               */
/* ------------------------------------------------------------------ */

export interface Unzip extends ZlibTransform {
  _engine: pako.Inflate | null;
}

interface UnzipConstructor {
  new (opts?: any): Unzip;
  (this: any, opts?: any): void;
  prototype: any;
}

export const Unzip = function Unzip(this: any, opts?: any) {
  if (!this) return;
  ZlibTransform.call(this, opts);
  this._engine = null;
} as unknown as UnzipConstructor;

Object.setPrototypeOf(Unzip.prototype, ZlibTransform.prototype);

Unzip.prototype._transform = function _transform(
  chunk: any,
  _enc: string,
  done: (err: Error | null, data?: any) => void,
): void {
  try {
    if (!this._engine) {
      const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      // gzip magic: 1f 8b -> windowBits 15+16, otherwise auto-detect with 15+32
      const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
      this._engine = new pako.Inflate({
        windowBits: isGzip ? 15 + 16 : 15 + 32,
      });
    }
    this._engine.push(chunk, false);
    if (this._engine.err) {
      done(new Error(this._engine.msg || "Unzip error"));
      return;
    }
    const out = drainEngine(this._engine as any);
    done(null, out ?? undefined);
  } catch (e) {
    done(e as Error);
  }
};

Unzip.prototype._flush = function _flush(
  done: (err: Error | null, data?: any) => void,
): void {
  try {
    if (this._engine) {
      this._engine.push(new Uint8Array(0), true);
      const out = drainEngine(this._engine as any);
      done(null, out ?? undefined);
    } else {
      done(null);
    }
  } catch (e) {
    done(e as Error);
  }
};

/* ------------------------------------------------------------------ */
/*  BrotliCompressStream                                                */
/* ------------------------------------------------------------------ */

export interface BrotliCompressStream extends ZlibTransform {}

interface BrotliCompressStreamConstructor {
  new (opts?: any): BrotliCompressStream;
  (this: any, opts?: any): void;
  prototype: any;
}

export const BrotliCompressStream = function BrotliCompressStream(this: any, opts?: any) {
  if (!this) return;
  ZlibTransform.call(this, opts);
  this._chunks = [] as Uint8Array[];
} as unknown as BrotliCompressStreamConstructor;

Object.setPrototypeOf(BrotliCompressStream.prototype, ZlibTransform.prototype);

BrotliCompressStream.prototype._transform = function _transform(
  chunk: any,
  _enc: string,
  done: (err: Error | null, data?: any) => void,
): void {
  const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  (this._chunks as Uint8Array[]).push(data);
  done(null);
};

BrotliCompressStream.prototype._flush = function _flush(
  done: (err: Error | null, data?: any) => void,
): void {
  if (!brotliInstance) {
    done(new Error("Brotli WASM not loaded"));
    return;
  }
  try {
    const parts = this._chunks as Uint8Array[];
    let total = 0;
    for (const p of parts) total += p.length;
    const merged = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
      merged.set(p, pos);
      pos += p.length;
    }
    this._chunks = [];
    done(null, Buffer.from(brotliInstance.compress(merged)));
  } catch (e) {
    done(e as Error);
  }
};

/* ------------------------------------------------------------------ */
/*  BrotliDecompressStream                                              */
/* ------------------------------------------------------------------ */

export interface BrotliDecompressStream extends ZlibTransform {}

interface BrotliDecompressStreamConstructor {
  new (opts?: any): BrotliDecompressStream;
  (this: any, opts?: any): void;
  prototype: any;
}

export const BrotliDecompressStream = function BrotliDecompressStream(this: any, opts?: any) {
  if (!this) return;
  ZlibTransform.call(this, opts);
  this._chunks = [] as Uint8Array[];
} as unknown as BrotliDecompressStreamConstructor;

Object.setPrototypeOf(BrotliDecompressStream.prototype, ZlibTransform.prototype);

BrotliDecompressStream.prototype._transform = function _transform(
  chunk: any,
  _enc: string,
  done: (err: Error | null, data?: any) => void,
): void {
  const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  (this._chunks as Uint8Array[]).push(data);
  done(null);
};

BrotliDecompressStream.prototype._flush = function _flush(
  done: (err: Error | null, data?: any) => void,
): void {
  const parts = this._chunks as Uint8Array[];
  let total = 0;
  for (const p of parts) total += p.length;
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    merged.set(p, pos);
    pos += p.length;
  }
  this._chunks = [];
  try {
    if (brotliInstance) {
      done(null, Buffer.from(brotliInstance.decompress(merged)));
      return;
    }
    done(null, Buffer.from(brotliDecompressJs(merged)));
  } catch (e) {
    done(e as Error);
  }
};

export const BrotliCompress = BrotliCompressStream;
export const BrotliDecompress = BrotliDecompressStream;


export function createGzip(opts?: any): Gzip {
  return new Gzip(opts);
}

export function createGunzip(opts?: any): Gunzip {
  return new Gunzip(opts);
}

export function createDeflate(opts?: any): Deflate {
  return new Deflate(opts);
}

export function createInflate(opts?: any): Inflate {
  return new Inflate(opts);
}

export function createDeflateRaw(opts?: any): DeflateRaw {
  return new DeflateRaw(opts);
}

export function createInflateRaw(opts?: any): InflateRaw {
  return new InflateRaw(opts);
}

export function createUnzip(opts?: any): Unzip {
  return new Unzip(opts);
}

export function createBrotliCompress(opts?: any): BrotliCompressStream {
  return new BrotliCompressStream(opts);
}

export function createBrotliDecompress(opts?: any): BrotliDecompressStream {
  return new BrotliDecompressStream(opts);
}


export const constants = {
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2,
  Z_RLE: 3,
  Z_FIXED: 4,
  Z_DEFAULT_STRATEGY: 0,
  ZLIB_VERNUM: 4784,
  Z_MIN_WINDOWBITS: 8,
  Z_MAX_WINDOWBITS: 15,
  Z_DEFAULT_WINDOWBITS: 15,
  Z_MIN_CHUNK: 64,
  Z_MAX_CHUNK: Infinity,
  Z_DEFAULT_CHUNK: 16384,
  Z_MIN_MEMLEVEL: 1,
  Z_MAX_MEMLEVEL: 9,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_MIN_LEVEL: -1,
  Z_MAX_LEVEL: 9,
  Z_DEFAULT_LEVEL: -1,
  BROTLI_DECODE: 0,
  BROTLI_ENCODE: 1,
  BROTLI_OPERATION_PROCESS: 0,
  BROTLI_OPERATION_FLUSH: 1,
  BROTLI_OPERATION_FINISH: 2,
  BROTLI_OPERATION_EMIT_METADATA: 3,
  BROTLI_PARAM_MODE: 0,
  BROTLI_MODE_GENERIC: 0,
  BROTLI_MODE_TEXT: 1,
  BROTLI_MODE_FONT: 2,
  BROTLI_PARAM_QUALITY: 1,
  BROTLI_MIN_QUALITY: 0,
  BROTLI_MAX_QUALITY: 11,
  BROTLI_DEFAULT_QUALITY: 11,
  BROTLI_PARAM_LGWIN: 2,
  BROTLI_MIN_WINDOW_BITS: 10,
  BROTLI_MAX_WINDOW_BITS: 24,
  BROTLI_DEFAULT_WINDOW: 22,
  BROTLI_PARAM_LGBLOCK: 3,
  BROTLI_MIN_INPUT_BLOCK_BITS: 16,
  BROTLI_MAX_INPUT_BLOCK_BITS: 24,
};

function promisifyZlib(
  fn: (input: any, optsOrCb: any, cb?: CompressCallback) => void,
): (input: Buffer | string, opts?: unknown) => Promise<Buffer> {
  return (input: Buffer | string, opts?: unknown) =>
    new Promise((resolve, reject) => {
      fn(input, opts ?? {}, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
}

export const promises = {
  gzip: promisifyZlib(gzip),
  gunzip: promisifyZlib(gunzip),
  deflate: promisifyZlib(deflate),
  inflate: promisifyZlib(inflate),
  deflateRaw: promisifyZlib(deflateRaw),
  inflateRaw: promisifyZlib(inflateRaw),
  unzip: promisifyZlib(unzip),
  brotliCompress: promisifyZlib(brotliCompress),
  brotliDecompress: promisifyZlib(brotliDecompress),
};

export default {
  gzip,
  gunzip,
  deflate,
  inflate,
  deflateRaw,
  inflateRaw,
  unzip,
  brotliCompress,
  brotliDecompress,
  gzipSync,
  gunzipSync,
  deflateSync,
  inflateSync,
  deflateRawSync,
  inflateRawSync,
  unzipSync,
  crc32,
  brotliCompressSync,
  brotliDecompressSync,
  preloadBrotli,
  Gzip,
  Gunzip,
  Deflate,
  Inflate,
  DeflateRaw,
  InflateRaw,
  Unzip,
  BrotliCompress: BrotliCompressStream,
  BrotliDecompress: BrotliDecompressStream,
  // Stream creators
  createGzip,
  createGunzip,
  createDeflate,
  createInflate,
  createDeflateRaw,
  createInflateRaw,
  createUnzip,
  createBrotliCompress,
  createBrotliDecompress,
  // Constants
  constants,
  promises,
};
