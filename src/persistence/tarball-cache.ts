// IndexedDB-backed cache of compressed npm tarballs, keyed by tarball URL.
// Lets warm installs skip the network entirely. All methods are best-effort:
// any IDB failure degrades to a cache miss, never a thrown error.

const DB_NAME = "nodepod-tarballs";
const STORE_NAME = "tarballs";
const DB_VERSION = 1;

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024; // 256MB
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

interface TarballEntry {
  bytes: ArrayBuffer;
  integrity?: string;
  storedAt: number;
  size: number;
}

export interface TarballCache {
  get(url: string): Promise<ArrayBuffer | null>;
  put(url: string, bytes: ArrayBuffer, integrity?: string): Promise<void>;
  prune(maxBytes?: number, maxAgeMs?: number): Promise<void>;
  close(): void;
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

function idbGet(db: IDBDatabase, key: string): Promise<TarballEntry | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as TarballEntry) ?? null);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: TarballEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function openTarballCache(): Promise<TarballCache | null> {
  const db = await openDB();
  if (!db) return null;

  return {
    async get(url: string): Promise<ArrayBuffer | null> {
      try {
        const entry = await idbGet(db, url);
        if (!entry?.bytes) return null;
        if (Date.now() - entry.storedAt > DEFAULT_MAX_AGE_MS) return null;
        return entry.bytes;
      } catch {
        return null;
      }
    },

    async put(url: string, bytes: ArrayBuffer, integrity?: string): Promise<void> {
      try {
        await idbPut(db, url, {
          bytes,
          integrity,
          storedAt: Date.now(),
          size: bytes.byteLength,
        });
      } catch {
        /* quota or transaction failure — cache is optional */
      }
    },

    // Evict expired entries, then oldest-first until under the byte budget.
    prune(maxBytes = DEFAULT_MAX_BYTES, maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<void> {
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, "readwrite");
          const store = tx.objectStore(STORE_NAME);
          const req = store.openCursor();
          const now = Date.now();
          const kept: Array<{ key: IDBValidKey; storedAt: number; size: number }> = [];

          req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
              const entry = cursor.value as TarballEntry;
              if (!entry?.storedAt || now - entry.storedAt > maxAgeMs) {
                cursor.delete();
              } else {
                kept.push({ key: cursor.key, storedAt: entry.storedAt, size: entry.size ?? 0 });
              }
              cursor.continue();
              return;
            }
            // cursor exhausted — evict oldest until under budget
            let total = kept.reduce((sum, e) => sum + e.size, 0);
            if (total > maxBytes) {
              kept.sort((a, b) => a.storedAt - b.storedAt);
              const evictTx = db.transaction(STORE_NAME, "readwrite");
              const evictStore = evictTx.objectStore(STORE_NAME);
              for (const e of kept) {
                if (total <= maxBytes) break;
                evictStore.delete(e.key);
                total -= e.size;
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

/* singleton for the extract dispatch path — opened once per realm */
let _singleton: Promise<TarballCache | null> | null = null;

export function getTarballCache(): Promise<TarballCache | null> {
  if (!_singleton) _singleton = openTarballCache();
  return _singleton;
}
