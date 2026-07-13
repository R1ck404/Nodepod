// SharedVFS — SharedArrayBuffer-backed VFS for synchronous cross-thread reads.
//
// When SAB is available (requires COOP/COEP headers), workers can do
// fs.readFileSync() directly from shared memory without async IPC.
// Falls back to snapshot-based approach when SAB is unavailable.
//
// Layout: file table (paths -> offset+length) + data region, all in one SAB.
// Main thread owns the canonical table; workers read from it.

/* ------------------------------------------------------------------ */
/*  Feature detection                                                  */
/* ------------------------------------------------------------------ */
export function isSharedArrayBufferAvailable(): boolean {
  try {
    return (
      typeof SharedArrayBuffer !== 'undefined' &&
      typeof Atomics !== 'undefined'
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Shared memory layout                                               */
/* ------------------------------------------------------------------ */

// Per entry, 272 bytes (8-byte aligned):
//   [0..3] flags  [4..7] contentOffset  [8..11] contentLength
//   [12..15] modified  [16..19] fnv1a path hash (fast lookup reject)
//   [20..267] null-terminated path  [268..271] spare
// Controller and reader are always compiled from this same file, so no
// cross-version layout negotiation is needed.
const ENTRY_SIZE = 272;
const ENTRY_FLAGS_OFFSET = 0;
const ENTRY_CONTENT_OFFSET = 4;
const ENTRY_CONTENT_LENGTH = 8;
const ENTRY_MODIFIED_OFFSET = 12;
const ENTRY_HASH_OFFSET = 16;
const ENTRY_PATH_OFFSET = 20;
const ENTRY_PATH_MAX = 248;

const FLAG_ACTIVE = 1;
const FLAG_DIRECTORY = 2;
const FLAG_SYMLINK = 4;

// Header (32 bytes, int32 slots):
//   [0] change version  [1] entry count  [2] data used  [3] writer lock
//   [4] waste bytes (orphaned data-region bytes from updates/deletes)
//   [5..7] reserved
const HEADER_SIZE = 32;
// Modern application dependency trees routinely exceed 16K files. The table
// is shared by all worker readers and cannot grow after boot, so reserve
// enough metadata for a full node_modules tree rather than silently omitting
// later files/directories from the worker-visible filesystem.
const MAX_ENTRIES = 65536;
const TABLE_SIZE = MAX_ENTRIES * ENTRY_SIZE;
const DATA_OFFSET = HEADER_SIZE + TABLE_SIZE;

const DEFAULT_BUFFER_SIZE = 64 * 1024 * 1024; // 64MB
const COMPACT_WASTE_THRESHOLD = 16 * 1024 * 1024; // 16MB

export interface SharedVFSStats {
  entries: number;
  activeEntries: number;
  dataUsed: number;
  wasteBytes: number;
  droppedWrites: number;
  bufferSize: number;
  compactions: number;
}

export interface SharedVFSStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  /** ms since epoch. resolution is seconds, the SAB only stores seconds. */
  mtime: number;
}

/* ------------------------------------------------------------------ */
/*  FNV-1a hash                                                        */
/* ------------------------------------------------------------------ */

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

/* ------------------------------------------------------------------ */
/*  SharedVFSController (main thread)                                  */
/* ------------------------------------------------------------------ */

// Main-thread controller. Owns the SAB and manages the file table.
export class SharedVFSController {
  private _buffer: SharedArrayBuffer;
  private _view: DataView;
  private _int32: Int32Array;
  private _uint8: Uint8Array;
  private _pathEncoder = new TextEncoder();
  private _pathDecoder = new TextDecoder();

  private _droppedWrites = 0;
  private _compactions = 0;

  constructor(bufferSize: number = DEFAULT_BUFFER_SIZE) {
    if (!isSharedArrayBufferAvailable()) {
      throw new Error('SharedArrayBuffer not available. Ensure COOP/COEP headers are set.');
    }

    this._buffer = new SharedArrayBuffer(bufferSize);
    this._view = new DataView(this._buffer);
    this._int32 = new Int32Array(this._buffer);
    this._uint8 = new Uint8Array(this._buffer);

    Atomics.store(this._int32, 0, 0);
    Atomics.store(this._int32, 1, 0);
    this._view.setUint32(8, 0);
    Atomics.store(this._int32, 3, 0);
    this._view.setUint32(16, 0); // waste bytes
  }

  get buffer(): SharedArrayBuffer {
    return this._buffer;
  }

  writeFile(path: string, content: Uint8Array): boolean {
    this._lock();
    try {
      // opportunistic compaction when orphaned bytes pile up (HMR rewriting
      // the same files bloats the append-only region)
      if (this._view.getUint32(16) > COMPACT_WASTE_THRESHOLD) {
        this._compactLocked();
      }

      let ok = this._writeFileLocked(path, content);
      if (!ok && this._view.getUint32(16) > 0) {
        // rescue: reclaim orphaned space, then retry once
        this._compactLocked();
        ok = this._writeFileLocked(path, content);
      }
      if (!ok) this._droppedWrites++;
      return ok;
    } finally {
      this._unlock();
    }
  }

  private _writeFileLocked(path: string, content: Uint8Array): boolean {
    const entryCount = Atomics.load(this._int32, 1);
    const dataUsed = this._view.getUint32(8);

    const existingIdx = this._findEntry(path);
    if (existingIdx !== -1) {
      return this._updateEntry(existingIdx, content, dataUsed);
    }

    if (entryCount >= MAX_ENTRIES) return false;
    if (DATA_OFFSET + dataUsed + content.byteLength > this._buffer.byteLength) return false;

    const contentOffset = dataUsed;
    this._uint8.set(content, DATA_OFFSET + contentOffset);

    const entryOffset = HEADER_SIZE + entryCount * ENTRY_SIZE;
    this._view.setUint32(entryOffset + ENTRY_FLAGS_OFFSET, FLAG_ACTIVE);
    this._view.setUint32(entryOffset + ENTRY_CONTENT_OFFSET, contentOffset);
    this._view.setUint32(entryOffset + ENTRY_CONTENT_LENGTH, content.byteLength);
    this._view.setUint32(entryOffset + ENTRY_MODIFIED_OFFSET, (Date.now() / 1000) | 0);

    this._writePath(entryOffset, path);

    Atomics.store(this._int32, 1, entryCount + 1);
    this._view.setUint32(8, dataUsed + content.byteLength);

    Atomics.add(this._int32, 0, 1);
    Atomics.notify(this._int32, 0);

    return true;
  }

  writeDirectory(path: string): boolean {
    this._lock();
    try {
      const entryCount = Atomics.load(this._int32, 1);
      if (this._findEntry(path) !== -1) return true;
      if (entryCount >= MAX_ENTRIES) {
        this._droppedWrites++;
        return false;
      }

      const entryOffset = HEADER_SIZE + entryCount * ENTRY_SIZE;
      this._view.setUint32(entryOffset + ENTRY_FLAGS_OFFSET, FLAG_ACTIVE | FLAG_DIRECTORY);
      this._view.setUint32(entryOffset + ENTRY_CONTENT_OFFSET, 0);
      this._view.setUint32(entryOffset + ENTRY_CONTENT_LENGTH, 0);
      this._view.setUint32(entryOffset + ENTRY_MODIFIED_OFFSET, (Date.now() / 1000) | 0);

      this._writePath(entryOffset, path);

      Atomics.store(this._int32, 1, entryCount + 1);
      Atomics.add(this._int32, 0, 1);
      Atomics.notify(this._int32, 0);

      return true;
    } finally {
      this._unlock();
    }
  }

  deleteFile(path: string): boolean {
    this._lock();
    try {
      const idx = this._findEntry(path);
      if (idx === -1) return false;

      const entryOffset = HEADER_SIZE + idx * ENTRY_SIZE;
      const flags = this._view.getUint32(entryOffset + ENTRY_FLAGS_OFFSET);
      this._view.setUint32(entryOffset + ENTRY_FLAGS_OFFSET, 0);

      // orphaned content bytes become waste (dirs carry no content)
      if (!(flags & FLAG_DIRECTORY)) {
        const contentLength = this._view.getUint32(entryOffset + ENTRY_CONTENT_LENGTH);
        this._addWaste(contentLength);
      }

      Atomics.add(this._int32, 0, 1);
      Atomics.notify(this._int32, 0);

      return true;
    } finally {
      this._unlock();
    }
  }

  readFile(path: string): Uint8Array | null {
    const idx = this._findEntry(path);
    if (idx === -1) return null;

    const entryOffset = HEADER_SIZE + idx * ENTRY_SIZE;
    const flags = this._view.getUint32(entryOffset + ENTRY_FLAGS_OFFSET);
    if (!(flags & FLAG_ACTIVE) || (flags & FLAG_DIRECTORY)) return null;

    const contentOffset = this._view.getUint32(entryOffset + ENTRY_CONTENT_OFFSET);
    const contentLength = this._view.getUint32(entryOffset + ENTRY_CONTENT_LENGTH);

    // Copy, not view, to avoid races
    return new Uint8Array(this._uint8.slice(
      DATA_OFFSET + contentOffset,
      DATA_OFFSET + contentOffset + contentLength,
    ));
  }

  exists(path: string): boolean {
    return this._findEntry(path) !== -1;
  }

  get version(): number {
    return Atomics.load(this._int32, 0);
  }

  getStats(): SharedVFSStats {
    const entries = Atomics.load(this._int32, 1);
    let active = 0;
    for (let i = 0; i < entries; i++) {
      const flags = this._view.getUint32(HEADER_SIZE + i * ENTRY_SIZE + ENTRY_FLAGS_OFFSET);
      if (flags & FLAG_ACTIVE) active++;
    }
    return {
      entries,
      activeEntries: active,
      dataUsed: this._view.getUint32(8),
      wasteBytes: this._view.getUint32(16),
      droppedWrites: this._droppedWrites,
      bufferSize: this._buffer.byteLength,
      compactions: this._compactions,
    };
  }

  // Rebuild the data region contiguously and drop tombstoned entries.
  // Public entry point takes the writer lock; writeFile calls the locked
  // variant internally.
  compact(): void {
    this._lock();
    try {
      this._compactLocked();
    } finally {
      this._unlock();
    }
  }

  /* ---- Internal ---- */

  private _addWaste(bytes: number): void {
    this._view.setUint32(16, this._view.getUint32(16) + bytes);
  }

  private _writePath(entryOffset: number, path: string): void {
    const pathBytes = this._pathEncoder.encode(path);
    const pathLen = Math.min(pathBytes.byteLength, ENTRY_PATH_MAX - 1);
    this._view.setUint32(entryOffset + ENTRY_HASH_OFFSET, fnv1a(path));
    this._uint8.set(pathBytes.subarray(0, pathLen), entryOffset + ENTRY_PATH_OFFSET);
    this._uint8[entryOffset + ENTRY_PATH_OFFSET + pathLen] = 0;
  }

  // Compacts both the entry table (drops inactive entries) and the data
  // region (copies live content contiguously). Caller must hold the lock.
  // Readers never cache offsets across calls, and main-thread JS can't run
  // concurrently with a worker read of a *consistent* entry — the version
  // bump at the end tells pollers something moved.
  private _compactLocked(): void {
    const entryCount = Atomics.load(this._int32, 1);

    // gather live entries
    const live: Array<{
      flags: number;
      length: number;
      modified: number;
      hash: number;
      pathBytes: Uint8Array;
      content: Uint8Array | null;
    }> = [];

    for (let i = 0; i < entryCount; i++) {
      const entryOffset = HEADER_SIZE + i * ENTRY_SIZE;
      const flags = this._view.getUint32(entryOffset + ENTRY_FLAGS_OFFSET);
      if (!(flags & FLAG_ACTIVE)) continue;

      const contentOffset = this._view.getUint32(entryOffset + ENTRY_CONTENT_OFFSET);
      const contentLength = this._view.getUint32(entryOffset + ENTRY_CONTENT_LENGTH);

      let pathEnd = 0;
      while (pathEnd < ENTRY_PATH_MAX && this._uint8[entryOffset + ENTRY_PATH_OFFSET + pathEnd] !== 0) {
        pathEnd++;
      }
      const pathBytes = this._uint8.slice(
        entryOffset + ENTRY_PATH_OFFSET,
        entryOffset + ENTRY_PATH_OFFSET + pathEnd,
      );

      const isDir = (flags & FLAG_DIRECTORY) !== 0;
      const content = isDir || contentLength === 0
        ? null
        : this._uint8.slice(
            DATA_OFFSET + contentOffset,
            DATA_OFFSET + contentOffset + contentLength,
          );

      live.push({
        flags,
        length: isDir ? 0 : contentLength,
        modified: this._view.getUint32(entryOffset + ENTRY_MODIFIED_OFFSET),
        hash: this._view.getUint32(entryOffset + ENTRY_HASH_OFFSET),
        pathBytes,
        content,
      });
    }

    // write back contiguously
    let dataUsed = 0;
    for (let i = 0; i < live.length; i++) {
      const e = live[i];
      const entryOffset = HEADER_SIZE + i * ENTRY_SIZE;
      let contentOffset = 0;
      if (e.content) {
        contentOffset = dataUsed;
        this._uint8.set(e.content, DATA_OFFSET + contentOffset);
        dataUsed += e.content.byteLength;
      }
      this._view.setUint32(entryOffset + ENTRY_FLAGS_OFFSET, e.flags);
      this._view.setUint32(entryOffset + ENTRY_CONTENT_OFFSET, contentOffset);
      this._view.setUint32(entryOffset + ENTRY_CONTENT_LENGTH, e.length);
      this._view.setUint32(entryOffset + ENTRY_MODIFIED_OFFSET, e.modified);
      this._view.setUint32(entryOffset + ENTRY_HASH_OFFSET, e.hash);
      this._uint8.set(e.pathBytes, entryOffset + ENTRY_PATH_OFFSET);
      this._uint8[entryOffset + ENTRY_PATH_OFFSET + e.pathBytes.byteLength] = 0;
    }

    // zero flags of now-unused trailing entry slots so stale data can't match
    for (let i = live.length; i < entryCount; i++) {
      this._view.setUint32(HEADER_SIZE + i * ENTRY_SIZE + ENTRY_FLAGS_OFFSET, 0);
    }

    Atomics.store(this._int32, 1, live.length);
    this._view.setUint32(8, dataUsed);
    this._view.setUint32(16, 0);
    this._compactions++;

    Atomics.add(this._int32, 0, 1);
    Atomics.notify(this._int32, 0);
  }

  private _findEntry(path: string): number {
    const entryCount = Atomics.load(this._int32, 1);
    const hash = fnv1a(path);
    const pathBytes = this._pathEncoder.encode(path);

    for (let i = 0; i < entryCount; i++) {
      const entryOffset = HEADER_SIZE + i * ENTRY_SIZE;
      const flags = this._view.getUint32(entryOffset + ENTRY_FLAGS_OFFSET);
      if (!(flags & FLAG_ACTIVE)) continue;
      // hash-first: one int compare rejects almost all non-matches
      if (this._view.getUint32(entryOffset + ENTRY_HASH_OFFSET) !== hash) continue;

      let match = true;
      for (let j = 0; j < pathBytes.byteLength; j++) {
        if (this._uint8[entryOffset + ENTRY_PATH_OFFSET + j] !== pathBytes[j]) {
          match = false;
          break;
        }
      }
      if (match && this._uint8[entryOffset + ENTRY_PATH_OFFSET + pathBytes.byteLength] === 0) {
        return i;
      }
    }
    return -1;
  }

  private _updateEntry(idx: number, content: Uint8Array, dataUsed: number): boolean {
    if (DATA_OFFSET + dataUsed + content.byteLength > this._buffer.byteLength) return false;

    const entryOffset = HEADER_SIZE + idx * ENTRY_SIZE;

    // the old content bytes become orphaned waste (append-only region)
    this._addWaste(this._view.getUint32(entryOffset + ENTRY_CONTENT_LENGTH));

    // Append-only — don't reuse old space to avoid races
    const contentOffset = dataUsed;
    this._uint8.set(content, DATA_OFFSET + contentOffset);

    this._view.setUint32(entryOffset + ENTRY_CONTENT_OFFSET, contentOffset);
    this._view.setUint32(entryOffset + ENTRY_CONTENT_LENGTH, content.byteLength);
    this._view.setUint32(entryOffset + ENTRY_MODIFIED_OFFSET, (Date.now() / 1000) | 0);

    this._view.setUint32(8, dataUsed + content.byteLength);
    Atomics.add(this._int32, 0, 1);
    Atomics.notify(this._int32, 0);

    return true;
  }

  private _lock(): void {
    while (Atomics.compareExchange(this._int32, 3, 0, 1) !== 0) {
      Atomics.wait(this._int32, 3, 1, 1);
    }
  }

  private _unlock(): void {
    Atomics.store(this._int32, 3, 0);
    Atomics.notify(this._int32, 3);
  }
}

/* ------------------------------------------------------------------ */
/*  SharedVFSReader (worker thread)                                    */
/* ------------------------------------------------------------------ */

// Worker-thread reader. Synchronous read access to shared memory.
export class SharedVFSReader {
  private _buffer: SharedArrayBuffer;
  private _view: DataView;
  private _int32: Int32Array;
  private _uint8: Uint8Array;
  private _pathEncoder = new TextEncoder();
  private _pathDecoder = new TextDecoder();

  constructor(buffer: SharedArrayBuffer) {
    this._buffer = buffer;
    this._view = new DataView(buffer);
    this._int32 = new Int32Array(buffer);
    this._uint8 = new Uint8Array(buffer);
  }

  readFileSync(path: string): Uint8Array | null {
    const idx = this._findEntry(path);
    if (idx === -1) return null;

    const entryOffset = HEADER_SIZE + idx * ENTRY_SIZE;
    const flags = this._view.getUint32(entryOffset + ENTRY_FLAGS_OFFSET);
    if (!(flags & FLAG_ACTIVE) || (flags & FLAG_DIRECTORY)) return null;

    const contentOffset = this._view.getUint32(entryOffset + ENTRY_CONTENT_OFFSET);
    const contentLength = this._view.getUint32(entryOffset + ENTRY_CONTENT_LENGTH);

    const result = new Uint8Array(contentLength);
    result.set(this._uint8.subarray(
      DATA_OFFSET + contentOffset,
      DATA_OFFSET + contentOffset + contentLength,
    ));
    return result;
  }

  existsSync(path: string): boolean {
    return this._findEntry(path) !== -1;
  }

  isDirectorySync(path: string): boolean {
    const idx = this._findEntry(path);
    if (idx === -1) return false;
    const entryOffset = HEADER_SIZE + idx * ENTRY_SIZE;
    const flags = this._view.getUint32(entryOffset + ENTRY_FLAGS_OFFSET);
    return (flags & FLAG_ACTIVE) !== 0 && (flags & FLAG_DIRECTORY) !== 0;
  }

  statSync(path: string): SharedVFSStat | null {
    const idx = this._findEntry(path);
    if (idx === -1) return null;
    const entryOffset = HEADER_SIZE + idx * ENTRY_SIZE;
    const flags = this._view.getUint32(entryOffset + ENTRY_FLAGS_OFFSET);
    if (!(flags & FLAG_ACTIVE)) return null;
    const isDirectory = (flags & FLAG_DIRECTORY) !== 0;
    const contentLength = this._view.getUint32(entryOffset + ENTRY_CONTENT_LENGTH);
    const modified = this._view.getUint32(entryOffset + ENTRY_MODIFIED_OFFSET);
    return {
      isFile: !isDirectory,
      isDirectory,
      size: isDirectory ? 0 : contentLength,
      mtime: modified * 1000,
    };
  }

  // immediate children only, basenames, O(n) over the entry table.
  // returns [] for missing paths.
  readdirSync(dir: string): string[] {
    const prefix = dir === "/" ? "/" : dir.endsWith("/") ? dir : dir + "/";
    const entryCount = Atomics.load(this._int32, 1);
    const names: string[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < entryCount; i++) {
      const entryOffset = HEADER_SIZE + i * ENTRY_SIZE;
      const flags = this._view.getUint32(entryOffset + ENTRY_FLAGS_OFFSET);
      if (!(flags & FLAG_ACTIVE)) continue;

      const path = this._readPath(entryOffset);
      if (!path.startsWith(prefix) || path === prefix) continue;

      // strip prefix then take up to the next slash, skip nested entries
      const rest = path.slice(prefix.length);
      const slashIdx = rest.indexOf("/");
      const name = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }

    return names;
  }

  get version(): number {
    return Atomics.load(this._int32, 0);
  }

  // Blocks until version changes. Returns new version or -1 on timeout.
  waitForChange(currentVersion: number, timeoutMs: number = 5000): number {
    const result = Atomics.wait(this._int32, 0, currentVersion, timeoutMs);
    if (result === 'timed-out') return -1;
    return Atomics.load(this._int32, 0);
  }

  /* ---- Internal ---- */

  private _findEntry(path: string): number {
    const entryCount = Atomics.load(this._int32, 1);
    const hash = fnv1a(path);
    const pathBytes = this._pathEncoder.encode(path);

    for (let i = 0; i < entryCount; i++) {
      const entryOffset = HEADER_SIZE + i * ENTRY_SIZE;
      const flags = this._view.getUint32(entryOffset + ENTRY_FLAGS_OFFSET);
      if (!(flags & FLAG_ACTIVE)) continue;
      // hash-first: one int compare rejects almost all non-matches
      if (this._view.getUint32(entryOffset + ENTRY_HASH_OFFSET) !== hash) continue;

      let match = true;
      for (let j = 0; j < pathBytes.byteLength; j++) {
        if (this._uint8[entryOffset + ENTRY_PATH_OFFSET + j] !== pathBytes[j]) {
          match = false;
          break;
        }
      }
      if (match && this._uint8[entryOffset + ENTRY_PATH_OFFSET + pathBytes.byteLength] === 0) {
        return i;
      }
    }
    return -1;
  }

  // decode a null-terminated path from an entry. needs a non-shared copy
  // because TextDecoder throws on SAB views.
  private _readPath(entryOffset: number): string {
    let end = 0;
    while (end < ENTRY_PATH_MAX && this._uint8[entryOffset + ENTRY_PATH_OFFSET + end] !== 0) {
      end++;
    }
    if (end === 0) return "";
    const copy = new Uint8Array(end);
    copy.set(this._uint8.subarray(entryOffset + ENTRY_PATH_OFFSET, entryOffset + ENTRY_PATH_OFFSET + end));
    return this._pathDecoder.decode(copy);
  }
}
