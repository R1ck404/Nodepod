// IndexedDB-backed cache of compiled WebAssembly.Module objects, keyed by
// content hash. Chromium and Firefox support structured-cloning compiled
// modules into IDB, which lets warm reloads skip recompiling 10-16MB
// binaries entirely. Browsers without clone support (and non-browser
// environments) degrade to a no-op: every operation is best-effort and a
// failure is just a cache miss.

const DB_NAME = "nodepod-wasm-modules";
const STORE_NAME = "wasmModules";
const DB_VERSION = 1;

const MAX_ENTRIES = 32;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface WasmModuleEntry {
  module: WebAssembly.Module;
  storedAt: number;
}

export interface WasmModuleCache {
  get(hash: string): Promise<WebAssembly.Module | null>;
  put(hash: string, module: WebAssembly.Module): Promise<void>;
  close(): void;
}

// Fast synchronous content hash: dual-lane FNV-1a over the full buffer plus
// the byte length. Used as the in-memory (L1) cache key where we cannot
// await crypto.subtle. One pass over 16MB costs single-digit milliseconds.
export function quickWasmHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ b, 0x01000197) >>> 0;
  }
  return `${h1.toString(16)}-${h2.toString(16)}-${bytes.length.toString(16)}`;
}

// Strong content hash for the persistent (IDB) key. Falls back to the quick
// hash when crypto.subtle is unavailable (insecure contexts).
export async function wasmContentHash(bytes: Uint8Array): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const buf = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const digest = await subtle.digest("SHA-256", buf);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    /* fall through */
  }
  return "fnv:" + quickWasmHash(bytes);
}

function openDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<WasmModuleEntry | null> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as WasmModuleEntry) ?? null);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

function idbPut(db: IDBDatabase, key: string, value: WasmModuleEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      // .put() throws synchronously with DataCloneError if this browser
      // can't structured-clone a WebAssembly.Module (historically Safari)
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    } catch (e) {
      reject(e);
    }
  });
}

// Evict expired entries, then oldest-first until at most MAX_ENTRIES remain.
// Compiled modules can be tens of MB each, so the count bound doubles as a
// rough byte budget.
function idbPrune(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      const now = Date.now();
      const kept: Array<{ key: IDBValidKey; storedAt: number }> = [];

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const entry = cursor.value as WasmModuleEntry;
          if (!entry?.storedAt || now - entry.storedAt > MAX_AGE_MS) {
            cursor.delete();
          } else {
            kept.push({ key: cursor.key, storedAt: entry.storedAt });
          }
          cursor.continue();
          return;
        }
        if (kept.length > MAX_ENTRIES) {
          kept.sort((a, b) => a.storedAt - b.storedAt);
          const evictTx = db.transaction(STORE_NAME, "readwrite");
          const evictStore = evictTx.objectStore(STORE_NAME);
          for (const e of kept.slice(0, kept.length - MAX_ENTRIES)) {
            evictStore.delete(e.key);
          }
        }
        resolve();
      };
      req.onerror = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function createCache(): Promise<WasmModuleCache | null> {
  const db = await openDB();
  if (!db) return null;

  // Flipped to false the first time a structured clone of a Module fails,
  // so we stop paying for doomed put() attempts.
  let cloneSupported = true;

  return {
    async get(hash: string): Promise<WebAssembly.Module | null> {
      try {
        const entry = await idbGet(db, hash);
        if (!entry?.module) return null;
        if (Date.now() - entry.storedAt > MAX_AGE_MS) return null;
        if (
          typeof WebAssembly !== "undefined" &&
          !(entry.module instanceof WebAssembly.Module)
        ) {
          return null;
        }
        return entry.module;
      } catch {
        return null;
      }
    },

    async put(hash: string, module: WebAssembly.Module): Promise<void> {
      if (!cloneSupported) return;
      try {
        await idbPut(db, hash, { module, storedAt: Date.now() });
        idbPrune(db).catch(() => {});
      } catch (e: any) {
        if (e?.name === "DataCloneError") cloneSupported = false;
      }
    },

    close(): void {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

let _singleton: Promise<WasmModuleCache | null> | null = null;

export function getWasmModuleCache(): Promise<WasmModuleCache | null> {
  if (!_singleton) _singleton = createCache();
  return _singleton;
}

/** Test hook: reset the singleton so a fresh environment can be simulated. */
export function __resetWasmModuleCacheForTests(): void {
  _singleton = null;
}
