// WASM compilation cache. Browsers block sync WebAssembly.Module() for large
// buffers on the main thread, so we either precompile in the background or
// offload to a worker where there's no size limit.
//
// Two tiers:
//   L1 — in-memory map keyed by a full synchronous SHA-256 digest,
//        consulted from the patched WebAssembly.Module
//        constructor which cannot await.
//   L2 — IndexedDB keyed by SHA-256, storing the compiled WebAssembly.Module
//        via structured clone (Chromium/Firefox). Warm reloads skip compile.

import { untrackedWasm } from "./event-loop";
import { readWasmMemoryImports, rememberWasmMemoryRequirements, wasmMemoryRequirements } from "./wasm-memory-clamp";
import {
  getWasmModuleCache,
  isHashingWasmContent,
  quickWasmHash,
  wasmContentHash,
} from "../persistence/wasm-module-cache";

const PRECOMPILE_THRESHOLD = 4 * 1024 * 1024; // 4 MB

type CacheEntry = {
  promise: Promise<WebAssembly.Module>;
  module: WebAssembly.Module | null;
  sourceBytes: number;
};

// L1: keyed by quickWasmHash(bytes) — content-derived, sync to compute
const moduleCache = new Map<string, CacheEntry>();
const MODULE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const MODULE_CACHE_MAX_ENTRIES = 64;

function trimModuleCache(): void {
  let bytes = 0;
  for (const entry of moduleCache.values()) bytes += entry.sourceBytes;
  for (const [key, entry] of moduleCache) {
    if ((bytes <= MODULE_CACHE_MAX_BYTES && moduleCache.size <= MODULE_CACHE_MAX_ENTRIES) || moduleCache.size <= 1) break;
    // In-flight work must remain discoverable or a new reader starts a
    // duplicate compile while the evicted promise still holds its binary.
    if (!entry.module) continue;
    moduleCache.delete(key);
    bytes -= entry.sourceBytes;
  }
}

function actualByteLength(bytes: ArrayBuffer | ArrayBufferView): number {
  return bytes.byteLength;
}

function toUint8(bytes: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// Persist a compiled module to IDB, keyed by SHA-256 of its bytes.
function persistModule(bytes: Uint8Array, module: WebAssembly.Module): void {
  wasmContentHash(bytes)
    .then(async (hash) => {
      const cache = await getWasmModuleCache();
      if (cache) await cache.put(hash, module);
    })
    .catch(() => {});
}

// Look up a previously-persisted module. Returns null on any failure.
async function loadPersistedModule(hash: string): Promise<WebAssembly.Module | null> {
  try {
    const cache = await getWasmModuleCache();
    if (!cache) return null;
    return await cache.get(hash);
  } catch {
    return null;
  }
}

// Register an externally-compiled module (e.g. from compileStreaming) in
// both tiers so later sync constructions hit the cache.
export function registerCompiledModule(
  bytes: Uint8Array,
  module: WebAssembly.Module,
): void {
  rememberWasmMemoryRequirements(module, readWasmMemoryImports(bytes));
  if (isHashingWasmContent()) return;
  const key = quickWasmHash(bytes);
  moduleCache.set(key, {
    promise: Promise.resolve(module),
    module,
    sourceBytes: bytes.byteLength,
  });
  trimModuleCache();
  persistModule(bytes, module);
}

// Warm asynchronous reads whose callers can use a background compilation.
export function precompileWasm(bytes: Uint8Array | ArrayBuffer): void {
  if (isHashingWasmContent()) return;
  if (typeof WebAssembly === "undefined") return;
  if (actualByteLength(bytes) < PRECOMPILE_THRESHOLD) return;

  const view = toUint8(bytes);
  const key = quickWasmHash(view);
  if (moduleCache.has(key)) return;

  // Hold a stable copy: callers may mutate/transfer their buffer, and both
  // the IDB-miss compile and the SHA-256 hash need the original bytes.
  const stable = view.slice();
  const entry: CacheEntry = {
    promise: (async () => {
      const hash = await wasmContentHash(stable);
      // A synchronous constructor may have compiled the bytes while the
      // digest was pending. Use its result instead of compiling again.
      const completed = moduleCache.get(key)?.module;
      if (completed) return completed;
      const persisted = await loadPersistedModule(hash);
      const compiledMeanwhile = moduleCache.get(key)?.module;
      if (compiledMeanwhile) return compiledMeanwhile;
      if (persisted) {
        rememberWasmMemoryRequirements(persisted, readWasmMemoryImports(stable));
        return persisted;
      }
      // a warm-up nobody awaits: it mustn't keep the process alive
      const mod = await untrackedWasm(() => WebAssembly.compile(stable as BufferSource));
      rememberWasmMemoryRequirements(mod, readWasmMemoryImports(stable));
      void getWasmModuleCache().then((cache) => cache?.put(hash, mod)).catch(() => {});
      return mod;
    })(),
    module: null,
    sourceBytes: stable.byteLength,
  };
  entry.promise.then(
    (m) => { entry.module = m; trimModuleCache(); },
    () => { if (moduleCache.get(key) === entry) moduleCache.delete(key); },
  );
  moduleCache.set(key, entry);
  trimModuleCache();
}

export function getCachedModule(bytes: BufferSource): WebAssembly.Module | null {
  if (isHashingWasmContent()) return null;
  // hashing is a single pass over the buffer; only paid on wasm construction
  const key = quickWasmHash(toUint8(bytes));
  const entry = moduleCache.get(key);
  if (entry?.module) {
    // Reads refresh the LRU; frequently used code stays hot under pressure.
    moduleCache.delete(key);
    moduleCache.set(key, entry);
    return entry.module;
  }
  return null;
}

// Worker-based compilation (no size limit in workers). One persistent worker
// is lazily created and reused across compiles instead of a throwaway worker
// per call.
let _compileWorker: Worker | null = null;
let _nextCompileId = 1;
const _pendingCompiles = new Map<
  number,
  { resolve: (m: WebAssembly.Module) => void; reject: (e: Error) => void }
>();

function getCompileWorker(): Worker {
  if (_compileWorker) return _compileWorker;
  const code = `
    self.onmessage = function(e) {
      try {
        var mod = new WebAssembly.Module(e.data.bytes);
        self.postMessage({ id: e.data.id, ok: true, module: mod });
      } catch (err) {
        self.postMessage({ id: e.data.id, ok: false, error: err.message });
      }
    };
  `;
  const url = URL.createObjectURL(
    new Blob([code], { type: "application/javascript" }),
  );
  let worker: Worker;
  try {
    worker = new Worker(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  worker.onmessage = (e: MessageEvent) => {
    const { id, ok, module, error } = e.data;
    const pending = _pendingCompiles.get(id);
    if (!pending) return;
    _pendingCompiles.delete(id);
    if (ok) pending.resolve(module);
    else pending.reject(new Error(error));
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || "Worker compilation failed");
    for (const pending of _pendingCompiles.values()) pending.reject(err);
    _pendingCompiles.clear();
    worker.terminate();
    if (_compileWorker === worker) _compileWorker = null;
  };
  _compileWorker = worker;
  return worker;
}

export function compileWasmInWorker(
  bytes: Uint8Array | ArrayBuffer,
): Promise<WebAssembly.Module> {
  const view = toUint8(bytes);
  const key = quickWasmHash(view);

  const existing = moduleCache.get(key);
  // A pending warm-up is already doing exactly this work. Share its promise
  // instead of retaining another binary and starting a second compilation.
  if (existing) return existing.promise;

  const stable = view.slice();
  const promise = (async () => {
    const hash = await wasmContentHash(stable);
    const completed = moduleCache.get(key)?.module;
    if (completed) return completed;
    const persisted = await loadPersistedModule(hash);
    const compiledMeanwhile = moduleCache.get(key)?.module;
    if (compiledMeanwhile) return compiledMeanwhile;
    if (persisted) {
      rememberWasmMemoryRequirements(persisted, readWasmMemoryImports(stable));
      return persisted;
    }

    // Parse before transferring our only owned copy. No bytes need to stay
    // alive for persistence: the digest has already been calculated.
    const requirements = readWasmMemoryImports(stable);

    const mod = await new Promise<WebAssembly.Module>((resolve, reject) => {
      let id: number | undefined;
      try {
        const worker = getCompileWorker();
        id = _nextCompileId++;
        _pendingCompiles.set(id, { resolve, reject });
        const ab = stable.buffer;
        worker.postMessage({ id, bytes: ab }, [ab]);
      } catch (error) {
        if (id !== undefined) _pendingCompiles.delete(id);
        // A failed transfer must not leave an unresolved task retaining its
        // callbacks. Only retry while we still own the source bytes.
        if (stable.byteLength === 0) { reject(error); return; }
        // No workers — fall back to async compile on this thread
        WebAssembly.compile(stable as BufferSource).then(resolve, reject);
      }
    });
    rememberWasmMemoryRequirements(mod, requirements);
    void getWasmModuleCache().then((cache) => cache?.put(hash, mod)).catch(() => {});
    return mod;
  })();

  const entry: CacheEntry = { promise, module: null, sourceBytes: view.byteLength };
  promise.then(
    (m) => { entry.module = m; trimModuleCache(); },
    () => { if (moduleCache.get(key) === entry) moduleCache.delete(key); },
  );
  moduleCache.set(key, entry);
  trimModuleCache();
  return promise;
}

export function needsAsyncCompile(bytes: BufferSource): boolean {
  return actualByteLength(bytes) >= PRECOMPILE_THRESHOLD;
}

export function wasmCacheStats(): { entries: number; pending: number } {
  let pending = 0;
  for (const entry of moduleCache.values()) if (!entry.module) pending++;
  return { entries: moduleCache.size, pending };
}

/** Drop only completed, reproducible modules. In-flight compiles stay live. */
export function reclaimWasmCache(): void {
  for (const [key, entry] of moduleCache) {
    if (entry.module) moduleCache.delete(key);
  }
  if (_compileWorker && _pendingCompiles.size === 0) {
    _compileWorker.terminate();
    _compileWorker = null;
  }
}

// Each constructor produces a distinct JS object while the host shares the
// compiled code. Hosts without module cloning fall back to compilation.
export function cloneCachedModule(module: WebAssembly.Module): WebAssembly.Module | null {
  try {
    const clone = structuredClone(module);
    rememberWasmMemoryRequirements(clone, wasmMemoryRequirements(module) ?? null);
    return clone;
  } catch {
    return null;
  }
}

export function disposeWasmCache(): void {
  moduleCache.clear();
  for (const pending of _pendingCompiles.values()) {
    pending.reject(new Error("Nodepod runtime disposed"));
  }
  _pendingCompiles.clear();
  if (_compileWorker) {
    try { _compileWorker.terminate(); } catch { /* ignore */ }
    _compileWorker = null;
  }
}

export { PRECOMPILE_THRESHOLD };
