// IndexedDB WorkspaceStore. One database holds every workspace on the
// origin; keys are prefixed with the workspace id so a workspace is a key
// range. Every commit is a single readwrite transaction over all stores, so
// entries and their blobs always land together or not at all.

import type { WorkspaceBatch, WorkspaceEntry, WorkspaceManifest, WorkspaceStore } from "./types";
import { changesTree } from "./paths";

const DB_NAME = "nodepod-workspaces";
const DB_VERSION = 1;
const WORKSPACES = "workspaces";
const ENTRIES = "entries";
const BLOBS = "blobs";

export interface IndexedDBWorkspaceStoreOptions {
  /** IDBFactory to use. Defaults to the global `indexedDB`. */
  indexedDB?: IDBFactory;
  /** IDBKeyRange implementation matching `indexedDB`. Defaults to the global. */
  IDBKeyRange?: typeof IDBKeyRange;
}

export interface StoredWorkspaceInfo {
  id: string;
  updatedAt: number;
}

interface Env {
  factory: IDBFactory;
  KeyRange: typeof IDBKeyRange;
}

function resolveEnv(opts: IndexedDBWorkspaceStoreOptions = {}): Env | null {
  const factory = opts.indexedDB ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  const KeyRange = opts.IDBKeyRange ?? (typeof IDBKeyRange !== "undefined" ? IDBKeyRange : undefined);
  if (!factory || !KeyRange) return null;
  return { factory, KeyRange };
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WORKSPACES)) db.createObjectStore(WORKSPACES);
      if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES);
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    req.onsuccess = () => {
      const db = req.result;
      // a newer schema elsewhere wants the database; get out of its way and
      // reopen on the next operation
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("nodepod-workspaces database upgrade is blocked by another tab"));
  });
}

function requestResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

// every key in the workspace: [id] sorts before [id, anything] and an array
// sorts after every string, so [id, []] closes the range
function workspaceRange(env: Env, id: string): IDBKeyRange {
  return env.KeyRange.bound([id], [id, []]);
}

// entries at or below `prefix`. "/" is 0x2f and "0" is 0x30, so
// [prefix + "/", prefix + "0") is exactly the children of prefix
function descendantsRange(env: Env, id: string, prefix: string): IDBKeyRange {
  return env.KeyRange.bound([id, prefix + "/"], [id, prefix + "0"], false, true);
}

/** Create a WorkspaceStore backed by IndexedDB. Returns null when IndexedDB is unavailable. */
export function createIndexedDBWorkspaceStore(
  id: string,
  opts: IndexedDBWorkspaceStoreOptions = {},
): WorkspaceStore | null {
  const env = resolveEnv(opts);
  if (!env) return null;
  let dbPromise: Promise<IDBDatabase> | null = null;

  const db = async (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      dbPromise = openDatabase(env.factory).then((opened) => {
        opened.addEventListener("close", () => { dbPromise = null; });
        const onVersionChange = opened.onversionchange;
        opened.onversionchange = (ev) => {
          dbPromise = null;
          onVersionChange?.call(opened, ev);
        };
        return opened;
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  };

  return {
    async load(): Promise<WorkspaceManifest | null> {
      const tx = (await db()).transaction([WORKSPACES, ENTRIES], "readonly");
      const [info, entries] = await Promise.all([
        requestResult(tx.objectStore(WORKSPACES).get(id)),
        requestResult(tx.objectStore(ENTRIES).getAll(workspaceRange(env, id))),
      ]);
      if (!info) return null;
      return { version: 1, entries: entries as WorkspaceEntry[] };
    },

    async readBlobs(ids: string[]): Promise<Map<string, Uint8Array>> {
      const out = new Map<string, Uint8Array>();
      if (ids.length === 0) return out;
      const store = (await db()).transaction(BLOBS, "readonly").objectStore(BLOBS);
      const values = await Promise.all(ids.map((blobId) => requestResult(store.get([id, blobId]))));
      ids.forEach((blobId, i) => {
        const value = values[i];
        if (value instanceof Uint8Array) out.set(blobId, value);
        else if (value instanceof ArrayBuffer) out.set(blobId, new Uint8Array(value));
      });
      return out;
    },

    async commit(batch: WorkspaceBatch): Promise<void> {
      const tx = (await db()).transaction([WORKSPACES, ENTRIES, BLOBS], "readwrite");
      const done = transactionDone(tx);
      try {
        const entries = tx.objectStore(ENTRIES);
        const blobs = tx.objectStore(BLOBS);
        for (const prefix of batch.deletePrefixes) {
          if (prefix === "/") {
            entries.delete(workspaceRange(env, id));
            continue;
          }
          entries.delete([id, prefix]);
          entries.delete(descendantsRange(env, id, prefix));
        }
        for (const path of batch.deletePaths) entries.delete([id, path]);
        for (const entry of batch.putEntries) entries.put(entry, [id, entry.path]);
        for (const { id: blobId, data } of batch.putBlobs) blobs.put(data, [id, blobId]);
        for (const blobId of batch.deleteBlobs) blobs.delete([id, blobId]);
        if (changesTree(batch)) tx.objectStore(WORKSPACES).put({ id, updatedAt: Date.now() }, id);
      } catch (err) {
        // a put that throws (DataCloneError, bad key) must not let the
        // requests queued before it commit on their own
        done.catch(() => {});
        try { tx.abort(); } catch { /* already finished */ }
        throw err;
      }
      await done;
    },

    async sweep(): Promise<void> {
      // one readwrite transaction, so no commit can land between reading
      // the references and deleting what nothing points at
      const tx = (await db()).transaction([ENTRIES, BLOBS], "readwrite");
      const done = transactionDone(tx);
      const range = workspaceRange(env, id);
      const [entries, blobKeys] = await Promise.all([
        requestResult(tx.objectStore(ENTRIES).getAll(range)),
        requestResult(tx.objectStore(BLOBS).getAllKeys(range)),
      ]);
      const referenced = new Set<string>();
      for (const entry of entries as WorkspaceEntry[]) if (entry.blob) referenced.add(entry.blob);
      const blobs = tx.objectStore(BLOBS);
      for (const key of blobKeys as Array<[string, string]>) {
        if (!referenced.has(key[1])) blobs.delete(key);
      }
      await done;
    },

    async clear(): Promise<void> {
      const tx = (await db()).transaction([WORKSPACES, ENTRIES, BLOBS], "readwrite");
      const done = transactionDone(tx);
      tx.objectStore(ENTRIES).delete(workspaceRange(env, id));
      tx.objectStore(BLOBS).delete(workspaceRange(env, id));
      tx.objectStore(WORKSPACES).delete(id);
      await done;
    },

    close(): void {
      const pending = dbPromise;
      dbPromise = null;
      pending?.then((opened) => opened.close(), () => {});
    },
  };
}

/** Every workspace saved in IndexedDB on this origin. */
export async function listIndexedDBWorkspaces(
  opts: IndexedDBWorkspaceStoreOptions = {},
): Promise<StoredWorkspaceInfo[]> {
  const env = resolveEnv(opts);
  if (!env) return [];
  const opened = await openDatabase(env.factory);
  try {
    const rows = await requestResult(
      opened.transaction(WORKSPACES, "readonly").objectStore(WORKSPACES).getAll(),
    );
    return (rows as StoredWorkspaceInfo[]).map(({ id, updatedAt }) => ({ id, updatedAt }));
  } finally {
    opened.close();
  }
}

/** Delete a workspace saved in IndexedDB. Don't call it while a Nodepod has that workspace open. */
export async function deleteIndexedDBWorkspace(
  id: string,
  opts: IndexedDBWorkspaceStoreOptions = {},
): Promise<void> {
  const store = createIndexedDBWorkspaceStore(id, opts);
  if (!store) return;
  try {
    await store.clear();
  } finally {
    store.close?.();
  }
}
