// IndexedDB-backed cache of compressed npm tarballs, keyed by tarball URL.
// Lets warm installs skip the network entirely. All methods are best-effort:
// any IDB failure degrades to a cache miss, never a thrown error.

const DB_NAME = "nodepod-tarballs";
const STORE_NAME = "tarballs";
// { storedAt, size } per tarball, so pruning never reads the archives
// themselves back (version 2)
const META_STORE_NAME = "meta";
const DB_VERSION = 2;

interface TarballMeta {
  storedAt: number;
  size: number;
}

// archives handed out by get(), with when they were stored: extraction
// writes an archive back only when that refreshes an old entry (see
// shouldRefreshTarball)
const handedOutAt = new WeakMap<ArrayBuffer, number>();
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Whether storing `bytes` again is worth it: false for an archive this cache
 * just returned from an entry stored within the last day (writing it back
 * would only move its age).
 */
export function shouldRefreshTarball(bytes: ArrayBuffer): boolean {
  const storedAt = handedOutAt.get(bytes);
  return storedAt === undefined || Date.now() - storedAt > REFRESH_AFTER_MS;
}

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
  clear(): Promise<void>;
  close(): void;
}

function openDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      let settled = false;
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const tx = req.transaction!;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
        if (!db.objectStoreNames.contains(META_STORE_NAME)) {
          const meta = db.createObjectStore(META_STORE_NAME);
          // entries stored before the meta store existed: record theirs once
          if ((event as IDBVersionChangeEvent).oldVersion >= 1) {
            const cursorReq = tx.objectStore(STORE_NAME).openCursor();
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (!cursor) return;
              const entry = cursor.value as TarballEntry | undefined;
              meta.put(
                { storedAt: entry?.storedAt ?? 0, size: entry?.size ?? 0 } satisfies TarballMeta,
                cursor.key,
              );
              cursor.continue();
            };
          }
        }
      };
      req.onsuccess = () => {
        if (settled) {
          // gave up waiting (blocked): don't hold a connection nobody uses
          try { req.result.close(); } catch { /* ignore */ }
          return;
        }
        settled = true;
        // a newer page upgrading the database: step aside instead of blocking it
        req.result.onversionchange = () => {
          try { req.result.close(); } catch { /* ignore */ }
        };
        resolve(req.result);
      };
      req.onerror = () => {
        settled = true;
        resolve(null);
      };
      // an older page still holds the version 1 database open: run
      // without the cache rather than wait for it to close
      req.onblocked = () => {
        if (settled) return;
        settled = true;
        resolve(null);
      };
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
    const tx = db.transaction([STORE_NAME, META_STORE_NAME], "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.objectStore(META_STORE_NAME).put({ storedAt: value.storedAt, size: value.size } satisfies TarballMeta, key);
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
        handedOutAt.set(entry.bytes, entry.storedAt);
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

    clear(): Promise<void> {
      return new Promise((resolve) => {
        try {
          const tx = db.transaction([STORE_NAME, META_STORE_NAME], "readwrite");
          tx.objectStore(STORE_NAME).clear();
          tx.objectStore(META_STORE_NAME).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    // Evict expired entries, then oldest-first until under the byte budget.
    prune(maxBytes = DEFAULT_MAX_BYTES, maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<void> {
      return new Promise((resolve) => {
        try {
          // walk the small meta records, never the archives
          const tx = db.transaction([STORE_NAME, META_STORE_NAME], "readwrite");
          const store = tx.objectStore(STORE_NAME);
          const req = tx.objectStore(META_STORE_NAME).openCursor();
          const now = Date.now();
          const kept: Array<{ key: IDBValidKey; storedAt: number; size: number }> = [];

          req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
              const entry = cursor.value as TarballMeta;
              if (!entry?.storedAt || now - entry.storedAt > maxAgeMs) {
                store.delete(cursor.key);
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
              const evictTx = db.transaction([STORE_NAME, META_STORE_NAME], "readwrite");
              const evictStore = evictTx.objectStore(STORE_NAME);
              const evictMeta = evictTx.objectStore(META_STORE_NAME);
              for (const e of kept) {
                if (total <= maxBytes) break;
                evictStore.delete(e.key);
                evictMeta.delete(e.key);
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
