// IndexedDB-backed cache for node_modules snapshots.
// Keyed by a hash of the package.json contents so stale caches auto-invalidate.
//
// v2 (plan 015): snapshots are stored in the flat binary format (offset
// manifest + one ArrayBuffer) instead of base64-encoded VolumeSnapshots.
// v3: the manifest and the data live in separate records and the data is a
// Blob, so a pack's manifest can be read without its data, and single files
// can be read out of it by byte range (disk-backed Blob slices) without
// loading the whole pack. Each write stores its data under a fresh version,
// so byte ranges handed out for one version never read another version's
// bytes. Older entries are simply ignored and age out.

import type { VFSBinarySnapshot, VFSSnapshotEntry } from '../threading/worker-protocol';

const DB_NAME = 'nodepod-snapshots';
const STORE_NAME = 'snapshots';
const DB_VERSION = 2;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SCHEMA = 3; // stored per entry; entries with a different schema are misses
// data records sit next to their manifest record: key + DATA_SUFFIX + version
const DATA_SUFFIX = '\u0000data\u0000';

/** A cached pack's manifest plus the version its byte ranges belong to. */
export interface PackHead {
  manifest: VFSSnapshotEntry[];
  version: string;
}

export interface IDBSnapshotCache {
  get(packageJsonHash: string): Promise<VFSBinarySnapshot | null>;
  set(packageJsonHash: string, snapshot: VFSBinarySnapshot): Promise<void>;
  /** The pack's manifest and version, without loading its data. */
  getManifest?(packageJsonHash: string): Promise<PackHead | null>;
  /**
   * `length` bytes of that version of the pack's data, starting at `offset`.
   * Null if the pack is gone or has been rewritten since.
   */
  readRange?(packageJsonHash: string, version: string, offset: number, length: number): Promise<Uint8Array | null>;
  close(): void;
}

interface ManifestRecord {
  schema: number;
  manifest: VFSSnapshotEntry[];
  byteLength: number;
  createdAt: number;
  version: string;
}

function newVersion(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return c && typeof c.randomUUID === 'function'
    ? c.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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

function idbWrite(
  db: IDBDatabase,
  puts: Array<[string, unknown]>,
  deletes: string[] = [],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const key of deletes) store.delete(key);
    for (const [key, value] of puts) store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function isFresh(entry: ManifestRecord | null): entry is ManifestRecord {
  return !!entry &&
    entry.schema === SCHEMA &&
    Array.isArray(entry.manifest) &&
    typeof entry.version === 'string' &&
    !(entry.createdAt && (Date.now() - entry.createdAt) > MAX_AGE_MS);
}

function idbCleanExpired(db: IDBDatabase): void {
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    // data key each fresh manifest record points at
    const keep = new Set<string>();
    const dataKeys: string[] = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        // data records of old versions, or whose manifest record is gone
        for (const key of dataKeys) {
          if (!keep.has(key)) store.delete(key);
        }
        return;
      }
      const key = String(cursor.key);
      if (key.includes(DATA_SUFFIX)) {
        dataKeys.push(key);
      } else if (isFresh(cursor.value)) {
        keep.add(key + DATA_SUFFIX + cursor.value.version);
      } else {
        // expired, and anything written by an older schema
        cursor.delete();
      }
      cursor.continue();
    };
  } catch { /* best-effort cleanup */ }
}

// Some contexts (WebKit private browsing) refuse Blobs in IndexedDB, and the
// failed transaction can then stay stuck, blocking every later write to the
// same store. Find out once, in a throwaway database.
let blobSupport: Promise<boolean> | null = null;
function idbAcceptsBlobs(): Promise<boolean> {
  if (typeof Blob === 'undefined' || typeof indexedDB === 'undefined') return Promise.resolve(false);
  blobSupport ??= new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    // a probe that never finishes means no
    setTimeout(() => done(false), 2000);
    try {
      const req = indexedDB.open('nodepod-blob-probe', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('probe');
      req.onerror = () => done(false);
      req.onsuccess = () => {
        const probe = req.result;
        const finish = (ok: boolean): void => {
          probe.close();
          done(ok);
          try { indexedDB.deleteDatabase('nodepod-blob-probe'); } catch { /* best effort */ }
        };
        try {
          const tx = probe.transaction('probe', 'readwrite');
          tx.objectStore('probe').put(new Blob([new Uint8Array([1])]), 'probe');
          tx.oncomplete = () => finish(true);
          tx.onerror = () => finish(false);
          tx.onabort = () => finish(false);
        } catch {
          finish(false);
        }
      };
    } catch {
      done(false);
    }
  });
  return blobSupport;
}

async function toBytes(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return null;
}

export async function openSnapshotCache(): Promise<IDBSnapshotCache | null> {
  const db = await openDB();
  if (!db) return null;

  // Background cleanup of expired entries
  idbCleanExpired(db);

  // data records by key + version: a Blob here is only a handle, slices
  // read from disk, and it keeps that version readable
  const dataRecords = new Map<string, Blob>();
  const dataRecord = async (key: string, version: string): Promise<Blob | ArrayBuffer | null> => {
    const dataKey = key + DATA_SUFFIX + version;
    const known = dataRecords.get(dataKey);
    if (known) return known;
    const record = await idbGet(db, dataKey);
    if (!(record instanceof ArrayBuffer) && !(typeof Blob !== 'undefined' && record instanceof Blob)) {
      return null;
    }
    // a Blob is just a handle; keeping an ArrayBuffer would pin the whole pack
    if (typeof Blob !== 'undefined' && record instanceof Blob) dataRecords.set(dataKey, record);
    return record;
  };

  return {
    async get(packageJsonHash: string): Promise<VFSBinarySnapshot | null> {
      try {
        const entry = await idbGet(db, packageJsonHash) as ManifestRecord | null;
        if (!isFresh(entry)) return null;
        const bytes = await toBytes(await dataRecord(packageJsonHash, entry.version));
        if (!bytes || bytes.byteLength !== entry.byteLength) return null;
        const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer as ArrayBuffer
          : bytes.slice().buffer;
        return { manifest: entry.manifest, data };
      } catch {
        return null;
      }
    },

    async set(packageJsonHash: string, snapshot: VFSBinarySnapshot): Promise<void> {
      try {
        const previous = await idbGet(db, packageJsonHash) as ManifestRecord | null;
        const record: ManifestRecord = {
          schema: SCHEMA,
          manifest: snapshot.manifest,
          byteLength: snapshot.data.byteLength,
          createdAt: Date.now(),
          version: newVersion(),
        };
        // a Blob lets readRange read slices from disk
        const data = (await idbAcceptsBlobs()) ? new Blob([snapshot.data]) : snapshot.data;
        await idbWrite(
          db,
          [
            [packageJsonHash, record],
            [packageJsonHash + DATA_SUFFIX + record.version, data],
          ],
          previous?.version ? [packageJsonHash + DATA_SUFFIX + previous.version] : [],
        );
      } catch { /* silently fail — cache is optional */ }
    },

    async getManifest(packageJsonHash: string): Promise<PackHead | null> {
      try {
        const entry = await idbGet(db, packageJsonHash) as ManifestRecord | null;
        return isFresh(entry) ? { manifest: entry.manifest, version: entry.version } : null;
      } catch {
        return null;
      }
    },

    async readRange(
      packageJsonHash: string,
      version: string,
      offset: number,
      length: number,
    ): Promise<Uint8Array | null> {
      try {
        const record = await dataRecord(packageJsonHash, version);
        if (!record) return null;
        if (record instanceof ArrayBuffer) {
          return new Uint8Array(record.slice(offset, offset + length));
        }
        return new Uint8Array(await record.slice(offset, offset + length).arrayBuffer());
      } catch {
        dataRecords.delete(packageJsonHash + DATA_SUFFIX + version);
        return null;
      }
    },

    close(): void {
      dataRecords.clear();
      try { db.close(); } catch { /* ignore */ }
    },
  };
}
