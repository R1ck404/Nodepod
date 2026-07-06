// IndexedDB-backed cache for node_modules snapshots.
// Keyed by a hash of the package.json contents so stale caches auto-invalidate.
//
// v2 (plan 015): snapshots are stored in the flat binary format (offset
// manifest + one ArrayBuffer) instead of base64-encoded VolumeSnapshots.
// The schema bump means v1 entries are simply ignored and age out.

import type { VFSBinarySnapshot } from '../threading/worker-protocol';

const DB_NAME = 'nodepod-snapshots';
const STORE_NAME = 'snapshots';
const DB_VERSION = 2;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SCHEMA = 2; // stored per entry; entries with a different schema are misses

export interface IDBSnapshotCache {
  get(packageJsonHash: string): Promise<VFSBinarySnapshot | null>;
  set(packageJsonHash: string, snapshot: VFSBinarySnapshot): Promise<void>;
  close(): void;
}

function openDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
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

function idbGet(db: IDBDatabase, key: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbCleanExpired(db: IDBDatabase): void {
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    const now = Date.now();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const entry = cursor.value;
      // expired entries AND pre-v2 (base64) entries get dropped
      if (
        (entry?.createdAt && (now - entry.createdAt) > MAX_AGE_MS) ||
        entry?.schema !== SCHEMA
      ) {
        cursor.delete();
      }
      cursor.continue();
    };
  } catch { /* best-effort cleanup */ }
}

export async function openSnapshotCache(): Promise<IDBSnapshotCache | null> {
  const db = await openDB();
  if (!db) return null;

  // Background cleanup of expired entries
  idbCleanExpired(db);

  return {
    async get(packageJsonHash: string): Promise<VFSBinarySnapshot | null> {
      try {
        const entry = await idbGet(db, packageJsonHash);
        if (!entry || entry.schema !== SCHEMA || !entry.manifest || !entry.data) return null;
        // Check expiry
        if (entry.createdAt && (Date.now() - entry.createdAt) > MAX_AGE_MS) return null;
        return { manifest: entry.manifest, data: entry.data } as VFSBinarySnapshot;
      } catch {
        return null;
      }
    },

    async set(packageJsonHash: string, snapshot: VFSBinarySnapshot): Promise<void> {
      try {
        await idbPut(db, packageJsonHash, {
          schema: SCHEMA,
          manifest: snapshot.manifest,
          data: snapshot.data,
          createdAt: Date.now(),
        });
      } catch { /* silently fail — cache is optional */ }
    },

    close(): void {
      try { db.close(); } catch { /* ignore */ }
    },
  };
}
