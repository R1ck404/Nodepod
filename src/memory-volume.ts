// in-memory VFS with POSIX-like semantics

import type { VolumeSnapshot, VolumeEntry } from './engine-types';
import { bytesToBase64, base64ToBytes } from './helpers/byte-encoding';
import { MOCK_IDS, MOCK_FS } from './constants/config';
import type { MemoryHandler } from './memory-handler';
import pako from 'pako';

export interface VolumeNode {
  kind: 'file' | 'directory' | 'symlink';
  content?: Uint8Array;
  children?: Map<string, VolumeNode>;
  target?: string;
  modified: number;
  /** Directory/symlink permission bits (files use inode.mode). Default 0o755 / 0o777. */
  mode?: number;
  /** Symlink atime (mtime uses `modified`). */
  atime?: number;
  uid?: number;
  gid?: number;
  /** Windows-style symlink type hint: 'file' | 'dir' | 'junction'. */
  symlinkType?: string;
  // lean spawn mode: file known to exist (from a lazy readdir listing) but
  // content not yet fetched from the main thread
  lazy?: boolean;
  // size reported by the main thread for a lazy stub (stat without content)
  lazySize?: number;
  inode?: VolumeFileInode;
}

interface VolumeFileInode {
  ino: number;
  content?: Uint8Array;
  mode: number;
  atime: number;
  mtime: number;
  ctime: number;
  nlink: number;
  uid?: number;
  gid?: number;
  // where evictable content can be read back from (package packs). cleared
  // as soon as the file is written: the bytes are then the user's own
  src?: ContentRef;
  // content kept deflated in memory (enableContentPacking); `content` is
  // undefined while this is set
  packed?: PackedRef;
}

/** A byte range inside a stored package pack. */
export interface ContentRef {
  pack: number;
  offset: number;
  length: number;
}

// ---- Packed content ----
// Installed package files are mostly never read (type declarations, source
// maps, alternate builds, docs), yet each held its own buffer on the main
// thread: a UI-kit install kept 120MB of package bytes, about 165MB with
// per-buffer overhead. With packing enabled, a background round deflates
// node_modules files nobody has read since the previous round into shared
// chunks, about 4x smaller. Reading a packed file inflates its chunk (about
// half a millisecond) and keeps that file unpacked from then on; stat,
// listings and sizes never inflate.
interface PackedChunk {
  bytes: Uint8Array; // deflate-raw
}

interface PackedRef {
  chunk: PackedChunk;
  offset: number;
  length: number;
}

interface PackState {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  lastActivity: number;
  lastRoundStart: number;
  // completed rounds; a file read during generation G is hot until round G
  // completes, so an aborted round doesn't forget what was in use
  generation: number;
  lastRead: WeakMap<VolumeFileInode, number>;
}

// uncompressed bytes per shared chunk
const PACK_CHUNK_BYTES = 128 * 1024;
// files at least this big are deflated on their own, a piece per slice
const PACK_SOLO_BYTES = 512 * 1024;
// smaller files cost about as much to reference as they save
const PACK_MIN_FILE_BYTES = 256;
// no reads or writes for this long before a round starts
const PACK_QUIET_MS = 15_000;
const PACK_MIN_INTERVAL_MS = 60_000;
// main-thread time per slice before yielding
const PACK_SLICE_MS = 8;
// recently inflated shared chunks (a process loading a package reads its
// files in dependency order, not chunk order), dropped once reads stop
const INFLATED_CHUNK_CACHE = 48;
const INFLATED_CHUNK_IDLE_MS = 3000;

/**
 * Async reader for paged-out file content (main thread, see
 * MemoryVolume.enableEviction). Returns exactly `length` bytes in a buffer
 * of their own.
 */
export interface VolumeContentSource {
  read(pack: number, offset: number, length: number): Promise<Uint8Array>;
}

// neighbours pulled in with a paged-out file: module loads walk a package
// directory, and a package's files sit next to each other in its pack
const READ_AHEAD_BYTES = 256 * 1024;
// gap between two wanted ranges that is still cheaper to read than to skip
const MAX_MERGE_GAP = 16 * 1024;
const MAX_MERGED_READ = 4 * 1024 * 1024;

function pagedOutError(path: string): SystemError {
  const err = new Error(
    `EAGAIN: '${path}' is paged out; read it with await nodepod.fs.readFile() or call volume.ensureResident() first`,
  ) as SystemError;
  err.code = 'EAGAIN';
  err.errno = -11;
  err.syscall = 'open';
  err.path = path;
  return err;
}

export interface VolumeFileHandle {
  read(): Uint8Array;
  write(data: Uint8Array): void;
  stat(): { size: number; mode: number; atimeMs: number; mtimeMs: number; ctimeMs: number; ino: number; nlink: number };
}

export interface BinaryVolumeEntry {
  path: string;
  offset: number;
  length: number;
  isDirectory: boolean;
  symlinkTarget?: string;
  inode?: number;
  mode?: number;
  atimeMs?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  nlink?: number;
  uid?: number;
  gid?: number;
}

// one entry for mountEntries(). entries sharing a linkGroup become hardlinks
// of a single inode (the first one mounted wins the content)
export interface MountEntry {
  path: string;
  kind: 'file' | 'directory' | 'symlink';
  content?: Uint8Array;
  /** Mount a paged-out file whose bytes are read from here on demand (needs enableEviction). */
  src?: ContentRef;
  target?: string;
  symlinkType?: string;
  mode?: number;
  uid?: number;
  gid?: number;
  atimeMs?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  nlink?: number;
  linkGroup?: string | number;
}

// Logical filesystem changes, fired through onMutation() for every mutation
// regardless of watcher/notify flags. Residency changes (lazy hydration,
// eviction, invalidation) are not mutations and never show up here.
export type VolumeMutation =
  // file content changed. path is the real file (symlinks already resolved)
  | { op: 'write'; path: string }
  // directory created, including parents created implicitly by writes
  | { op: 'mkdir'; path: string }
  | { op: 'symlink'; path: string }
  | { op: 'link'; path: string; existing: string }
  // file, symlink or a whole directory subtree removed
  | { op: 'remove'; path: string }
  // whole subtree moved; whatever sat at `to` before is gone
  | { op: 'rename'; from: string; to: string }
  // mode / owner / times changed; carries only the fields that changed
  | ({ op: 'meta'; path: string } & MetaChange)
  // bulk mount; per-entry mutations are not reported individually
  | { op: 'mount'; entries: ReadonlyArray<{ path: string }> };

export interface VolumeNodeInfo {
  kind: 'file' | 'directory' | 'symlink';
  mode: number;
  uid?: number;
  gid?: number;
  mtimeMs: number;
  atimeMs: number;
  size: number;
  target?: string;
  symlinkType?: string;
  /** false when the file is a lazy stub / evicted (content not in memory) */
  resident: boolean;
  /** opaque identity token, shared by hardlinks and stable across renames */
  inode?: object;
  content?: Uint8Array;
}

// a miss handler that throws ETIMEDOUT (no answer in time) or EAGAIN (the
// main thread couldn't page the content in) says nothing about whether the
// path exists, so it must not be cached as missing
function isTransientMiss(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ETIMEDOUT' || code === 'EAGAIN';
}

export interface MetaChange {
  mode?: number;
  uid?: number;
  gid?: number;
  atimeMs?: number;
  mtimeMs?: number;
}

function countPathSegments(path: string): number {
  let depth = 0;
  for (let index = 0; index < path.length; index++) {
    if (path.charCodeAt(index) === 47) depth++;
  }
  return depth;
}

// lean spawn mode: synchronous fallback consulted on read misses for paths
// under lazy directory names (e.g. node_modules excluded from the spawn
// snapshot). Implementations block on a SAB round-trip to the main thread.
export interface VolumeMissHandler {
  readFile(path: string): Uint8Array | null;
  /** Entries of a directory; symlinks are reported as such (lstat) with their target. */
  readdir(
    path: string,
  ): Array<{ name: string; isDirectory: boolean; size?: number; isSymlink?: boolean; target?: string }> | null;
  stat(path: string): { isFile: boolean; isDirectory: boolean; size: number } | null;
  statMany?(paths: string[]): Array<{ isFile: boolean; isDirectory: boolean; size: number } | null> | null;
}

type FileChangeHandler = (filePath: string, content: string) => void;
type FileDeleteHandler = (filePath: string) => void;
type VolumeEventHandler = FileChangeHandler | FileDeleteHandler;

export interface FileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  size: number;
  mode: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
  birthtime: Date;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  nlink: number;
  uid: number;
  gid: number;
  dev: number;
  ino: number;
  rdev: number;
  blksize: number;
  blocks: number;
  atimeNs: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
}

export type WatchEventKind = 'change' | 'rename';
export type WatchCallback = (event: WatchEventKind, name: string | null) => void;

export interface FileWatchHandle {
  close(): void;
  ref(): this;
  unref(): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
  addListener(event: string, listener: (...args: unknown[]) => void): this;
  removeAllListeners(event?: string): this;
  emit(event: string, ...args: unknown[]): boolean;
}

// minimal EventEmitter-based FSWatcher for fs.watch()
class FSWatcher implements FileWatchHandle {
  private _listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private _closeFn: (() => void) | null = null;
  private _closed = false;

  constructor(closeFn: () => void) {
    this._closeFn = closeFn;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    if (this._closeFn) { this._closeFn(); this._closeFn = null; }
    // emit 'close' before clearing listeners so subscribers actually get it.
    // chokidar and friends wait on this event to know the handle's released.
    this.emit("close");
    this._listeners.clear();
  }
  ref(): this { return this; }
  unref(): this { return this; }

  on(event: string, listener: (...args: unknown[]) => void): this {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(listener);
    return this;
  }
  addListener(event: string, listener: (...args: unknown[]) => void): this {
    return this.on(event, listener);
  }
  once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }
  off(event: string, listener: (...args: unknown[]) => void): this {
    return this.removeListener(event, listener);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    const list = this._listeners.get(event);
    if (list) {
      const idx = list.indexOf(listener);
      if (idx >= 0) list.splice(idx, 1);
    }
    return this;
  }
  removeAllListeners(event?: string): this {
    if (event) this._listeners.delete(event);
    else this._listeners.clear();
    return this;
  }
  emit(event: string, ...args: unknown[]): boolean {
    const list = this._listeners.get(event);
    if (!list || list.length === 0) return false;
    for (const fn of [...list]) {
      try { fn(...args); } catch (e) { console.error('[FSWatcher] listener error:', e); }
    }
    return true;
  }
}

interface ActiveWatcher {
  callback: WatchCallback;
  recursive: boolean;
  active: boolean;
}

export interface SystemError extends Error {
  code: string;
  errno: number;
  syscall: string;
  path?: string;
}

export function makeSystemError(
  code: 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EEXIST' | 'ENOTEMPTY' | 'ELOOP' | 'EACCES',
  syscall: string,
  targetPath: string,
  detail?: string
): SystemError {
  const errnoTable: Record<string, number> = {
    ENOENT: -2,
    ENOTDIR: -20,
    EISDIR: -21,
    EEXIST: -17,
    ENOTEMPTY: -39,
    ELOOP: -40,
    EACCES: -13,
  };

  const descriptions: Record<string, string> = {
    ENOENT: 'no such file or directory',
    ENOTDIR: 'not a directory',
    EISDIR: 'is a directory',
    EEXIST: 'file already exists',
    ENOTEMPTY: 'directory not empty',
    ELOOP: 'too many symbolic links encountered',
    EACCES: 'permission denied',
  };

  const err = new Error(
    detail || `${code}: ${descriptions[code]}, ${syscall} '${targetPath}'`
  ) as SystemError;
  err.code = code;
  err.errno = errnoTable[code];
  err.syscall = syscall;
  err.path = targetPath;
  return err;
}

export class MemoryVolume {
  private tree: VolumeNode;
  private _disposed = false;
  private textEncoder = new TextEncoder();
  private textDecoder = new TextDecoder();
  // lean spawn mode (see VolumeMissHandler)
  private _missHandler: VolumeMissHandler | null = null;
  private _lazyDirNames: string[] = [];
  private _lazyListed = new Set<string>();
  private _lazyNegative = new Set<string>();
  // paths invalidated by main (large-file broadcast) — re-fetchable via the
  // miss handler even when outside the lazy dir names
  private _lazyInvalidated = new Set<string>();
  private _lazyResident = new Map<string, number>();
  private _lazyResidentBytes = 0;
  private _lazyResidentMaxBytes: number;
  // unique ino per path. rust walkdir with follow_links(true) tracks visited
  // (dev,ino) pairs to break cycles, so ino=0 for everything makes it drop
  // every file as "already visited".
  private _inos = new Map<string, number>();
  private _nextIno = 1;
  // Reverse index for hardlink-aware lazy eviction and file-handle writes.
  // Keeping this alongside the tree avoids a full filesystem walk whenever
  // all aliases of an inode need to be updated.
  private _inodePaths = new Map<VolumeFileInode, Set<string>>();
  private _mutationListeners = new Set<(mutation: VolumeMutation) => void>();
  private _metaListeners = new Set<(path: string, change: MetaChange) => void>();
  private _silentMountListeners = new Set<(paths: string[]) => void>();
  private _journalMute = 0;
  // main-thread eviction of pack-backed content (enableEviction)
  private _contentSource: VolumeContentSource | null = null;
  private _residentBudget = 0;
  private _srcResident = new Map<VolumeFileInode, number>();
  private _srcResidentBytes = 0;
  private _evictionPaused = 0;
  private _hydrating = new Map<VolumeFileInode, Promise<void>>();
  // per pack, inodes sorted by offset (for read-ahead)
  private _packIndex = new Map<number, VolumeFileInode[]>();
  private _packIndexDirty = new Set<number>();
  private _pagedOutSyncMisses = 0;
  // enableContentPacking
  private _packState: PackState | null = null;
  private _inflatedChunks: Array<{ chunk: PackedChunk; bytes: Uint8Array }> = [];
  private _inflatedTimer: ReturnType<typeof setTimeout> | null = null;
  // peekFileSync reading through readFileSync: a copy, not a use
  private _peeking = false;

  private get _journaling(): boolean {
    return this._journalMute === 0 && this._mutationListeners.size > 0;
  }

  private _journal(mutation: VolumeMutation): void {
    for (const cb of this._mutationListeners) {
      try { cb(mutation); } catch (e) { console.error('Volume mutation listener error:', e); }
    }
  }

  private _fileInode(node: VolumeNode): VolumeFileInode {
    if (node.kind !== 'file') throw makeSystemError('EISDIR', 'open', '');
    if (!node.inode) {
      const modified = node.modified || Date.now();
      node.inode = {
        ino: this._nextIno++,
        content: node.content,
        mode: 0o644,
        atime: modified,
        mtime: modified,
        ctime: modified,
        nlink: 1,
        uid: node.uid ?? MOCK_IDS.UID,
        gid: node.gid ?? MOCK_IDS.GID,
      };
      node.content = undefined;
    }
    return node.inode;
  }

  private _fileContent(node: VolumeNode): Uint8Array | undefined {
    return this._fileInode(node).content;
  }

  private _linkInodePath(path: string, inode: VolumeFileInode): void {
    let paths = this._inodePaths.get(inode);
    if (!paths) {
      paths = new Set<string>();
      this._inodePaths.set(inode, paths);
    }
    paths.add(path);
  }

  private _unlinkInodePath(path: string, inode: VolumeFileInode): void {
    const paths = this._inodePaths.get(inode);
    if (!paths) return;
    paths.delete(path);
    if (paths.size === 0) this._inodePaths.delete(inode);
  }

  private _fileInodeAt(path: string, node: VolumeNode): VolumeFileInode {
    const inode = this._fileInode(node);
    // an inode's paths are registered where it is created, linked, renamed
    // or mounted. only a path-less (legacy/lazy-listed) inode learns its path
    // here: callers that followed a symlink would otherwise register an
    // alias that outlives the file it points at
    if (!this._inodePaths.has(inode)) this._linkInodePath(path, inode);
    return inode;
  }

  private _pathsForInode(inode: VolumeFileInode): string[] {
    return [...(this._inodePaths.get(inode) ?? [])];
  }

  // nodes currently linked to this inode (skips stale registrations)
  private _nodesForInode(inode: VolumeFileInode): Array<{ path: string; node: VolumeNode }> {
    const out: Array<{ path: string; node: VolumeNode }> = [];
    for (const path of this._pathsForInode(inode)) {
      const node = this._locateCanonical(path);
      if (node?.kind === 'file' && node.inode === inode) out.push({ path, node });
    }
    return out;
  }

  private _releaseNodeLinks(node: VolumeNode, path: string): void {
    if (node.kind === 'file') {
      const inode = this._fileInodeAt(path, node);
      this._unlinkInodePath(path, inode);
      inode.nlink = Math.max(0, inode.nlink - 1);
      inode.ctime = Date.now();
      // last link gone: stop holding its paged-in bytes
      if (inode.src && !this._inodePaths.has(inode)) this._dropSource(inode);
      return;
    }
    if (node.kind !== 'directory' || !node.children) return;
    for (const [name, child] of node.children) {
      this._releaseNodeLinks(child, path === '/' ? `/${name}` : `${path}/${name}`);
    }
  }

  private _remapNodeInodePaths(node: VolumeNode, from: string, to: string): void {
    if (node.kind === 'file') {
      const inode = this._fileInodeAt(from, node);
      this._unlinkInodePath(from, inode);
      this._linkInodePath(to, inode);
      return;
    }
    if (node.kind !== 'directory' || !node.children) return;
    for (const [name, child] of node.children) {
      const oldPath = from === '/' ? `/${name}` : `${from}/${name}`;
      const newPath = to === '/' ? `/${name}` : `${to}/${name}`;
      this._remapNodeInodePaths(child, oldPath, newPath);
    }
  }
  private _inoFor(path: string): number {
    let n = this._inos.get(path);
    if (n === undefined) {
      n = this._nextIno++;
      this._inos.set(path, n);
    }
    return n;
  }

  // decode arbitrary input to UTF-8. handles Uint8Array (including SAB-backed
  // which TextDecoder rejects directly), ArrayBuffer, other TypedArray views,
  // and plain arrays from postMessage(Array.from(u8)). must never throw —
  // broadcast calls this and a throw would hide writes from watchers
  private decodeText(data: unknown): string {
    try {
      if (data == null) return "";
      if (data instanceof Uint8Array) {
        if (typeof SharedArrayBuffer !== "undefined" && data.buffer instanceof SharedArrayBuffer) {
          const copy = new Uint8Array(data.byteLength);
          copy.set(data);
          return this.textDecoder.decode(copy);
        }
        return this.textDecoder.decode(data);
      }
      if (data instanceof ArrayBuffer) {
        return this.textDecoder.decode(data);
      }
      if (ArrayBuffer.isView(data as any)) {
        const view = data as ArrayBufferView;
        const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        if (typeof SharedArrayBuffer !== "undefined" && u8.buffer instanceof SharedArrayBuffer) {
          const copy = new Uint8Array(u8.byteLength);
          copy.set(u8);
          return this.textDecoder.decode(copy);
        }
        return this.textDecoder.decode(u8);
      }
      if (Array.isArray(data) || (typeof (data as any).length === "number")) {
        const u8 = Uint8Array.from(data as ArrayLike<number>);
        return this.textDecoder.decode(u8);
      }
      return String(data);
    } catch {
      return "";
    }
  }

  // normalize any input shape that can reach writeFileSync (string, Uint8Array,
  // ArrayBuffer, TypedArray view, plain array) into a proper Uint8Array
  private toBytes(data: unknown): Uint8Array {
    if (typeof data === "string") return this.textEncoder.encode(data);
    if (data == null) return new Uint8Array(0);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data as any)) {
      const view = data as ArrayBufferView;
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    if (Array.isArray(data) || typeof (data as any).length === "number") {
      return Uint8Array.from(data as ArrayLike<number>);
    }
    return this.textEncoder.encode(String(data));
  }
  private activeWatchers = new Map<string, Set<ActiveWatcher>>();
  private subscribers = new Map<string, Set<VolumeEventHandler>>();
  private _handler: MemoryHandler | null;
  private _bulkMountHandler: ((snapshot: {
    manifest: Array<{ path: string; offset: number; length: number; isDirectory: boolean }>;
    data: ArrayBuffer;
  }) => void) | null = null;

  // lazily hydrated package content kept per worker; older bytes are
  // dropped (LRU) and re-read from the main thread if touched again
  constructor(handler?: MemoryHandler | null, lazyResidentMaxBytes = 32 * 1024 * 1024) {
    this._handler = handler ?? null;
    this._lazyResidentMaxBytes = Math.max(1, lazyResidentMaxBytes);
    this.tree = {
      kind: 'directory',
      children: new Map(),
      modified: Date.now(),
    };
  }

  // ---- Event subscription ----

  on(event: 'change', handler: FileChangeHandler): this;
  on(event: 'delete', handler: FileDeleteHandler): this;
  on(event: string, handler: VolumeEventHandler): this {
    if (!this.subscribers.has(event)) {
      this.subscribers.set(event, new Set());
    }
    this.subscribers.get(event)!.add(handler);
    return this;
  }

  off(event: 'change', handler: FileChangeHandler): this;
  off(event: 'delete', handler: FileDeleteHandler): this;
  off(event: string, handler: VolumeEventHandler): this {
    const handlers = this.subscribers.get(event);
    if (handlers) handlers.delete(handler);
    return this;
  }

  setBulkMountHandler(handler: typeof this._bulkMountHandler): void {
    this._bulkMountHandler = handler;
  }

  /**
   * Subscribe to metadata changes only (chmod/chown/utimes and their l*
   * variants), with the fields that changed. Cheaper than onMutation, which
   * resolves canonical paths for every mutation. Returns an unsubscribe fn.
   */
  onMetaChange(cb: (path: string, change: MetaChange) => void): () => void {
    this._metaListeners.add(cb);
    return () => { this._metaListeners.delete(cb); };
  }

  /** Subscribe to every logical mutation (see VolumeMutation). Returns an unsubscribe fn. */
  /**
   * Entries mounted without notify (bulk restores) fire no watchers: `cb`
   * gets their paths, so processes that listed those directories earlier
   * can look again. Cheaper than onMutation, which journals every change.
   */
  onSilentMount(cb: (paths: string[]) => void): () => void {
    this._silentMountListeners.add(cb);
    return () => { this._silentMountListeners.delete(cb); };
  }

  onMutation(cb: (mutation: VolumeMutation) => void): () => void {
    this._mutationListeners.add(cb);
    return () => { this._mutationListeners.delete(cb); };
  }

  /**
   * lstat-like view of the node at exactly `p`: no symlink is followed, not
   * even in a parent directory (null for paths that only exist through
   * one). Never hydrates lazy content and never throws. `inode` is an
   * opaque identity token shared by hardlinks and stable across renames.
   */
  inspectNode(p: string): VolumeNodeInfo | null {
    let norm: string;
    let node: VolumeNode | undefined;
    try {
      norm = this.normalize(p);
      node = this._locateCanonical(norm);
    } catch {
      return null;
    }
    if (!node) return null;
    if (node.kind === 'directory') {
      return {
        kind: 'directory',
        mode: node.mode ?? 0o755,
        uid: node.uid,
        gid: node.gid,
        mtimeMs: node.modified,
        atimeMs: node.atime ?? node.modified,
        size: 0,
        resident: true,
      };
    }
    if (node.kind === 'symlink') {
      return {
        kind: 'symlink',
        mode: node.mode ?? 0o777,
        uid: node.uid,
        gid: node.gid,
        mtimeMs: node.modified,
        atimeMs: node.atime ?? node.modified,
        size: (node.target ?? '').length,
        target: node.target,
        symlinkType: node.symlinkType,
        resident: true,
      };
    }
    const inode = this._fileInodeAt(norm, node);
    const packed = inode.packed;
    const resident = !node.lazy && (inode.content !== undefined || !!packed);
    const info: VolumeNodeInfo = {
      kind: 'file',
      mode: inode.mode,
      uid: inode.uid ?? node.uid,
      gid: inode.gid ?? node.gid,
      mtimeMs: inode.mtime,
      atimeMs: inode.atime,
      size: inode.content?.byteLength ?? packed?.length ?? node.lazySize ?? inode.src?.length ?? 0,
      resident,
      inode,
      content: resident ? inode.content : undefined,
    };
    // a packed file's bytes are only inflated if the caller wants them
    if (resident && packed && inode.content === undefined) {
      const volume = this;
      Object.defineProperty(info, 'content', {
        enumerable: true,
        get: () => volume._peekPacked(packed),
      });
    }
    return info;
  }

  /** Rebuild internal inode indexes after an external tree replacement. */
  rebuildIndexes(): void {
    this._inodePaths.clear();
    this._inos.clear();
    let maxIno = 0;
    const visit = (node: VolumeNode, path: string): void => {
      if (node.kind === 'file') {
        const inode = this._fileInode(node);
        maxIno = Math.max(maxIno, inode.ino);
        this._linkInodePath(path, inode);
        return;
      }
      if (node.kind !== 'directory' || !node.children) return;
      for (const [name, child] of node.children) {
        visit(child, path === '/' ? `/${name}` : `${path}/${name}`);
      }
    };
    visit(this.tree, '/');
    this._nextIno = Math.max(1, maxIno + 1);
  }

  private broadcast(event: 'change', path: string, content: string): void;
  private broadcast(event: 'delete', path: string): void;
  private broadcast(event: string, ...args: unknown[]): void {
    const handlers = this.subscribers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          (handler as (...a: unknown[]) => void)(...args);
        } catch (e) {
          console.error('Volume event handler error:', e);
        }
      }
    }
  }

  // ---- Stats ----

  getStats(): {
    fileCount: number;
    totalBytes: number;
    dirCount: number;
    watcherCount: number;
    lazyResidentBytes: number;
    pagedOutFiles: number;
    pagedOutBytes: number;
    residentPackBytes: number;
    pagedOutSyncMisses: number;
    packedFiles: number;
    packedBytes: number;
    packedStoredBytes: number;
  } {
    let fileCount = 0;
    let totalBytes = 0;
    let dirCount = 0;
    let pagedOutFiles = 0;
    let pagedOutBytes = 0;
    let packedFiles = 0;
    let packedBytes = 0;
    const chunks = new Set<PackedChunk>();
    const walk = (node: VolumeNode) => {
      if (node.kind === 'file') {
        fileCount++;
        const inode = this._fileInode(node);
        totalBytes += inode.content?.byteLength ?? 0;
        if (inode.content === undefined && inode.src) {
          pagedOutFiles++;
          pagedOutBytes += inode.src.length;
        }
        if (inode.packed) {
          packedFiles++;
          packedBytes += inode.packed.length;
          chunks.add(inode.packed.chunk);
        }
      } else if (node.kind === 'directory') {
        dirCount++;
        if (node.children) {
          for (const child of node.children.values()) walk(child);
        }
      }
    };
    walk(this.tree);
    let watcherCount = 0;
    for (const set of this.activeWatchers.values()) watcherCount += set.size;
    return {
      fileCount,
      totalBytes,
      dirCount,
      watcherCount,
      lazyResidentBytes: this._lazyResidentBytes,
      pagedOutFiles,
      pagedOutBytes,
      residentPackBytes: this._srcResidentBytes,
      pagedOutSyncMisses: this._pagedOutSyncMisses,
      packedFiles,
      packedBytes,
      packedStoredBytes: [...chunks].reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0),
    };
  }

  /** Clean up all owned data and listeners. A disposed volume is empty. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.activeWatchers.clear();
    this.subscribers.clear();
    this.globalChangeListeners.clear();
    this._mutationListeners.clear();
    this._metaListeners.clear();
    this._missHandler = null;
    this._bulkMountHandler = null;
    this._lazyDirNames = [];
    this._lazyListed.clear();
    this._lazyNegative.clear();
    this._lazyInvalidated.clear();
    this._lazyResident.clear();
    this._lazyResidentBytes = 0;
    this._contentSource = null;
    this._srcResident.clear();
    this._srcResidentBytes = 0;
    this._hydrating.clear();
    this._packIndex.clear();
    this._packIndexDirty.clear();
    if (this._packState?.timer) clearTimeout(this._packState.timer);
    this._packState = null;
    if (this._inflatedTimer) clearTimeout(this._inflatedTimer);
    this._inflatedTimer = null;
    this._inflatedChunks = [];
    this._inos.clear();
    this._inodePaths.clear();
    this.tree = {
      kind: 'directory',
      children: new Map(),
      modified: Date.now(),
    };
    if (this._handler) {
      this._handler.statCache.clear();
      this._handler.pathNormCache.clear();
    }
  }

  // ---- Snapshot serialization ----

  toSnapshot(excludePrefixes?: string[], excludeDirNames?: Set<string>): VolumeSnapshot {
    const entries: VolumeEntry[] = [];
    this.collectEntries('/', this.tree, entries, excludePrefixes, excludeDirNames);
    return { entries };
  }

  private collectEntries(
    currentPath: string,
    node: VolumeNode,
    result: VolumeEntry[],
    excludePrefixes?: string[],
    excludeDirNames?: Set<string>,
  ): void {
    if (excludePrefixes) {
      for (const prefix of excludePrefixes) {
        if (currentPath === prefix || currentPath.startsWith(prefix + '/')) return;
      }
    }

    if (node.kind === 'file') {
      // a lazy stub's bytes live elsewhere — writing it as '' would turn it
      // into an empty file on restore
      if (node.lazy) return;
      let data = '';
      const inode = this._fileInodeAt(currentPath, node);
      const content = inode.content ?? (inode.packed ? this._peekPacked(inode.packed) : undefined);
      if (content && content.length > 0) {
        data = bytesToBase64(content);
      }
      result.push({
        path: currentPath,
        kind: 'file',
        data,
        inode: inode.ino,
        mode: inode.mode,
        atimeMs: inode.atime,
        mtimeMs: inode.mtime,
        ctimeMs: inode.ctime,
        nlink: inode.nlink,
        uid: inode.uid ?? node.uid,
        gid: inode.gid ?? node.gid,
      });
    } else if (node.kind === 'symlink') {
      result.push({
        path: currentPath,
        kind: 'symlink',
        target: node.target,
        mode: node.mode,
        atimeMs: node.atime,
        mtimeMs: node.modified,
        uid: node.uid,
        gid: node.gid,
        symlinkType: node.symlinkType,
      });
    } else if (node.kind === 'directory') {
      result.push({
        path: currentPath,
        kind: 'directory',
        mode: node.mode,
        uid: node.uid,
        gid: node.gid,
        mtimeMs: node.modified,
      });
      if (node.children) {
        for (const [name, child] of node.children) {
          // Skip excluded directory names at any depth (e.g. node_modules, .cache)
          if (excludeDirNames && child.kind === 'directory' && excludeDirNames.has(name)) continue;
          const childPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
          this.collectEntries(childPath, child, result, excludePrefixes, excludeDirNames);
        }
      }
    }
  }

  // restore from a binary snapshot (flat ArrayBuffer + offset manifest, used by workers)
  static fromBinarySnapshot(snapshot: { manifest: BinaryVolumeEntry[]; data: ArrayBuffer }): MemoryVolume {
    const vol = new MemoryVolume();
    vol.mountEntries(MemoryVolume._binaryToMountEntries(snapshot.manifest, new Uint8Array(snapshot.data)));
    return vol;
  }

  // merge a binary snapshot without copying file payloads or emitting events
  mountBinarySnapshot(snapshot: {
    manifest: BinaryVolumeEntry[];
    data: ArrayBuffer;
  }, notifyBulk = true): number {
    const mounted = this.mountEntries(
      MemoryVolume._binaryToMountEntries(snapshot.manifest, new Uint8Array(snapshot.data)),
    );
    if (notifyBulk) this._bulkMountHandler?.(snapshot);
    return mounted;
  }

  // file payloads stay views into fullData — no copy
  private static _binaryToMountEntries(manifest: BinaryVolumeEntry[], fullData: Uint8Array): MountEntry[] {
    const entries: MountEntry[] = [];
    for (const entry of manifest) {
      if (entry.isDirectory) {
        entries.push({
          path: entry.path,
          kind: 'directory',
          mode: entry.mode,
          uid: entry.uid,
          gid: entry.gid,
          mtimeMs: entry.mtimeMs,
        });
      } else if (entry.symlinkTarget !== undefined) {
        entries.push({
          path: entry.path,
          kind: 'symlink',
          target: entry.symlinkTarget,
          mode: entry.mode,
          uid: entry.uid,
          gid: entry.gid,
          atimeMs: entry.atimeMs,
          mtimeMs: entry.mtimeMs,
        });
      } else if (
        entry.offset >= 0 &&
        entry.length >= 0 &&
        entry.offset + entry.length <= fullData.byteLength
      ) {
        entries.push({
          path: entry.path,
          kind: 'file',
          content: fullData.subarray(entry.offset, entry.offset + entry.length),
          // ino numbers come from another volume: they only say which
          // entries are hardlinks of each other
          linkGroup: (entry.nlink ?? 1) > 1 ? entry.inode : undefined,
          mode: entry.mode,
          uid: entry.uid,
          gid: entry.gid,
          atimeMs: entry.atimeMs,
          mtimeMs: entry.mtimeMs,
          ctimeMs: entry.ctimeMs,
          nlink: entry.nlink,
        });
      }
    }
    return entries;
  }

  static fromSnapshot(snapshot: VolumeSnapshot): MemoryVolume {
    const vol = new MemoryVolume();
    vol.mountEntries(MemoryVolume.snapshotToMountEntries(snapshot));
    return vol;
  }

  static snapshotToMountEntries(snapshot: VolumeSnapshot): MountEntry[] {
    return snapshot.entries.map((entry): MountEntry => {
      if (entry.kind === 'file') {
        return {
          path: entry.path,
          kind: 'file',
          content: entry.data ? base64ToBytes(entry.data) : new Uint8Array(0),
          linkGroup: (entry.nlink ?? 1) > 1 ? entry.inode : undefined,
          mode: entry.mode,
          uid: entry.uid,
          gid: entry.gid,
          atimeMs: entry.atimeMs,
          mtimeMs: entry.mtimeMs,
          ctimeMs: entry.ctimeMs,
          nlink: entry.nlink,
        };
      }
      if (entry.kind === 'symlink') {
        return {
          path: entry.path,
          kind: 'symlink',
          target: entry.target ?? '',
          symlinkType: entry.symlinkType,
          mode: entry.mode,
          uid: entry.uid,
          gid: entry.gid,
          atimeMs: entry.atimeMs,
          mtimeMs: entry.mtimeMs,
        };
      }
      return {
        path: entry.path,
        kind: 'directory',
        mode: entry.mode,
        uid: entry.uid,
        gid: entry.gid,
        mtimeMs: entry.mtimeMs,
      };
    });
  }

  /**
   * Merge entries into the volume. Missing parents are created and an entry
   * whose path holds a node of another kind replaces it. With `notify`, every
   * entry fires the same watcher/global/mutation events a regular write
   * would. Without it, a single `mount` mutation is reported for the whole
   * batch and the new entries fire no watchers (removing a node of another
   * kind at an entry's path still does, like any removal).
   */
  mountEntries(entries: ReadonlyArray<MountEntry>, opts: { notify?: boolean } = {}): number {
    const notify = opts.notify === true;
    this._notePackActivity();
    const groups = new Map<string | number, VolumeFileInode>();
    const sorted = entries
      .map((entry, index) => ({ entry, index, depth: countPathSegments(entry.path) }))
      .sort((a, b) =>
        a.depth - b.depth ||
        Number(b.entry.kind === 'directory') - Number(a.entry.kind === 'directory') ||
        a.index - b.index,
      );

    let mounted = 0;
    if (!notify) this._journalMute++;
    try {
      for (const { entry } of sorted) {
        const path = this.normalize(entry.path);
        if (path === '/') continue;
        this._mountEntry(path, entry, groups, notify);
        mounted++;
      }
    } finally {
      if (!notify) this._journalMute--;
    }
    if (!notify && this._journaling) this._journal({ op: 'mount', entries });
    if (!notify && this._silentMountListeners.size > 0 && entries.length > 0) {
      const paths = entries.map((entry) => entry.path);
      for (const cb of this._silentMountListeners) {
        try {
          cb(paths);
        } catch (e) {
          console.error('Volume mount listener error:', e);
        }
      }
    }
    return mounted;
  }

  private _mountEntry(
    path: string,
    entry: MountEntry,
    groups: Map<string | number, VolumeFileInode>,
    notify: boolean,
  ): void {
    const existing = this.locateRaw(path);

    if (entry.kind === 'directory') {
      if (existing && existing.kind !== 'directory') this.unlinkSync(path);
      const { node, created } = this.ensureDirTracked(path);
      this._announceCreatedDirs(created, notify);
      if (entry.mode !== undefined) node.mode = entry.mode;
      if (entry.uid !== undefined) node.uid = entry.uid;
      if (entry.gid !== undefined) node.gid = entry.gid;
      if (entry.mtimeMs !== undefined) node.modified = entry.mtimeMs;
      return;
    }

    if (existing?.kind === 'directory') this.removeTreeSync(path);
    else if (existing && (entry.kind === 'symlink' || existing.kind === 'symlink')) this.unlinkSync(path);

    const { node: parent, created } = this.ensureDirTracked(this.parentOf(path));
    this._announceCreatedDirs(created, notify);
    const name = this.nameOf(path);
    const now = Date.now();

    if (entry.kind === 'symlink') {
      parent.children!.set(name, {
        kind: 'symlink',
        target: entry.target ?? '',
        modified: entry.mtimeMs ?? now,
        atime: entry.atimeMs ?? now,
        mode: entry.mode ?? 0o777,
        uid: entry.uid ?? MOCK_IDS.UID,
        gid: entry.gid ?? MOCK_IDS.GID,
        symlinkType: entry.symlinkType,
      });
      if (this._handler) this._handler.invalidateStat(path);
      this._invalidateLazyListedFor(path);
      if (notify) {
        this.triggerWatchers(path, 'rename');
        this.notifyGlobalListeners(path, 'add');
      }
      if (this._journaling) this._journal({ op: 'symlink', path });
      return;
    }

    if (entry.content === undefined && entry.src) {
      const current = parent.children!.get(name);
      if (current) {
        this._untrackLazyResident(path);
        this._releaseNodeLinks(current, path);
      }
      let inode = entry.linkGroup === undefined ? undefined : groups.get(entry.linkGroup);
      if (!inode) {
        const mtime = entry.mtimeMs ?? now;
        inode = {
          ino: this._nextIno++,
          content: undefined,
          mode: entry.mode ?? 0o644,
          atime: entry.atimeMs ?? mtime,
          mtime,
          ctime: entry.ctimeMs ?? mtime,
          nlink: entry.nlink ?? 1,
          uid: entry.uid,
          gid: entry.gid,
          src: entry.src,
        };
        if (entry.linkGroup !== undefined) groups.set(entry.linkGroup, inode);
        this._indexSource(inode);
      }
      parent.children!.set(name, {
        kind: 'file',
        modified: inode.mtime,
        inode,
        lazy: true,
        lazySize: inode.src?.length ?? 0,
      });
      this._linkInodePath(path, inode);
      if (this._handler) this._handler.invalidateStat(path);
      this._invalidateLazyListedFor(path);
      if (notify) {
        this.triggerWatchers(path, current ? 'change' : 'rename');
        this.notifyGlobalListeners(path, current ? 'change' : 'add');
      }
      if (this._journaling) this._journal({ op: 'write', path });
      return;
    }

    const group = entry.linkGroup === undefined ? undefined : groups.get(entry.linkGroup);
    if (group) {
      // later member of a hardlink group: alias the inode mounted first
      const current = parent.children!.get(name);
      if (current) {
        this._untrackLazyResident(path);
        this._releaseNodeLinks(current, path);
      }
      parent.children!.set(name, { kind: 'file', modified: group.mtime, inode: group });
      this._linkInodePath(path, group);
      if (this._handler) this._handler.invalidateStat(path);
      this._invalidateLazyListedFor(path);
      if (notify) {
        this.triggerWatchers(path, current ? 'change' : 'rename');
        this.notifyGlobalListeners(path, current ? 'change' : 'add');
      }
      if (this._journaling) this._journal({ op: 'write', path });
      return;
    }

    this.writeInternal(path, entry.content ?? new Uint8Array(0), notify);
    const node = this.locateRaw(path);
    if (node?.kind !== 'file') return;
    const inode = this._fileInodeAt(path, node);
    if (entry.mode !== undefined) inode.mode = entry.mode;
    if (entry.atimeMs !== undefined) inode.atime = entry.atimeMs;
    if (entry.mtimeMs !== undefined) {
      inode.mtime = entry.mtimeMs;
      node.modified = entry.mtimeMs;
    }
    if (entry.ctimeMs !== undefined) inode.ctime = entry.ctimeMs;
    if (entry.nlink !== undefined) inode.nlink = entry.nlink;
    if (entry.uid !== undefined) inode.uid = entry.uid;
    if (entry.gid !== undefined) inode.gid = entry.gid;
    if (entry.linkGroup !== undefined) groups.set(entry.linkGroup, inode);
    if (entry.src && this._contentSource) {
      // resident now, but evictable: the pack can give the bytes back
      inode.src = entry.src;
      this._indexSource(inode);
      this._trackSource(inode);
    }
  }

  private _announceCreatedDirs(created: string[], notify: boolean): void {
    for (const path of created) {
      this._invalidateLazyListedFor(path);
      if (this._handler) this._handler.invalidateStat(path);
      if (notify) {
        this.triggerWatchers(path, 'rename');
        this.notifyGlobalListeners(path, 'addDir');
      }
      if (this._journaling) this._journal({ op: 'mkdir', path });
    }
  }

  // ---- Path utilities ----

  private normalize(p: string): string {
    if (this._disposed) throw new Error('[Nodepod] Filesystem has been disposed');
    if (this._handler) {
      const cached = this._handler.pathNormCache.get(p);
      if (cached !== undefined) return cached;
    }
    if (!p.startsWith('/')) p = '/' + p;
    const parts = p.split('/').filter(Boolean);
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === '..') resolved.pop();
      else if (part !== '.') resolved.push(part);
    }
    const result = '/' + resolved.join('/');
    if (this._handler) this._handler.pathNormCache.set(p, result);
    return result;
  }

  // assumes pre-normalized input (starts with '/', no '..' or double slashes)
  private segments(p: string): string[] {
    if (p === '/') return [];
    // skip leading '/' then split — no empty strings since input is normalized
    return p.substring(1).split('/');
  }

  private parentOf(p: string): string {
    const idx = p.lastIndexOf('/');
    return idx <= 0 ? '/' : p.slice(0, idx);
  }

  private nameOf(p: string): string {
    const idx = p.lastIndexOf('/');
    return p.slice(idx + 1);
  }

  private resolveNode(p: string, followFinal: boolean, seen = new Set<string>()): VolumeNode | undefined {
    if (p === '/') return this.tree;
    const segments = this.segments(p);
    let current = this.tree;
    let currentPath = '';
    for (let index = 0; index < segments.length; index++) {
      if (current.kind !== 'directory' || !current.children) return undefined;
      const segment = segments[index];
      const child = current.children.get(segment);
      if (!child) return undefined;
      currentPath += '/' + segment;
      const shouldFollow = child.kind === 'symlink' && (followFinal || index < segments.length - 1);
      if (!shouldFollow) {
        current = child;
        continue;
      }
      if (seen.has(currentPath) || seen.size >= 40) {
        throw makeSystemError('ELOOP', 'stat', p);
      }
      seen.add(currentPath);
      const target = child.target!;
      const targetPath = target.startsWith('/')
        ? this.normalize(target)
        : this.normalize(this.parentOf(currentPath) + '/' + target);
      const remainder = segments.slice(index + 1).join('/');
      const resolvedPath = remainder ? this.normalize(targetPath + '/' + remainder) : targetPath;
      return this.resolveNode(resolvedPath, followFinal, seen);
    }
    return current;
  }

  // the node at exactly this path: no symlink is followed, final or not.
  // a path that only exists through a symlinked directory is not canonical
  private _locateCanonical(p: string): VolumeNode | undefined {
    let current: VolumeNode | undefined = this.tree;
    for (const segment of this.segments(p)) {
      if (current.kind !== 'directory' || !current.children) return undefined;
      current = current.children.get(segment);
      if (!current) return undefined;
    }
    return current;
  }

  private locateRaw(p: string): VolumeNode | undefined {
    return this.resolveNode(p, false);
  }

  private locate(p: string): VolumeNode | undefined {
    return this.resolveNode(p, true);
  }

  private ensureDir(p: string): VolumeNode {
    if (p === '/') return this.tree;
    let current = this.tree;
    let start = 1; // skip leading '/'
    const len = p.length;
    while (start < len) {
      let end = p.indexOf('/', start);
      if (end === -1) end = len;
      const seg = p.substring(start, end);
      start = end + 1;
      if (!current.children) current.children = new Map();
      let child = current.children.get(seg);
      if (!child) {
        child = { kind: 'directory', children: new Map(), modified: Date.now() };
        current.children.set(seg, child);
        if (this._journaling) this._journal({ op: 'mkdir', path: p.substring(0, end) });
      } else if (child.kind !== 'directory') {
        throw new Error(`ENOTDIR: not a directory, '${p}'`);
      }
      current = child;
    }
    return current;
  }

  // same as ensureDir but returns the list of segments it actually had to create,
  // so mkdirSync(recursive: true) can fire one addDir per new dir and stay quiet
  // about ones that already existed
  private ensureDirTracked(p: string): { node: VolumeNode; created: string[] } {
    const created: string[] = [];
    if (p === '/') return { node: this.tree, created };
    let current = this.tree;
    let start = 1;
    const len = p.length;
    let currentPath = '';
    while (start < len) {
      let end = p.indexOf('/', start);
      if (end === -1) end = len;
      const seg = p.substring(start, end);
      start = end + 1;
      currentPath = currentPath + '/' + seg;
      if (!current.children) current.children = new Map();
      let child = current.children.get(seg);
      if (!child) {
        child = { kind: 'directory', children: new Map(), modified: Date.now() };
        current.children.set(seg, child);
        created.push(currentPath);
      } else if (child.kind !== 'directory') {
        throw new Error(`ENOTDIR: not a directory, '${p}'`);
      }
      current = child;
    }
    return { node: current, created };
  }

  // ---- Internal write ----

  // expects pre-normalized path
  private writeInternal(
    norm: string,
    data: string | Uint8Array | unknown,
    notify: boolean,
    seen: Set<string> = new Set(),
  ): void {
    const lastSlash = norm.lastIndexOf('/');
    const parentPath = lastSlash <= 0 ? '/' : norm.slice(0, lastSlash);
    const name = norm.slice(lastSlash + 1);

    if (!name) {
      throw new Error(`EISDIR: illegal operation on a directory, '${norm}'`);
    }

    const parent = this.ensureDir(parentPath);
    const existing = parent.children!.get(name);
    const existed = !!existing;
    // callers may pass any buffer-ish shape (ArrayBuffer, TypedArray view, plain
    // array from postMessage, Node Buffer). storing anything but a Uint8Array
    // would break every downstream read
    const bytes = this.toBytes(data);
    this._untrackLazyResident(norm);
    this._invalidateLazyListedFor(norm);
    if (existing?.kind === 'directory') throw makeSystemError('EISDIR', 'open', norm);

    const now = Date.now();
    this._notePackActivity();
    if (existing?.kind === 'file') {
      const inode = this._fileInodeAt(norm, existing);
      if (inode.src) this._forgetSource(inode);
      inode.packed = undefined;
      inode.content = bytes;
      inode.mtime = now;
      inode.ctime = now;
      existing.modified = now;
      existing.lazy = false;
      existing.lazySize = undefined;
    } else if (existing?.kind === 'symlink') {
      if (seen.has(norm) || seen.size >= 40) throw makeSystemError('ELOOP', 'open', norm);
      seen.add(norm);
      const targetPath = existing.target!.startsWith('/')
        ? this.normalize(existing.target!)
        : this.normalize(parentPath + '/' + existing.target!);
      this.writeInternal(targetPath, data, notify, seen);
      return;
    } else {
      const inode: VolumeFileInode = {
        ino: this._nextIno++,
        content: bytes,
        mode: 0o644,
        atime: now,
        mtime: now,
        ctime: now,
        nlink: 1,
      };
      parent.children!.set(name, {
        kind: 'file',
        modified: now,
        inode,
      });
      this._linkInodePath(norm, inode);
    }

    if (this._handler) this._handler.invalidateStat(norm);
    if (this._journaling) this._journal({ op: 'write', path: norm });

    if (notify) {
      this.triggerWatchers(norm, existed ? 'change' : 'rename');
      // Keep the legacy text event contract, but do not decode binary data if
      // nobody is subscribed. The normal VFS bridge uses fs.watch instead.
      const changeHandlers = this.subscribers.get('change');
      if (changeHandlers && changeHandlers.size > 0) {
        this.broadcast('change', norm, typeof data === 'string' ? data : this.decodeText(bytes));
      }
      this.notifyGlobalListeners(norm, existed ? 'change' : 'add');
    }
  }

  // ---- Main-thread eviction of pack-backed content ----

  /**
   * Keep node_modules files that nobody reads deflated in memory (see
   * PackedChunk). Main thread only: rounds run after the volume has been
   * quiet for a while and yield between slices; reads stay synchronous.
   */
  enableContentPacking(): void {
    if (this._packState || this._missHandler || this._disposed) return;
    this._packState = {
      timer: null,
      running: false,
      lastActivity: Date.now(),
      lastRoundStart: -Infinity,
      generation: 0,
      lastRead: new WeakMap(),
    };
    this._schedulePackCheck(PACK_QUIET_MS);
  }

  get contentPackingEnabled(): boolean {
    return this._packState !== null;
  }

  /**
   * A file's bytes for bulk copies (snapshots): like readFileSync, but the
   * file isn't counted as in use, and a packed file is inflated for the
   * caller and stays packed.
   */
  peekFileSync(p: string): Uint8Array {
    const norm = this.normalize(p);
    const node = this.locate(norm);
    if (node?.kind === 'file' && !node.lazy) {
      const inode = node.inode;
      if (inode?.packed && inode.content === undefined) return this._peekPacked(inode.packed);
      const bytes = inode ? inode.content : node.content;
      if (bytes && !inode?.src) return bytes;
    }
    this._peeking = true;
    try {
      return this.readFileSync(p);
    } finally {
      this._peeking = false;
    }
  }

  /** Run a packing round now (tests; normally rounds start on their own). */
  packContentNow(): Promise<void> {
    if (!this._packState || this._packState.running) return Promise.resolve();
    return this._packRound();
  }

  private _noteRead(inode: VolumeFileInode): void {
    const state = this._packState!;
    state.lastRead.set(inode, state.generation);
    this._notePackActivity();
    if (inode.packed) this._unpack(inode);
  }

  private _notePackActivity(): void {
    const state = this._packState;
    if (!state) return;
    state.lastActivity = Date.now();
    if (!state.timer && !state.running) this._schedulePackCheck(PACK_QUIET_MS);
  }

  private _schedulePackCheck(delay: number): void {
    const state = this._packState;
    if (!state) return;
    const timer = setTimeout(() => {
      state.timer = null;
      if (this._packState !== state || state.running) return;
      const wait =
        Math.max(state.lastActivity + PACK_QUIET_MS, state.lastRoundStart + PACK_MIN_INTERVAL_MS) - Date.now();
      if (wait > 0) {
        this._schedulePackCheck(wait);
        return;
      }
      void this._packRound();
    }, delay);
    // never keep a Node host alive for this
    (timer as unknown as { unref?: () => void }).unref?.();
    state.timer = timer;
  }

  private _packable(inode: VolumeFileInode, state: PackState): boolean {
    const content = inode.content;
    return (
      !!content &&
      content.byteLength >= PACK_MIN_FILE_BYTES &&
      !inode.packed &&
      !inode.src &&
      // not read since the last completed round
      state.lastRead.get(inode) !== state.generation
    );
  }

  private async _packRound(): Promise<void> {
    const state = this._packState;
    if (!state || state.running) return;
    state.running = true;
    const started = Date.now();
    state.lastRoundStart = started;
    this._inflatedChunks = [];
    let completed = false;
    try {
      let sliceStart = Date.now();
      // yield between slices; stop the round when the volume is in use again
      const proceed = async (): Promise<boolean> => {
        if (Date.now() - sliceStart >= PACK_SLICE_MS) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          sliceStart = Date.now();
        }
        return this._packState === state && state.lastActivity <= started;
      };

      // walk for candidates (no content is touched), yielding like the rest
      const candidates: VolumeNode[] = [];
      // files mounted from a pack are views into its one big buffer: any of
      // them left unpacked would keep all of it alive next to the chunks
      const views: VolumeNode[] = [];
      const stack: Array<[VolumeNode, string, boolean]> = [[this.tree, '', false]];
      let visited = 0;
      while (stack.length > 0) {
        if (++visited % 2048 === 0 && !(await proceed())) return;
        const [node, name, inPackages] = stack.pop()!;
        if (node.kind === 'directory') {
          if (!node.children) continue;
          const under = inPackages || name === 'node_modules';
          for (const [childName, child] of node.children) stack.push([child, childName, under]);
          continue;
        }
        if (!inPackages || node.kind !== 'file' || node.lazy) continue;
        const bytes = node.inode ? node.inode.content : node.content;
        if (!bytes) continue;
        if (bytes.byteLength !== bytes.buffer.byteLength) views.push(node);
        // package.json: read by every resolver. wasm: a tool's engine,
        // loaded whole at its startup, and it only halves
        if (name === 'package.json' || name.endsWith('.wasm') || bytes.byteLength < PACK_MIN_FILE_BYTES) continue;
        if (node.inode && !this._packable(node.inode, state)) continue;
        candidates.push(node);
      }

      let group: VolumeFileInode[] = [];
      let groupBytes = 0;
      // hard links: one inode, several candidate nodes
      const grouped = new Set<VolumeFileInode>();
      for (const node of candidates) {
        // groups are built and packed without yielding: their bytes can't
        // change underneath
        if (group.length === 0 && !(await proceed())) return;
        if (node.kind !== 'file' || node.lazy) continue;
        const inode = this._fileInode(node);
        if (grouped.has(inode) || !this._packable(inode, state)) continue;
        const size = inode.content!.byteLength;
        if (size >= PACK_SOLO_BYTES) {
          // it yields: pack what's pending first
          if (group.length > 0) {
            this._packGroup(group, groupBytes);
            group = [];
            groupBytes = 0;
            grouped.clear();
          }
          if (!(await this._packSolo(inode, state, proceed))) return;
          continue;
        }
        group.push(inode);
        grouped.add(inode);
        groupBytes += size;
        if (groupBytes >= PACK_CHUNK_BYTES) {
          this._packGroup(group, groupBytes);
          group = [];
          groupBytes = 0;
          grouped.clear();
        }
      }
      if (group.length > 0) this._packGroup(group, groupBytes);
      // what stays unpacked gets buffers of its own
      for (const node of views) {
        if (node.kind !== 'file') continue;
        const holder = node.inode ?? node;
        const bytes = holder.content;
        if (bytes && bytes.byteLength !== bytes.buffer.byteLength) holder.content = new Uint8Array(bytes);
      }
      completed = true;
    } finally {
      if (completed) state.generation++;
      state.running = false;
      this._inflatedChunks = [];
      // in use again since the round started: go again after the next quiet period
      if (this._packState === state && state.lastActivity > started && !state.timer) {
        this._schedulePackCheck(PACK_QUIET_MS);
      }
    }
  }

  private _packGroup(group: VolumeFileInode[], size: number): void {
    const joined = new Uint8Array(size);
    const offsets: number[] = [];
    let offset = 0;
    for (const inode of group) {
      offsets.push(offset);
      joined.set(inode.content!, offset);
      offset += inode.content!.byteLength;
    }
    const chunk: PackedChunk = { bytes: pako.deflateRaw(joined, { level: 1 }) };
    for (let i = 0; i < group.length; i++) {
      const inode = group[i];
      inode.packed = { chunk, offset: offsets[i], length: inode.content!.byteLength };
      inode.content = undefined;
    }
  }

  // a big file deflates in pieces across slices, then replaces the content
  // only if nothing touched the file meanwhile
  private async _packSolo(
    inode: VolumeFileInode,
    state: PackState,
    proceed: () => Promise<boolean>,
  ): Promise<boolean> {
    const bytes = inode.content!;
    const deflater = new pako.Deflate({ level: 1, raw: true });
    const PIECE = 256 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += PIECE) {
      if (!(await proceed())) return false;
      const end = Math.min(bytes.byteLength, offset + PIECE);
      deflater.push(bytes.subarray(offset, end), end === bytes.byteLength);
    }
    if (deflater.err || !(deflater.result instanceof Uint8Array)) return true;
    if (inode.content !== bytes || !this._packable(inode, state)) return true;
    inode.packed = { chunk: { bytes: deflater.result }, offset: 0, length: bytes.byteLength };
    inode.content = undefined;
    return true;
  }

  private _inflateChunk(chunk: PackedChunk): Uint8Array {
    const cache = this._inflatedChunks;
    for (let i = 0; i < cache.length; i++) {
      if (cache[i].chunk !== chunk) continue;
      const hit = cache[i];
      if (i > 0) {
        cache.splice(i, 1);
        cache.unshift(hit);
      }
      return hit.bytes;
    }
    const bytes = pako.inflateRaw(chunk.bytes);
    cache.unshift({ chunk, bytes });
    if (cache.length > INFLATED_CHUNK_CACHE) cache.pop();
    if (!this._inflatedTimer) {
      const timer = setTimeout(() => {
        this._inflatedTimer = null;
        this._inflatedChunks = [];
      }, INFLATED_CHUNK_IDLE_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
      this._inflatedTimer = timer;
    }
    return bytes;
  }

  // a packed file's bytes in a buffer of their own
  private _peekPacked(ref: PackedRef): Uint8Array {
    // a file deflated on its own: inflating yields exactly its bytes
    if (ref.offset === 0 && ref.length >= PACK_SOLO_BYTES) return pako.inflateRaw(ref.chunk.bytes);
    return this._inflateChunk(ref.chunk).slice(ref.offset, ref.offset + ref.length);
  }

  // the file is in use: keep it unpacked from now on
  private _unpack(inode: VolumeFileInode): void {
    const ref = inode.packed;
    if (!ref) return;
    inode.content = this._peekPacked(ref);
    inode.packed = undefined;
  }

  /**
   * Let content mounted with a `src` (package packs) be dropped from memory
   * under an LRU budget and read back from `source` on demand. Paged-out
   * files can't be read synchronously: callers await ensureResident() first.
   */
  enableEviction(source: VolumeContentSource, budgetBytes: number): void {
    this._contentSource = source;
    this._residentBudget = Math.max(0, budgetBytes);
    this._evictOverBudget();
  }

  get evictionEnabled(): boolean {
    return this._contentSource !== null;
  }

  /** Hold off eviction (e.g. during an install that reads packages synchronously). Returns the resume fn. */
  pauseEviction(): () => void {
    this._evictionPaused++;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this._evictionPaused--;
      this._evictOverBudget();
    };
  }

  /**
   * Turn files that were mounted from `buffer` (a pack's data) into
   * paged-out stubs backed by `pack`, so the buffer can be collected.
   * Files for which `keepResident` is true are copied out of it instead.
   * Anything written since the mount no longer points into `buffer` and is
   * left alone.
   */
  adoptPackContent(
    pack: number,
    manifest: ReadonlyArray<BinaryVolumeEntry>,
    buffer: ArrayBufferLike,
    keepResident: (path: string) => boolean,
  ): number {
    if (!this._contentSource) return 0;
    let adopted = 0;
    for (const entry of manifest) {
      if (entry.isDirectory || entry.symlinkTarget !== undefined) continue;
      let node: VolumeNode | undefined;
      try {
        node = this.locateRaw(this.normalize(entry.path));
      } catch {
        continue;
      }
      const inode = node?.kind === 'file' ? node.inode : undefined;
      if (!inode || inode.src || !inode.content || inode.content.buffer !== buffer) continue;
      if (keepResident(entry.path)) {
        inode.content = inode.content.slice();
        continue;
      }
      inode.src = { pack, offset: entry.offset, length: entry.length };
      this._indexSource(inode);
      this._evictInodeContent(inode, entry.length);
      adopted++;
    }
    return adopted;
  }

  /** How many paths link to the file at `p` (1 for anything that isn't a hardlinked file). */
  linkCount(p: string): number {
    try {
      const node = this._locateCanonical(this.normalize(p));
      if (node?.kind !== 'file' || !node.inode) return node ? 1 : 0;
      return this._inodePaths.get(node.inode)?.size ?? 1;
    } catch {
      return 0;
    }
  }

  /** Every path that is a hardlink to the file at `p` (including `p`), without following symlinks. */
  linksOf(p: string): string[] {
    let norm: string;
    let node: VolumeNode | undefined;
    try {
      norm = this.normalize(p);
      node = this._locateCanonical(norm);
    } catch {
      return [];
    }
    if (node?.kind !== 'file' || !node.inode) return node ? [norm] : [];
    return this._pathsForInode(node.inode);
  }

  /** Paged-out files at or below `root` (canonical paths, symlinks not followed). */
  pagedOutPaths(root: string): string[] {
    const out: string[] = [];
    if (!this._contentSource) return out;
    let start: VolumeNode | undefined;
    let norm: string;
    try {
      norm = this.normalize(root);
      start = this._locateCanonical(norm);
    } catch {
      return out;
    }
    const walk = (node: VolumeNode, path: string): void => {
      if (node.kind === 'file') {
        if (node.inode?.src && node.inode.content === undefined) out.push(path);
      } else if (node.kind === 'directory' && node.children) {
        for (const [name, child] of node.children) walk(child, path === '/' ? `/${name}` : `${path}/${name}`);
      }
    };
    if (start) walk(start, norm);
    return out;
  }

  /** true when reading `p` synchronously would need ensureResident() first. */
  isPagedOut(p: string): boolean {
    if (!this._contentSource) return false;
    try {
      const node = this.locate(this.normalize(p));
      return node?.kind === 'file' && !!node.inode?.src && node.inode.content === undefined;
    } catch {
      return false;
    }
  }

  /** Page the given files (and their pack neighbours) back into memory. */
  async ensureResident(paths: string | readonly string[]): Promise<void> {
    const source = this._contentSource;
    if (!source) return;
    const list = typeof paths === 'string' ? [paths] : paths;
    const pending: Promise<void>[] = [];
    const wanted = new Set<VolumeFileInode>();
    for (const p of list) {
      let node: VolumeNode | undefined;
      try {
        node = this.locate(this.normalize(p));
      } catch {
        continue;
      }
      const inode = node?.kind === 'file' ? node.inode : undefined;
      if (!inode?.src || inode.content !== undefined) continue;
      const inFlight = this._hydrating.get(inode);
      if (inFlight) pending.push(inFlight);
      else wanted.add(inode);
    }
    if (wanted.size > 0) {
      for (const inode of Array.from(wanted)) this._addReadAhead(inode, wanted);
      const run = this._pageIn(source, Array.from(wanted));
      for (const inode of wanted) this._hydrating.set(inode, run);
      pending.push(run);
    }
    await Promise.all(pending);
  }

  private async _pageIn(source: VolumeContentSource, inodes: VolumeFileInode[]): Promise<void> {
    try {
      // one read per run of neighbouring ranges
      const byPack = new Map<number, VolumeFileInode[]>();
      for (const inode of inodes) {
        const list = byPack.get(inode.src!.pack);
        if (list) list.push(inode);
        else byPack.set(inode.src!.pack, [inode]);
      }
      const reads: Promise<void>[] = [];
      for (const [pack, list] of byPack) {
        list.sort((a, b) => a.src!.offset - b.src!.offset);
        // ranges are captured up front: a write while the read is in
        // flight clears the inode's src
        let group: Array<{ inode: VolumeFileInode; offset: number; length: number }> = [];
        let start = 0;
        let end = 0;
        const flush = (): void => {
          if (group.length === 0) return;
          const members = group;
          const from = start;
          reads.push(source.read(pack, from, end - from).then((bytes) => {
            for (const { inode, offset, length } of members) {
              // own buffer per file, so evicting one really frees it
              this._pagedIn(inode, bytes.slice(offset - from, offset - from + length));
            }
          }));
          group = [];
        };
        for (const inode of list) {
          const { offset, length } = inode.src!;
          if (
            group.length > 0 &&
            (offset - end > MAX_MERGE_GAP || offset + length - start > MAX_MERGED_READ)
          ) {
            flush();
          }
          if (group.length === 0) {
            start = offset;
            end = offset;
          }
          group.push({ inode, offset, length });
          end = Math.max(end, offset + length);
        }
        flush();
      }
      await Promise.all(reads);
    } finally {
      for (const inode of inodes) this._hydrating.delete(inode);
    }
    // callers read synchronously in the microtasks right after their await
    // resolves; evicting on a later task means no page-in (this one or a
    // concurrent one) can take their bytes away first
    this._scheduleEviction();
  }

  private _evictionScheduled = false;

  private _scheduleEviction(): void {
    if (this._evictionScheduled) return;
    this._evictionScheduled = true;
    setTimeout(() => {
      this._evictionScheduled = false;
      this._evictOverBudget();
    }, 0);
  }

  private _pagedIn(inode: VolumeFileInode, bytes: Uint8Array): void {
    // written or deleted while the read was in flight: the read is stale
    if (!inode.src || inode.content !== undefined) return;
    const links = this._nodesForInode(inode);
    if (links.length === 0) return;
    inode.content = bytes;
    for (const { path, node } of links) {
      node.lazy = false;
      node.lazySize = undefined;
      if (this._handler) this._handler.invalidateStat(path);
    }
    this._trackSource(inode);
  }

  private _addReadAhead(inode: VolumeFileInode, into: Set<VolumeFileInode>): void {
    const src = inode.src!;
    const index = this._sortedPackIndex(src.pack);
    if (!index) return;
    let lo = 0;
    let hi = index.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (index[mid].src!.offset < src.offset) lo = mid + 1;
      else hi = mid;
    }
    const limit = src.offset + src.length + READ_AHEAD_BYTES;
    for (let i = lo; i < index.length; i++) {
      const next = index[i];
      const nextSrc = next.src;
      if (!nextSrc || nextSrc.pack !== src.pack) continue;
      if (nextSrc.offset >= limit) break;
      if (next.content === undefined && !this._hydrating.has(next) && this._inodePaths.has(next)) {
        into.add(next);
      }
    }
  }

  private _indexSource(inode: VolumeFileInode): void {
    const pack = inode.src!.pack;
    let list = this._packIndex.get(pack);
    if (!list) {
      list = [];
      this._packIndex.set(pack, list);
    }
    list.push(inode);
    this._packIndexDirty.add(pack);
  }

  private _sortedPackIndex(pack: number): VolumeFileInode[] | undefined {
    const list = this._packIndex.get(pack);
    if (list && this._packIndexDirty.delete(pack)) {
      // drop inodes that were written over or deleted since (and repeats)
      const live = [...new Set(list)].filter((inode) => inode.src?.pack === pack && this._inodePaths.has(inode));
      live.sort((a, b) => a.src!.offset - b.src!.offset);
      this._packIndex.set(pack, live);
      return live;
    }
    return list;
  }

  private _trackSource(inode: VolumeFileInode): void {
    if (!this._contentSource || !inode.src || inode.content === undefined) return;
    const previous = this._srcResident.get(inode);
    if (previous !== undefined) {
      this._srcResident.delete(inode);
      this._srcResidentBytes -= previous;
    }
    const size = inode.content.byteLength;
    this._srcResident.set(inode, size);
    this._srcResidentBytes += size;
  }

  private _touchSource(inode: VolumeFileInode): void {
    const size = this._srcResident.get(inode);
    if (size === undefined) return;
    this._srcResident.delete(inode);
    this._srcResident.set(inode, size);
  }

  // the bytes are the user's own now; nothing to page them back in from
  private _forgetSource(inode: VolumeFileInode): void {
    const size = this._srcResident.get(inode);
    if (size !== undefined) {
      this._srcResident.delete(inode);
      this._srcResidentBytes -= size;
    }
    if (inode.src) {
      this._packIndexDirty.add(inode.src.pack);
      this._schedulePackIndexCompaction();
    }
    inode.src = undefined;
    for (const { node } of this._nodesForInode(inode)) {
      node.lazy = false;
      node.lazySize = undefined;
    }
  }

  private _dropSource(inode: VolumeFileInode): void {
    const size = this._srcResident.get(inode);
    if (size !== undefined) {
      this._srcResident.delete(inode);
      this._srcResidentBytes -= size;
    }
    inode.content = undefined;
    this._packIndexDirty.add(inode.src!.pack);
    this._schedulePackIndexCompaction();
  }

  private _compactionScheduled = false;

  // drop deleted/rewritten inodes from the read-ahead index soon, so they
  // can be collected even if that pack is never read from again
  private _schedulePackIndexCompaction(): void {
    if (this._compactionScheduled) return;
    this._compactionScheduled = true;
    setTimeout(() => {
      this._compactionScheduled = false;
      for (const pack of Array.from(this._packIndexDirty)) this._sortedPackIndex(pack);
    }, 0);
  }

  private _evictOverBudget(): void {
    if (!this._contentSource || this._evictionPaused > 0) return;
    if (this._srcResidentBytes <= this._residentBudget) return;
    for (const [inode, size] of this._srcResident) {
      if (this._srcResidentBytes <= this._residentBudget) break;
      this._srcResident.delete(inode);
      this._srcResidentBytes -= size;
      this._evictInodeContent(inode, inode.src?.length ?? size);
      for (const { path } of this._nodesForInode(inode)) {
        if (this._handler) this._handler.invalidateStat(path);
      }
    }
  }

  // ---- Lean spawn mode: lazy hydration ----

  // Install a synchronous fallback for read misses under the given directory
  // names (lean spawn snapshots exclude e.g. node_modules). Pass null to
  // remove. Only read paths consult the handler; writes behave as always.
  setMissHandler(handler: VolumeMissHandler | null, lazyDirNames: string[] = []): void {
    this._missHandler = handler;
    this._lazyDirNames = handler ? lazyDirNames.slice() : [];
    this._lazyListed.clear();
    this._lazyNegative.clear();
    if (!handler) {
      this._lazyResident.clear();
      this._lazyResidentBytes = 0;
    }
  }

  private _untrackLazyResident(path: string): void {
    const size = this._lazyResident.get(path);
    if (size === undefined) return;
    this._lazyResident.delete(path);
    this._lazyResidentBytes -= size;
  }

  private _untrackLazyTree(prefix: string): void {
    for (const path of Array.from(this._lazyResident.keys())) {
      if (path === prefix || path.startsWith(prefix + '/')) {
        this._untrackLazyResident(path);
      }
    }
  }

  private _remapLazyTree(from: string, to: string): void {
    const moved: Array<[string, number]> = [];
    for (const [path, size] of this._lazyResident) {
      if (path === from || path.startsWith(from + '/')) {
        moved.push([to + path.slice(from.length), size]);
        this._lazyResident.delete(path);
      }
    }
    for (const [path, size] of moved) this._lazyResident.set(path, size);
  }

  // A local mutation at `norm`: the node there is new or gone, so a listing
  // merged for the old one no longer applies (a directory created here may
  // still have unhydrated children on the main thread). Its ancestors stay
  // listed: creating, removing or moving an entry locally doesn't hide any
  // remote child from them, and re-listing a large directory like
  // node_modules after every write made each package extraction pay a full
  // listing round trip for the next lookup.
  private _invalidateLazyListedFor(norm: string): void {
    this._lazyListed.delete(norm);
  }

  // The main thread changed `norm` and the local entry was dropped: the
  // parent chain must be listed again to rediscover it.
  private _invalidateLazyListedChain(norm: string): void {
    this._lazyListed.delete(norm);
    let parent = this.parentOf(norm);
    for (;;) {
      this._lazyListed.delete(parent);
      if (parent === '/') break;
      parent = this.parentOf(parent);
    }
  }

  // After a move the subtree is complete locally (a lazy source was hydrated
  // first, anything else was local to begin with): record its directories as
  // listed so lookups under the new location don't round-trip.
  private _markLazyTreeListed(norm: string, node: VolumeNode): void {
    if (node.kind !== 'directory') return;
    if (this._isUnderLazy(norm)) this._lazyListed.add(norm);
    if (!node.children) return;
    for (const [name, child] of node.children) {
      if (child.kind === 'directory') {
        this._markLazyTreeListed(norm === '/' ? '/' + name : norm + '/' + name, child);
      }
    }
  }

  /** Mark every directory entry that shares this inode as a lazy stub. */
  private _evictInodeContent(inode: VolumeFileInode, lazySize: number): void {
    inode.content = undefined;
    for (const path of this._pathsForInode(inode)) {
      const node = this.locateRaw(path);
      if (node?.kind === 'file' && (!node.inode || node.inode === inode)) {
        node.lazy = true;
        node.lazySize = lazySize;
      }
      this._untrackLazyResident(path);
    }
  }

  private _trackLazyResident(path: string, node: VolumeNode): void {
    const content = this._fileContent(node);
    if (!content || !this._isUnderLazy(path)) return;
    this._untrackLazyResident(path);
    const size = content.byteLength;
    this._lazyResident.set(path, size);
    this._lazyResidentBytes += size;

    while (
      this._lazyResidentBytes > this._lazyResidentMaxBytes &&
      this._lazyResident.size > 1
    ) {
      const oldest = this._lazyResident.keys().next().value as string | undefined;
      if (!oldest) break;
      const oldSize = this._lazyResident.get(oldest)!;
      this._lazyResident.delete(oldest);
      this._lazyResidentBytes -= oldSize;
      const oldNode = this.locateRaw(oldest);
      if (oldNode?.kind === 'file') {
        this._evictInodeContent(this._fileInodeAt(oldest, oldNode), oldSize);
      }
    }
  }

  private _touchLazyResident(path: string): void {
    const size = this._lazyResident.get(path);
    if (size === undefined) return;
    this._lazyResident.delete(path);
    this._lazyResident.set(path, size);
  }

  /**
   * The main thread mounted entries in these directories without per-file
   * notifications: forget their listings (and every cached miss) so the
   * next lookup lists them again and finds the new entries.
   */
  relistLazy(dirs: string[]): void {
    if (!this._missHandler) return;
    for (const dir of dirs) this._lazyListed.delete(this.normalize(dir));
    this._lazyNegative.clear();
  }

  // Main broadcast said this file changed but was too large to ship bytes.
  // Drop the local copy silently; the next read pulls fresh content through
  // the miss handler (works for any path, not just lazy dir names). No-op
  // without a miss handler — better a stale copy than a lost file.
  markLazyInvalidated(p: string): void {
    if (!this._missHandler) return;
    const norm = this.normalize(p);
    this._untrackLazyTree(norm);
    this._lazyNegative.delete(norm);
    this._lazyInvalidated.add(norm);
    this._invalidateLazyListedChain(norm);
    const parent = this.locate(this.parentOf(norm));
    if (parent?.kind === 'directory') {
      parent.children?.delete(this.nameOf(norm));
    }
    if (this._handler) this._handler.invalidateStat(norm);
  }

  private _isUnderLazy(norm: string): boolean {
    if (!this._missHandler) return false;
    if (this._lazyInvalidated.has(norm)) return true;
    if (this._lazyDirNames.length === 0) return false;
    let start = 1;
    const len = norm.length;
    while (start < len) {
      let end = norm.indexOf('/', start);
      if (end === -1) end = len;
      const seg = norm.substring(start, end);
      if (this._lazyDirNames.includes(seg)) return true;
      start = end + 1;
    }
    return false;
  }

  // Try to materialize a missing path from the miss handler. Returns true if
  // the path exists locally afterwards (possibly as a lazy stub). Never
  // notifies watchers (hydration is not a "change" — the file logically
  // existed all along).
  //
  // Misses are answered from directory listings: walk to the deepest local
  // ancestor. If the spawn snapshot shipped that directory whole (it is not
  // lazy) or its listing was already merged, the child is known to be
  // missing without asking the main thread. Otherwise one readdir round trip
  // lists it, creating stubs that answer every later probe in that directory.
  // Module resolution probes a handful of candidate paths per directory
  // level, so this turns one blocking round trip per probe into roughly one
  // per directory.
  private _hydrateMiss(norm: string, depth = 0): boolean {
    if (!this._missHandler || this._lazyNegative.has(norm) || !this._isUnderLazy(norm)) {
      return false;
    }
    // main said this exact path changed: fetch it directly
    if (this._lazyInvalidated.has(norm)) return this._hydrateMissDirect(norm);
    // a node_modules .wasm the main thread doesn't have (big binaries are
    // skipped at install) is fetched from the CDN when asked for by path
    // (see isRecoverableWasmPath): no listing would show it
    if (norm.endsWith('.wasm')) return this._hydrateMissDirect(norm);

    const segments = this.segments(norm);
    let node: VolumeNode = this.tree;
    let path = '';
    for (let i = 0; i < segments.length; i++) {
      if (node.kind !== 'directory') {
        // listings record symlinks as file stubs; one may be a linked dir
        return node.lazy ? this._hydrateMissDirect(norm) : false;
      }
      const name = segments[i];
      let child = node.children?.get(name);
      if (!child) {
        const dirPath = path || '/';
        if (!this._isUnderLazy(dirPath)) {
          // a lazy root (node_modules) that didn't exist when this process
          // started: nothing above it is listed, so ask for it by path
          if (!this._isUnderLazy(`${path}/${name}`) || !this._hydrateMissDirect(`${path}/${name}`)) return false;
        } else {
          if (this._lazyListed.has(dirPath)) return false;
          this._lazyList(dirPath, node);
        }
        child = node.children?.get(name);
        if (!child) return false;
      }
      if (child.kind === 'symlink') {
        // a linked package (workspaces, pnpm layouts): continue at the
        // link's target, where the rest of the path actually lives
        if (depth >= 16 || child.target === undefined) return false;
        const base = path || '/';
        const target = child.target.startsWith('/') ? child.target : `${base}/${child.target}`;
        const rest = segments.slice(i + 1).join('/');
        this._hydrateMiss(this.normalize(rest ? `${target}/${rest}` : target), depth + 1);
        // the target may be local (a workspace package) or just hydrated
        try {
          return this.locate(norm) !== undefined;
        } catch {
          return false; // a link loop
        }
      }
      node = child;
      path += '/' + name;
    }
    return true;
  }

  // Per-path fetch: stat, then content. Used for explicitly invalidated
  // paths and anything the listing walk can't answer.
  private _hydrateMissDirect(norm: string): boolean {
    const handler = this._missHandler;
    if (!handler) return false;
    let st: { isFile: boolean; isDirectory: boolean; size: number } | null = null;
    try {
      st = handler.stat(norm);
    } catch (e) {
      if (isTransientMiss(e)) return false;
      st = null;
    }
    if (!st) {
      this._lazyNegative.add(norm);
      return false;
    }
    this._journalMute++;
    try {
      if (st.isDirectory) {
        this.ensureDir(norm);
        return true;
      }
      let bytes: Uint8Array | null = null;
      try {
        bytes = handler.readFile(norm);
      } catch (e) {
        if (isTransientMiss(e)) return false;
        bytes = null;
      }
      if (bytes === null) {
        this._lazyNegative.add(norm);
        return false;
      }
      this.writeInternal(norm, bytes, false);
    } catch {
      // a local entry of another kind is in the way (ensureDir/writeInternal
      // throw): a miss, never an exception out of existsSync/statSync
      return false;
    } finally {
      this._journalMute--;
    }
    const hydrated = this.locateRaw(norm);
    if (hydrated?.kind === 'file') this._trackLazyResident(norm, hydrated);
    return true;
  }

  // Fetch content for a lazy stub created by _lazyList.
  private _hydrateStub(norm: string, node: VolumeNode): void {
    if (!this._missHandler) {
      const inode = node.inode;
      if (inode?.src && inode.content === undefined) {
        // paged out on the main thread: bytes only come back asynchronously
        this._pagedOutSyncMisses++;
        throw pagedOutError(norm);
      }
      node.lazy = false;
      return;
    }
    let bytes: Uint8Array | null = null;
    try { bytes = this._missHandler.readFile(norm); } catch { bytes = null; }
    if (bytes === null) {
      // keep lazy=true and content undefined so a later read can retry
      return;
    }
    node.lazy = false;
    this._fileInodeAt(norm, node).content = bytes;
    node.lazySize = undefined;
    node.modified = Date.now();
    this._fileInodeAt(norm, node).mtime = node.modified;
    if (this._handler) this._handler.invalidateStat(norm);
    this._trackLazyResident(norm, node);
  }

  // Fetch only the size for a lazy stub — stat must not pull full content
  // (readdir { withFileTypes } stats every entry; fetching content there
  // would turn one listing into N content round-trips).
  private _hydrateStubStat(norm: string, node: VolumeNode): void {
    if (!this._missHandler || node.lazySize !== undefined) return;
    let st: { isFile: boolean; isDirectory: boolean; size: number } | null = null;
    try {
      st = this._missHandler.stat(norm);
    } catch (e) {
      if (isTransientMiss(e)) return;
      st = null;
    }
    node.lazySize = st?.size ?? 0;
  }

  // Fully hydrate a subtree before structural changes (rename/link). A moved
  // lazy stub would otherwise try to fetch content under its NEW path, which
  // the main thread doesn't know about.
  // Returns false when part of the tree couldn't be fetched (it stays lazy
  // or unlisted).
  private _hydrateTree(norm: string, node: VolumeNode): boolean {
    if (!this._missHandler) return true;
    if (node.kind === 'file') {
      if (node.lazy) this._hydrateStub(norm, node);
      return !node.lazy;
    }
    if (node.kind !== 'directory') return true;
    this._lazyList(norm, node);
    let complete = !this._isUnderLazy(norm) || this._lazyListed.has(norm);
    if (!node.children) return complete;
    for (const [name, child] of node.children) {
      const childPath = norm === '/' ? `/${name}` : `${norm}/${name}`;
      if (!this._hydrateTree(childPath, child)) complete = false;
    }
    return complete;
  }

  // Populate a lazy directory's listing once: union of proxy entries and any
  // local children (local wins). Subdirs become unlisted lazy dirs; files
  // become content-less stubs hydrated on first read/stat.
  private _lazyList(norm: string, node: VolumeNode): void {
    if (!this._missHandler || this._lazyListed.has(norm) || !this._isUnderLazy(norm)) {
      return;
    }
    this._lazyListed.add(norm);
    let entries: ReturnType<VolumeMissHandler['readdir']> = null;
    try {
      entries = this._missHandler.readdir(norm);
    } catch (e) {
      // list again next time instead of keeping a partial listing forever
      if (isTransientMiss(e)) this._lazyListed.delete(norm);
      entries = null;
    }
    if (!entries) return;
    if (!node.children) node.children = new Map();
    let complete = true;
    for (const entry of entries) {
      if (node.children.has(entry.name)) continue;
      if (entry.isSymlink) {
        // a linked package (workspaces, pnpm layouts) or a .bin entry: keep
        // it a link so it resolves (and realpaths) to its target
        if (entry.target === undefined) {
          complete = false; // resolved per path on lookup instead
          continue;
        }
        node.children.set(entry.name, { kind: 'symlink', target: entry.target, modified: Date.now() });
        continue;
      }
      node.children.set(
        entry.name,
        entry.isDirectory
          ? { kind: 'directory', children: new Map(), modified: Date.now() }
          : { kind: 'file', lazy: true, lazySize: entry.size, modified: Date.now() },
      );
    }
    if (!complete) this._lazyListed.delete(norm);
  }

  // ---- Public synchronous API ----

  existsSync(p: string): boolean {
    const norm = this.normalize(p);
    let node = this.locate(norm);
    if (!node && this._missHandler && this._hydrateMiss(norm)) {
      node = this.locate(norm);
    }
    return node !== undefined;
  }

  statSync(p: string): FileStat {
    const norm = this.normalize(p);

    if (this._handler) {
      const cached = this._handler.statCache.get(norm);
      if (cached !== undefined) return cached;
    }

    let node = this.locate(norm);
    if (!node && this._missHandler && this._hydrateMiss(norm)) {
      node = this.locate(norm);
    }
    if (!node) throw makeSystemError('ENOENT', 'stat', p);
    if (node.lazy) this._hydrateStubStat(norm, node);

    const inode = node.kind === 'file' ? this._fileInodeAt(norm, node) : null;
    const fileSize = node.kind === 'file'
      ? (inode?.content?.length ?? inode?.packed?.length ?? node.lazySize ?? inode?.src?.length ?? 0)
      : 0;
    const ts = inode?.mtime ?? node.modified;
    const uid = inode?.uid ?? node.uid ?? MOCK_IDS.UID;
    const gid = inode?.gid ?? node.gid ?? MOCK_IDS.GID;

    const result: FileStat = {
      isFile: () => node.kind === 'file',
      isDirectory: () => node.kind === 'directory',
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      size: fileSize,
      mode: node.kind === 'directory' ? (node.mode ?? 0o755) : (inode?.mode ?? 0o644),
      mtime: new Date(ts),
      atime: new Date(inode?.atime ?? node.atime ?? ts),
      ctime: new Date(inode?.ctime ?? ts),
      birthtime: new Date(ts),
      mtimeMs: ts,
      atimeMs: inode?.atime ?? node.atime ?? ts,
      ctimeMs: inode?.ctime ?? ts,
      birthtimeMs: ts,
      nlink: inode?.nlink ?? 1,
      uid,
      gid,
      dev: 0,
      ino: inode?.ino ?? this._inoFor(norm),
      rdev: 0,
      blksize: MOCK_FS.BLOCK_SIZE,
      blocks: Math.ceil(fileSize / MOCK_FS.BLOCK_CALC_SIZE),
      atimeNs: BigInt(inode?.atime ?? node.atime ?? ts) * 1000000n,
      mtimeNs: BigInt(ts) * 1000000n,
      ctimeNs: BigInt(inode?.ctime ?? ts) * 1000000n,
      birthtimeNs: BigInt(ts) * 1000000n,
    };

    if (this._handler) this._handler.statCache.set(norm, result);
    return result;
  }

  lstatSync(p: string): FileStat {
    const norm = this.normalize(p);
    let node = this.locateRaw(norm);
    if (!node && this._missHandler && this._hydrateMiss(norm)) {
      node = this.locateRaw(norm);
    }
    if (!node) throw makeSystemError('ENOENT', 'lstat', p);

    if (node.kind === 'symlink') {
      const mtimeMs = node.modified;
      const atimeMs = node.atime ?? mtimeMs;
      const mode = 0o120000 | ((node.mode ?? 0o777) & 0o777);
      return {
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => true,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
        size: (node.target || '').length,
        mode,
        mtime: new Date(mtimeMs),
        atime: new Date(atimeMs),
        ctime: new Date(mtimeMs),
        birthtime: new Date(mtimeMs),
        mtimeMs,
        atimeMs,
        ctimeMs: mtimeMs,
        birthtimeMs: mtimeMs,
        nlink: 1,
        uid: node.uid ?? MOCK_IDS.UID,
        gid: node.gid ?? MOCK_IDS.GID,
        dev: 0,
        ino: this._inoFor(norm),
        rdev: 0,
        blksize: MOCK_FS.BLOCK_SIZE,
        blocks: 0,
        atimeNs: BigInt(atimeMs) * 1000000n,
        mtimeNs: BigInt(mtimeMs) * 1000000n,
        ctimeNs: BigInt(mtimeMs) * 1000000n,
        birthtimeNs: BigInt(mtimeMs) * 1000000n,
      };
    }
    return this.statSync(norm);
  }

  readFileSync(p: string): Uint8Array;
  readFileSync(p: string, encoding: 'utf8' | 'utf-8'): string;
  readFileSync(p: string, encoding?: 'utf8' | 'utf-8'): Uint8Array | string {
    const norm = this.normalize(p);
    let node = this.locate(norm);
    if (!node && this._missHandler && this._hydrateMiss(norm)) {
      node = this.locate(norm);
    }
    if (!node) throw makeSystemError('ENOENT', 'open', p);
    if (node.kind !== 'file') throw makeSystemError('EISDIR', 'read', p);
    const inode = this._fileInodeAt(norm, node);
    if (this._packState && !this._peeking) this._noteRead(inode);
    // hydrate when lazy OR content was evicted via a hardlink sibling's LRU path
    if (node.lazy || (inode.content == null && (this._missHandler || inode.src))) {
      this._hydrateStub(norm, node);
    }
    if (inode.content == null && node.lazy) {
      throw makeSystemError('ENOENT', 'open', p);
    }

    const bytes = inode.content || new Uint8Array(0);
    inode.atime = Date.now();
    this._touchLazyResident(norm);
    if (inode.src) this._touchSource(inode);
    if (encoding === 'utf8' || encoding === 'utf-8') {
      return this.decodeText(bytes);
    }
    return bytes;
  }

  openFileHandleSync(p: string): VolumeFileHandle {
    const norm = this.normalize(p);
    const node = this.locate(norm);
    if (!node) throw makeSystemError('ENOENT', 'open', p);
    if (node.kind !== 'file') throw makeSystemError('EISDIR', 'open', p);
    const inode = this._fileInodeAt(norm, node);
    if (this._packState) this._noteRead(inode);
    if (node.lazy || (inode.content == null && (this._missHandler || inode.src))) {
      this._hydrateStub(norm, node);
    }
    if (inode.content == null && node.lazy) {
      throw makeSystemError('ENOENT', 'open', p);
    }
    return {
      read: () => {
        // packed again by a round while the handle stayed open
        if (inode.packed) this._unpack(inode);
        return inode.content ?? new Uint8Array(0);
      },
      write: (data: Uint8Array) => {
        if (inode.src) this._forgetSource(inode);
        inode.packed = undefined;
        inode.content = data;
        inode.mtime = Date.now();
        inode.ctime = inode.mtime;
        for (const path of this._pathsForInode(inode)) {
          if (this._handler) this._handler.invalidateStat(path);
          this.triggerWatchers(path, 'change');
          this.notifyGlobalListeners(path, 'change');
        }
        if (this._journaling) {
          for (const { path } of this._nodesForInode(inode)) this._journal({ op: 'write', path });
        }
      },
      stat: () => ({
        size: inode.content?.length ?? inode.packed?.length ?? 0,
        mode: inode.mode,
        atimeMs: inode.atime,
        mtimeMs: inode.mtime,
        ctimeMs: inode.ctime,
        ino: inode.ino,
        nlink: inode.nlink,
      }),
    };
  }

  writeFileSync(p: string, data: string | Uint8Array | ArrayBuffer | ArrayBufferView | unknown): void {
    const norm = this.normalize(p);
    this.writeInternal(norm, data, true);
  }

  // runtime cache write — skips watcher and onGlobalChange notifications
  writeCacheSync(p: string, data: string | Uint8Array | ArrayBuffer | ArrayBufferView | unknown): void {
    const norm = this.normalize(p);
    this.writeInternal(norm, data, false);
  }

  mkdirSync(p: string, options?: { recursive?: boolean; mode?: number }): string | undefined {
    const norm = this.normalize(p);
    const mode = options?.mode !== undefined ? options.mode & 0o7777 : 0o777;

    if (options?.recursive) {
      const { created } = this.ensureDirTracked(norm);
      for (const path of created) {
        const node = this.locateRaw(path);
        if (node?.kind === 'directory') node.mode = mode;
      }
      this._announceCreatedDirs(created, true);
      return created.length > 0 ? created[0] : undefined;
    }

    const parentPath = this.parentOf(norm);
    const name = this.nameOf(norm);
    if (!name) return undefined;

    const parent = this.locate(parentPath);
    if (!parent) throw makeSystemError('ENOENT', 'mkdir', parentPath);
    if (parent.kind !== 'directory') throw makeSystemError('ENOTDIR', 'mkdir', parentPath);
    if (parent.children!.has(name)) throw makeSystemError('EEXIST', 'mkdir', p);

    parent.children!.set(name, {
      kind: 'directory',
      children: new Map(),
      modified: Date.now(),
      mode,
    });

    this._invalidateLazyListedFor(norm);
    if (this._handler) this._handler.invalidateStat(norm);
    if (this._journaling) this._journal({ op: 'mkdir', path: this._canonicalPath(norm) });
    this.triggerWatchers(norm, 'rename');
    this.notifyGlobalListeners(norm, 'addDir');
    return undefined;
  }

  readdirSync(p: string): string[] {
    const norm = this.normalize(p);
    let node = this.locate(norm);
    if (!node && this._missHandler && this._hydrateMiss(norm)) {
      node = this.locate(norm);
    }
    if (!node) throw makeSystemError('ENOENT', 'scandir', p);
    if (node.kind !== 'directory') throw makeSystemError('ENOTDIR', 'scandir', p);
    if (this._missHandler) this._lazyList(norm, node);
    return Array.from(node.children!.keys());
  }

  unlinkSync(p: string): void {
    const norm = this.normalize(p);
    const parentPath = this.parentOf(norm);
    const name = this.nameOf(norm);

    const parent = this.locate(parentPath);
    if (!parent || parent.kind !== 'directory') throw makeSystemError('ENOENT', 'unlink', p);

    const target = parent.children!.get(name);
    if (!target) throw makeSystemError('ENOENT', 'unlink', p);
    if (target.kind === 'directory') throw makeSystemError('EISDIR', 'unlink', p);

    this._untrackLazyResident(norm);
    this._invalidateLazyListedFor(norm);
    this._releaseNodeLinks(target, norm);
    parent.children!.delete(name);
    if (this._handler) this._handler.invalidateStat(norm);
    if (this._journaling) this._journal({ op: 'remove', path: this._canonicalPath(norm) });
    this.triggerWatchers(norm, 'rename');
    this.broadcast('delete', norm);
    this.notifyGlobalListeners(norm, 'unlink');
  }

  rmdirSync(p: string): void {
    const norm = this.normalize(p);
    const parentPath = this.parentOf(norm);
    const name = this.nameOf(norm);

    if (!name) throw new Error(`EPERM: operation not permitted, '${p}'`);

    const parent = this.locate(parentPath);
    if (!parent || parent.kind !== 'directory') throw makeSystemError('ENOENT', 'rmdir', p);

    const target = parent.children!.get(name);
    if (!target) throw makeSystemError('ENOENT', 'rmdir', p);
    if (target.kind !== 'directory') throw makeSystemError('ENOTDIR', 'rmdir', p);
    if (target.children!.size > 0) throw makeSystemError('ENOTEMPTY', 'rmdir', p);

    parent.children!.delete(name);
    if (this._handler) this._handler.invalidateStat(norm);
    if (this._journaling) this._journal({ op: 'remove', path: this._canonicalPath(norm) });

    // fire watchers so recursive `/`-watchers learn the directory is gone.
    // without this, a worker's fs.rmSync() silently drops rmdir events — main
    // thread's VFSBridge never sees the empty subdir and later renames into
    // that location fail with ENOTEMPTY
    this.triggerWatchers(norm, 'rename');
    this.broadcast('delete', norm);
    this.notifyGlobalListeners(norm, 'unlink');
  }

  removeTreeSync(p: string): void {
    const norm = this.normalize(p);
    const parentPath = this.parentOf(norm);
    const name = this.nameOf(norm);
    if (!name) throw new Error(`EPERM: operation not permitted, '${p}'`);

    const parent = this.locate(parentPath);
    if (!parent || parent.kind !== 'directory') throw makeSystemError('ENOENT', 'rm', p);
    let target = parent.children!.get(name);
    if (!target && this._missHandler && this._hydrateMiss(norm)) {
      target = parent.children!.get(name);
    }
    if (!target) throw makeSystemError('ENOENT', 'rm', p);
    if (target.kind !== 'directory') {
      this.unlinkSync(norm);
      return;
    }

    if (this._missHandler) this._hydrateTree(norm, target);
    const removed: string[] = [];
    const collect = (node: VolumeNode, base: string): void => {
      if (node.kind === 'directory' && node.children) {
        for (const [childName, child] of node.children) {
          collect(child, `${base}/${childName}`);
        }
      }
      removed.push(base);
    };
    collect(target, norm);

    this._releaseNodeLinks(target, norm);
    parent.children!.delete(name);
    this._untrackLazyTree(norm);
    this._invalidateLazyListedFor(norm);
    if (this._journaling) this._journal({ op: 'remove', path: this._canonicalPath(norm) });
    for (const removedPath of removed) {
      this._lazyListed.delete(removedPath);
      this._lazyNegative.add(removedPath);
      if (this._handler) this._handler.invalidateStat(removedPath);
      this.triggerWatchers(removedPath, 'rename');
      this.broadcast('delete', removedPath);
      this.notifyGlobalListeners(removedPath, 'unlink');
    }
  }

  renameSync(from: string, to: string): void {
    const normFrom = this.normalize(from);
    const normTo = this.normalize(to);

    const fromParent = this.locate(this.parentOf(normFrom));
    if (!fromParent || fromParent.kind !== 'directory') throw makeSystemError('ENOENT', 'rename', from);

    const fromName = this.nameOf(normFrom);
    let node = fromParent.children!.get(fromName);
    if (!node && this._missHandler && this._hydrateMiss(normFrom)) {
      node = fromParent.children!.get(fromName);
    }
    if (!node) throw makeSystemError('ENOENT', 'rename', from);
    if (node.kind === 'directory' && normTo.startsWith(normFrom === '/' ? '/' : normFrom + '/')) {
      // moving a directory into itself would make the tree a cycle
      const err = new Error(`EINVAL: invalid argument, rename '${from}' -> '${to}'`) as SystemError;
      err.code = 'EINVAL';
      err.errno = -22;
      err.syscall = 'rename';
      err.path = from;
      throw err;
    }

    // a moved lazy subtree would hydrate under the wrong (new) path — pull
    // everything local before the move
    const hydrated = this._missHandler ? this._hydrateTree(normFrom, node) : true;

    const toParent = this.ensureDir(this.parentOf(normTo));
    const toName = this.nameOf(normTo);

    // collect all descendant paths BEFORE the move so we can fire events for
    // each child after. needed for directory renames (e.g. Vite's atomic move
    // of `/.vite/deps_temp_XXX` → `/.vite/deps`) — otherwise watchers and
    // cross-thread VFS sync never see that files moved
    const descendantPairs: Array<{ oldPath: string; newPath: string; isDir: boolean }> = [];
    if (node.kind === 'directory') {
      const walk = (n: VolumeNode, oldBase: string, newBase: string) => {
        if (n.kind !== 'directory' || !n.children) return;
        for (const [childName, childNode] of n.children) {
          const childOld = oldBase === '/' ? '/' + childName : oldBase + '/' + childName;
          const childNew = newBase === '/' ? '/' + childName : newBase + '/' + childName;
          descendantPairs.push({
            oldPath: childOld,
            newPath: childNew,
            isDir: childNode.kind === 'directory',
          });
          if (childNode.kind === 'directory') walk(childNode, childOld, childNew);
        }
      };
      walk(node, normFrom, normTo);
    }

    // if the target already exists, remove it first — matches POSIX rename
    // semantics that Vite relies on for the deps_temp → deps commit.
    // Intentionally no ENOTEMPTY for non-empty dest dirs (Vite clobber).
    const replaced = toParent.children!.get(toName);
    if (node.kind === 'file' && replaced?.kind === 'file' &&
        this._fileInodeAt(normFrom, node) === this._fileInodeAt(normTo, replaced)) {
      return;
    }
    if (replaced) {
      this._untrackLazyTree(normTo);
      this._releaseNodeLinks(replaced, normTo);
      toParent.children!.delete(toName);
    }
    // resolve before the move: afterwards the source path is gone
    const canonicalFrom = this._journaling ? this._canonicalPath(normFrom) : undefined;
    fromParent.children!.delete(fromName);
    toParent.children!.set(toName, node);
    this._remapNodeInodePaths(node, normFrom, normTo);
    this._remapLazyTree(normFrom, normTo);
    this._invalidateLazyListedFor(normFrom);
    this._invalidateLazyListedFor(normTo);
    // a complete local copy: lookups under the new location needn't list
    if (this._missHandler && hydrated) this._markLazyTreeListed(normTo, node);

    if (this._handler) {
      this._handler.invalidateStat(normFrom);
      this._handler.invalidateStat(normTo);
      for (const pair of descendantPairs) {
        this._handler.invalidateStat(pair.oldPath);
        this._handler.invalidateStat(pair.newPath);
      }
    }

    if (this._journaling) {
      this._journal({ op: 'rename', from: canonicalFrom ?? normFrom, to: this._canonicalPath(normTo) });
    }

    // fire watcher + global-listener events for the top-level move
    this.triggerWatchers(normFrom, 'rename');
    this.triggerWatchers(normTo, 'rename');
    this.notifyGlobalListeners(normFrom, 'unlink');
    this.notifyGlobalListeners(normTo, node.kind === 'directory' ? 'addDir' : 'add');

    // fire events for every descendant so recursive watchers (the worker→main
    // vfs-sync handler, HMR watchers, etc.) see every moved path. without this,
    // Vite's atomic commit `deps_temp_XXX` → `deps` is invisible to the main
    // thread's VFS and all bundled dep files stay at the old path
    for (const pair of descendantPairs) {
      this.triggerWatchers(pair.oldPath, 'rename');
      this.triggerWatchers(pair.newPath, 'rename');
      this.notifyGlobalListeners(pair.oldPath, 'unlink');
      this.notifyGlobalListeners(pair.newPath, pair.isDir ? 'addDir' : 'add');
    }
  }

  accessSync(p: string, mode: number = 0): void {
    if (!this.existsSync(p)) throw makeSystemError('ENOENT', 'access', p);
    if (!mode) return; // F_OK
    const st = this.statSync(p);
    const m = st.mode & 0o777;
    // owner triad is enough for this single-user VFS
    if ((mode & 4) !== 0 && (m & 0o400) === 0) throw makeSystemError('EACCES', 'access', p);
    if ((mode & 2) !== 0 && (m & 0o200) === 0) throw makeSystemError('EACCES', 'access', p);
    if ((mode & 1) !== 0 && (m & 0o100) === 0) throw makeSystemError('EACCES', 'access', p);
  }

  copyFileSync(src: string, dest: string, mode: number = 0): void {
    if ((mode & 1) !== 0 && this.existsSync(dest)) {
      // COPYFILE_EXCL = 1
      throw makeSystemError('EEXIST', 'copyfile', dest);
    }
    const data = this.readFileSync(src);
    this.writeFileSync(dest, data);
  }

  realpathSync(p: string): string {
    const norm = this.normalize(p);
    const resolve = (path: string, seen: Set<string>): string => {
      const segments = this.segments(path);
      let current = this.tree;
      let currentPath = '';
      for (let index = 0; index < segments.length; index++) {
        if (current.kind !== 'directory' || !current.children) throw makeSystemError('ENOTDIR', 'realpath', p);
        const segment = segments[index];
        const child = current.children.get(segment);
        if (!child) throw makeSystemError('ENOENT', 'realpath', p);
        currentPath += '/' + segment;
        if (child.kind !== 'symlink') {
          current = child;
          continue;
        }
        if (seen.has(currentPath) || seen.size >= 40) throw makeSystemError('ELOOP', 'realpath', p);
        seen.add(currentPath);
        const target = child.target!;
        const targetPath = target.startsWith('/')
          ? this.normalize(target)
          : this.normalize(this.parentOf(currentPath) + '/' + target);
        const remainder = segments.slice(index + 1).join('/');
        return resolve(remainder ? this.normalize(targetPath + '/' + remainder) : targetPath, seen);
      }
      return currentPath || '/';
    };
    return resolve(norm, new Set());
  }

  symlinkSync(target: string, linkPath: string, type?: string): void {
    const normLink = this.normalize(linkPath);
    const parentPath = this.parentOf(normLink);
    const name = this.nameOf(normLink);

    if (!name) throw new Error(`EISDIR: invalid symlink path, '${linkPath}'`);
    const parent = this.ensureDir(parentPath);

    if (parent.children!.has(name)) throw makeSystemError('EEXIST', 'symlink', linkPath);
    const now = Date.now();
    parent.children!.set(name, {
      kind: 'symlink',
      target,
      modified: now,
      atime: now,
      mode: 0o777,
      uid: MOCK_IDS.UID,
      gid: MOCK_IDS.GID,
      symlinkType: type,
    });

    if (this._handler) this._handler.invalidateStat(normLink);
    if (this._journaling) this._journal({ op: 'symlink', path: normLink });
    this.triggerWatchers(normLink, 'rename');
    this.notifyGlobalListeners(normLink, 'add');
  }

  readlinkSync(p: string): string {
    const norm = this.normalize(p);
    const node = this.locateRaw(norm);
    if (!node) throw makeSystemError('ENOENT', 'readlink', p);
    if (node.kind !== 'symlink') {
      const err = new Error(`EINVAL: invalid argument, readlink '${p}'`) as SystemError;
      err.code = 'EINVAL';
      err.errno = -22;
      err.syscall = 'readlink';
      err.path = p;
      throw err;
    }
    return node.target!;
  }

  linkSync(existingPath: string, newPath: string): void {
    const normExisting = this.normalize(existingPath);
    const existing = this.locate(normExisting);
    if (!existing) throw makeSystemError('ENOENT', 'link', existingPath);
    if (existing.kind !== 'file') throw makeSystemError('EISDIR', 'link', existingPath);
    // sharing a content-less stub would alias undefined content. a paged-out
    // inode keeps its source, so its aliases can page it back in
    const pagedOut = !!existing.inode?.src && existing.inode.content === undefined;
    if (existing.lazy && !pagedOut) this._hydrateStub(normExisting, existing);

    const normNew = this.normalize(newPath);
    const parentPath = this.parentOf(normNew);
    const name = this.nameOf(normNew);
    const parent = this.ensureDir(parentPath);

    if (parent.children!.has(name)) throw makeSystemError('EEXIST', 'link', newPath);
    const inode = this._fileInodeAt(normExisting, existing);
    inode.nlink++;
    inode.ctime = Date.now();
    parent.children!.set(
      name,
      pagedOut
        ? { kind: 'file', modified: inode.mtime, inode, lazy: true, lazySize: inode.src!.length }
        : { kind: 'file', modified: inode.mtime, inode },
    );
    this._linkInodePath(normNew, inode);

    if (this._handler) this._handler.invalidateStat(normNew);
    if (this._journaling) this._journal({ op: 'link', path: normNew, existing: normExisting });
    this.triggerWatchers(normNew, 'rename');
    this.notifyGlobalListeners(normNew, 'add');
  }

  // mkdir/unlink/rmdir/rm/rename resolve the parent directory through
  // symlinks; journal paths must name where the change actually happened
  private _canonicalPath(norm: string): string {
    const parent = this.parentOf(norm);
    if (parent === '/') return norm;
    try {
      const real = this.realpathSync(parent);
      if (real === parent) return norm;
      return (real === '/' ? '' : real) + '/' + this.nameOf(norm);
    } catch {
      return norm;
    }
  }

  // chmod/chown/utimes follow symlinks: report the node they actually changed
  private _journalMetaFollowed(norm: string, changed: MetaChange): void {
    if (!this._journaling && this._metaListeners.size === 0) return;
    let path = norm;
    try {
      path = this.realpathSync(norm);
    } catch {
      // dangling link: nothing changed that could be saved
    }
    this._reportMeta(path, changed);
  }

  // lchmod/lchown/lutimes change the node itself
  private _journalMetaAt(norm: string, changed: MetaChange): void {
    if (!this._journaling && this._metaListeners.size === 0) return;
    this._reportMeta(this._canonicalPath(norm), changed);
  }

  private _reportMeta(path: string, changed: MetaChange): void {
    if (this._journaling) this._journal({ op: 'meta', path, ...changed });
    for (const cb of this._metaListeners) {
      try { cb(path, changed); } catch (e) { console.error('Volume meta listener error:', e); }
    }
  }

  chmodSync(_p: string, _mode: number): void {
    const norm = this.normalize(_p);
    const node = this.locate(norm);
    if (!node) throw makeSystemError('ENOENT', 'chmod', _p);
    const mode = _mode & 0o7777;
    if (node.kind === 'file') {
      const inode = this._fileInodeAt(norm, node);
      inode.mode = mode;
      inode.ctime = Date.now();
    } else if (node.kind === 'directory') {
      node.mode = mode;
      node.modified = Date.now();
    }
    if (this._handler) this._handler.invalidateStat(norm);
    this._journalMetaFollowed(norm, { mode });
  }

  lchmodSync(p: string, mode: number): void {
    const norm = this.normalize(p);
    const node = this.locateRaw(norm);
    if (!node) throw makeSystemError('ENOENT', 'lchmod', p);
    const bits = mode & 0o7777;
    if (node.kind === 'file') {
      const inode = this._fileInodeAt(norm, node);
      inode.mode = bits;
      inode.ctime = Date.now();
    } else {
      node.mode = bits;
      node.modified = Date.now();
    }
    if (this._handler) this._handler.invalidateStat(norm);
    this._journalMetaAt(norm, { mode: bits });
  }

  chownSync(p: string, uid: number, gid: number): void {
    const norm = this.normalize(p);
    const node = this.locate(norm);
    if (!node) throw makeSystemError('ENOENT', 'chown', p);
    if (node.kind === 'file') {
      const inode = this._fileInodeAt(norm, node);
      inode.uid = uid;
      inode.gid = gid;
      inode.ctime = Date.now();
    } else {
      node.uid = uid;
      node.gid = gid;
      node.modified = Date.now();
    }
    if (this._handler) this._handler.invalidateStat(norm);
    this._journalMetaFollowed(norm, { uid, gid });
  }

  lchownSync(p: string, uid: number, gid: number): void {
    const norm = this.normalize(p);
    const node = this.locateRaw(norm);
    if (!node) throw makeSystemError('ENOENT', 'lchown', p);
    if (node.kind === 'file') {
      const inode = this._fileInodeAt(norm, node);
      inode.uid = uid;
      inode.gid = gid;
      inode.ctime = Date.now();
    } else {
      node.uid = uid;
      node.gid = gid;
      node.modified = Date.now();
    }
    if (this._handler) this._handler.invalidateStat(norm);
    this._journalMetaAt(norm, { uid, gid });
  }

  private _parseTimes(
    p: string,
    syscall: string,
    atime: number | Date,
    mtime: number | Date,
  ): { atimeMs: number; mtimeMs: number } {
    const atimeMs = atime instanceof Date ? atime.getTime() : Number(atime) * 1000;
    const mtimeMs = mtime instanceof Date ? mtime.getTime() : Number(mtime) * 1000;
    if (!Number.isFinite(atimeMs) || !Number.isFinite(mtimeMs)) {
      const error = new Error(`EINVAL: invalid time, ${syscall} '${p}'`) as SystemError;
      error.code = 'EINVAL';
      error.errno = -22;
      error.syscall = syscall;
      error.path = p;
      throw error;
    }
    return { atimeMs, mtimeMs };
  }

  utimesSync(p: string, atime: number | Date, mtime: number | Date): void {
    const norm = this.normalize(p);
    const node = this.locate(norm);
    if (!node) throw makeSystemError('ENOENT', 'utimes', p);
    const { atimeMs, mtimeMs } = this._parseTimes(p, 'utimes', atime, mtime);
    if (node.kind === 'file') {
      const inode = this._fileInodeAt(norm, node);
      inode.atime = atimeMs;
      inode.mtime = mtimeMs;
      inode.ctime = Date.now();
    } else {
      node.atime = atimeMs;
    }
    node.modified = mtimeMs;
    if (this._handler) this._handler.invalidateStat(norm);
    this._journalMetaFollowed(norm, { atimeMs, mtimeMs });
  }

  lutimesSync(p: string, atime: number | Date, mtime: number | Date): void {
    const norm = this.normalize(p);
    const node = this.locateRaw(norm);
    if (!node) throw makeSystemError('ENOENT', 'lutimes', p);
    const { atimeMs, mtimeMs } = this._parseTimes(p, 'lutimes', atime, mtime);
    if (node.kind === 'file') {
      const inode = this._fileInodeAt(norm, node);
      inode.atime = atimeMs;
      inode.mtime = mtimeMs;
      inode.ctime = Date.now();
    } else {
      node.atime = atimeMs;
    }
    node.modified = mtimeMs;
    if (this._handler) this._handler.invalidateStat(norm);
    this._journalMetaAt(norm, { atimeMs, mtimeMs });
  }

  appendFileSync(p: string, data: string | Uint8Array | unknown): void {
    const norm = this.normalize(p);
    let existing: Uint8Array = new Uint8Array(0);
    const node = this.locate(norm);
    if (node && node.kind === 'file') {
      if (node.lazy) this._hydrateStub(norm, node);
      const inode = this._fileInodeAt(norm, node);
      if (inode.packed) this._unpack(inode);
      existing = inode.content || new Uint8Array(0);
    }
    const bytes = this.toBytes(data);
    const combined = new Uint8Array(existing.length + bytes.length);
    combined.set(existing);
    combined.set(bytes, existing.length);
    this.writeInternal(norm, combined, true);
  }

  truncateSync(p: string, len: number = 0): void {
    const norm = this.normalize(p);
    const node = this.locate(norm);
    if (!node) throw makeSystemError('ENOENT', 'truncate', p);
    if (node.kind !== 'file') throw makeSystemError('EISDIR', 'truncate', p);
    if (node.lazy) this._hydrateStub(norm, node);
    const inode = this._fileInodeAt(norm, node);
    if (inode.src) this._forgetSource(inode);
    if (inode.packed) this._unpack(inode);
    const content = inode.content || new Uint8Array(0);
    if (len < content.length) {
      inode.content = content.slice(0, len);
    } else if (len > content.length) {
      const bigger = new Uint8Array(len);
      bigger.set(content);
      inode.content = bigger;
    }
    node.modified = Date.now();
    inode.mtime = node.modified;
    inode.ctime = node.modified;

    if (this._handler) this._handler.invalidateStat(norm);
    if (this._journaling) {
      for (const { path } of this._nodesForInode(inode)) this._journal({ op: 'write', path });
    }
    this.triggerWatchers(norm, 'change');
    this.notifyGlobalListeners(norm, 'change');
  }

  // ---- Async wrappers ----

  readFile(
    p: string,
    optionsOrCb?: { encoding?: string } | ((err: Error | null, data?: Uint8Array | string) => void),
    cb?: (err: Error | null, data?: Uint8Array | string) => void
  ): void {
    const actualCb = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
    const opts = typeof optionsOrCb === 'object' ? optionsOrCb : undefined;
    try {
      const data = opts?.encoding
        ? this.readFileSync(p, opts.encoding as 'utf8')
        : this.readFileSync(p);
      if (actualCb) setTimeout(() => actualCb(null, data), 0);
    } catch (err) {
      if (actualCb) setTimeout(() => actualCb(err as Error), 0);
    }
  }

  stat(p: string, cb?: (err: Error | null, stats?: FileStat) => void): void {
    try {
      const stats = this.statSync(p);
      if (cb) setTimeout(() => cb(null, stats), 0);
    } catch (err) {
      if (cb) setTimeout(() => cb(err as Error), 0);
    }
  }

  lstat(p: string, cb?: (err: Error | null, stats?: FileStat) => void): void {
    try {
      const stats = this.lstatSync(p);
      if (cb) setTimeout(() => cb(null, stats), 0);
    } catch (err) {
      if (cb) setTimeout(() => cb(err as Error), 0);
    }
  }

  readdir(
    p: string,
    optionsOrCb?: { withFileTypes?: boolean } | ((err: Error | null, files?: string[]) => void),
    cb?: (err: Error | null, files?: string[]) => void
  ): void {
    const actualCb = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
    try {
      const files = this.readdirSync(p);
      if (actualCb) setTimeout(() => actualCb(null, files), 0);
    } catch (err) {
      if (actualCb) setTimeout(() => actualCb(err as Error), 0);
    }
  }

  realpath(p: string, cb?: (err: Error | null, resolved?: string) => void): void {
    try {
      const resolved = this.realpathSync(p);
      if (cb) setTimeout(() => cb(null, resolved), 0);
    } catch (err) {
      if (cb) setTimeout(() => cb(err as Error), 0);
    }
  }

  access(p: string, modeOrCb?: number | ((err: Error | null) => void), cb?: (err: Error | null) => void): void {
    const actualCb = typeof modeOrCb === 'function' ? modeOrCb : cb;
    const mode = typeof modeOrCb === 'number' ? modeOrCb : 0;
    try {
      this.accessSync(p, mode);
      if (actualCb) setTimeout(() => actualCb(null), 0);
    } catch (err) {
      if (actualCb) setTimeout(() => actualCb(err as Error), 0);
    }
  }

  // ---- File watchers ----

  watch(
    target: string,
    optionsOrCb?: { persistent?: boolean; recursive?: boolean; encoding?: string } | WatchCallback,
    cb?: WatchCallback
  ): FileWatchHandle {
    const norm = this.normalize(target);

    let opts: { persistent?: boolean; recursive?: boolean } = {};
    let actualCb: WatchCallback | undefined;

    if (typeof optionsOrCb === 'function') {
      actualCb = optionsOrCb;
    } else if (optionsOrCb) {
      opts = optionsOrCb;
      actualCb = cb;
    } else {
      actualCb = cb;
    }

    const handle = new FSWatcher(() => {
      watcher.active = false;
      const set = this.activeWatchers.get(norm);
      if (set) {
        set.delete(watcher);
        if (set.size === 0) this.activeWatchers.delete(norm);
      }
    });

    const watcher: ActiveWatcher = {
      callback: (event, filename) => {
        if (actualCb) actualCb(event, filename);
        handle.emit('change', event, filename);
      },
      recursive: opts.recursive || false,
      active: true,
    };

    if (!this.activeWatchers.has(norm)) {
      this.activeWatchers.set(norm, new Set());
    }
    this.activeWatchers.get(norm)!.add(watcher);

    return handle;
  }

  private triggerWatchers(changedPath: string, event: WatchEventKind): void {
    // changedPath is already normalized by the caller — no need to re-normalize
    const norm = changedPath;
    const lastSlash = norm.lastIndexOf('/');
    const fileName = norm.slice(lastSlash + 1);
    const directParent = lastSlash <= 0 ? '/' : norm.slice(0, lastSlash);

    const direct = this.activeWatchers.get(norm);
    if (direct) {
      for (const w of direct) {
        if (w.active) {
          try { w.callback(event, fileName); } catch (e) { console.error('Watcher error:', e); }
        }
      }
    }

    // walk up the tree to notify parent/recursive watchers
    let current = directParent;
    let relative = fileName;

    while (current) {
      const parentWatchers = this.activeWatchers.get(current);
      if (parentWatchers) {
        for (const w of parentWatchers) {
          if (w.active) {
            if (w.recursive || current === directParent) {
              try { w.callback(event, relative); } catch (e) { console.error('Watcher error:', e); }
            }
          }
        }
      }

      if (current === '/') break;
      const idx = current.lastIndexOf('/');
      const currentName = current.slice(idx + 1);
      relative = currentName + '/' + relative;
      current = idx <= 0 ? '/' : current.slice(0, idx);
    }

  }

  // ---- Global change listeners (for chokidar/HMR bridging) ----
  private globalChangeListeners = new Set<(path: string, event: string) => void>();

  onGlobalChange(cb: (path: string, event: string) => void): () => void {
    this.globalChangeListeners.add(cb);
    return () => { this.globalChangeListeners.delete(cb); };
  }

  private notifyGlobalListeners(path: string, event: string): void {
    for (const cb of this.globalChangeListeners) {
      try { cb(path, event); } catch (e) { console.error('Global VFS listener error:', e); }
    }
  }

  // ---- Stream-like APIs ----

  createReadStream(p: string): {
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    pipe: (dest: unknown) => unknown;
  } {
    const self = this;
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

    const readable = {
      on(event: string, cb: (...args: unknown[]) => void) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(cb);
        return readable;
      },
      pipe(dest: unknown) { return dest; },
    };

    setTimeout(() => {
      try {
        const data = self.readFileSync(p);
        handlers['data']?.forEach(cb => cb(data));
        handlers['end']?.forEach(cb => cb());
      } catch (err) {
        handlers['error']?.forEach(cb => cb(err));
      }
    }, 0);

    return readable;
  }

  createWriteStream(p: string): {
    write: (data: string | Uint8Array) => boolean;
    end: (data?: string | Uint8Array) => void;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
  } {
    const self = this;
    const pending: Uint8Array[] = [];
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const enc = this.textEncoder;

    return {
      write(data: string | Uint8Array): boolean {
        pending.push(typeof data === 'string' ? enc.encode(data) : data);
        return true;
      },
      end(data?: string | Uint8Array): void {
        if (data) pending.push(typeof data === 'string' ? enc.encode(data) : data);
        const totalLen = pending.reduce((sum, chunk) => sum + chunk.length, 0);
        const merged = new Uint8Array(totalLen);
        let pos = 0;
        for (const chunk of pending) {
          merged.set(chunk, pos);
          pos += chunk.length;
        }
        self.writeFileSync(p, merged);
        handlers['finish']?.forEach(cb => cb());
        handlers['close']?.forEach(cb => cb());
      },
      on(event: string, cb: (...args: unknown[]) => void) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(cb);
        return this;
      },
    };
  }
}
