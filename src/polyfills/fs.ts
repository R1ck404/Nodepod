// fs polyfill -- buildFileSystemBridge(volume, getCwd) wraps MemoryVolume into a Node.js-compatible fs API

import type {
  MemoryVolume,
  FileStat,
  FileWatchHandle,
  WatchCallback,
  WatchEventKind,
  VolumeFileHandle,
} from "../memory-volume";
import { makeSystemError } from "../memory-volume";
import { precompileWasm } from "../helpers/wasm-cache";
import {
  prefetchWasmFromCdn,
  resolveWasmAssetPath,
} from "../helpers/wasm-cdn";
import { Readable, Writable } from "./stream";
import { Buffer } from "./buffer";
import type { FsReadStreamInstance, FsWriteStreamInstance, FsReadableState, FsWritableState } from "../types/fs-streams";
import { getRegistry, isExitSentinel, type Handle } from "../helpers/event-loop";
import { setImmediate as scheduleImmediate } from "./timers";
import { settledPromise, settledResolve, settledReject } from "../helpers/sync-scope";

export type { FileStat, FileWatchHandle, WatchCallback, WatchEventKind };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// Callback-style fs completions, like node's I/O callbacks: each runs in a
// task of its own (so promise continuations and nextTicks run between two
// of them) and keeps the event loop alive until it has. One MessageChannel
// message per callback: setTimeout(0) cost >= 1ms per call and browsers
// clamp nested timers to 4ms, which made callback-driven directory walks
// crawl.
const _fsCallbacks: Array<{ handle: Handle; fn: () => void }> = [];
let _fsCallbackPort: MessagePort | null = null;

function runNextFsCallback(): void {
  const next = _fsCallbacks.shift();
  if (!next) return;
  next.handle.close();
  try {
    next.fn();
  } catch (e) {
    if (isExitSentinel(e)) return;
    // an uncaught error in a callback, as in node
    queueMicrotask(() => {
      throw e;
    });
  }
}

function deferCallback(fn: () => void): void {
  if (typeof MessageChannel === "undefined") {
    scheduleImmediate(fn);
    return;
  }
  if (!_fsCallbackPort) {
    const channel = new MessageChannel();
    channel.port1.onmessage = runNextFsCallback;
    _fsCallbackPort = channel.port2;
  }
  _fsCallbacks.push({ handle: getRegistry().register("FSReqCallback"), fn });
  _fsCallbackPort.postMessage(0);
}

export type PathArg = string | URL;

export interface Dirent {
  name: string;
  parentPath: string;
  path: string;
  _dir: boolean;
  _file: boolean;
  isDirectory(): boolean;
  isFile(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
}

interface DirentConstructor {
  new (
    entryName: string,
    isDir: boolean,
    isFile: boolean,
    parentPath?: string,
    isSymlink?: boolean,
  ): Dirent;
  (
    this: any,
    entryName: string,
    isDir: boolean,
    isFile: boolean,
    parentPath?: string,
    isSymlink?: boolean,
  ): void;
  prototype: any;
}

export const Dirent = function Dirent(
  this: any,
  entryName: string,
  isDir: boolean,
  isFile: boolean,
  parentPath?: string,
  isSymlink = false,
) {
  if (!this) return;
  this.name = entryName;
  this._dir = isDir;
  this._file = isFile;
  this._symlink = isSymlink;
  this.parentPath = parentPath ?? "";
  this.path = this.parentPath;
} as unknown as DirentConstructor;

Dirent.prototype.isDirectory = function isDirectory(this: any): boolean {
  return this._dir;
};
Dirent.prototype.isFile = function isFile(this: any): boolean {
  return this._file;
};
Dirent.prototype.isBlockDevice = function isBlockDevice(): boolean {
  return false;
};
Dirent.prototype.isCharacterDevice = function isCharacterDevice(): boolean {
  return false;
};
Dirent.prototype.isFIFO = function isFIFO(): boolean {
  return false;
};
Dirent.prototype.isSocket = function isSocket(): boolean {
  return false;
};
Dirent.prototype.isSymbolicLink = function isSymbolicLink(this: any): boolean {
  return !!this._symlink;
};

export interface Dir {
  readonly path: string;
  _entries: Dirent[];
  _pos: number;
  _closed: boolean;
  readSync(): Dirent | null;
  read(): Promise<Dirent | null>;
  read(cb: (err: Error | null, dirent: Dirent | null) => void): void;
  closeSync(): void;
  close(): Promise<void>;
  close(cb: (err: Error | null) => void): void;
  [Symbol.asyncIterator](): AsyncIterableIterator<Dirent>;
}

interface DirConstructor {
  new (dirPath: string, entries: Dirent[]): Dir;
  (this: any, dirPath: string, entries: Dirent[]): void;
  prototype: any;
}

export const Dir = function Dir(this: any, dirPath: string, entries: Dirent[]) {
  if (!this) return;
  this.path = dirPath;
  this._entries = entries;
  this._pos = 0;
  this._closed = false;
} as unknown as DirConstructor;

Dir.prototype.readSync = function readSync(this: any): Dirent | null {
  if (this._closed) throw new Error("ERR_DIR_CLOSED: Directory handle was closed");
  if (this._pos >= this._entries.length) return null;
  return this._entries[this._pos++];
};

Dir.prototype.read = function read(this: any, cb?: (err: Error | null, dirent: Dirent | null) => void): Promise<Dirent | null> | void {
  if (cb) {
    try {
      const entry = this.readSync();
      queueMicrotask(() => cb(null, entry));
    } catch (e) {
      queueMicrotask(() => cb(e as Error, null));
    }
    return;
  }
  const self = this;
  return new Promise((resolve, reject) => {
    try {
      resolve(self.readSync());
    } catch (e) {
      reject(e);
    }
  });
};

Dir.prototype.closeSync = function closeSync(this: any): void {
  this._closed = true;
};

Dir.prototype.close = function close(this: any, cb?: (err: Error | null) => void): Promise<void> | void {
  this._closed = true;
  if (cb) {
    queueMicrotask(() => cb(null));
    return;
  }
  return Promise.resolve();
};

Dir.prototype[Symbol.asyncIterator] = function(this: any): AsyncIterableIterator<Dirent> {
  const self = this;
  return {
    async next(): Promise<IteratorResult<Dirent>> {
      const entry = self.readSync();
      if (entry === null) return { done: true, value: undefined as any };
      return { done: false, value: entry };
    },
    [Symbol.asyncIterator]() { return this; },
  };
};

export class StatFs {
  type: number;
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
  files: number;
  ffree: number;
  constructor() {
    this.type = 0x61756673; // "aufs" magic number
    this.bsize = 4096;
    this.blocks = 262144;     // ~1GB virtual
    this.bfree = 131072;      // ~512MB free
    this.bavail = 131072;
    this.files = 65536;
    this.ffree = 32768;
  }
}

export class StatWatcher {
  private _listeners: Map<string, ((...args: unknown[]) => void)[]> = new Map();
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _poll: (() => void) | null = null;

  start(
    _filename: string,
    _persistent?: boolean,
    interval = 5007,
    poll?: () => void,
  ): void {
    this.stop();
    this._poll = poll ?? null;
    if (!this._poll) return;
    this._interval = setInterval(() => {
      try { this._poll?.(); } catch { /* ignore */ }
    }, interval);
  }
  stop(): void {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._poll = null;
    this._emit("stop");
  }
  ref(): this { return this; }
  unref(): this { return this; }
  on(event: string, listener: (...args: unknown[]) => void): this {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(listener);
    return this;
  }
  once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    const arr = this._listeners.get(event);
    if (arr) {
      const idx = arr.indexOf(listener);
      if (idx !== -1) arr.splice(idx, 1);
    }
    return this;
  }
  off(event: string, listener: (...args: unknown[]) => void): this {
    return this.removeListener(event, listener);
  }
  addListener(event: string, listener: (...args: unknown[]) => void): this {
    return this.on(event, listener);
  }
  removeAllListeners(event?: string): this {
    if (event) this._listeners.delete(event);
    else this._listeners.clear();
    return this;
  }
  emit(event: string, ...args: unknown[]): boolean {
    return this._emit(event, ...args);
  }
  private _emit(event: string, ...args: unknown[]): boolean {
    const arr = this._listeners.get(event);
    if (!arr || arr.length === 0) return false;
    for (const fn of arr.slice()) fn(...args);
    return true;
  }
}

interface FsConstantsShape {
  F_OK: number;
  R_OK: number;
  W_OK: number;
  X_OK: number;
  O_RDONLY: number;
  O_WRONLY: number;
  O_RDWR: number;
  O_CREAT: number;
  O_EXCL: number;
  O_TRUNC: number;
  O_APPEND: number;
  O_DIRECTORY: number;
  O_NOFOLLOW: number;
  O_SYNC: number;
  O_DSYNC: number;
  O_NONBLOCK: number;
  O_NOCTTY: number;
  S_IFMT: number;
  S_IFREG: number;
  S_IFDIR: number;
  S_IFLNK: number;
  S_IFCHR: number;
  S_IFBLK: number;
  S_IFIFO: number;
  S_IFSOCK: number;
  S_IRWXU: number;
  S_IRUSR: number;
  S_IWUSR: number;
  S_IXUSR: number;
  S_IRWXG: number;
  S_IRGRP: number;
  S_IWGRP: number;
  S_IXGRP: number;
  S_IRWXO: number;
  S_IROTH: number;
  S_IWOTH: number;
  S_IXOTH: number;
  COPYFILE_EXCL: number;
  COPYFILE_FICLONE: number;
  COPYFILE_FICLONE_FORCE: number;
  UV_FS_SYMLINK_DIR: number;
  UV_FS_SYMLINK_JUNCTION: number;
}

type StatOptions = { bigint?: boolean; throwIfNoEntry?: boolean };
type WriteFileOptions = { encoding?: string | null; mode?: number; flag?: string };
type CpOptions = {
  recursive?: boolean;
  force?: boolean;
  errorOnExist?: boolean;
  filter?: (src: string, dest: string) => boolean;
  dereference?: boolean;
  preserveTimestamps?: boolean;
  verbatimSymlinks?: boolean;
  mode?: number;
};
type GlobOptions = {
  cwd?: string;
  exclude?: string[] | ((p: string) => boolean);
  withFileTypes?: boolean;
};
type RmOptions = { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number };

interface FsPromisesShape {
  readFile(target: PathArg): Promise<Buffer>;
  readFile(target: PathArg, enc: BufferEncoding): Promise<string>;
  readFile(
    target: PathArg,
    opts: { encoding: BufferEncoding },
  ): Promise<string>;
  readFile(
    target: PathArg,
    encOrOpts?: string | { encoding?: string | null },
  ): Promise<Buffer | string>;
  writeFile(
    target: PathArg,
    data: string | Uint8Array,
    opts?: WriteFileOptions,
  ): Promise<void>;
  appendFile(target: PathArg, data: string | Uint8Array): Promise<void>;
  stat(target: PathArg, opts?: StatOptions): Promise<FileStat | undefined>;
  lstat(target: PathArg, opts?: StatOptions): Promise<FileStat | undefined>;
  readdir(target: PathArg): Promise<string[]>;
  mkdir(
    target: PathArg,
    opts?: { recursive?: boolean; mode?: number },
  ): Promise<string | undefined>;
  unlink(target: PathArg): Promise<void>;
  rmdir(target: PathArg): Promise<void>;
  rm(target: PathArg, opts?: RmOptions): Promise<void>;
  rename(src: PathArg, dest: PathArg): Promise<void>;
  access(target: PathArg, mode?: number): Promise<void>;
  realpath(target: PathArg): Promise<string>;
  copyFile(src: PathArg, dest: PathArg): Promise<void>;
  symlink(target: PathArg, path: PathArg, type?: string): Promise<void>;
  readlink(target: PathArg): Promise<string>;
  link(existingPath: PathArg, newPath: PathArg): Promise<void>;
  chmod(target: PathArg, mode: number): Promise<void>;
  chown(target: PathArg, uid: number, gid: number): Promise<void>;
  lchown(target: PathArg, uid: number, gid: number): Promise<void>;
  truncate(target: PathArg, len?: number): Promise<void>;
  utimes(target: PathArg, atime: unknown, mtime: unknown): Promise<void>;
  lutimes(target: PathArg, atime: unknown, mtime: unknown): Promise<void>;
  glob(
    pattern: string | string[],
    opts?: GlobOptions,
  ): AsyncIterable<string | Dirent>;
  constants: FsConstantsShape;
}


export interface FsBridge {
  __openFileHandleSync(target: PathArg): VolumeFileHandle;
  readFileSync(target: PathArg): Buffer;
  readFileSync(target: PathArg, enc: BufferEncoding): string;
  readFileSync(target: PathArg, opts: { encoding: BufferEncoding }): string;
  readFileSync(target: PathArg, opts: { encoding?: null }): Buffer;
  readFileSync(
    target: PathArg,
    encOrOpts?: string | { encoding?: string | null },
  ): Buffer | string;
  writeFileSync(
    target: PathArg,
    data: string | Uint8Array,
    opts?: WriteFileOptions | string,
  ): void;
  appendFileSync(target: PathArg, data: string | Uint8Array): void;
  existsSync(target: PathArg): boolean;
  mkdirSync(
    target: PathArg,
    opts?: { recursive?: boolean; mode?: number },
  ): string | undefined;
  readdirSync(target: PathArg): string[];
  readdirSync(target: PathArg, opts: { withFileTypes: true }): Dirent[];
  readdirSync(
    target: PathArg,
    opts?: { withFileTypes?: boolean; encoding?: string } | string,
  ): string[] | Buffer[] | Dirent[];
  statSync(target: PathArg, opts?: StatOptions): FileStat | undefined;
  lstatSync(target: PathArg, opts?: StatOptions): FileStat | undefined;
  fstatSync(fd: number, opts?: StatOptions): FileStat | undefined;
  unlinkSync(target: PathArg): void;
  rmdirSync(target: PathArg): void;
  renameSync(src: PathArg, dest: PathArg): void;
  realpathSync: ((target: PathArg) => string) & {
    native: (target: PathArg) => string;
  };
  accessSync(target: PathArg, mode?: number): void;
  copyFileSync(src: PathArg, dest: PathArg, mode?: number): void;
  symlinkSync(target: PathArg, path: PathArg, type?: string): void;
  readlinkSync(target: PathArg): string;
  linkSync(existingPath: PathArg, newPath: PathArg): void;
  chmodSync(target: PathArg, mode: number): void;
  chownSync(target: PathArg, uid: number, gid: number): void;
  truncateSync(target: PathArg, len?: number): void;
  lchownSync(target: PathArg, uid: number, gid: number): void;
  lutimesSync(target: PathArg, atime: unknown, mtime: unknown): void;
  fchownSync(fd: number, uid: number, gid: number): void;
  fchmodSync(fd: number, mode: number): void;
  openSync(target: string, flags: string | number, mode?: number): number;
  closeSync(fd: number): void;
  readSync(
    fd: number,
    buf: Buffer | Uint8Array,
    off: number,
    len: number,
    pos: number | null,
  ): number;
  writeSync(
    fd: number,
    buf: Buffer | Uint8Array | string,
    off?: number,
    len?: number,
    pos?: number | null,
  ): number;
  ftruncateSync(fd: number, len?: number): void;
  fsyncSync(fd: number): void;
  fdatasyncSync(fd: number): void;
  mkdtempSync(prefix: string): string;
  rmSync(target: string, opts?: RmOptions): void;
  opendirSync(target: unknown): Dir;
  watchFile(
    filename: unknown,
    optsOrListener?: unknown,
    listener?: unknown,
  ): StatWatcher;
  unwatchFile(filename: unknown, listener?: unknown): void;
  watch(
    filename: string,
    opts?: { persistent?: boolean; recursive?: boolean },
    listener?: WatchCallback,
  ): FileWatchHandle;
  watch(filename: string, listener?: WatchCallback): FileWatchHandle;
  readFile(
    target: string,
    cb: (err: Error | null, data?: Uint8Array) => void,
  ): void;
  readFile(
    target: string,
    opts: { encoding: string },
    cb: (err: Error | null, data?: string) => void,
  ): void;
  writeFile(
    target: string,
    data: string | Uint8Array,
    cb: (err: Error | null) => void,
  ): void;
  appendFile(
    target: string,
    data: string | Uint8Array,
    cb: (err: Error | null) => void,
  ): void;
  stat(target: string, cb: (err: Error | null, stats?: FileStat) => void): void;
  lstat(
    target: string,
    cb: (err: Error | null, stats?: FileStat) => void,
  ): void;
  readdir(
    target: string,
    cb: (err: Error | null, entries?: string[]) => void,
  ): void;
  readdir(
    target: string,
    opts: { withFileTypes?: boolean; encoding?: string } | string,
    cb: (err: Error | null, entries?: string[] | Buffer[] | Dirent[]) => void,
  ): void;
  mkdir(
    target: string,
    opts: { recursive?: boolean },
    cb: (err: Error | null) => void,
  ): void;
  unlink(target: string, cb: (err: Error | null) => void): void;
  rmdir(target: string, cb: (err: Error | null) => void): void;
  rename(oldPath: string, newPath: string, cb: (err: Error | null) => void): void;
  realpath(
    target: string,
    cb: (err: Error | null, resolved?: string) => void,
  ): void;
  access(target: string, cb: (err: Error | null) => void): void;
  access(target: string, mode: number, cb: (err: Error | null) => void): void;
  symlink(target: string, path: string, cb: (err: Error | null) => void): void;
  symlink(
    target: string,
    path: string,
    type: string,
    cb: (err: Error | null) => void,
  ): void;
  readlink(
    target: string,
    cb: (err: Error | null, linkTarget?: string) => void,
  ): void;
  link(
    existingPath: string,
    newPath: string,
    cb: (err: Error | null) => void,
  ): void;
  chmod(target: string, mode: number, cb: (err: Error | null) => void): void;
  chown(
    target: string,
    uid: number,
    gid: number,
    cb: (err: Error | null) => void,
  ): void;
  createReadStream(
    target: string,
    opts?: {
      encoding?: string;
      start?: number;
      end?: number;
      highWaterMark?: number;
      flags?: string;
      mode?: number;
      autoClose?: boolean;
      fd?: number;
    },
  ): import("./stream").Readable;
  createWriteStream(
    target: string,
    opts?: { encoding?: string; flags?: string },
  ): import("./stream").Writable;
  ReadStream: new (path: unknown, opts?: Record<string, unknown>) => import("./stream").Readable;
  WriteStream: new (path: unknown, opts?: Record<string, unknown>) => import("./stream").Writable;
  cpSync(src: unknown, dest: unknown, opts?: CpOptions): void;
  cp(src: unknown, dest: unknown, optsOrCb?: unknown, cb?: (err: Error | null) => void): void;
  readvSync(fd: number, buffers: ArrayBufferView[], pos?: number | null): number;
  readv(fd: number, buffers: ArrayBufferView[], posOrCb?: unknown, cb?: unknown): void;
  globSync(pattern: string | string[], opts?: GlobOptions): string[] | Dirent[];
  glob(pattern: string | string[], optsOrCb?: unknown, cb?: unknown): void;
  statfsSync(target: unknown, opts?: unknown): StatFs;
  statfs(target: unknown, optsOrCb?: unknown, cb?: unknown): void;
  openAsBlob(target: unknown, opts?: { type?: string }): Promise<Blob>;
  exists(target: unknown, cb: (exists: boolean) => void): void;
  lchmodSync(target: unknown, mode: number): void;
  lchmod(target: unknown, mode: number, cb: (err: Error | null) => void): void;
  fdatasync(fd: number, cb: (err: Error | null) => void): void;
  fsync(fd: number, cb: (err: Error | null) => void): void;
  ftruncate(fd: number, lenOrCb?: unknown, cb?: unknown): void;
  truncate(target: unknown, lenOrCb?: unknown, cb?: unknown): void;
  mkdtemp(prefix: string, optsOrCb?: unknown, cb?: unknown): void;
  StatFs: typeof StatFs;
  StatWatcher: typeof StatWatcher;
  promises: FsPromisesShape;
  constants: FsConstantsShape;
}

// matches an RFC-3986 URI scheme prefix. data:/blob: dont have // so we
// just detect "<scheme>:" since thats all we ever see leak into fs paths.
const URL_SCHEME_RE = /^[a-z][a-z0-9+\-.]*:/i;

function resolvePath(target: unknown, cwdFn?: () => string): string {
  let p: string;

  if (typeof target === "string") {
    p = target;
  } else if (
    target instanceof URL ||
    // cross-realm URL objects fail instanceof, so duck-type check
    (target && typeof target === "object" &&
      typeof (target as any).protocol === "string" &&
      typeof (target as any).pathname === "string")
  ) {
    const url = target as { protocol: string; pathname: string };
    if (url.protocol !== "file:") {
      throw new Error(`Unsupported protocol: ${url.protocol}`);
    }
    p = decodeURIComponent(url.pathname);
  } else if (target && typeof target === "object" && "toString" in target) {
    p = String(target);
  } else {
    throw new TypeError(`Path must be a string or URL. Got: ${typeof target}`);
  }

  // url polyfill in src/polyfills/url.ts auto-roots relative URLs at
  // "http://localhost" so jiti / tailwind / postcss can hand us strings
  // like "http://localhost/app/foo.js" via fs.statSync. without stripping
  // we'd get nonsense like "/app/http://localhost/app/foo.js".
  if (URL_SCHEME_RE.test(p)) {
    try {
      const u = new globalThis.URL(p);
      if (u.protocol === "file:" || u.protocol === "http:" || u.protocol === "https:") {
        p = decodeURIComponent(u.pathname) || p;
      }
    } catch {}
  }

  if (!p.startsWith("/") && cwdFn) {
    const cwd = cwdFn();
    p = cwd.endsWith("/") ? cwd + p : cwd + "/" + p;
  }

  return p;
}

// plain Uint8Array.toString() returns comma-separated bytes, not UTF-8 text --
// must wrap with Buffer.from() so .toString() works like Node's Buffer
function wrapAsBuffer(raw: Uint8Array): Buffer {
  if (typeof (raw as any).readUInt8 === "function") return raw as Buffer;
  return Buffer.from(raw) as Buffer;
}

interface OpenFile {
  filePath: string;
  cursor: number;
  mode: string;
  data: Uint8Array;
  isDirectory?: boolean;
  /** Permission bits to apply on first persist of a newly created file. */
  createMode?: number;
}

export function buildFileSystemBridge(
  volume: MemoryVolume,
  getCwd?: () => string,
): FsBridge {
  // each bridge gets its own FD namespace (per-process isolation)
  const openFiles = new Map<number, OpenFile>();
  let fdCounter = 3;

  function numericFlagsToString(f: number): string {
    const O_WRONLY = 1;
    const O_RDWR = 2;
    const O_TRUNC = 512;
    const O_APPEND = 1024;
    const readWrite = (f & O_RDWR) === O_RDWR;
    const writeOnly = (f & O_WRONLY) === O_WRONLY;
    const append = (f & O_APPEND) === O_APPEND;
    const trunc = (f & O_TRUNC) === O_TRUNC;
    if (append) return readWrite ? "a+" : "a";
    // O_WRONLY without O_TRUNC must not truncate (Node preserves); map to "r+"
    if (writeOnly) return trunc ? "w" : "r+";
    if (readWrite) return trunc ? "w+" : "r+";
    return "r";
  }
  const abs = (target: unknown) => resolvePath(target, getCwd);
  // symlink targets: keep relative strings; only absolutize absolute targets
  const symlinkTargetArg = (target: unknown): string => {
    const t = String(target ?? "");
    if (t.startsWith("/")) return abs(t);
    return t;
  };

  function persistWritableFd(fd: number): void {
    const entry = openFiles.get(fd);
    if (!entry || entry.isDirectory) return;
    if (
      entry.mode.includes("w") ||
      entry.mode.includes("a") ||
      entry.mode.includes("+")
    ) {
      volume.writeFileSync(entry.filePath, entry.data);
      if (entry.createMode !== undefined) {
        volume.chmodSync(entry.filePath, entry.createMode & 0o777);
        entry.createMode = undefined;
      }
    }
  }

  const fsConst: FsConstantsShape = {
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_RDWR: 2,
    O_CREAT: 64,
    O_EXCL: 128,
    O_TRUNC: 512,
    O_APPEND: 1024,
    O_DIRECTORY: 65536,
    O_NOFOLLOW: 131072,
    O_SYNC: 1052672,
    O_DSYNC: 4096,
    O_NONBLOCK: 2048,
    O_NOCTTY: 256,
    S_IFMT: 61440,
    S_IFREG: 32768,
    S_IFDIR: 16384,
    S_IFLNK: 40960,
    S_IFCHR: 8192,
    S_IFBLK: 24576,
    S_IFIFO: 4096,
    S_IFSOCK: 49152,
    S_IRWXU: 448,   // 0o700
    S_IRUSR: 256,   // 0o400
    S_IWUSR: 128,   // 0o200
    S_IXUSR: 64,    // 0o100
    S_IRWXG: 56,    // 0o070
    S_IRGRP: 32,    // 0o040
    S_IWGRP: 16,    // 0o020
    S_IXGRP: 8,     // 0o010
    S_IRWXO: 7,     // 0o007
    S_IROTH: 4,     // 0o004
    S_IWOTH: 2,     // 0o002
    S_IXOTH: 1,     // 0o001
    COPYFILE_EXCL: 1,
    COPYFILE_FICLONE: 2,
    COPYFILE_FICLONE_FORCE: 4,
    UV_FS_SYMLINK_DIR: 1,
    UV_FS_SYMLINK_JUNCTION: 2,
  };

  // Helper to build Dirent array from directory entries
  function toDirents(dirPath: string, names: string[]): Dirent[] {
    return names.map((name) => {
      const full = dirPath.endsWith("/")
        ? dirPath + name
        : dirPath + "/" + name;
      let isDir = false;
      let isFile = false;
      let isSymlink = false;
      try {
        const st = volume.lstatSync(full);
        isSymlink = st.isSymbolicLink();
        isDir = !isSymlink && st.isDirectory();
        isFile = !isSymlink && st.isFile();
      } catch {
        isFile = true;
      }
      return new Dirent(name, isDir, isFile, dirPath, isSymlink);
    });
  }

  function isEnoent(err: unknown): boolean {
    return !!(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT");
  }

  function toBigIntStats(st: FileStat): FileStat {
    const wrap = (n: number) => BigInt(n) as unknown as number;
    return {
      ...st,
      size: wrap(st.size),
      mode: wrap(st.mode),
      nlink: wrap(st.nlink),
      uid: wrap(st.uid),
      gid: wrap(st.gid),
      dev: wrap(st.dev),
      ino: wrap(st.ino),
      rdev: wrap(st.rdev),
      blksize: wrap(st.blksize),
      blocks: wrap(st.blocks),
      atimeMs: wrap(st.atimeMs) as unknown as number,
      mtimeMs: wrap(st.mtimeMs) as unknown as number,
      ctimeMs: wrap(st.ctimeMs) as unknown as number,
      birthtimeMs: wrap(st.birthtimeMs) as unknown as number,
      atimeNs: BigInt(Math.trunc(st.atimeMs)) * 1000000n,
      mtimeNs: BigInt(Math.trunc(st.mtimeMs)) * 1000000n,
      ctimeNs: BigInt(Math.trunc(st.ctimeMs)) * 1000000n,
      birthtimeNs: BigInt(Math.trunc(st.birthtimeMs)) * 1000000n,
    };
  }

  function applyStatOptions(st: FileStat | undefined, opts?: StatOptions): FileStat | undefined {
    if (st === undefined) return undefined;
    return opts?.bigint ? toBigIntStats(st) : st;
  }

  function runStat(
    fn: () => FileStat,
    opts?: StatOptions,
  ): FileStat | undefined {
    try {
      return applyStatOptions(fn(), opts);
    } catch (err) {
      if (opts?.throwIfNoEntry === false && isEnoent(err)) return undefined;
      throw err;
    }
  }

  function decodeBytes(raw: Uint8Array, enc?: string | null): Buffer | string {
    if (!enc || enc === "buffer") return wrapAsBuffer(raw);
    return Buffer.from(raw).toString(enc as BufferEncoding);
  }

  function normalizeWriteData(
    data: string | Uint8Array | ArrayBuffer | ArrayBufferView | unknown,
    encoding?: string | null,
  ): Uint8Array {
    if (typeof data === "string") {
      return Buffer.from(data, (encoding || "utf8") as BufferEncoding) as unknown as Uint8Array;
    }
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && ArrayBuffer.isView(data as ArrayBufferView)) {
      const view = data as ArrayBufferView;
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    if (Array.isArray(data) || (data && typeof (data as { length?: number }).length === "number")) {
      return Uint8Array.from(data as ArrayLike<number>);
    }
    return new Uint8Array(0);
  }

  function encodeReaddirNames(names: string[], encoding?: string): string[] | Buffer[] {
    if (encoding === "buffer") {
      return names.map((n) => Buffer.from(n) as unknown as Buffer);
    }
    if (!encoding || encoding === "utf8" || encoding === "utf-8") return names;
    return names.map((n) => Buffer.from(n).toString(encoding as BufferEncoding));
  }

  function expandBraces(pat: string): string[] {
    const m = pat.match(/^([^{]*)\{([^}]+)\}(.*)$/);
    if (!m) return [pat];
    const prefix = m[1], alts = m[2].split(","), suffix = m[3];
    const result: string[] = [];
    for (const alt of alts) result.push(...expandBraces(prefix + alt + suffix));
    return result;
  }

  function globToRegex(pat: string): RegExp {
    let re = "";
    let i = 0;
    while (i < pat.length) {
      const ch = pat[i];
      if (ch === "*" && pat[i + 1] === "*") {
        if (pat[i + 2] === "/") { re += "(?:.+/)?"; i += 3; }
        else { re += ".*"; i += 2; }
      } else if (ch === "*") { re += "[^/]*"; i++; }
      else if (ch === "?") { re += "[^/]"; i++; }
      else if (ch === "[") {
        let j = i + 1;
        if (j < pat.length && (pat[j] === "!" || pat[j] === "^")) j++;
        if (j < pat.length && pat[j] === "]") j++;
        while (j < pat.length && pat[j] !== "]") j++;
        if (j >= pat.length) { re += "\\["; i++; }
        else {
          let cls = pat.slice(i + 1, j);
          if (cls.startsWith("!") || cls.startsWith("^")) cls = "^" + cls.slice(1);
          re += "[" + cls.replace(/\\/g, "\\\\") + "]";
          i = j + 1;
        }
      } else if (".()^$|+{}".includes(ch)) { re += "\\" + ch; i++; }
      else { re += ch; i++; }
    }
    return new RegExp("^" + re + "$");
  }

  function matchGlob(
    pattern: string | string[],
    opts?: GlobOptions,
  ): string[] | Dirent[] {
    const patterns = Array.isArray(pattern) ? pattern : [pattern];
    const cwd = opts?.cwd ? abs(opts.cwd) : (getCwd ? getCwd() : "/");
    const exclude = opts?.exclude;
    const regexes: RegExp[] = [];
    for (const p of patterns) {
      for (const expanded of expandBraces(p)) regexes.push(globToRegex(expanded));
    }
    let excludeFn: ((p: string) => boolean) | null = null;
    if (typeof exclude === "function") excludeFn = exclude;
    else if (Array.isArray(exclude) && exclude.length > 0) {
      const exRegexes: RegExp[] = [];
      for (const ep of exclude) {
        for (const expanded of expandBraces(ep)) exRegexes.push(globToRegex(expanded));
      }
      excludeFn = (p: string) => exRegexes.some((r) => r.test(p));
    }
    const results: string[] = [];
    function walk(dir: string, base: string): void {
      let entries: string[];
      try { entries = volume.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        const full = dir.endsWith("/") ? dir + name : dir + "/" + name;
        const rel = base ? base + "/" + name : name;
        let isDir = false;
        try { isDir = volume.lstatSync(full).isDirectory(); } catch {}
        if (isDir) {
          if (regexes.some((r) => r.test(rel))) results.push(rel);
          walk(full, rel);
        } else {
          results.push(rel);
        }
      }
    }
    walk(cwd, "");
    const matched = results.filter((f) => {
      if (excludeFn && excludeFn(f)) return false;
      return regexes.some((r) => r.test(f));
    });
    if (opts?.withFileTypes) {
      return matched.map((rel) => {
        const full = cwd.endsWith("/") ? cwd + rel : cwd + "/" + rel;
        const parent = full.substring(0, full.lastIndexOf("/")) || "/";
        const name = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
        return toDirents(parent, [name])[0];
      });
    }
    return matched;
  }

  function busyWait(ms: number): void {
    if (ms <= 0) return;
    const end = Date.now() + ms;
    while (Date.now() < end) { /* sync retry delay */ }
  }

  function rmWithRetry(fn: () => void, opts?: RmOptions): void {
    const maxRetries = opts?.maxRetries ?? 0;
    const retryDelay = opts?.retryDelay ?? 100;
    let lastErr: unknown;
    for (let i = 0; i <= maxRetries; i++) {
      try {
        fn();
        return;
      } catch (err) {
        lastErr = err;
        const code = (err as { code?: string })?.code;
        if (i >= maxRetries || (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")) throw err;
        busyWait(retryDelay);
      }
    }
    throw lastErr;
  }

  // watchFile polling state (per bridge / volume)
  type WatchFileEntry = {
    watcher: StatWatcher;
    listeners: Set<(curr: FileStat, prev: FileStat) => void>;
    prev?: FileStat;
    interval: number;
  };
  const watchFileMap = new Map<string, WatchFileEntry>();

  function pollWatchFile(path: string, entry: WatchFileEntry): void {
    let curr: FileStat | undefined;
    try {
      curr = volume.statSync(path);
    } catch {
      curr = undefined;
    }
    const prev = entry.prev;
    if (curr && prev) {
      if (
        curr.mtimeMs !== prev.mtimeMs ||
        curr.size !== prev.size ||
        curr.ino !== prev.ino
      ) {
        for (const listener of entry.listeners) {
          try { listener(curr, prev); } catch { /* ignore */ }
        }
        entry.watcher.emit("change", curr, prev);
      }
    }
    entry.prev = curr;
  }
  class FileHandle {
    fd: number;
    constructor(fd: number) {
      this.fd = fd;
    }

    appendFile(data: string | Uint8Array): Promise<void> {
      const entry = openFiles.get(this.fd);
      if (!entry) return Promise.reject(makeBadfError("appendFile"));
      const bytes = typeof data === "string" ? encoder.encode(data) : data;
      const newData = new Uint8Array(entry.data.length + bytes.length);
      newData.set(entry.data);
      newData.set(bytes, entry.data.length);
      entry.data = newData;
      entry.cursor = newData.length;
      return Promise.resolve();
    }

    chmod(mode: number): Promise<void> {
      const entry = openFiles.get(this.fd);
      if (!entry) return Promise.reject(makeBadfError("chmod"));
      try {
        volume.chmodSync(entry.filePath, mode);
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    }

    chown(uid: number, gid: number): Promise<void> {
      const entry = openFiles.get(this.fd);
      if (!entry) return Promise.reject(makeBadfError("chown"));
      try {
        volume.chownSync(entry.filePath, uid, gid);
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    }

    close(): Promise<void> {
      try {
        if (openFiles.has(this.fd)) {
          persistWritableFd(this.fd);
          openFiles.delete(this.fd);
        }
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    }

    createReadStream(opts?: { encoding?: string; start?: number; end?: number; highWaterMark?: number }): Readable {
      const entry = openFiles.get(this.fd);
      if (!entry) throw makeBadfError("createReadStream");
      if (entry.isDirectory) throw makeSystemError("EISDIR", "read", entry.filePath);
      const start = opts?.start ?? 0;
      const end = opts?.end ?? Infinity;
      let pos = start;
      const hwm = opts?.highWaterMark ?? 64 * 1024;
      const stream: any = new Readable({
        highWaterMark: hwm,
        read(size: number) {
          try {
            if (pos > end) {
              stream.push(null);
              return;
            }
            const toRead = Math.min(size || hwm, Math.max(0, (end === Infinity ? entry.data.length - 1 : end) - pos + 1));
            if (toRead <= 0 || pos >= entry.data.length) {
              stream.push(null);
              return;
            }
            const chunk = entry.data.subarray(pos, pos + toRead);
            pos += chunk.length;
            stream.push(Buffer.from(chunk));
            if (pos > end || pos >= entry.data.length) stream.push(null);
          } catch (err) {
            stream.destroy(err as Error);
          }
        },
      });
      stream.path = entry.filePath;
      stream.fd = this.fd;
      return stream;
    }

    createWriteStream(_opts?: { encoding?: string }): Writable {
      const entry = openFiles.get(this.fd);
      if (!entry) throw makeBadfError("createWriteStream");
      const chunks: Uint8Array[] = [];
      const stream: any = new Writable();
      stream.path = entry.filePath;
      stream.fd = this.fd;
      stream._write = (chunk: Uint8Array | string, _enc: string, cb: (err?: Error | null) => void) => {
        const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
        chunks.push(bytes);
        cb(null);
      };
      stream.on("finish", () => {
        const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let pos = 0;
        for (const c of chunks) { merged.set(c, pos); pos += c.length; }
        entry.data = merged;
        entry.cursor = merged.length;
      });
      return stream;
    }

    datasync(): Promise<void> {
      try {
        persistWritableFd(this.fd);
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    }

    read(
      bufOrOpts?: Buffer | Uint8Array | { buffer: Buffer | Uint8Array; offset?: number; length?: number; position?: number | null },
      offset?: number,
      length?: number,
      position?: number | null,
    ): Promise<{ bytesRead: number; buffer: Buffer | Uint8Array }> {
      const entry = openFiles.get(this.fd);
      if (!entry) return Promise.reject(makeBadfError("read"));
      let buf: Buffer | Uint8Array;
      let off: number;
      let len: number;
      let pos: number | null;
      if (bufOrOpts && typeof bufOrOpts === "object" && "buffer" in bufOrOpts) {
        const opts = bufOrOpts as { buffer: Buffer | Uint8Array; offset?: number; length?: number; position?: number | null };
        buf = opts.buffer;
        off = opts.offset ?? 0;
        len = opts.length ?? buf.length;
        pos = opts.position ?? null;
      } else {
        buf = bufOrOpts ? (bufOrOpts as Buffer | Uint8Array) : (Buffer.alloc(16384) as unknown as Buffer);
        off = offset ?? 0;
        len = length ?? buf.length;
        pos = position ?? null;
      }
      const readAt = pos !== null ? pos : entry.cursor;
      const count = Math.min(len, entry.data.length - readAt);
      if (count <= 0) return Promise.resolve({ bytesRead: 0, buffer: buf });
      for (let i = 0; i < count; i++) buf[off + i] = entry.data[readAt + i];
      if (pos === null) entry.cursor += count;
      return Promise.resolve({ bytesRead: count, buffer: buf });
    }

    readableWebStream(): ReadableStream<Uint8Array> {
      const entry = openFiles.get(this.fd);
      const data = entry ? new Uint8Array(entry.data) : new Uint8Array(0);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
    }

    readFile(opts?: { encoding?: string | null } | string): Promise<Buffer | string> {
      const entry = openFiles.get(this.fd);
      if (!entry) return Promise.reject(makeBadfError("readFile"));
      const enc = typeof opts === "string" ? opts : opts?.encoding;
      if (enc === "utf8" || enc === "utf-8") {
        return Promise.resolve(decoder.decode(entry.data));
      }
      return Promise.resolve(wrapAsBuffer(new Uint8Array(entry.data)));
    }

    readLines(): AsyncIterable<string> {
      const entry = openFiles.get(this.fd);
      const content = entry ? decoder.decode(entry.data) : "";
      const lines = content.split("\n");
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next(): Promise<IteratorResult<string>> {
              if (i < lines.length) return Promise.resolve({ value: lines[i++], done: false });
              return Promise.resolve({ value: undefined as any, done: true });
            },
          };
        },
      };
    }

    readv(buffers: ArrayBufferView[], position?: number): Promise<{ bytesRead: number; buffers: ArrayBufferView[] }> {
      const entry = openFiles.get(this.fd);
      if (!entry) return Promise.reject(makeBadfError("readv"));
      let totalRead = 0;
      let readPos = position ?? entry.cursor;
      for (const buf of buffers) {
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const count = Math.min(u8.length, entry.data.length - readPos);
        if (count <= 0) break;
        for (let i = 0; i < count; i++) u8[i] = entry.data[readPos + i];
        readPos += count;
        totalRead += count;
        if (count < u8.length) break;
      }
      if (position === undefined) entry.cursor = readPos;
      return Promise.resolve({ bytesRead: totalRead, buffers });
    }

    stat(opts?: StatOptions): Promise<FileStat | undefined> {
      const entry = openFiles.get(this.fd);
      if (!entry) return Promise.reject(makeBadfError("fstat"));
      try {
        return Promise.resolve(runStat(() => volume.statSync(entry.filePath), opts));
      } catch (e) {
        return Promise.reject(e);
      }
    }

    sync(): Promise<void> {
      try {
        persistWritableFd(this.fd);
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    }

    truncate(len: number = 0): Promise<void> {
      const entry = openFiles.get(this.fd);
      if (!entry) return Promise.reject(makeBadfError("ftruncate"));
      if (len < entry.data.length) {
        entry.data = entry.data.slice(0, len);
      } else if (len > entry.data.length) {
        const bigger = new Uint8Array(len);
        bigger.set(entry.data);
        entry.data = bigger;
      }
      return Promise.resolve();
    }

    utimes(atime: unknown, mtime: unknown): Promise<void> {
      const entry = openFiles.get(this.fd);
      if (!entry) return Promise.reject(makeBadfError("futimes"));
      try {
        volume.utimesSync(entry.filePath, atime as number | Date, mtime as number | Date);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }

    write(
      buf: Buffer | Uint8Array | string,
      offsetOrOpts?: number | { offset?: number; length?: number; position?: number | null },
      length?: number,
      position?: number | null,
    ): Promise<{ bytesWritten: number; buffer: Buffer | Uint8Array | string }> {
      const entry = openFiles.get(this.fd);
      if (!entry) return Promise.reject(makeBadfError("write"));
      let bytes: Uint8Array;
      let off: number;
      let len: number;
      let pos: number | null | undefined;
      if (typeof buf === "string") {
        bytes = encoder.encode(buf);
        off = 0;
        len = bytes.length;
        pos = typeof offsetOrOpts === "number" ? offsetOrOpts : null;
      } else if (typeof offsetOrOpts === "object" && offsetOrOpts !== null) {
        bytes = buf;
        off = offsetOrOpts.offset ?? 0;
        len = offsetOrOpts.length ?? bytes.length - off;
        pos = offsetOrOpts.position;
      } else {
        bytes = buf;
        off = (offsetOrOpts as number) ?? 0;
        len = length ?? bytes.length - off;
        pos = position;
      }
      const writeAt = pos !== null && pos !== undefined ? pos : entry.cursor;
      const endAt = writeAt + len;
      if (endAt > entry.data.length) {
        const expanded = new Uint8Array(endAt);
        expanded.set(entry.data);
        entry.data = expanded;
      }
      for (let i = 0; i < len; i++) entry.data[writeAt + i] = bytes[off + i];
      if (pos === null || pos === undefined) entry.cursor = endAt;
      return Promise.resolve({ bytesWritten: len, buffer: buf });
    }

    writeFile(data: string | Uint8Array): Promise<void> {
      const entry = openFiles.get(this.fd);
      if (!entry) return Promise.reject(makeBadfError("writeFile"));
      const bytes = typeof data === "string" ? encoder.encode(data) : data;
      entry.data = new Uint8Array(bytes);
      entry.cursor = bytes.length;
      return Promise.resolve();
    }

    writev(buffers: ArrayBufferView[], position?: number): Promise<{ bytesWritten: number; buffers: ArrayBufferView[] }> {
      const entry = openFiles.get(this.fd);
      if (!entry) return Promise.reject(makeBadfError("writev"));
      let totalWritten = 0;
      let writePos = position ?? entry.cursor;
      for (const buf of buffers) {
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const endAt = writePos + u8.length;
        if (endAt > entry.data.length) {
          const expanded = new Uint8Array(endAt);
          expanded.set(entry.data);
          entry.data = expanded;
        }
        for (let i = 0; i < u8.length; i++) entry.data[writePos + i] = u8[i];
        writePos += u8.length;
        totalWritten += u8.length;
      }
      if (position === undefined) entry.cursor = writePos;
      return Promise.resolve({ bytesWritten: totalWritten, buffers });
    }

    [Symbol.asyncDispose](): Promise<void> {
      return this.close();
    }
  }

  function makeBadfError(syscall: string): Error & { code: string; errno: number } {
    const err = new Error(`EBADF: bad file descriptor, ${syscall}`) as Error & { code: string; errno: number };
    err.code = "EBADF";
    err.errno = -9;
    return err;
  }
  const promisesApi: FsPromisesShape = {
    readFile(
      target: unknown,
      encOrOpts?: string | { encoding?: string | null },
    ): Promise<Buffer | string> {
      return settledPromise((ok, fail) => {
        try {
          const p = abs(target);
          let enc: string | undefined;
          if (typeof encOrOpts === "string") enc = encOrOpts;
          else if (encOrOpts?.encoding) enc = encOrOpts.encoding ?? undefined;
          const raw = volume.readFileSync(p);
          if (p.endsWith(".wasm")) precompileWasm(raw);
          ok(decodeBytes(raw, enc));
        } catch (e) {
          fail(e);
        }
      });
    },
    writeFile(
      target: unknown,
      data: string | Uint8Array,
      opts?: WriteFileOptions,
    ): Promise<void> {
      return settledPromise((ok, fail) => {
        try {
          bridge.writeFileSync(target as PathArg, data, opts);
          ok();
        } catch (e) {
          fail(e);
        }
      });
    },
    stat(target: unknown, opts?: StatOptions): Promise<FileStat | undefined> {
      return settledPromise((ok, fail) => {
        try {
          ok(runStat(() => volume.statSync(abs(target)), opts));
        } catch (e) {
          fail(e);
        }
      });
    },
    mkdir(
      target: unknown,
      opts?: { recursive?: boolean; mode?: number },
    ): Promise<string | undefined> {
      return settledPromise((ok, fail) => {
        try {
          ok(volume.mkdirSync(abs(target), opts));
        } catch (e) {
          fail(e);
        }
      });
    },
    unlink(target: unknown): Promise<void> {
      return settledPromise((ok, fail) => {
        try {
          volume.unlinkSync(abs(target));
          ok();
        } catch (e) {
          fail(e);
        }
      });
    },
    rmdir(target: unknown): Promise<void> {
      return settledPromise((ok, fail) => {
        try {
          volume.rmdirSync(abs(target) as string);
          ok();
        } catch (e) {
          fail(e);
        }
      });
    },
    rename(src: unknown, dest: unknown): Promise<void> {
      return settledPromise((ok, fail) => {
        try {
          volume.renameSync(abs(src), abs(dest));
          ok();
        } catch (e) {
          fail(e);
        }
      });
    },
    access(target: unknown, mode?: number): Promise<void> {
      return settledPromise((ok, fail) => {
        try {
          volume.accessSync(abs(target), mode);
          ok();
        } catch (e) {
          fail(e);
        }
      });
    },
    realpath(target: unknown): Promise<string> {
      return settledPromise((ok, fail) => {
        try {
          ok(volume.realpathSync(abs(target)));
        } catch (e) {
          fail(e);
        }
      });
    },
    copyFile(src: unknown, dest: unknown, mode: number = 0): Promise<void> {
      return settledPromise((ok, fail) => {
        try {
          volume.copyFileSync(abs(src), abs(dest), mode);
          ok();
        } catch (e) {
          fail(e);
        }
      });
    },
    appendFile(target: unknown, data: string | Uint8Array): Promise<void> {
      return settledPromise((ok, fail) => {
        try {
          volume.appendFileSync(abs(target), data);
          ok();
        } catch (e) {
          fail(e);
        }
      });
    },
    symlink(target: unknown, path: unknown, type?: string): Promise<void> {
      return settledPromise((ok, fail) => {
        try {
          volume.symlinkSync(symlinkTargetArg(target), abs(path), type);
          ok();
        } catch (e) {
          fail(e);
        }
      });
    },
    readlink(target: unknown): Promise<string> {
      return settledPromise((ok, fail) => {
        try {
          ok(volume.readlinkSync(abs(target)));
        } catch (e) {
          fail(e);
        }
      });
    },
    link(existingPath: unknown, newPath: unknown): Promise<void> {
      return settledPromise((ok, fail) => {
        try {
          volume.linkSync(abs(existingPath), abs(newPath));
          ok();
        } catch (e) {
          fail(e);
        }
      });
    },
    chmod(target: unknown, mode: number): Promise<void> {
      return settledPromise((ok, fail) => {
        try {
          volume.chmodSync(abs(target), mode);
          ok();
        } catch (e) {
          fail(e);
        }
      });
    },
    chown(target: unknown, uid: number, gid: number): Promise<void> {
      return settledPromise((ok, fail) => {
        try {
          volume.chownSync(abs(target), uid, gid);
          ok();
        } catch (e) {
          fail(e);
        }
      });
    },
    truncate(target: unknown, len?: number): Promise<void> {
      return settledPromise((ok, fail) => {
        try {
          volume.truncateSync(abs(target), len);
          ok();
        } catch (e) {
          fail(e);
        }
      });
    },
    rm(
      target: unknown,
      opts?: RmOptions,
    ): Promise<void> {
      return new Promise(async (ok, fail) => {
        try {
          const maxRetries = opts?.maxRetries ?? 0;
          const retryDelay = opts?.retryDelay ?? 100;
          let lastErr: unknown;
          for (let i = 0; i <= maxRetries; i++) {
            try {
              bridge.rmSync(abs(target), opts);
              ok();
              return;
            } catch (err) {
              lastErr = err;
              const code = (err as { code?: string })?.code;
              if (i >= maxRetries || (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")) {
                fail(err);
                return;
              }
              await new Promise((r) => setTimeout(r, retryDelay));
            }
          }
          fail(lastErr);
        } catch (e) {
          fail(e);
        }
      });
    },
    lstat(target: unknown, opts?: StatOptions): Promise<FileStat | undefined> {
      return settledPromise((ok, fail) => {
        try {
          ok(runStat(() => volume.lstatSync(abs(target)), opts));
        } catch (e) {
          fail(e);
        }
      });
    },
    utimes(target: unknown, atime: unknown, mtime: unknown): Promise<void> {
      try {
        volume.utimesSync(abs(target), atime as number | Date, mtime as number | Date);
        return settledResolve();
      } catch (error) {
        return settledReject(error);
      }
    },
    lchown(target: unknown, uid: number, gid: number): Promise<void> {
      try {
        volume.lchownSync(abs(target), uid, gid);
        return settledResolve();
      } catch (error) {
        return settledReject(error);
      }
    },
    lutimes(target: unknown, atime: unknown, mtime: unknown): Promise<void> {
      try {
        volume.lutimesSync(abs(target), atime as number | Date, mtime as number | Date);
        return settledResolve();
      } catch (error) {
        return settledReject(error);
      }
    },
    opendir(target: unknown, _opts?: unknown): Promise<Dir> {
      try {
        const p = abs(target);
        const names = volume.readdirSync(p);
        const entries = toDirents(p, names);
        return settledResolve(new Dir(p, entries));
      } catch (e) {
        return settledReject(e);
      }
    },
    readdir(
      target: unknown,
      opts?: { withFileTypes?: boolean; encoding?: string } | string,
    ): Promise<string[] | Buffer[] | Dirent[]> {
      try {
        const p = abs(target);
        const names = volume.readdirSync(p);
        const o = typeof opts === "string" ? { encoding: opts } : opts;
        if (o?.withFileTypes) {
          return settledResolve(toDirents(p, names));
        }
        return settledResolve(encodeReaddirNames(names, o?.encoding));
      } catch (e) {
        return settledReject(e);
      }
    },
    glob(
      pattern: string | string[],
      opts?: GlobOptions,
    ): AsyncIterable<string | Dirent> {
      const matched = matchGlob(pattern, opts) as Array<string | Dirent>;
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next() {
              if (i < matched.length) {
                return settledResolve({ value: matched[i++], done: false as const });
              }
              return settledResolve({ value: undefined as never, done: true as const });
            },
          };
        },
      };
    },
    open(target: unknown, flags?: string | number, _mode?: number): Promise<FileHandle> {
      try {
        const f = flags ?? "r";
        const fd = bridge.openSync(abs(target), f, _mode);
        return settledResolve(new FileHandle(fd));
      } catch (e) {
        return settledReject(e);
      }
    },
    mkdtemp(prefix: string): Promise<string> {
      try {
        return settledResolve(bridge.mkdtempSync(prefix));
      } catch (e) {
        return settledReject(e);
      }
    },
    watch(
      filename: unknown,
      opts?: { persistent?: boolean; recursive?: boolean; signal?: AbortSignal },
    ): AsyncIterable<{ eventType: string; filename: string | null }> {
      const p = abs(filename);
      const events: { eventType: string; filename: string | null }[] = [];
      let resolve: (() => void) | null = null;
      let closed = false;

      const handle = volume.watch(p, { persistent: opts?.persistent, recursive: opts?.recursive }, (event, name) => {
        events.push({ eventType: event, filename: name });
        if (resolve) { resolve(); resolve = null; }
      });

      // keeps the loop alive while the iterator is open. abort/return releases
      const elHandle = getRegistry().register("FSWatcher");
      const releaseAll = () => {
        if (closed) return;
        closed = true;
        handle.close();
        elHandle.close();
      };

      if (opts?.signal) {
        opts.signal.addEventListener("abort", () => { releaseAll(); if (resolve) { resolve(); resolve = null; } }, { once: true });
      }

      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<{ eventType: string; filename: string | null }>> {
              if (events.length > 0) {
                return settledResolve({ value: events.shift()!, done: false });
              }
              if (closed) return settledResolve({ value: undefined as any, done: true });
              return new Promise<IteratorResult<{ eventType: string; filename: string | null }>>((res) => {
                resolve = () => {
                  if (events.length > 0) res({ value: events.shift()!, done: false });
                  else res({ value: undefined as any, done: true });
                };
              });
            },
            return(): Promise<IteratorResult<{ eventType: string; filename: string | null }>> {
              releaseAll();
              return settledResolve({ value: undefined as any, done: true });
            },
          };
        },
      };
    },
    statfs(_target: unknown): Promise<StatFs> {
      return settledResolve(new StatFs());
    },
    cp(
      src: unknown,
      dest: unknown,
      opts?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean },
    ): Promise<void> {
      try {
        bridge.cpSync(src, dest, opts);
        return settledResolve();
      } catch (e) {
        return settledReject(e);
      }
    },
    FileHandle: FileHandle as any,
    constants: fsConst,
  } as FsPromisesShape;
  const realpathSyncFn = function realpathSync(target: unknown): string {
    return volume.realpathSync(abs(target));
  };
  (realpathSyncFn as any).native = function native(target: unknown): string {
    return volume.realpathSync(abs(target));
  };

  const bridge: FsBridge = {
    __openFileHandleSync(target: PathArg): VolumeFileHandle {
      return volume.openFileHandleSync(abs(target));
    },
    readFileSync(
      target: unknown,
      encOrOpts?: string | { encoding?: string | null },
    ): Buffer | string {
      const p = abs(target);
      let enc: string | undefined;
      if (typeof encOrOpts === "string") enc = encOrOpts;
      else if (encOrOpts?.encoding) enc = encOrOpts.encoding ?? undefined;
      const wasmPath =
        p.endsWith(".wasm") && p.includes("/node_modules/")
          ? resolveWasmAssetPath(volume, p)
          : p;

      try {
        const raw = volume.readFileSync(wasmPath);
        if (wasmPath.endsWith(".wasm")) precompileWasm(raw);
        return decodeBytes(raw, enc);
      } catch (err: any) {
        // .wasm under node_modules missing from the VFS (e.g. >15MB binary
        // that skipped extraction): kick an async CDN prefetch so a retry
        // succeeds, but never block this thread with a sync download.
        if (
          err?.code === "ENOENT" &&
          p.endsWith(".wasm") &&
          p.includes("/node_modules/")
        ) {
          console.warn(
            `[nodepod] ${p} not in VFS — fetching from CDN in the background; the next read will succeed once it lands`,
          );
          prefetchWasmFromCdn(volume, wasmPath).catch(() => {});
        }
        throw err;
      }
    },

    writeFileSync(
      target: unknown,
      data: string | Uint8Array | ArrayBuffer | ArrayBufferView | unknown,
      opts?: WriteFileOptions | string,
    ): void {
      const options: WriteFileOptions =
        typeof opts === "string" ? { encoding: opts } : opts ?? {};
      const bytes = normalizeWriteData(data, options.encoding);

      if (typeof target === "number") {
        const entry = openFiles.get(target);
        if (!entry) {
          const err = new Error(
            "EBADF: bad file descriptor, write",
          ) as Error & { code: string; errno: number };
          err.code = "EBADF";
          err.errno = -9;
          throw err;
        }
        entry.data = new Uint8Array(bytes);
        entry.cursor = bytes.length;
        return;
      }

      const wp = abs(target);
      const flag = options.flag ?? "w";
      const mode = options.mode ?? 0o666;
      const fd = bridge.openSync(wp, flag, mode);
      try {
        if (flag.includes("a")) {
          bridge.writeSync(fd, bytes as unknown as Buffer, 0, bytes.length, null);
        } else {
          bridge.ftruncateSync(fd, 0);
          bridge.writeSync(fd, bytes as unknown as Buffer, 0, bytes.length, 0);
        }
      } finally {
        bridge.closeSync(fd);
      }
      if (wp.endsWith(".wasm")) {
        precompileWasm(bytes);
      }
    },

    existsSync(target: unknown): boolean {
      return volume.existsSync(abs(target));
    },

    mkdirSync(target: unknown, opts?: { recursive?: boolean; mode?: number }): string | undefined {
      return volume.mkdirSync(abs(target), opts);
    },

    readdirSync(
      target: unknown,
      opts?: { withFileTypes?: boolean; encoding?: string } | string,
    ): string[] | Buffer[] | Dirent[] {
      const p = abs(target);
      const names = volume.readdirSync(p);
      const o = typeof opts === "string" ? { encoding: opts } : opts;
      if (o?.withFileTypes) {
        return toDirents(p, names);
      }
      return encodeReaddirNames(names, o?.encoding);
    },

    statSync(target: unknown, opts?: StatOptions): FileStat | undefined {
      const p = abs(target);
      // probing callers (vite's tryStatSync, resolvers) mostly miss: answer
      // those without constructing and unwinding an ENOENT error
      if (opts?.throwIfNoEntry === false && !volume.existsSync(p)) return undefined;
      return runStat(() => volume.statSync(p), opts);
    },

    lstatSync(target: unknown, opts?: StatOptions): FileStat | undefined {
      return runStat(() => volume.lstatSync(abs(target)), opts);
    },

    fstatSync(fd: number, opts?: StatOptions): FileStat | undefined {
      const entry = openFiles.get(fd);
      if (!entry) {
        const err = new Error("EBADF: bad file descriptor, fstat") as Error & {
          code: string;
          errno: number;
        };
        err.code = "EBADF";
        err.errno = -9;
        throw err;
      }
      return runStat(() => volume.statSync(entry.filePath), opts);
    },

    unlinkSync(target: unknown): void {
      volume.unlinkSync(abs(target));
    },

    rmdirSync(target: unknown): void {
      volume.rmdirSync(abs(target));
    },

    renameSync(src: unknown, dest: unknown): void {
      volume.renameSync(abs(src), abs(dest));
    },

    realpathSync: realpathSyncFn as FsBridge["realpathSync"],

    accessSync(target: unknown, mode?: number): void {
      volume.accessSync(abs(target), mode);
    },

    copyFileSync(src: unknown, dest: unknown, mode: number = 0): void {
      volume.copyFileSync(abs(src), abs(dest), mode);
    },

    symlinkSync(target: unknown, path: unknown, _type?: string): void {
      volume.symlinkSync(symlinkTargetArg(target), abs(path), _type);
    },

    readlinkSync(target: unknown): string {
      return volume.readlinkSync(abs(target));
    },

    linkSync(existingPath: unknown, newPath: unknown): void {
      volume.linkSync(abs(existingPath), abs(newPath));
    },

    chmodSync(target: unknown, mode: number): void {
      volume.chmodSync(abs(target), mode);
    },

    chownSync(target: unknown, uid: number, gid: number): void {
      volume.chownSync(abs(target), uid, gid);
    },

    lchownSync(target: unknown, uid: number, gid: number): void {
      volume.lchownSync(abs(target), uid, gid);
    },

    utimesSync(target: unknown, atime: unknown, mtime: unknown): void {
      volume.utimesSync(abs(target), atime as number | Date, mtime as number | Date);
    },

    lutimesSync(target: unknown, atime: unknown, mtime: unknown): void {
      volume.lutimesSync(abs(target), atime as number | Date, mtime as number | Date);
    },

    futimesSync(fd: number, atime: unknown, mtime: unknown): void {
      const entry = openFiles.get(fd);
      if (!entry) throw makeBadfError("futimes");
      volume.utimesSync(entry.filePath, atime as number | Date, mtime as number | Date);
    },

    fchownSync(fd: number, uid: number, gid: number): void {
      const entry = openFiles.get(fd);
      if (!entry) throw makeBadfError("fchown");
      volume.chownSync(entry.filePath, uid, gid);
    },

    fchmodSync(fd: number, mode: number): void {
      const entry = openFiles.get(fd);
      if (!entry) throw makeBadfError("fchmod");
      volume.chmodSync(entry.filePath, mode);
    },

    appendFileSync(target: unknown, data: string | Uint8Array): void {
      volume.appendFileSync(abs(target), data);
    },

    truncateSync(target: unknown, len?: number): void {
      volume.truncateSync(abs(target), len);
    },
    openSync(target: unknown, flags: string | number, mode?: number): number {
      const p = abs(target);
      const numeric = typeof flags === "number" ? flags : null;
      const flagStr = numeric !== null ? numericFlagsToString(numeric) : String(flags);
      const O_CREAT = 64;
      const O_EXCL = 128;
      const O_DIRECTORY = 65536;
      const O_NOFOLLOW = 131072;
      const createMode = mode ?? 0o666;
      const wantsExcl =
        (numeric !== null && (numeric & O_EXCL) !== 0) || flagStr.includes("x");
      const wantsCreat =
        (numeric !== null && (numeric & O_CREAT) !== 0) ||
        /[wax]/i.test(flagStr);
      const wantsDirectory = numeric !== null && (numeric & O_DIRECTORY) !== 0;
      const wantsNoFollow = numeric !== null && (numeric & O_NOFOLLOW) !== 0;
      const isWrite = flagStr.includes("w") || flagStr.includes("a");
      const isReadOnly = flagStr.includes("r") && !flagStr.includes("+");

      if (wantsNoFollow) {
        try {
          const raw = volume.lstatSync(p);
          if (raw.isSymbolicLink()) {
            throw makeSystemError("ELOOP", "open", p);
          }
        } catch (err) {
          if ((err as { code?: string }).code === "ELOOP") throw err;
          // missing path handled below
        }
      }

      const exists = volume.existsSync(p);

      if (wantsExcl && exists) {
        const err = new Error(
          `EEXIST: file already exists, open '${p}'`,
        ) as Error & { code: string; errno: number; path: string };
        err.code = "EEXIST";
        err.errno = -17;
        err.path = p;
        throw err;
      }

      if (!exists && (isReadOnly || (flagStr === "r+" && !wantsCreat))) {
        const err = new Error(
          `ENOENT: no such file or directory, open '${p}'`,
        ) as Error & { code: string; errno: number; path: string };
        err.code = "ENOENT";
        err.errno = -2;
        err.path = p;
        throw err;
      }

      if (exists && wantsDirectory) {
        const st = volume.statSync(p);
        if (!st.isDirectory()) throw makeSystemError("ENOTDIR", "open", p);
        const fd = fdCounter++;
        openFiles.set(fd, {
          filePath: p,
          cursor: 0,
          mode: flagStr,
          data: new Uint8Array(0),
          isDirectory: true,
        });
        return fd;
      }

      if (exists) {
        try {
          if (volume.statSync(p).isDirectory()) {
            if (wantsDirectory || isReadOnly) {
              const fd = fdCounter++;
              openFiles.set(fd, {
                filePath: p,
                cursor: 0,
                mode: flagStr,
                data: new Uint8Array(0),
                isDirectory: true,
              });
              return fd;
            }
            throw makeSystemError("EISDIR", "open", p);
          }
        } catch (err) {
          if ((err as { code?: string }).code === "EISDIR") throw err;
        }
      }

      let content: Uint8Array;
      let created = false;
      if (exists && !flagStr.includes("w")) {
        content = volume.readFileSync(p);
      } else {
        content = new Uint8Array(0);
        if (isWrite || wantsCreat) {
          const parent = p.substring(0, p.lastIndexOf("/")) || "/";
          if (!volume.existsSync(parent)) {
            volume.mkdirSync(parent, { recursive: true });
          }
          if (!exists) created = true;
        }
      }

      const fd = fdCounter++;
      openFiles.set(fd, {
        filePath: p,
        cursor: flagStr.includes("a") ? content.length : 0,
        mode: flagStr,
        data: new Uint8Array(content),
        createMode: created ? createMode : undefined,
      });
      if (exists && flagStr.includes("w") && !flagStr.includes("a")) {
        // truncate on open for 'w' — deferred until first persist so fsync
        // semantics stay Node-like, but remember mode if caller set one.
        if (mode !== undefined) {
          openFiles.get(fd)!.createMode = createMode;
        }
      }
      return fd;
    },

    closeSync(fd: number): void {
      const entry = openFiles.get(fd);
      if (!entry) return;
      persistWritableFd(fd);
      openFiles.delete(fd);
    },

    readSync(
      fd: number,
      buf: Buffer | Uint8Array,
      off: number,
      len: number,
      pos: number | null,
    ): number {
      const entry = openFiles.get(fd);
      if (!entry) {
        const err = new Error("EBADF: bad file descriptor, read") as Error & {
          code: string;
          errno: number;
        };
        err.code = "EBADF";
        err.errno = -9;
        throw err;
      }
      const readAt = pos !== null ? pos : entry.cursor;
      const count = Math.min(len, entry.data.length - readAt);
      if (count <= 0) return 0;
      for (let i = 0; i < count; i++) {
        buf[off + i] = entry.data[readAt + i];
      }
      if (pos === null) entry.cursor += count;
      return count;
    },

    writeSync(
      fd: number,
      buf: Buffer | Uint8Array | string,
      off?: number,
      len?: number,
      pos?: number | null,
    ): number {
      const entry = openFiles.get(fd);
      if (!entry) {
        const err = new Error("EBADF: bad file descriptor, write") as Error & {
          code: string;
          errno: number;
        };
        err.code = "EBADF";
        err.errno = -9;
        throw err;
      }

      let bytes: Uint8Array;
      if (typeof buf === "string") {
        bytes = encoder.encode(buf);
        off = 0;
        len = bytes.length;
      } else {
        bytes = buf;
        off = off ?? 0;
        len = len ?? bytes.length - off;
      }

      const writeAt = pos !== null && pos !== undefined ? pos : entry.cursor;
      const endAt = writeAt + len;

      if (endAt > entry.data.length) {
        const expanded = new Uint8Array(endAt);
        expanded.set(entry.data);
        entry.data = expanded;
      }

      for (let i = 0; i < len; i++) {
        entry.data[writeAt + i] = bytes[off + i];
      }

      if (pos === null || pos === undefined) entry.cursor = endAt;
      return len;
    },

    writevSync(fd: number, buffers: ArrayBufferView[], pos?: number | null): number {
      let totalWritten = 0;
      for (const buf of buffers) {
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const n = bridge.writeSync(fd, u8 as unknown as Buffer, 0, u8.length, pos != null ? pos + totalWritten : undefined);
        totalWritten += n;
      }
      return totalWritten;
    },

    ftruncateSync(fd: number, len: number = 0): void {
      const entry = openFiles.get(fd);
      if (!entry) {
        const err = new Error(
          "EBADF: bad file descriptor, ftruncate",
        ) as Error & { code: string; errno: number };
        err.code = "EBADF";
        err.errno = -9;
        throw err;
      }
      if (len < entry.data.length) {
        entry.data = entry.data.slice(0, len);
      } else if (len > entry.data.length) {
        const bigger = new Uint8Array(len);
        bigger.set(entry.data);
        entry.data = bigger;
      }
    },

    fsyncSync(fd: number): void {
      const entry = openFiles.get(fd);
      if (!entry) {
        const err = new Error("EBADF: bad file descriptor, fsync") as Error & {
          code: string;
          errno: number;
        };
        err.code = "EBADF";
        err.errno = -9;
        throw err;
      }
      persistWritableFd(fd);
    },
    fdatasyncSync(fd: number): void {
      const entry = openFiles.get(fd);
      if (!entry) {
        const err = new Error("EBADF: bad file descriptor, fdatasync") as Error & {
          code: string;
          errno: number;
        };
        err.code = "EBADF";
        err.errno = -9;
        throw err;
      }
      persistWritableFd(fd);
    },

    mkdtempSync(prefix: string): string {
      const rand = Math.random().toString(36).substring(2, 8);
      const dirPath = abs(`${prefix}${rand}`);
      volume.mkdirSync(dirPath, { recursive: true });
      return dirPath;
    },

    rmSync(
      target: unknown,
      opts?: RmOptions,
    ): void {
      rmWithRetry(() => {
        const p = abs(target);
        if (!volume.existsSync(p)) {
          if (opts?.force) return;
          throw makeSystemError("ENOENT", "rm", p);
        }
        const st = volume.statSync(p);
        if (st.isDirectory()) {
          if (opts?.recursive) {
            volume.removeTreeSync(p);
          } else {
            throw makeSystemError("EISDIR", "rm", p);
          }
        } else {
          volume.unlinkSync(p);
        }
      }, opts);
    },
    watch(
      filename: unknown,
      optsOrCb?: { persistent?: boolean; recursive?: boolean } | WatchCallback,
      cb?: WatchCallback,
    ): FileWatchHandle {
      const p = abs(filename);
      const inner = volume.watch(
        p,
        optsOrCb as { persistent?: boolean; recursive?: boolean },
        cb,
      );
      // hold a Handle for the loop and wrap close() to release it. ref/unref
      // mirror node's FSWatcher API so watcher.unref() lets the process exit
      // without having to close the watcher first.
      const elHandle = getRegistry().register("FSWatcher");
      const origClose = inner.close?.bind(inner);
      if (origClose) {
        inner.close = () => {
          origClose();
          elHandle.close();
        };
      }
      (inner as any).ref = () => {
        elHandle.ref();
        return inner;
      };
      (inner as any).unref = () => {
        elHandle.unref();
        return inner;
      };
      return inner;
    },

    watchFile(
      filename: unknown,
      optsOrListener?:
        | { interval?: number; persistent?: boolean }
        | ((curr: FileStat, prev: FileStat) => void),
      listener?: (curr: FileStat, prev: FileStat) => void,
    ): StatWatcher {
      const p = abs(filename);
      const opts =
        typeof optsOrListener === "function" ? undefined : optsOrListener;
      const cb =
        typeof optsOrListener === "function" ? optsOrListener : listener;
      const interval = opts?.interval ?? 5007;
      let entry = watchFileMap.get(p);
      if (!entry) {
        const watcher = new StatWatcher();
        entry = {
          watcher,
          listeners: new Set(),
          interval,
          prev: (() => {
            try { return volume.statSync(p); } catch { return undefined; }
          })(),
        };
        watchFileMap.set(p, entry);
        watcher.start(p, opts?.persistent !== false, interval, () => {
          const e = watchFileMap.get(p);
          if (e) pollWatchFile(p, e);
        });
      }
      if (cb) {
        entry.listeners.add(cb);
        entry.watcher.on("change", cb as (...args: unknown[]) => void);
      }
      return entry.watcher;
    },

    unwatchFile(
      filename: unknown,
      listener?: (curr: FileStat, prev: FileStat) => void,
    ): void {
      const p = abs(filename);
      const entry = watchFileMap.get(p);
      if (!entry) return;
      if (listener) {
        entry.listeners.delete(listener);
        entry.watcher.removeListener("change", listener as (...args: unknown[]) => void);
      } else {
        entry.listeners.clear();
        entry.watcher.removeAllListeners("change");
      }
      if (entry.listeners.size === 0) {
        entry.watcher.stop();
        watchFileMap.delete(p);
      }
    },
    readFile(
      target: unknown,
      optsOrCb?:
        | string
        | { encoding?: string | null }
        | ((err: Error | null, data?: Buffer | string) => void),
      cb?: (err: Error | null, data?: Buffer | string) => void,
    ): void {
      const p = abs(target);
      let actualCb: ((err: Error | null, data?: Buffer | string) => void) | undefined;
      let enc: string | undefined;
      if (typeof optsOrCb === "function") {
        actualCb = optsOrCb as (err: Error | null, data?: Buffer | string) => void;
      } else {
        actualCb = cb;
        if (typeof optsOrCb === "string") {
          enc = optsOrCb;
        } else if (optsOrCb && typeof optsOrCb === "object") {
          enc = (optsOrCb as { encoding?: string | null }).encoding ?? undefined;
        }
      }
      try {
        const raw = volume.readFileSync(p);
        const data = decodeBytes(raw, enc);
        if (actualCb) deferCallback(() => actualCb(null, data));
      } catch (e) {
        if (actualCb) deferCallback(() => actualCb(e as Error));
      }
    },

    writeFile(
      target: unknown,
      data: unknown,
      optsOrCb?: unknown,
      maybeCb?: (err: Error | null) => void,
    ): void {
      const cb = typeof optsOrCb === "function"
        ? optsOrCb as (err: Error | null) => void
        : maybeCb;
      const opts = typeof optsOrCb === "object" && optsOrCb !== null
        ? optsOrCb as WriteFileOptions
        : typeof optsOrCb === "string"
          ? { encoding: optsOrCb }
          : undefined;
      try {
        bridge.writeFileSync(target as PathArg, data as any, opts);
        if (cb) deferCallback(() => cb(null));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    stat(
      target: unknown,
      optsOrCb?: unknown,
      maybeCb?: (err: Error | null, stats?: FileStat) => void,
    ): void {
      const cb = typeof optsOrCb === "function"
        ? optsOrCb as (err: Error | null, stats?: FileStat) => void
        : maybeCb as (err: Error | null, stats?: FileStat) => void;
      const opts = typeof optsOrCb === "object" && optsOrCb !== null
        ? optsOrCb as StatOptions
        : undefined;
      try {
        const st = runStat(() => volume.statSync(abs(target)), opts);
        if (cb) deferCallback(() => cb(null, st));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    lstat(
      target: unknown,
      optsOrCb?: unknown,
      maybeCb?: (err: Error | null, stats?: FileStat) => void,
    ): void {
      const cb = typeof optsOrCb === "function"
        ? optsOrCb as (err: Error | null, stats?: FileStat) => void
        : maybeCb as (err: Error | null, stats?: FileStat) => void;
      const opts = typeof optsOrCb === "object" && optsOrCb !== null
        ? optsOrCb as StatOptions
        : undefined;
      try {
        const st = runStat(() => volume.lstatSync(abs(target)), opts);
        if (cb) deferCallback(() => cb(null, st));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    readdir(
      target: unknown,
      optsOrCb?:
        | { withFileTypes?: boolean; encoding?: string }
        | string
        | ((err: Error | null, files?: string[] | Buffer[] | Dirent[]) => void),
      cb?: (err: Error | null, files?: string[] | Buffer[] | Dirent[]) => void,
    ): void {
      const actualCb = typeof optsOrCb === "function" ? optsOrCb : cb;
      const opts = typeof optsOrCb === "function"
        ? undefined
        : typeof optsOrCb === "string"
          ? { encoding: optsOrCb }
          : optsOrCb;
      const p = abs(target);
      // Must defer the callback. Metro's node crawler (and similar) pairs
      // sync-looking readdir with async lstat and uses an activeCalls counter;
      // a synchronous readdir callback can resolve the crawl with an empty
      // file map before any lstat callbacks run.
      try {
        const names = volume.readdirSync(p);
        const files = opts?.withFileTypes
          ? toDirents(p, names)
          : encodeReaddirNames(names, opts?.encoding);
        if (actualCb) deferCallback(() => actualCb(null, files));
      } catch (e) {
        if (actualCb) deferCallback(() => actualCb(e as Error));
      }
    },

    mkdir(
      target: unknown,
      optsOrCb?:
        | { recursive?: boolean; mode?: number }
        | ((err: Error | null, path?: string) => void),
      cb?: (err: Error | null, path?: string) => void,
    ): void {
      const actualCb = typeof optsOrCb === "function" ? optsOrCb : cb;
      const opts = typeof optsOrCb === "object" ? optsOrCb : undefined;
      try {
        const created = volume.mkdirSync(abs(target), opts);
        if (actualCb) deferCallback(() => actualCb(null, created));
      } catch (e) {
        if (actualCb) deferCallback(() => actualCb(e as Error));
      }
    },

    unlink(target: unknown, cb?: (err: Error | null) => void): void {
      try {
        volume.unlinkSync(abs(target));
        if (cb) deferCallback(() => cb(null));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    rmdir(target: unknown, optsOrCb?: unknown, maybeCb?: (err: Error | null) => void): void {
      const cb = typeof optsOrCb === "function"
        ? optsOrCb as (err: Error | null) => void
        : maybeCb;
      try {
        volume.rmdirSync(abs(target));
        if (cb) deferCallback(() => cb(null));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    rename(oldPath: unknown, newPath: unknown, cb?: (err: Error | null) => void): void {
      try {
        volume.renameSync(abs(oldPath), abs(newPath));
        if (cb) deferCallback(() => cb(null));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    realpath(
      target: unknown,
      optsOrCb?: unknown,
      maybeCb?: (err: Error | null, resolved?: string) => void,
    ): void {
      const cb = typeof optsOrCb === "function"
        ? optsOrCb as (err: Error | null, resolved?: string) => void
        : maybeCb;
      volume.realpath(abs(target), cb);
    },

    access(
      target: unknown,
      modeOrCb?: number | ((err: Error | null) => void),
      cb?: (err: Error | null) => void,
    ): void {
      volume.access(abs(target), modeOrCb, cb);
    },

    appendFile(
      target: unknown,
      data: string | Uint8Array,
      optsOrCb?: unknown,
      maybeCb?: (err: Error | null) => void,
    ): void {
      const cb = typeof optsOrCb === "function"
        ? optsOrCb as (err: Error | null) => void
        : maybeCb;
      try {
        volume.appendFileSync(abs(target), data);
        if (cb) deferCallback(() => cb(null));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    symlink(
      target: unknown,
      path: unknown,
      typeOrCb?: string | ((err: Error | null) => void),
      cb?: (err: Error | null) => void,
    ): void {
      const actualCb = typeof typeOrCb === "function" ? typeOrCb : cb;
      const type = typeof typeOrCb === "string" ? typeOrCb : undefined;
      try {
        volume.symlinkSync(symlinkTargetArg(target), abs(path), type);
        if (actualCb) deferCallback(() => actualCb(null));
      } catch (e) {
        if (actualCb) deferCallback(() => actualCb(e as Error));
      }
    },

    readlink(
      target: unknown,
      optsOrCb?: unknown,
      maybeCb?: (err: Error | null, linkTarget?: string) => void,
    ): void {
      const cb = typeof optsOrCb === "function"
        ? optsOrCb as (err: Error | null, linkTarget?: string) => void
        : maybeCb;
      try {
        const result = volume.readlinkSync(abs(target));
        if (cb) deferCallback(() => cb(null, result));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    link(
      existingPath: unknown,
      newPath: unknown,
      cb?: (err: Error | null) => void,
    ): void {
      try {
        volume.linkSync(abs(existingPath), abs(newPath));
        if (cb) deferCallback(() => cb(null));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    chmod(
      target: unknown,
      mode: unknown,
      cb?: (err: Error | null) => void,
    ): void {
      try {
        volume.chmodSync(abs(target), mode as number);
        if (cb) deferCallback(() => cb(null));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    chown(
      target: unknown,
      uid: number,
      gid: number,
      cb?: (err: Error | null) => void,
    ): void {
      try {
        volume.chownSync(abs(target), uid, gid);
        if (cb) deferCallback(() => cb(null));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    lchown(
      target: unknown,
      uid: number,
      gid: number,
      cb: (err: Error | null) => void,
    ): void {
      try {
        volume.lchownSync(abs(target), uid, gid);
        if (cb) deferCallback(() => cb(null));
      } catch (error) {
        if (cb) deferCallback(() => cb(error as Error));
      }
    },

    utimes(
      target: unknown,
      atime: number | string | Date,
      mtime: number | string | Date,
      cb: (err: Error | null) => void,
    ): void {
      try {
        volume.utimesSync(abs(target), atime as number | Date, mtime as number | Date);
        if (cb) deferCallback(() => cb(null));
      } catch (error) {
        if (cb) deferCallback(() => cb(error as Error));
      }
    },

    lutimes(
      target: unknown,
      atime: number | string | Date,
      mtime: number | string | Date,
      cb: (err: Error | null) => void,
    ): void {
      try {
        volume.lutimesSync(abs(target), atime as number | Date, mtime as number | Date);
        if (cb) deferCallback(() => cb(null));
      } catch (error) {
        if (cb) deferCallback(() => cb(error as Error));
      }
    },
    open(
      target: unknown,
      flagsOrCb: string | number | ((err: Error | null, fd?: number) => void),
      modeOrCb?: number | ((err: Error | null, fd?: number) => void),
      cb?: (err: Error | null, fd?: number) => void,
    ): void {
      let flags: string | number = "r";
      let mode: number | undefined;
      let callback: (err: Error | null, fd?: number) => void;
      if (typeof flagsOrCb === "function") {
        callback = flagsOrCb;
      } else {
        flags = flagsOrCb;
        if (typeof modeOrCb === "function") {
          callback = modeOrCb;
        } else {
          mode = modeOrCb;
          callback = cb!;
        }
      }
      try {
        const fd = bridge.openSync(abs(target), flags, mode);
        if (callback) deferCallback(() => callback(null, fd));
      } catch (e) {
        if (callback) deferCallback(() => callback(e as Error));
      }
    },

    close(fd: number, cb?: (err: Error | null) => void): void {
      try {
        bridge.closeSync(fd);
        if (cb) deferCallback(() => cb(null));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    read(
      fd: number,
      bufOrOpts:
        | Buffer
        | Uint8Array
        | {
            buffer: Buffer | Uint8Array;
            offset?: number;
            length?: number;
            position?: number | null;
          },
      offsetOrCb?:
        | number
        | ((
            err: Error | null,
            bytesRead?: number,
            buffer?: Buffer | Uint8Array,
          ) => void),
      length?: number,
      position?: number | null,
      cb?: (
        err: Error | null,
        bytesRead?: number,
        buffer?: Buffer | Uint8Array,
      ) => void,
    ): void {
      let buf: Buffer | Uint8Array;
      let off: number;
      let len: number;
      let pos: number | null;
      let callback: (
        err: Error | null,
        bytesRead?: number,
        buffer?: Buffer | Uint8Array,
      ) => void;

      if (typeof offsetOrCb === "function") {
        // read(fd, opts, cb) form
        const opts = bufOrOpts as {
          buffer: Buffer | Uint8Array;
          offset?: number;
          length?: number;
          position?: number | null;
        };
        buf = opts.buffer;
        off = opts.offset ?? 0;
        len = opts.length ?? buf.length;
        pos = opts.position ?? null;
        callback = offsetOrCb;
      } else {
        buf = bufOrOpts as Buffer | Uint8Array;
        off = (offsetOrCb as number) ?? 0;
        len = length ?? buf.length;
        pos = position ?? null;
        callback = cb!;
      }

      try {
        const n = bridge.readSync(fd, buf, off, len, pos);
        if (callback) deferCallback(() => callback(null, n, buf));
      } catch (e) {
        if (callback) deferCallback(() => callback(e as Error, 0, buf));
      }
    },

    write(
      fd: number,
      buf: Buffer | Uint8Array | string,
      offsetOrCb?:
        | number
        | ((
            err: Error | null,
            written?: number,
            buffer?: Buffer | Uint8Array | string,
          ) => void),
      lengthOrEnc?: number | string,
      positionOrCb?:
        | number
        | null
        | ((
            err: Error | null,
            written?: number,
            buffer?: Buffer | Uint8Array | string,
          ) => void),
      cb?: (
        err: Error | null,
        written?: number,
        buffer?: Buffer | Uint8Array | string,
      ) => void,
    ): void {
      let callback: (
        err: Error | null,
        written?: number,
        buffer?: Buffer | Uint8Array | string,
      ) => void;
      if (typeof offsetOrCb === "function") {
        callback = offsetOrCb;
        try {
          const n = bridge.writeSync(fd, buf);
          deferCallback(() => callback(null, n, buf));
        } catch (e) {
          deferCallback(() => callback(e as Error, 0, buf));
        }
        return;
      }
      if (typeof positionOrCb === "function") {
        callback = positionOrCb;
      } else {
        callback = cb!;
      }
      try {
        const off = typeof offsetOrCb === "number" ? offsetOrCb : undefined;
        const len = typeof lengthOrEnc === "number" ? lengthOrEnc : undefined;
        const pos = typeof positionOrCb === "number" ? positionOrCb : undefined;
        const n = bridge.writeSync(fd, buf, off, len, pos);
        if (callback) deferCallback(() => callback(null, n, buf));
      } catch (e) {
        if (callback) deferCallback(() => callback(e as Error, 0, buf));
      }
    },

    writev(
      fd: number,
      buffers: ArrayBufferView[],
      positionOrCb?:
        | number
        | null
        | ((err: Error | null, bytesWritten?: number, buffers?: ArrayBufferView[]) => void),
      cb?: (err: Error | null, bytesWritten?: number, buffers?: ArrayBufferView[]) => void,
    ): void {
      const callback = typeof positionOrCb === "function" ? positionOrCb : cb;
      const pos = typeof positionOrCb === "number" ? positionOrCb : null;
      try {
        let totalWritten = 0;
        for (const buf of buffers) {
          const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          const n = bridge.writeSync(fd, u8 as unknown as Buffer, 0, u8.length, pos !== null ? pos + totalWritten : undefined);
          totalWritten += n;
        }
        if (callback) deferCallback(() => callback(null, totalWritten, buffers));
      } catch (e) {
        if (callback) deferCallback(() => callback(e as Error, 0, buffers));
      }
    },

    fstat(fd: number, optsOrCb?: unknown, maybeCb?: (err: Error | null, stats?: FileStat) => void): void {
      const cb = typeof optsOrCb === "function"
        ? optsOrCb as (err: Error | null, stats?: FileStat) => void
        : maybeCb;
      const opts = typeof optsOrCb === "object" && optsOrCb !== null
        ? optsOrCb as StatOptions
        : undefined;
      try {
        const st = bridge.fstatSync(fd, opts);
        if (cb) deferCallback(() => cb(null, st));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    futimes(
      fd: number,
      atime: number | string | Date,
      mtime: number | string | Date,
      cb: (err: Error | null) => void,
    ): void {
      const entry = openFiles.get(fd);
      if (!entry) {
        if (cb) deferCallback(() => cb(makeBadfError("futimes")));
        return;
      }
      try {
        volume.utimesSync(entry.filePath, atime as number | Date, mtime as number | Date);
        if (cb) deferCallback(() => cb(null));
      } catch (error) {
        if (cb) deferCallback(() => cb(error as Error));
      }
    },

    fchown(
      fd: number,
      uid: number,
      gid: number,
      cb: (err: Error | null) => void,
    ): void {
      try {
        bridge.fchownSync(fd, uid, gid);
        if (cb) deferCallback(() => cb(null));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    fchmod(
      fd: number,
      mode: number,
      cb: (err: Error | null) => void,
    ): void {
      try {
        bridge.fchmodSync(fd, mode);
        if (cb) deferCallback(() => cb(null));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },
    // function constructor, not class -- graceful-fs calls fs$ReadStream.apply(this, args)
    ReadStream: (() => {
      function FsReadStream(this: FsReadStreamInstance, pathArg: unknown, opts?: Record<string, unknown>) {
        if (!(this instanceof FsReadStream)) return new (FsReadStream as unknown as new (p: unknown, o?: Record<string, unknown>) => FsReadStreamInstance)(pathArg, opts);
        const self: FsReadStreamInstance = this;
        self._queue = [];
        self._active = false;
        self._terminated = false;
        self._endFired = false;
        self._endEmitted = false;
        self._objectMode = false;
        self._reading = false;
        self._highWaterMark = 16384;
        self._autoDestroy = true;
        self._encoding = null;
        self._readableByteLength = 0;
        self._draining = false;
        self.readable = true;
        self.readableEnded = false;
        self.readableFlowing = null;
        self.destroyed = false;
        self.closed = false;
        self.errored = null;
        self.readableObjectMode = false;
        self.readableHighWaterMark = 16384;
        self.readableDidRead = false;
        self.readableAborted = false;
        self._readableState = {
          get objectMode() { return self._objectMode; },
          get highWaterMark() { return self._highWaterMark; },
          get ended() { return self._terminated; },
          get endEmitted() { return self._endEmitted; },
          set endEmitted(v: boolean) { self._endEmitted = v; },
          get flowing() { return self.readableFlowing; },
          set flowing(v: boolean | null) { self.readableFlowing = v; },
          get reading() { return self._reading; },
          get length() { return self._queue ? self._queue.length : 0; },
          get destroyed() { return self.destroyed; },
          get errored() { return self.errored; },
          get closed() { return self.closed; },
          pipes: [],
          awaitDrainWriters: null,
          multiAwaitDrain: false,
          readableListening: false,
          resumeScheduled: false,
          paused: true,
          emitClose: true,
          get autoDestroy() { return self._autoDestroy; },
          defaultEncoding: "utf8",
          needReadable: false,
          emittedReadable: false,
          readingMore: false,
          dataEmitted: false,
        };
        self.path = abs(pathArg);
        self.fd = (opts?.fd as number | null) ?? null;
        self.flags = (opts?.flags as string) ?? "r";
        self.mode = (opts?.mode as number) ?? 0o666;
        self.autoClose = opts?.autoClose !== false;
        (self as any)._start = typeof opts?.start === "number" ? opts.start : 0;
        (self as any)._end = typeof opts?.end === "number" ? opts.end : Infinity;
        (self as any)._pos = (self as any)._start;
        if (typeof opts?.highWaterMark === "number") {
          self._highWaterMark = opts.highWaterMark;
          self.readableHighWaterMark = opts.highWaterMark;
        }
        queueMicrotask(() => self.open());
      }
      FsReadStream.prototype = Object.create(Readable.prototype);
      FsReadStream.prototype.constructor = FsReadStream;

      FsReadStream.prototype.open = function () {
        try {
          if (this.fd === null) {
            this.fd = bridge.openSync(this.path, this.flags, this.mode);
          }
          this.emit("open", this.fd);
          this.emit("ready");
        } catch (err) {
          this.destroy(err);
        }
      };

      FsReadStream.prototype._read = function (size?: number) {
        if (this.fd === null) return;
        try {
          const end = (this as any)._end as number;
          let pos = (this as any)._pos as number;
          if (pos > end) {
            this.push(null);
            return;
          }
          const hwm = size || this._highWaterMark || 64 * 1024;
          const maxLen = end === Infinity ? hwm : Math.min(hwm, end - pos + 1);
          if (maxLen <= 0) {
            this.push(null);
            return;
          }
          const buf = Buffer.alloc(maxLen);
          const n = bridge.readSync(this.fd, buf, 0, maxLen, pos);
          if (n <= 0) {
            this.push(null);
            return;
          }
          (this as any)._pos = pos + n;
          this.push(buf.subarray(0, n));
          if ((this as any)._pos > end) this.push(null);
        } catch (err) {
          this.destroy(err);
        }
      };

      FsReadStream.prototype.close = function (cb?: (err?: Error | null) => void) {
        if (this.fd !== null) {
          try {
            bridge.closeSync(this.fd);
          } catch {}
          this.fd = null;
        }
        this.destroy();
        if (cb) cb(null);
      };

      return FsReadStream as any;
    })(),

    // function constructor, not class -- graceful-fs calls fs$WriteStream.apply(this, args)
    WriteStream: (() => {
      function FsWriteStream(this: FsWriteStreamInstance, pathArg: unknown, opts?: Record<string, unknown>) {
        if (!(this instanceof FsWriteStream)) return new (FsWriteStream as unknown as new (p: unknown, o?: Record<string, unknown>) => FsWriteStreamInstance)(pathArg, opts);
        const self: FsWriteStreamInstance = this;
        self._parts = [];
        self._closed = false;
        self._objectMode = false;
        self._highWaterMark = 16384;
        self._autoDestroy = true;
        self._corked = 0;
        self._corkedWrites = [];
        self._writableByteLength = 0;
        self.writable = true;
        self.writableEnded = false;
        self.writableFinished = false;
        self.writableNeedDrain = false;
        self.destroyed = false;
        self.closed = false;
        self.errored = null;
        self.writableObjectMode = false;
        self.writableHighWaterMark = 16384;
        self.writableCorked = 0;
        self._writableState = {
          get objectMode() { return self._objectMode; },
          get highWaterMark() { return self._highWaterMark; },
          get finished() { return self.writableFinished; },
          set finished(v: boolean) { self.writableFinished = v; },
          get ended() { return self.writableEnded; },
          set ended(v: boolean) { self.writableEnded = v; },
          get destroyed() { return self.destroyed; },
          get errored() { return self.errored; },
          get closed() { return self.closed; },
          get corked() { return self._corked; },
          get length() { return self._writableByteLength; },
          get needDrain() { return self.writableNeedDrain; },
          writing: false,
          errorEmitted: false,
          emitClose: true,
          get autoDestroy() { return self._autoDestroy; },
          defaultEncoding: "utf8",
          finalCalled: false,
          ending: false,
          bufferedIndex: 0,
        };
        self.path = abs(pathArg);
        self.fd = (opts?.fd as number | null) ?? null;
        self.flags = (opts?.flags as string) ?? "w";
        self.mode = (opts?.mode as number) ?? 0o666;
        self.autoClose = opts?.autoClose !== false;
        self.bytesWritten = 0;
        self._chunks = [] as Uint8Array[];
        self._enc = new TextEncoder();
        queueMicrotask(() => self.open());
      }
      FsWriteStream.prototype = Object.create(Writable.prototype);
      FsWriteStream.prototype.constructor = FsWriteStream;

      FsWriteStream.prototype.open = function () {
        try {
          this.fd = bridge.openSync(this.path, this.flags, this.mode);
          this.emit("open", this.fd);
          this.emit("ready");
        } catch (err) {
          this.destroy(err);
        }
      };

      FsWriteStream.prototype._write = function (
        chunk: Uint8Array | string,
        _encoding: string,
        callback: (err?: Error | null) => void,
      ) {
        const bytes =
          typeof chunk === "string" ? this._enc.encode(chunk) : chunk;
        this._chunks.push(bytes);
        this.bytesWritten += bytes.length;
        callback(null);
      };

      FsWriteStream.prototype.close = function (cb?: (err?: Error | null) => void) {
        this._flushChunks();
        if (this.fd !== null) {
          try {
            bridge.closeSync(this.fd);
          } catch {}
          this.fd = null;
        }
        this.emit("finish");
        this.emit("close");
        if (cb) cb(null);
      };

      FsWriteStream.prototype._flushChunks = function () {
        if (!this._chunks || this._chunks.length === 0) return;
        if (this.fd === null) return;
        const totalLen = this._chunks.reduce((sum: number, c: Uint8Array) => sum + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let pos = 0;
        for (const c of this._chunks) {
          merged.set(c, pos);
          pos += c.length;
        }
        // write into the FD buffer so closeSync persists the same bytes
        // (bypass writeFileSync — that would be wiped by closeSync's empty FD)
        const isAppend = typeof this.flags === "string" && this.flags.includes("a");
        const writePos = isAppend ? null : 0;
        if (!isAppend) {
          bridge.ftruncateSync(this.fd, 0);
        }
        bridge.writeSync(this.fd, merged as unknown as Buffer, 0, merged.length, writePos);
        this._chunks = [];
      };

      FsWriteStream.prototype.end = function (chunkOrCb?: any, encOrCb?: any, cb?: any) {
        if (typeof chunkOrCb === "function") {
          cb = chunkOrCb;
          chunkOrCb = undefined;
        } else if (typeof encOrCb === "function") {
          cb = encOrCb;
          encOrCb = undefined;
        }
        if (chunkOrCb !== undefined) {
          const bytes =
            typeof chunkOrCb === "string"
              ? this._enc.encode(chunkOrCb)
              : chunkOrCb;
          this._chunks.push(bytes);
          this.bytesWritten += bytes.length;
        }
        this._flushChunks();
        if (this.fd !== null && this.autoClose) {
          try {
            bridge.closeSync(this.fd);
          } catch {}
          this.fd = null;
        }
        this.emit("finish");
        this.emit("close");
        if (cb) cb();
        return this;
      };

      return FsWriteStream as any;
    })(),

    createReadStream(
      target: unknown,
      opts?: { encoding?: string; start?: number; end?: number; highWaterMark?: number; flags?: string; mode?: number; autoClose?: boolean; fd?: number },
    ): Readable {
      return new (bridge.ReadStream as any)(target, opts);
    },

    createWriteStream(
      target: unknown,
      opts?: { encoding?: string; flags?: string },
    ): Writable {
      const p = abs(target);
      const isAppend = opts?.flags === "a";
      const chunks: Uint8Array[] = [];
      const enc = new TextEncoder();
      let bytesWritten = 0;
      let closed = false;

      const stream: any = new Writable();
      stream.path = p;
      stream.fd = null;
      stream.open = function () {
        stream.fd = 43;
        stream.emit("open", stream.fd);
      };
      Object.defineProperty(stream, "bytesWritten", {
        get: () => bytesWritten,
        enumerable: true,
      });
      queueMicrotask(() => stream.open());

      const flushAndClose = function (cb?: (err?: Error | null) => void) {
        if (closed) {
          if (cb) cb(null);
          return;
        }
        closed = true;
        const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let pos = 0;
        for (const c of chunks) {
          merged.set(c, pos);
          pos += c.length;
        }

        try {
          if (isAppend) {
            volume.appendFileSync(p, merged);
          } else {
            volume.writeFileSync(p, merged);
          }
        } catch (e) {
          if (cb) cb(e as Error);
          return;
        }

        stream.emit("finish");
        stream.emit("close");
        if (cb) cb(null);
      };

      stream.write = function (
        chunk: Uint8Array | string,
        encOrCb?: string | ((err?: Error | null) => void),
        cb?: (err?: Error | null) => void,
      ): boolean {
        const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
        chunks.push(bytes);
        bytesWritten += bytes.length;
        const callback = typeof encOrCb === "function" ? encOrCb : cb;
        if (callback) queueMicrotask(() => callback(null));
        return true;
      };

      stream.end = function (
        chunkOrCb?: Uint8Array | string | (() => void),
        encOrCb?: string | (() => void),
        cb?: () => void,
      ): Writable {
        if (typeof chunkOrCb === "function") {
          cb = chunkOrCb;
        } else if (chunkOrCb !== undefined) {
          const bytes =
            typeof chunkOrCb === "string" ? enc.encode(chunkOrCb) : chunkOrCb;
          chunks.push(bytes);
          bytesWritten += bytes.length;
        }
        if (typeof encOrCb === "function") cb = encOrCb;

        flushAndClose(cb as any);
        return stream;
      };

      stream.close = function (cb?: (err?: Error | null) => void) {
        flushAndClose(cb);
      };

      return stream;
    },
    opendirSync(target: unknown, _opts?: unknown): Dir {
      const p = abs(target);
      const names = volume.readdirSync(p);
      const entries = toDirents(p, names);
      return new Dir(p, entries);
    },

    opendir(
      target: unknown,
      optsOrCb?: unknown | ((err: Error | null, dir?: Dir) => void),
      cb?: (err: Error | null, dir?: Dir) => void,
    ): void | Promise<Dir> {
      const callback = typeof optsOrCb === "function" ? optsOrCb as (err: Error | null, dir?: Dir) => void : cb;
      try {
        const dir = bridge.opendirSync(target);
        if (callback) {
          queueMicrotask(() => callback(null, dir));
          return;
        }
        return Promise.resolve(dir);
      } catch (e) {
        if (callback) {
          queueMicrotask(() => callback(e as Error));
          return;
        }
        return Promise.reject(e);
      }
    },
    exists(target: unknown, cb: (exists: boolean) => void): void {
      const result = volume.existsSync(abs(target));
      deferCallback(() => cb(result));
    },
    lchmodSync(target: unknown, mode: number): void {
      volume.lchmodSync(abs(target), mode);
    },

    lchmod(
      target: unknown,
      mode: number,
      cb: (err: Error | null) => void,
    ): void {
      try {
        volume.lchmodSync(abs(target), mode);
        if (cb) deferCallback(() => cb(null));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },
    fdatasync(fd: number, cb: (err: Error | null) => void): void {
      try {
        bridge.fdatasyncSync(fd);
        if (cb) deferCallback(() => cb(null));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    fsync(fd: number, cb: (err: Error | null) => void): void {
      try {
        bridge.fsyncSync(fd);
        if (cb) deferCallback(() => cb(null));
      } catch (e) {
        if (cb) deferCallback(() => cb(e as Error));
      }
    },

    ftruncate(
      fd: number,
      lenOrCb?: number | ((err: Error | null) => void),
      cb?: (err: Error | null) => void,
    ): void {
      const callback = typeof lenOrCb === "function" ? lenOrCb : cb;
      const len = typeof lenOrCb === "number" ? lenOrCb : 0;
      try {
        bridge.ftruncateSync(fd, len);
        if (callback) deferCallback(() => callback(null));
      } catch (e) {
        if (callback) deferCallback(() => callback(e as Error));
      }
    },

    truncate(
      target: unknown,
      lenOrCb?: number | ((err: Error | null) => void),
      cb?: (err: Error | null) => void,
    ): void {
      const callback = typeof lenOrCb === "function" ? lenOrCb : cb;
      const len = typeof lenOrCb === "number" ? lenOrCb : 0;
      try {
        volume.truncateSync(abs(target), len);
        if (callback) deferCallback(() => callback(null));
      } catch (e) {
        if (callback) deferCallback(() => callback(e as Error));
      }
    },

    mkdtemp(
      prefix: string,
      optsOrCb?: unknown | ((err: Error | null, folder?: string) => void),
      cb?: (err: Error | null, folder?: string) => void,
    ): void {
      const callback = typeof optsOrCb === "function"
        ? optsOrCb as (err: Error | null, folder?: string) => void
        : cb;
      try {
        const result = bridge.mkdtempSync(prefix);
        if (callback) deferCallback(() => callback(null, result));
      } catch (e) {
        if (callback) deferCallback(() => callback(e as Error));
      }
    },
    readvSync(fd: number, buffers: ArrayBufferView[], pos?: number | null): number {
      let totalRead = 0;
      for (const buf of buffers) {
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const n = bridge.readSync(
          fd,
          u8 as unknown as Buffer,
          0,
          u8.length,
          pos != null ? pos + totalRead : null,
        );
        totalRead += n;
        if (n < u8.length) break; // short read — EOF
      }
      return totalRead;
    },

    readv(
      fd: number,
      buffers: ArrayBufferView[],
      positionOrCb?:
        | number
        | null
        | ((err: Error | null, bytesRead?: number, buffers?: ArrayBufferView[]) => void),
      cb?: (err: Error | null, bytesRead?: number, buffers?: ArrayBufferView[]) => void,
    ): void {
      const callback = typeof positionOrCb === "function" ? positionOrCb : cb;
      const pos = typeof positionOrCb === "number" ? positionOrCb : null;
      try {
        const n = bridge.readvSync(fd, buffers, pos);
        if (callback) deferCallback(() => callback(null, n, buffers));
      } catch (e) {
        if (callback) deferCallback(() => callback(e as Error, 0, buffers));
      }
    },
    cpSync(
      src: unknown,
      dest: unknown,
      opts?: CpOptions,
    ): void {
      const srcPath = abs(src);
      const destPath = abs(dest);
      if (opts?.filter && !opts.filter(srcPath, destPath)) return;

      const dereference = opts?.dereference === true;
      const lst = dereference ? volume.statSync(srcPath) : volume.lstatSync(srcPath);

      if (lst.isSymbolicLink() && !dereference) {
        let target = volume.readlinkSync(srcPath);
        if (!opts?.verbatimSymlinks && !target.startsWith("/")) {
          // keep relative target as-is (Node default for verbatimSymlinks false still
          // stores the string; we preserve the readlink result)
        }
        const parent = destPath.substring(0, destPath.lastIndexOf("/")) || "/";
        if (!volume.existsSync(parent)) volume.mkdirSync(parent, { recursive: true });
        if (volume.existsSync(destPath)) {
          if (opts?.errorOnExist) {
            const err = new Error(
              `EEXIST: file already exists, cp '${srcPath}' -> '${destPath}'`,
            ) as Error & { code: string };
            err.code = "EEXIST";
            throw err;
          }
          if (opts?.force === false) return;
          try { volume.unlinkSync(destPath); } catch { /* ignore */ }
        }
        volume.symlinkSync(target, destPath);
        if (opts?.preserveTimestamps) {
          volume.lutimesSync(destPath, lst.atime, lst.mtime);
        }
        return;
      }

      const st = dereference ? lst : volume.statSync(srcPath);
      if (st.isDirectory()) {
        if (!opts?.recursive) {
          const err = new Error(
            `EISDIR: illegal operation on a directory, cp '${srcPath}' -> '${destPath}'`,
          ) as Error & { code: string };
          err.code = "EISDIR";
          throw err;
        }
        if (!volume.existsSync(destPath)) {
          volume.mkdirSync(destPath, { recursive: true });
        }
        const children = volume.readdirSync(srcPath);
        for (const child of children) {
          const childSrc = srcPath.endsWith("/") ? srcPath + child : srcPath + "/" + child;
          const childDest = destPath.endsWith("/") ? destPath + child : destPath + "/" + child;
          bridge.cpSync(childSrc, childDest, opts);
        }
        if (opts?.preserveTimestamps) {
          volume.utimesSync(destPath, st.atime, st.mtime);
        }
      } else {
        if (opts?.errorOnExist && volume.existsSync(destPath)) {
          const err = new Error(
            `EEXIST: file already exists, cp '${srcPath}' -> '${destPath}'`,
          ) as Error & { code: string };
          err.code = "EEXIST";
          throw err;
        }
        if (opts?.force === false && volume.existsSync(destPath)) return;
        const parent = destPath.substring(0, destPath.lastIndexOf("/")) || "/";
        if (!volume.existsSync(parent)) {
          volume.mkdirSync(parent, { recursive: true });
        }
        volume.copyFileSync(srcPath, destPath, opts?.mode ?? 0);
        if (opts?.preserveTimestamps) {
          volume.utimesSync(destPath, st.atime, st.mtime);
        }
      }
    },

    cp(
      src: unknown,
      dest: unknown,
      optsOrCb?: CpOptions | ((err: Error | null) => void),
      cb?: (err: Error | null) => void,
    ): void {
      const callback = typeof optsOrCb === "function" ? optsOrCb : cb;
      const opts = typeof optsOrCb === "object" ? optsOrCb : undefined;
      try {
        bridge.cpSync(src, dest, opts);
        if (callback) deferCallback(() => callback(null));
      } catch (e) {
        if (callback) deferCallback(() => callback(e as Error));
      }
    },
    statfsSync(_target: unknown, _opts?: unknown): StatFs {
      return new StatFs();
    },

    statfs(
      target: unknown,
      optsOrCb?: unknown | ((err: Error | null, stats?: StatFs) => void),
      cb?: (err: Error | null, stats?: StatFs) => void,
    ): void {
      const callback = typeof optsOrCb === "function"
        ? optsOrCb as (err: Error | null, stats?: StatFs) => void
        : cb;
      const result = new StatFs();
      if (callback) deferCallback(() => callback(null, result));
    },
    globSync(
      pattern: string | string[],
      opts?: GlobOptions,
    ): string[] | Dirent[] {
      return matchGlob(pattern, opts);
    },

    glob(
      pattern: string | string[],
      optsOrCb?:
        | GlobOptions
        | ((err: Error | null, matches?: string[] | Dirent[]) => void),
      cb?: (err: Error | null, matches?: string[] | Dirent[]) => void,
    ): void {
      const callback = typeof optsOrCb === "function" ? optsOrCb : cb;
      const opts = typeof optsOrCb === "object" ? optsOrCb : undefined;
      try {
        const result = bridge.globSync(pattern, opts);
        if (callback) deferCallback(() => callback(null, result));
      } catch (e) {
        if (callback) deferCallback(() => callback(e as Error));
      }
    },
    openAsBlob(target: unknown, _opts?: { type?: string }): Promise<Blob> {
      try {
        const p = abs(target);
        const data = volume.readFileSync(p);
        const type = _opts?.type || "";
        const copy = new Uint8Array(data).buffer;
        return Promise.resolve(new Blob([copy], { type }));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    StatFs: StatFs as any,
    StatWatcher: StatWatcher as any,

    promises: promisesApi,
    constants: fsConst,
  } as FsBridge;

  return bridge;
}

export default buildFileSystemBridge;
