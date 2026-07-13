// WASM compilation cache. Browsers block sync WebAssembly.Module() for large
// buffers on the main thread, so we either precompile in the background or
// offload to a worker where there's no size limit.
//
// Two tiers:
//   L1 — in-memory map keyed by a fast synchronous content hash (dual-lane
//        FNV-1a + length), consulted from the patched WebAssembly.Module
//        constructor which cannot await.
//   L2 — IndexedDB keyed by SHA-256, storing the compiled WebAssembly.Module
//        via structured clone (Chromium/Firefox). Warm reloads skip compile.

import {
  getWasmModuleCache,
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

function trimModuleCache(): void {
  let bytes = 0;
  for (const entry of moduleCache.values()) bytes += entry.sourceBytes;
  while (bytes > MODULE_CACHE_MAX_BYTES && moduleCache.size > 1) {
    const oldest = moduleCache.keys().next().value as string | undefined;
    if (!oldest) break;
    const entry = moduleCache.get(oldest)!;
    moduleCache.delete(oldest);
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

function toArrayBuffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
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
async function loadPersistedModule(
  bytes: Uint8Array,
): Promise<WebAssembly.Module | null> {
  try {
    const cache = await getWasmModuleCache();
    if (!cache) return null;
    return await cache.get(await wasmContentHash(bytes));
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
  const key = quickWasmHash(bytes);
  moduleCache.set(key, {
    promise: Promise.resolve(module),
    module,
    sourceBytes: bytes.byteLength,
  });
  trimModuleCache();
  persistModule(bytes, module);
}

// Call as early as possible (e.g. when writing .wasm to VFS)
export function precompileWasm(bytes: Uint8Array | ArrayBuffer): void {
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
      const persisted = await loadPersistedModule(stable);
      if (persisted) return persisted;
      const mod = await WebAssembly.compile(stable as BufferSource);
      persistModule(stable, mod);
      return mod;
    })(),
    module: null,
    sourceBytes: stable.byteLength,
  };
  entry.promise.then(
    (m) => { entry.module = m; },
    () => { moduleCache.delete(key); },
  );
  moduleCache.set(key, entry);
  trimModuleCache();
}

export function getCachedModule(bytes: BufferSource): WebAssembly.Module | null {
  // hashing is a single pass over the buffer; only paid on wasm construction
  const entry = moduleCache.get(quickWasmHash(toUint8(bytes)));
  if (entry?.module) return entry.module;
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
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
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
  if (existing?.module) return Promise.resolve(existing.module);

  const stable = view.slice();
  const promise = (async () => {
    const persisted = await loadPersistedModule(stable);
    if (persisted) return persisted;

    const mod = await new Promise<WebAssembly.Module>((resolve, reject) => {
      try {
        const worker = getCompileWorker();
        const id = _nextCompileId++;
        _pendingCompiles.set(id, { resolve, reject });
        const ab = toArrayBuffer(stable.slice());
        worker.postMessage({ id, bytes: ab }, [ab]);
      } catch {
        // No workers — fall back to async compile on this thread
        WebAssembly.compile(stable as BufferSource).then(resolve, reject);
      }
    });
    persistModule(stable, mod);
    return mod;
  })();

  const entry: CacheEntry = { promise, module: null, sourceBytes: stable.byteLength };
  promise.then(
    (m) => { entry.module = m; },
    () => { moduleCache.delete(key); },
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
