// Zlib polyfill using pako for deflate/inflate/gzip + optional brotli-wasm

import { Buffer } from "./buffer";
import { Transform } from "./stream";
import { CDN_BROTLI_WASM, cdnImport } from "../constants/cdn-urls";
// Pure JS brotli decompressor (no WASM, no Node APIs) - sync fallback
// @ts-ignore - no type declarations for brotli/decompress
import brotliJsDecompress from "brotli/decompress";
import pako from "pako";
import { getRegistry } from "../helpers/event-loop";


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

/** Pure JS brotli decompressor, used as sync fallback when WASM isn't ready. */
function brotliDecompressJs(input: Uint8Array): Uint8Array {
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

export function gzip(input: Buffer | string, cb: CompressCallback): void {
  try {
    const data = typeof input === "string" ? Buffer.from(input) : input;
    const compressed = pako.gzip(data);
    cb(null, Buffer.from(compressed));
  } catch (e) {
    cb(e as Error, Buffer.alloc(0));
  }
}

export function gunzip(input: Buffer, cb: CompressCallback): void {
  try {
    const decompressed = pako.ungzip(input);
    cb(null, Buffer.from(decompressed));
  } catch (e) {
    cb(e as Error, Buffer.alloc(0));
  }
}

export function deflate(input: Buffer | string, cb: CompressCallback): void {
  try {
    const data = typeof input === "string" ? Buffer.from(input) : input;
    const compressed = pako.deflate(data);
    cb(null, Buffer.from(compressed));
  } catch (e) {
    cb(e as Error, Buffer.alloc(0));
  }
}

export function inflate(input: Buffer, cb: CompressCallback): void {
  try {
    const decompressed = pako.inflate(input);
    cb(null, Buffer.from(decompressed));
  } catch (e) {
    cb(e as Error, Buffer.alloc(0));
  }
}

export function deflateRaw(input: Buffer | string, cb: CompressCallback): void {
  try {
    const data = typeof input === "string" ? Buffer.from(input) : input;
    const compressed = pako.deflateRaw(data);
    cb(null, Buffer.from(compressed));
  } catch (e) {
    cb(e as Error, Buffer.alloc(0));
  }
}

export function inflateRaw(input: Buffer, cb: CompressCallback): void {
  try {
    const decompressed = pako.inflateRaw(input);
    cb(null, Buffer.from(decompressed));
  } catch (e) {
    cb(e as Error, Buffer.alloc(0));
  }
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


export function gzipSync(input: Buffer | string): Buffer {
  const data = typeof input === "string" ? Buffer.from(input) : input;
  return Buffer.from(pako.gzip(data));
}

export function gunzipSync(input: Buffer): Buffer {
  return Buffer.from(pako.ungzip(input));
}

export function deflateSync(input: Buffer | string): Buffer {
  const data = typeof input === "string" ? Buffer.from(input) : input;
  return Buffer.from(pako.deflate(data));
}

export function inflateSync(input: Buffer): Buffer {
  return Buffer.from(pako.inflate(input));
}

export function deflateRawSync(input: Buffer | string): Buffer {
  const data = typeof input === "string" ? Buffer.from(input) : input;
  return Buffer.from(pako.deflateRaw(data));
}

export function inflateRawSync(input: Buffer): Buffer {
  return Buffer.from(pako.inflateRaw(input));
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

ZlibTransform.prototype.flush = function flush(cb?: (err: Error | null) => void): void {
  if (cb) queueMicrotask(() => cb(null));
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
  this._engine = new pako.Inflate({ ...(opts || {}) });
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
} as unknown as BrotliCompressStreamConstructor;

Object.setPrototypeOf(BrotliCompressStream.prototype, ZlibTransform.prototype);

BrotliCompressStream.prototype._transform = function _transform(
  chunk: any,
  _enc: string,
  done: (err: Error | null, data?: any) => void,
): void {
  if (!brotliInstance) {
    done(new Error("Brotli WASM not loaded"));
    return;
  }
  try {
    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    done(null, Buffer.from(brotliInstance.compress(data)));
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
} as unknown as BrotliDecompressStreamConstructor;

Object.setPrototypeOf(BrotliDecompressStream.prototype, ZlibTransform.prototype);

BrotliDecompressStream.prototype._transform = function _transform(
  chunk: any,
  _enc: string,
  done: (err: Error | null, data?: any) => void,
): void {
  if (!brotliInstance) {
    done(new Error("Brotli WASM not loaded"));
    return;
  }
  try {
    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    done(null, Buffer.from(brotliInstance.decompress(data)));
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

export default {
  gzip,
  gunzip,
  deflate,
  inflate,
  deflateRaw,
  inflateRaw,
  brotliCompress,
  brotliDecompress,
  gzipSync,
  gunzipSync,
  deflateSync,
  inflateSync,
  deflateRawSync,
  inflateRawSync,
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
};
