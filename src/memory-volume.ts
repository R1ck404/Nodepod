// in-memory VFS with POSIX-like semantics

import type { VolumeSnapshot, VolumeEntry } from './engine-types';
import { bytesToBase64, base64ToBytes } from './helpers/byte-encoding';
import { MOCK_IDS, MOCK_FS } from './constants/config';
import type { MemoryHandler } from './memory-handler';

export interface VolumeNode {
  kind: 'file' | 'directory' | 'symlink';
  content?: Uint8Array;
  children?: Map<string, VolumeNode>;
  target?: string;
  modified: number;
  // lean spawn mode: file known to exist (from a lazy readdir listing) but
  // content not yet fetched from the main thread
  lazy?: boolean;
  // size reported by the main thread for a lazy stub (stat without content)
  lazySize?: number;
}

// lean spawn mode: synchronous fallback consulted on read misses for paths
// under lazy directory names (e.g. node_modules excluded from the spawn
// snapshot). Implementations block on a SAB round-trip to the main thread.
export interface VolumeMissHandler {
  readFile(path: string): Uint8Array | null;
  readdir(path: string): Array<{ name: string; isDirectory: boolean }> | null;
  stat(path: string): { isFile: boolean; isDirectory: boolean; size: number } | null;
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
  code: 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EEXIST' | 'ENOTEMPTY',
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
  };

  const descriptions: Record<string, string> = {
    ENOENT: 'no such file or directory',
    ENOTDIR: 'not a directory',
    EISDIR: 'is a directory',
    EEXIST: 'file already exists',
    ENOTEMPTY: 'directory not empty',
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

  constructor(handler?: MemoryHandler | null, lazyResidentMaxBytes = 64 * 1024 * 1024) {
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

  getStats(): { fileCount: number; totalBytes: number; dirCount: number; watcherCount: number; lazyResidentBytes: number } {
    let fileCount = 0;
    let totalBytes = 0;
    let dirCount = 0;
    const walk = (node: VolumeNode) => {
      if (node.kind === 'file') {
        fileCount++;
        totalBytes += node.content?.byteLength ?? 0;
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
    return { fileCount, totalBytes, dirCount, watcherCount, lazyResidentBytes: this._lazyResidentBytes };
  }

  /** Clean up all owned data and listeners. A disposed volume is empty. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.activeWatchers.clear();
    this.subscribers.clear();
    this.globalChangeListeners.clear();
    this._missHandler = null;
    this._lazyDirNames = [];
    this._lazyListed.clear();
    this._lazyNegative.clear();
    this._lazyInvalidated.clear();
    this._lazyResident.clear();
    this._lazyResidentBytes = 0;
    this._inos.clear();
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
      let data = '';
      if (node.content && node.content.length > 0) {
        data = bytesToBase64(node.content);
      }
      result.push({ path: currentPath, kind: 'file', data });
    } else if (node.kind === 'symlink') {
      result.push({ path: currentPath, kind: 'file', data: `symlink:${node.target}` });
    } else if (node.kind === 'directory') {
      result.push({ path: currentPath, kind: 'directory' });
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
  static fromBinarySnapshot(snapshot: { manifest: Array<{ path: string; offset: number; length: number; isDirectory: boolean }>; data: ArrayBuffer }): MemoryVolume {
    const vol = new MemoryVolume();
    const fullData = new Uint8Array(snapshot.data);

    // directories first, then by depth
    const sorted = [...snapshot.manifest].sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.path.split("/").length - b.path.split("/").length;
    });

    for (const entry of sorted) {
      if (entry.path === "/") continue;
      if (entry.isDirectory) {
        if (!vol.existsSync(entry.path)) vol.mkdirSync(entry.path, { recursive: true });
      } else {
        const parentDir = entry.path.substring(0, entry.path.lastIndexOf("/")) || "/";
        if (parentDir !== "/" && !vol.existsSync(parentDir)) {
          vol.mkdirSync(parentDir, { recursive: true });
        }
        // the transferred snapshot has a single owner in this worker; keeping
        // views avoids a second full filesystem copy; later writes replace the
        // node content and are naturally copy-on-write.
        const content = fullData.subarray(entry.offset, entry.offset + entry.length);
        vol.writeInternal(vol.normalize(entry.path), content, false);
      }
    }

    return vol;
  }

  static fromSnapshot(snapshot: VolumeSnapshot): MemoryVolume {
    const vol = new MemoryVolume();

    const sorted = snapshot.entries
      .map((entry, idx) => ({ entry, depth: entry.path.split('/').length, idx }))
      .sort((a, b) => a.depth - b.depth || a.idx - b.idx)
      .map(x => x.entry);

    for (const entry of sorted) {
      if (entry.path === '/') continue;

      if (entry.kind === 'directory') {
        vol.mkdirSync(entry.path, { recursive: true });
      } else if (entry.kind === 'file') {
        let content: Uint8Array;
        if (entry.data) {
          content = base64ToBytes(entry.data);
        } else {
          content = new Uint8Array(0);
        }
        const parentDir = entry.path.substring(0, entry.path.lastIndexOf('/')) || '/';
        if (parentDir !== '/' && !vol.existsSync(parentDir)) {
          vol.mkdirSync(parentDir, { recursive: true });
        }
        vol.writeInternal(vol.normalize(entry.path), content, false);
      }
    }

    return vol;
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

  private locateRaw(p: string): VolumeNode | undefined {
    if (p === '/') return this.tree;
    let current = this.tree;
    let start = 1; // skip leading '/'
    const len = p.length;
    while (start < len) {
      let end = p.indexOf('/', start);
      if (end === -1) end = len;
      const seg = p.substring(start, end);
      start = end + 1;
      if (current.kind === 'symlink') {
        const resolved = this.locateRaw(current.target!);
        if (!resolved || resolved.kind !== 'directory') return undefined;
        current = resolved;
      }
      if (current.kind !== 'directory' || !current.children) return undefined;
      const child = current.children.get(seg);
      if (!child) return undefined;
      current = child;
    }
    return current;
  }

  private locate(p: string): VolumeNode | undefined {
    const node = this.locateRaw(p);
    if (!node) return undefined;
    // follow final symlink
    if (node.kind === 'symlink') {
      return this.locate(node.target!);
    }
    return node;
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
  private writeInternal(norm: string, data: string | Uint8Array | unknown, notify: boolean): void {
    const lastSlash = norm.lastIndexOf('/');
    const parentPath = lastSlash <= 0 ? '/' : norm.slice(0, lastSlash);
    const name = norm.slice(lastSlash + 1);

    if (!name) {
      throw new Error(`EISDIR: illegal operation on a directory, '${norm}'`);
    }

    const parent = this.ensureDir(parentPath);
    const existed = parent.children!.has(name);
    // callers may pass any buffer-ish shape (ArrayBuffer, TypedArray view, plain
    // array from postMessage, Node Buffer). storing anything but a Uint8Array
    // would break every downstream read
    const bytes = this.toBytes(data);
    this._untrackLazyResident(norm);

    parent.children!.set(name, {
      kind: 'file',
      content: bytes,
      modified: Date.now(),
    });

    if (this._handler) this._handler.invalidateStat(norm);

    if (notify) {
      this.triggerWatchers(norm, existed ? 'change' : 'rename');
      // pass the normalized Uint8Array so decodeText gets a real BufferSource —
      // raw `data` would throw for plain arrays
      this.broadcast('change', norm, typeof data === 'string' ? data : this.decodeText(bytes));
      this.notifyGlobalListeners(norm, existed ? 'change' : 'add');
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

  private _trackLazyResident(path: string, node: VolumeNode): void {
    if (!node.content || !this._isUnderLazy(path)) return;
    this._untrackLazyResident(path);
    const size = node.content.byteLength;
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
        oldNode.content = undefined;
        oldNode.lazy = true;
        oldNode.lazySize = oldSize;
      }
    }
  }

  private _touchLazyResident(path: string): void {
    const size = this._lazyResident.get(path);
    if (size === undefined) return;
    this._lazyResident.delete(path);
    this._lazyResident.set(path, size);
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
  // the path exists locally afterwards. Never notifies watchers (hydration is
  // not a "change" — the file logically existed all along).
  private _hydrateMiss(norm: string): boolean {
    if (!this._missHandler || this._lazyNegative.has(norm) || !this._isUnderLazy(norm)) {
      return false;
    }
    let st: { isFile: boolean; isDirectory: boolean; size: number } | null = null;
    try { st = this._missHandler.stat(norm); } catch { st = null; }
    if (!st) {
      this._lazyNegative.add(norm);
      return false;
    }
    if (st.isDirectory) {
      this.ensureDir(norm);
      return true;
    }
    let bytes: Uint8Array | null = null;
    try { bytes = this._missHandler.readFile(norm); } catch { bytes = null; }
    if (bytes === null) {
      this._lazyNegative.add(norm);
      return false;
    }
    this.writeInternal(norm, bytes, false);
    const hydrated = this.locateRaw(norm);
    if (hydrated?.kind === 'file') this._trackLazyResident(norm, hydrated);
    return true;
  }

  // Fetch content for a lazy stub created by _lazyList.
  private _hydrateStub(norm: string, node: VolumeNode): void {
    node.lazy = false;
    if (!this._missHandler) return;
    let bytes: Uint8Array | null = null;
    try { bytes = this._missHandler.readFile(norm); } catch { bytes = null; }
    node.content = bytes ?? new Uint8Array(0);
    node.lazySize = undefined;
    node.modified = Date.now();
    if (this._handler) this._handler.invalidateStat(norm);
    this._trackLazyResident(norm, node);
  }

  // Fetch only the size for a lazy stub — stat must not pull full content
  // (readdir { withFileTypes } stats every entry; fetching content there
  // would turn one listing into N content round-trips).
  private _hydrateStubStat(norm: string, node: VolumeNode): void {
    if (!this._missHandler || node.lazySize !== undefined) return;
    let st: { isFile: boolean; isDirectory: boolean; size: number } | null = null;
    try { st = this._missHandler.stat(norm); } catch { st = null; }
    node.lazySize = st?.size ?? 0;
  }

  // Fully hydrate a subtree before structural changes (rename/link). A moved
  // lazy stub would otherwise try to fetch content under its NEW path, which
  // the main thread doesn't know about.
  private _hydrateTree(norm: string, node: VolumeNode): void {
    if (!this._missHandler) return;
    if (node.kind === 'file') {
      if (node.lazy) this._hydrateStub(norm, node);
      return;
    }
    if (node.kind !== 'directory') return;
    this._lazyList(norm, node);
    if (!node.children) return;
    for (const [name, child] of node.children) {
      const childPath = norm === '/' ? `/${name}` : `${norm}/${name}`;
      this._hydrateTree(childPath, child);
    }
  }

  // Populate a lazy directory's listing once: union of proxy entries and any
  // local children (local wins). Subdirs become unlisted lazy dirs; files
  // become content-less stubs hydrated on first read/stat.
  private _lazyList(norm: string, node: VolumeNode): void {
    if (!this._missHandler || this._lazyListed.has(norm) || !this._isUnderLazy(norm)) {
      return;
    }
    this._lazyListed.add(norm);
    let entries: Array<{ name: string; isDirectory: boolean }> | null = null;
    try { entries = this._missHandler.readdir(norm); } catch { entries = null; }
    if (!entries) return;
    if (!node.children) node.children = new Map();
    for (const entry of entries) {
      if (node.children.has(entry.name)) continue;
      node.children.set(
        entry.name,
        entry.isDirectory
          ? { kind: 'directory', children: new Map(), modified: Date.now() }
          : { kind: 'file', lazy: true, modified: Date.now() },
      );
    }
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

    const fileSize =
      node.kind === 'file' ? (node.content?.length ?? node.lazySize ?? 0) : 0;
    const ts = node.modified;

    const result: FileStat = {
      isFile: () => node.kind === 'file',
      isDirectory: () => node.kind === 'directory',
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      size: fileSize,
      mode: node.kind === 'directory' ? 0o755 : 0o644,
      mtime: new Date(ts),
      atime: new Date(ts),
      ctime: new Date(ts),
      birthtime: new Date(ts),
      mtimeMs: ts,
      atimeMs: ts,
      ctimeMs: ts,
      birthtimeMs: ts,
      nlink: 1,
      uid: MOCK_IDS.UID,
      gid: MOCK_IDS.GID,
      dev: 0,
      ino: this._inoFor(norm),
      rdev: 0,
      blksize: MOCK_FS.BLOCK_SIZE,
      blocks: Math.ceil(fileSize / MOCK_FS.BLOCK_CALC_SIZE),
      atimeNs: BigInt(ts) * 1000000n,
      mtimeNs: BigInt(ts) * 1000000n,
      ctimeNs: BigInt(ts) * 1000000n,
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
      const ts = node.modified;
      return {
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => true,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
        size: (node.target || '').length,
        mode: 0o120777,
        mtime: new Date(ts),
        atime: new Date(ts),
        ctime: new Date(ts),
        birthtime: new Date(ts),
        mtimeMs: ts,
        atimeMs: ts,
        ctimeMs: ts,
        birthtimeMs: ts,
        nlink: 1,
        uid: 1000,
        gid: 1000,
        dev: 0,
        ino: this._inoFor(norm),
        rdev: 0,
        blksize: MOCK_FS.BLOCK_SIZE,
        blocks: 0,
        atimeNs: BigInt(ts) * 1000000n,
        mtimeNs: BigInt(ts) * 1000000n,
        ctimeNs: BigInt(ts) * 1000000n,
        birthtimeNs: BigInt(ts) * 1000000n,
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
    if (node.lazy) this._hydrateStub(norm, node);

    const bytes = node.content || new Uint8Array(0);
    this._touchLazyResident(norm);
    if (encoding === 'utf8' || encoding === 'utf-8') {
      return this.decodeText(bytes);
    }
    return bytes;
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

  mkdirSync(p: string, options?: { recursive?: boolean }): void {
    const norm = this.normalize(p);

    if (options?.recursive) {
      const { created } = this.ensureDirTracked(norm);
      for (const path of created) {
        if (this._handler) this._handler.invalidateStat(path);
        this.triggerWatchers(path, 'rename');
        this.notifyGlobalListeners(path, 'addDir');
      }
      return;
    }

    const parentPath = this.parentOf(norm);
    const name = this.nameOf(norm);
    if (!name) return;

    const parent = this.locate(parentPath);
    if (!parent) throw makeSystemError('ENOENT', 'mkdir', parentPath);
    if (parent.kind !== 'directory') throw makeSystemError('ENOTDIR', 'mkdir', parentPath);
    if (parent.children!.has(name)) throw makeSystemError('EEXIST', 'mkdir', p);

    parent.children!.set(name, {
      kind: 'directory',
      children: new Map(),
      modified: Date.now(),
    });

    if (this._handler) this._handler.invalidateStat(norm);
    this.triggerWatchers(norm, 'rename');
    this.notifyGlobalListeners(norm, 'addDir');
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
    if (target.kind !== 'file') throw makeSystemError('EISDIR', 'unlink', p);

    this._untrackLazyResident(norm);
    parent.children!.delete(name);
    if (this._handler) this._handler.invalidateStat(norm);
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

    // fire watchers so recursive `/`-watchers learn the directory is gone.
    // without this, a worker's fs.rmSync() silently drops rmdir events — main
    // thread's VFSBridge never sees the empty subdir and later renames into
    // that location fail with ENOTEMPTY
    this.triggerWatchers(norm, 'rename');
    this.broadcast('delete', norm);
    this.notifyGlobalListeners(norm, 'unlink');
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

    // a moved lazy subtree would hydrate under the wrong (new) path — pull
    // everything local before the move
    if (this._missHandler) this._hydrateTree(normFrom, node);

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
    // semantics that Vite relies on for the deps_temp → deps commit
    if (toParent.children!.has(toName)) {
      this._untrackLazyTree(normTo);
      toParent.children!.delete(toName);
    }
    fromParent.children!.delete(fromName);
    toParent.children!.set(toName, node);
    this._remapLazyTree(normFrom, normTo);

    if (this._handler) {
      this._handler.invalidateStat(normFrom);
      this._handler.invalidateStat(normTo);
      for (const pair of descendantPairs) {
        this._handler.invalidateStat(pair.oldPath);
        this._handler.invalidateStat(pair.newPath);
      }
    }

    // fire watcher + global-listener events for the top-level move
    this.triggerWatchers(normFrom, 'rename');
    this.triggerWatchers(normTo, 'rename');
    this.notifyGlobalListeners(normFrom, 'unlink');
    this.notifyGlobalListeners(normTo, 'add');

    // fire events for every descendant so recursive watchers (the worker→main
    // vfs-sync handler, HMR watchers, etc.) see every moved path. without this,
    // Vite's atomic commit `deps_temp_XXX` → `deps` is invisible to the main
    // thread's VFS and all bundled dep files stay at the old path
    for (const pair of descendantPairs) {
      this.triggerWatchers(pair.oldPath, 'rename');
      this.triggerWatchers(pair.newPath, 'rename');
      this.notifyGlobalListeners(pair.oldPath, 'unlink');
      this.notifyGlobalListeners(pair.newPath, 'add');
    }
  }

  accessSync(p: string, _mode?: number): void {
    if (!this.existsSync(p)) throw makeSystemError('ENOENT', 'access', p);
  }

  copyFileSync(src: string, dest: string): void {
    const data = this.readFileSync(src);
    this.writeFileSync(dest, data);
  }

  realpathSync(p: string): string {
    const norm = this.normalize(p);
    let node = this.locateRaw(norm);
    if (!node && this._missHandler && this._hydrateMiss(norm)) {
      node = this.locateRaw(norm);
    }
    if (!node) throw makeSystemError('ENOENT', 'realpath', p);
    if (node.kind === 'symlink') {
      return this.realpathSync(node.target!);
    }
    return norm;
  }

  symlinkSync(target: string, linkPath: string, _type?: string): void {
    const normLink = this.normalize(linkPath);
    const parentPath = this.parentOf(normLink);
    const name = this.nameOf(normLink);

    if (!name) throw new Error(`EISDIR: invalid symlink path, '${linkPath}'`);
    const parent = this.ensureDir(parentPath);

    parent.children!.set(name, {
      kind: 'symlink',
      target: this.normalize(target),
      modified: Date.now(),
    });

    if (this._handler) this._handler.invalidateStat(normLink);
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
    // sharing a content-less stub would alias undefined content
    if (existing.lazy) this._hydrateStub(normExisting, existing);

    const normNew = this.normalize(newPath);
    const parentPath = this.parentOf(normNew);
    const name = this.nameOf(normNew);
    const parent = this.ensureDir(parentPath);

    parent.children!.set(name, {
      kind: 'file',
      content: existing.content,
      modified: existing.modified,
    });

    if (this._handler) this._handler.invalidateStat(normNew);
    this.triggerWatchers(normNew, 'rename');
    this.notifyGlobalListeners(normNew, 'add');
  }

  chmodSync(_p: string, _mode: number): void {
    // no-op besides existence check, VFS doesn't track permissions
    const norm = this.normalize(_p);
    if (!this.locate(norm)) throw makeSystemError('ENOENT', 'chmod', _p);
  }

  chownSync(_p: string, _uid: number, _gid: number): void {
    const norm = this.normalize(_p);
    if (!this.locate(norm)) throw makeSystemError('ENOENT', 'chown', _p);
  }

  appendFileSync(p: string, data: string | Uint8Array | unknown): void {
    const norm = this.normalize(p);
    let existing: Uint8Array = new Uint8Array(0);
    const node = this.locate(norm);
    if (node && node.kind === 'file') {
      if (node.lazy) this._hydrateStub(norm, node);
      existing = node.content || new Uint8Array(0);
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
    const content = node.content || new Uint8Array(0);
    if (len < content.length) {
      node.content = content.slice(0, len);
    } else if (len > content.length) {
      const bigger = new Uint8Array(len);
      bigger.set(content);
      node.content = bigger;
    }
    node.modified = Date.now();

    if (this._handler) this._handler.invalidateStat(norm);
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
    this.stat(p, cb);
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
    try {
      this.accessSync(p);
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
