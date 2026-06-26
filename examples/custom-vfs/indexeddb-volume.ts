/**
 * Example IVolume adapter: IndexedDB write-through persistence.
 *
 * Nodepod's VFS contract is synchronous (it emulates Node's sync fs/require via
 * eval + SyncPromise), but IndexedDB is async. The pragmatic pattern is:
 *
 *   1. On boot, load every file from IDB into an in-memory MemoryVolume.
 *   2. On every mutation (write/mkdir/unlink/rmdir/rename/...), write-through
 *      to IDB in the background. Reads stay synchronous from memory.
 *
 * This gives you persistence across reloads. The in-memory copy still exists
 * (so this alone doesn't reduce peak heap), but it's no longer the *only*
 * copy — you can later add LRU eviction of cold entries and rehydrate them
 * from IDB on read (see the TODO at the bottom). True peak-heap reduction
 * needs the SAB-bridged async path noted below.
 *
 * True "IDB as the live source of truth with nothing in memory" would require
 * blocking the main thread with SharedArrayBuffer + Atomics.wait while a
 * worker services each read — only works with COOP/COEP and is a separate,
 * larger effort.
 *
 * Usage:
 *   import { IndexedDBVolume } from "./indexeddb-volume";
 *   const volume = await IndexedDBVolume.create("my-app-fs");
 *   const nodepod = await Nodepod.boot({ volume, files: { "/index.js": "..." } });
 */
import { MemoryVolume } from "../../src/memory-volume";
import type { IVolume, VolumeWriteData } from "../../src/types/volume";
import type { FileStat, FileWatchHandle, WatchCallback } from "../../src/memory-volume";
import type { VolumeSnapshot } from "../../src/engine-types";

const FILE_STORE = "files";
const META_STORE = "meta";
const DIR_KEY = "__dirs__"; // single record holding a JSON array of dir paths

interface DirRecord {
  dirs: string[];
}

function openDB(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE);
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAllKeys(db: IDBDatabase, store: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAllKeys();
    req.onsuccess = () => resolve((req.result as string[]).filter((k) => k !== DIR_KEY));
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export class IndexedDBVolume implements IVolume {
  private _mem: MemoryVolume;
  private _db: IDBDatabase;
  private _dirs: Set<string> = new Set(["/"]);
  private _pendingFlush: Promise<void> = Promise.resolve();

  private constructor(mem: MemoryVolume, db: IDBDatabase, dirs: Set<string>) {
    this._mem = mem;
    this._db = db;
    this._dirs = dirs;
  }

  /** Open (or create) the IDB store and hydrate the in-memory cache from it. */
  static async create(dbName: string = "nodepod-vfs"): Promise<IndexedDBVolume> {
    const db = await openDB(dbName);
    const mem = new MemoryVolume();

    // hydrate directories
    const dirRec = await idbGet<DirRecord>(db, META_STORE, DIR_KEY);
    const dirs = new Set<string>(["/"]);
    if (dirRec?.dirs) {
      for (const d of dirRec.dirs) {
        dirs.add(d);
        try { mem.mkdirSync(d, { recursive: true }); } catch { /* ignore dup */ }
      }
    }

    // hydrate files
    const paths = await idbGetAllKeys(db, FILE_STORE);
    for (const path of paths) {
      const bytes = await idbGet<Uint8Array>(db, FILE_STORE, path);
      if (bytes) {
        const parent = path.substring(0, path.lastIndexOf("/")) || "/";
        if (parent !== "/" && !mem.existsSync(parent)) mem.mkdirSync(parent, { recursive: true });
        mem.writeFileSync(path, bytes);
      }
    }

    return new IndexedDBVolume(mem, db, dirs);
  }

  /** Flush all pending IDB writes. Await before unload to guarantee persistence. */
  async flush(): Promise<void> {
    await this._pendingFlush;
  }

  close(): void {
    try { this._db.close(); } catch { /* ignore */ }
  }

  // ---- write-through helpers ----

  private _persistFile(path: string, data: Uint8Array): void {
    this._pendingFlush = this._pendingFlush.then(() => idbPut(this._db, FILE_STORE, path, data).catch(() => {}));
  }
  private _deleteFile(path: string): void {
    this._pendingFlush = this._pendingFlush.then(() => idbDelete(this._db, FILE_STORE, path).catch(() => {}));
  }
  private _persistDirs(): void {
    const snapshot = Array.from(this._dirs);
    this._pendingFlush = this._pendingFlush.then(() =>
      idbPut(this._db, META_STORE, DIR_KEY, { dirs: snapshot } as DirRecord).catch(() => {}),
    );
  }
  private _addDir(path: string): void {
    if (this._dirs.has(path)) return;
    this._dirs.add(path);
    this._persistDirs();
  }

  // ---- IVolume: sync read API delegates to memory ----

  existsSync(p: string): boolean { return this._mem.existsSync(p); }
  statSync(p: string): FileStat { return this._mem.statSync(p); }
  lstatSync(p: string): FileStat { return this._mem.lstatSync(p); }
  accessSync(p: string, mode?: number): void { return this._mem.accessSync(p, mode); }

  readFileSync(p: string): Uint8Array;
  readFileSync(p: string, encoding: "utf8" | "utf-8"): string;
  readFileSync(p: string, encoding?: "utf8" | "utf-8"): Uint8Array | string {
    return this._mem.readFileSync(p, encoding as any);
  }

  // ---- IVolume: mutations write-through to IDB ----

  writeFileSync(p: string, data: VolumeWriteData): void {
    this._mem.writeFileSync(p, data as any);
    // normalize to Uint8Array for IDB (MemoryVolume already stores bytes)
    const bytes = this._mem.readFileSync(p);
    this._persistFile(p, bytes);
  }

  appendFileSync(p: string, data: VolumeWriteData): void {
    this._mem.appendFileSync(p, data as any);
    const bytes = this._mem.readFileSync(p);
    this._persistFile(p, bytes);
  }

  truncateSync(p: string, len?: number): void {
    this._mem.truncateSync(p, len);
    const bytes = this._mem.readFileSync(p);
    this._persistFile(p, bytes);
  }

  copyFileSync(src: string, dest: string): void {
    this._mem.copyFileSync(src, dest);
    const bytes = this._mem.readFileSync(dest);
    this._persistFile(dest, bytes);
  }

  mkdirSync(p: string, options?: { recursive?: boolean }): void {
    this._mem.mkdirSync(p, options);
    this._addDir(p);
  }

  readdirSync(p: string): string[] { return this._mem.readdirSync(p); }

  rmdirSync(p: string): void {
    this._mem.rmdirSync(p);
    this._dirs.delete(p);
    this._persistDirs();
  }

  symlinkSync(target: string, linkPath: string, type?: string): void {
    // symlinks are memory-only; persisting them as files would break round-trip.
    // For a real adapter you'd store a sentinel record + target.
    this._mem.symlinkSync(target, linkPath, type);
  }
  readlinkSync(p: string): string { return this._mem.readlinkSync(p); }
  linkSync(existingPath: string, newPath: string): void {
    this._mem.linkSync(existingPath, newPath);
    const bytes = this._mem.readFileSync(newPath);
    this._persistFile(newPath, bytes);
  }
  realpathSync(p: string): string { return this._mem.realpathSync(p); }

  unlinkSync(p: string): void {
    this._mem.unlinkSync(p);
    this._deleteFile(p);
  }

  renameSync(from: string, to: string): void {
    this._mem.renameSync(from, to);
    // best-effort: copy bytes to new key, delete old
    try {
      const bytes = this._mem.readFileSync(to);
      this._persistFile(to, bytes);
    } catch { /* may be a dir */ }
    this._deleteFile(from);
  }

  chmodSync(p: string, mode: number): void { this._mem.chmodSync(p, mode); }
  chownSync(p: string, uid: number, gid: number): void { this._mem.chownSync(p, uid, gid); }

  // ---- async wrappers ----
  readFile(p: string, optionsOrCb?: any, cb?: any): void { this._mem.readFile(p, optionsOrCb, cb); }
  stat(p: string, cb?: (err: Error | null, stats?: FileStat) => void): void { this._mem.stat(p, cb); }
  lstat(p: string, cb?: (err: Error | null, stats?: FileStat) => void): void { this._mem.lstat(p, cb); }
  readdir(p: string, optionsOrCb?: any, cb?: any): void { this._mem.readdir(p, optionsOrCb, cb); }
  realpath(p: string, cb?: (err: Error | null, resolved?: string) => void): void { this._mem.realpath(p, cb); }
  access(p: string, modeOrCb?: any, cb?: any): void { this._mem.access(p, modeOrCb, cb); }

  // ---- watchers / events delegate to memory ----
  watch(target: string, optionsOrCb?: any, cb?: WatchCallback): FileWatchHandle {
    return this._mem.watch(target, optionsOrCb, cb);
  }
  on(event: string, handler: (...args: any[]) => void): this {
    (this._mem.on as any)(event, handler);
    return this;
  }
  off(event: string, handler: (...args: any[]) => void): this {
    (this._mem.off as any)(event, handler);
    return this;
  }
  onGlobalChange(cb: (path: string, event: string) => void): () => void {
    return this._mem.onGlobalChange(cb);
  }

  createReadStream(p: string) { return this._mem.createReadStream(p); }
  createWriteStream(p: string) { return this._mem.createWriteStream(p); }

  // ---- snapshot / lifecycle ----
  toSnapshot(excludePrefixes?: string[], excludeDirNames?: Set<string>): VolumeSnapshot {
    return this._mem.toSnapshot(excludePrefixes, excludeDirNames);
  }

  replaceFromSnapshot(snapshot: VolumeSnapshot): void {
    this._mem.replaceFromSnapshot(snapshot);
    // best-effort: re-seed IDB from the new snapshot
    this._dirs = new Set(["/"]);
    for (const entry of snapshot.entries) {
      if (entry.kind === "directory") this._dirs.add(entry.path);
    }
    this._persistDirs();
    for (const entry of snapshot.entries) {
      if (entry.kind === "file" && entry.data) {
        // decode base64
        try {
          const bin = atob(entry.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          this._persistFile(entry.path, bytes);
        } catch { /* ignore */ }
      }
    }
  }

  getStats() { return this._mem.getStats(); }

  dispose(): void {
    this._mem.dispose();
    this.close();
  }

  // TODO: LRU eviction. Track access timestamps; when memory grows past a
  // threshold, evict cold file paths from the in-memory cache (delete the
  // MemoryVolume node but keep the IDB record). On readFileSync of an evicted
  // path, synchronously throw ENOENT is wrong — instead you'd need the SAB
  // bridge to block-and-fetch. That's the async-source-of-truth follow-up.
}
