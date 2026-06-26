// Pluggable virtual filesystem contract.
//
// MemoryVolume is the default in-memory implementation. Users who want to
// back the VFS with IndexedDB, localStorage, a remote store, or anything
// else can implement this interface and pass it to Nodepod.boot({ volume }).
//
// The contract is intentionally synchronous to mirror Node's fs.readFileSync /
// require() semantics that nodepod emulates via eval + SyncPromise. Async
// backends (IDB, fetch) must therefore pre-load into an in-memory cache and
// write-through on mutations; a future revision may add a SAB-bridged async
// mode. See docs/how-nodepod-works.mdx for the rationale.
//
// Memory note: every spawn() walks the whole tree via readdirSync/statSync/
// readFileSync to build a binary snapshot for the worker. Adapters that lazily
// load from a remote/IDB store will have all reachable files materialized on
// each spawn. To avoid peak-heap growth, either (a) keep a hot working set in
// memory and exclude cold paths from snapshots, or (b) wait for the planned
// SAB-bridged async mode that lets workers read directly from the adapter.

import type { FileStat, FileWatchHandle, WatchCallback } from "../memory-volume";
import type { VolumeSnapshot } from "../engine-types";

/** Data shapes accepted by writeFileSync / appendFileSync. */
export type VolumeWriteData =
  | string
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | unknown;

/** Result of getStats(). */
export interface VolumeStats {
  fileCount: number;
  totalBytes: number;
  dirCount: number;
  watcherCount: number;
}

/** Readable stream-like handle returned by createReadStream(). */
export interface VolumeReadStream {
  // `on` returns void in the contract; the default MemoryVolume returns the
  // stream for chaining, which is assignable via method bivariance.
  on(event: string, cb: (...args: unknown[]) => void): void;
  pipe(dest: unknown): unknown;
}

/** Writable stream-like handle returned by createWriteStream(). */
export interface VolumeWriteStream {
  write(data: string | Uint8Array): boolean;
  end(data?: string | Uint8Array): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

/**
 * Synchronous virtual filesystem adapter.
 *
 * All `*Sync` methods must throw Node-style SystemError objects (with `code`,
 * `errno`, `syscall`, `path`) on failure so the fs polyfill propagates errors
 * correctly. Watch + global-change events are required for HMR / chokidar /
 * cross-thread VFS sync to work.
 */
export interface IVolume {
  /* ---- existence / stat ---- */
  existsSync(p: string): boolean;
  statSync(p: string): FileStat;
  lstatSync(p: string): FileStat;
  accessSync(p: string, mode?: number): void;

  /* ---- read / write ---- */
  readFileSync(p: string): Uint8Array;
  readFileSync(p: string, encoding: "utf8" | "utf-8"): string;
  readFileSync(p: string, encoding?: "utf8" | "utf-8"): Uint8Array | string;

  writeFileSync(p: string, data: VolumeWriteData): void;
  appendFileSync(p: string, data: VolumeWriteData): void;
  truncateSync(p: string, len?: number): void;
  copyFileSync(src: string, dest: string): void;

  /* ---- directories ---- */
  mkdirSync(p: string, options?: { recursive?: boolean }): void;
  readdirSync(p: string): string[];
  rmdirSync(p: string): void;

  /* ---- links ---- */
  symlinkSync(target: string, linkPath: string, type?: string): void;
  readlinkSync(p: string): string;
  linkSync(existingPath: string, newPath: string): void;
  realpathSync(p: string): string;

  /* ---- mutate ---- */
  unlinkSync(p: string): void;
  renameSync(from: string, to: string): void;
  chmodSync(p: string, mode: number): void;
  chownSync(p: string, uid: number, gid: number): void;

  /* ---- async wrappers (callback-style, mirror Node fs) ---- */
  readFile(
    p: string,
    optionsOrCb?:
      | { encoding?: string }
      | ((err: Error | null, data?: Uint8Array | string) => void),
    cb?: (err: Error | null, data?: Uint8Array | string) => void,
  ): void;
  stat(p: string, cb?: (err: Error | null, stats?: FileStat) => void): void;
  lstat(p: string, cb?: (err: Error | null, stats?: FileStat) => void): void;
  readdir(
    p: string,
    optionsOrCb?:
      | { withFileTypes?: boolean }
      | ((err: Error | null, files?: string[]) => void),
    cb?: (err: Error | null, files?: string[]) => void,
  ): void;
  realpath(
    p: string,
    cb?: (err: Error | null, resolved?: string) => void,
  ): void;
  access(
    p: string,
    modeOrCb?: number | ((err: Error | null) => void),
    cb?: (err: Error | null) => void,
  ): void;

  /* ---- watchers / events ---- */
  watch(
    target: string,
    optionsOrCb?:
      | { persistent?: boolean; recursive?: boolean; encoding?: string }
      | WatchCallback,
    cb?: WatchCallback,
  ): FileWatchHandle;

  on(event: "change", handler: (filePath: string, content: string) => void): this;
  on(event: "delete", handler: (filePath: string) => void): this;
  // generic overload uses a variadic any handler so custom adapters can
  // implement a single signature instead of mirroring every overload.
  on(event: string, handler: (...args: any[]) => void): this;

  off(event: "change", handler: (filePath: string, content: string) => void): this;
  off(event: "delete", handler: (filePath: string) => void): this;
  off(event: string, handler: (...args: any[]) => void): this;

  /** Subscribe to every write/delete/rename. Returns an unsubscribe fn. */
  onGlobalChange(cb: (path: string, event: string) => void): () => void;

  /* ---- streams ---- */
  createReadStream(p: string): VolumeReadStream;
  createWriteStream(p: string): VolumeWriteStream;

  /* ---- snapshot / introspection / lifecycle ---- */
  toSnapshot(
    excludePrefixes?: string[],
    excludeDirNames?: Set<string>,
  ): VolumeSnapshot;

  /**
   * Replace the entire filesystem contents with the given snapshot.
   * Used by Nodepod.restore(). Adapters that don't support in-place swap
   * can re-init from the snapshot entries.
   */
  replaceFromSnapshot(snapshot: VolumeSnapshot): void;

  getStats(): VolumeStats;

  /** Release watchers, subscribers, caches. Called on Nodepod.teardown(). */
  dispose(): void;
}
