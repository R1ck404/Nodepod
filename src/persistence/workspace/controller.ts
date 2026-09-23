// Saves a MemoryVolume to a WorkspaceStore and restores it at boot.
//
// The volume is the source of truth. The controller keeps no copy of the
// stored manifest: mutations only mark paths (and file inodes) dirty, and a
// flush reads the current state of each dirty path. That makes the result
// independent of how mutations were ordered or coalesced, and keeps the
// steady-state cost to a WeakMap slot per saved file.

import { EventEmitter } from "../../polyfills/events";
import type { MemoryVolume, MountEntry, VolumeMutation, VolumeNodeInfo } from "../../memory-volume";
import type { WorkspaceLock } from "./lock";
import { createPathFilter, DEFAULT_EXCLUDED_DIR_NAMES } from "./paths";
import type {
  PersistenceSavedEvent,
  PersistenceStatus,
  WorkspaceBatch,
  WorkspaceEntry,
  WorkspaceStore,
} from "./types";

const DEFAULT_DEBOUNCE_MS = 250;
// save at least this often while changes keep streaming in
const MAX_WAIT_MS = 2000;
// save right away once this much content is waiting
const EAGER_FLUSH_BYTES = 8 * 1024 * 1024;
// blob bytes per commit; bounds the structured-clone copy made while saving
const MAX_BATCH_BYTES = 16 * 1024 * 1024;
// blob bytes read per step while restoring
const LOAD_CHUNK_BYTES = 32 * 1024 * 1024;
// unreferenced blobs are collected after this many removals (and at boot)
const SWEEP_EVERY_REMOVALS = 500;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

export interface WorkspacePersistenceOptions {
  excludeDirNames?: string[];
  exclude?: (path: string) => boolean;
  debounceMs?: number;
  /** Blob bytes per commit. Default 16 MiB. */
  maxBatchBytes?: number;
}

interface DirtySet {
  paths: Set<string>;
  inodes: Set<object>;
  prefixes: Set<string>;
}

let blobCounter = 0;
function newBlobId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${(blobCounter++).toString(36)}`;
}

// Structured clone copies a view's whole underlying buffer, so a file that
// is a subarray of a 100 MB package pack would store 100 MB. Views and
// SharedArrayBuffer-backed arrays get copied down to their own bytes.
function ownBytes(data: Uint8Array): Uint8Array {
  const shared = typeof SharedArrayBuffer !== "undefined" && data.buffer instanceof SharedArrayBuffer;
  if (!shared && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data;
  return data.slice();
}

function toEntry(path: string, info: VolumeNodeInfo, blob?: string): WorkspaceEntry {
  const entry: WorkspaceEntry = { path, kind: info.kind, mode: info.mode, mtimeMs: info.mtimeMs };
  if (info.atimeMs !== undefined) entry.atimeMs = info.atimeMs;
  if (info.uid !== undefined) entry.uid = info.uid;
  if (info.gid !== undefined) entry.gid = info.gid;
  if (info.kind === "file") {
    entry.size = info.size;
    entry.blob = blob;
  } else if (info.kind === "symlink") {
    entry.target = info.target;
    if (info.symlinkType !== undefined) entry.symlinkType = info.symlinkType;
  }
  return entry;
}

function toMountEntry(entry: WorkspaceEntry): MountEntry {
  return {
    path: entry.path,
    kind: entry.kind,
    target: entry.target,
    symlinkType: entry.symlinkType,
    mode: entry.mode,
    uid: entry.uid,
    gid: entry.gid,
    atimeMs: entry.atimeMs,
    mtimeMs: entry.mtimeMs,
  };
}

function emptyBatch(): WorkspaceBatch {
  return { deletePrefixes: [], deletePaths: [], putEntries: [], putBlobs: [], deleteBlobs: [] };
}

function isEmptyBatch(b: WorkspaceBatch): boolean {
  return !b.deletePrefixes.length && !b.deletePaths.length && !b.putEntries.length &&
    !b.putBlobs.length && !b.deleteBlobs.length;
}

/**
 * Keeps a workspace saved. Available as `nodepod.persistence` when booted
 * with the `persistence` option. Emits `saved` ({ entries, bytes }) after
 * each successful save and `error` when one fails; failed saves are retried.
 */
export class WorkspacePersistence extends EventEmitter {
  readonly id: string;

  private _volume: MemoryVolume;
  private _store: WorkspaceStore;
  private _lock: WorkspaceLock | null;
  private _isExcluded: (path: string) => boolean;
  private _debounceMs: number;
  private _maxBatchBytes: number;

  private _blobOf = new WeakMap<object, string>();
  private _dirty: DirtySet = { paths: new Set(), inodes: new Set(), prefixes: new Set() };
  private _dirtyBytes = 0;
  private _firstDirtyAt = 0;
  private _removalsSinceSweep = 0;

  private _timer: ReturnType<typeof setTimeout> | null = null;
  // serializes commits, sweeps and clear()
  private _queue: Promise<void> = Promise.resolve();
  private _saving = false;
  private _failed = false;
  private _retryMs = 0;
  private _closed = false;
  private _closing: Promise<void> | null = null;
  private _detach: (() => void) | null = null;

  constructor(
    id: string,
    volume: MemoryVolume,
    store: WorkspaceStore,
    opts: WorkspacePersistenceOptions = {},
    lock: WorkspaceLock | null = null,
  ) {
    super();
    this.id = id;
    this._volume = volume;
    this._store = store;
    this._lock = lock;
    this._isExcluded = createPathFilter(opts.excludeDirNames ?? DEFAULT_EXCLUDED_DIR_NAMES, opts.exclude);
    this._debounceMs = Math.max(0, opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this._maxBatchBytes = Math.max(1, opts.maxBatchBytes ?? MAX_BATCH_BYTES);
    if (lock) {
      lock.onLost = () => {
        const err = new Error(
          `Workspace "${id}" was taken over by another tab; this tab no longer saves it.`,
        ) as Error & { code: string };
        err.code = "EWORKSPACELOCKLOST";
        this._shutDown();
        this._store.close?.();
        this._reportError(err);
      };
    }
  }

  get status(): PersistenceStatus {
    if (this._closed) return "closed";
    if (this._saving) return "saving";
    if (this._failed) return "error";
    return this.pendingChanges > 0 ? "pending" : "idle";
  }

  /** Paths waiting to be saved. */
  get pendingChanges(): number {
    return this._dirty.paths.size + this._dirty.prefixes.size;
  }

  /**
   * Load the stored workspace into the (empty) volume. Resolves false when
   * nothing (or an empty tree) was stored. Call before attach() so the
   * restore isn't saved straight back.
   */
  async load(): Promise<boolean> {
    const manifest = await this._store.load();
    if (!manifest || manifest.entries.length === 0) return false;

    const nonFiles: MountEntry[] = [];
    const filesByBlob = new Map<string, WorkspaceEntry[]>();
    for (const entry of manifest.entries) {
      if (entry.path === "/" || this._isExcluded(entry.path)) continue;
      if (entry.kind !== "file") {
        nonFiles.push(toMountEntry(entry));
      } else if (entry.blob) {
        const group = filesByBlob.get(entry.blob);
        if (group) group.push(entry);
        else filesByBlob.set(entry.blob, [entry]);
      }
    }
    this._volume.mountEntries(nonFiles);

    // files go in chunks so the peak is one chunk of blobs on top of what's
    // already mounted; a hardlink group always stays in one chunk
    let chunk: WorkspaceEntry[][] = [];
    let chunkBytes = 0;
    const mountChunk = async (): Promise<void> => {
      const blobs = await this._store.readBlobs(chunk.map((group) => group[0].blob!));
      const mount: MountEntry[] = [];
      for (const group of chunk) {
        const blob = group[0].blob!;
        const data = blobs.get(blob);
        if (!data) {
          console.warn(`[Nodepod] workspace "${this.id}": missing content for ${group[0].path}`);
          continue;
        }
        for (const entry of group) {
          mount.push({ ...toMountEntry(entry), content: data, linkGroup: blob });
        }
      }
      this._volume.mountEntries(mount);
      for (const entry of mount) {
        const token = this._volume.inspectNode(entry.path)?.inode;
        if (token) this._blobOf.set(token, entry.linkGroup as string);
      }
      chunk = [];
      chunkBytes = 0;
    };
    for (const group of filesByBlob.values()) {
      chunk.push(group);
      chunkBytes += group[0].size ?? 0;
      if (chunkBytes >= LOAD_CHUNK_BYTES) await mountChunk();
    }
    if (chunk.length > 0) await mountChunk();

    // collect whatever the last session orphaned, off the boot path
    void this._enqueue(() => this._sweep()).catch(() => {});
    return true;
  }

  /** Start saving changes. */
  attach(): void {
    if (this._detach || this._closed) return;
    const off = this._volume.onMutation(this._onMutation);
    const onHidden = (): void => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        this.flush().catch(() => {});
      }
    };
    const onPageHide = (): void => { this.flush().catch(() => {}); };
    const doc = typeof document !== "undefined" ? document : null;
    const win = typeof window !== "undefined" ? window : null;
    doc?.addEventListener("visibilitychange", onHidden);
    win?.addEventListener("pagehide", onPageHide);
    this._detach = () => {
      off();
      doc?.removeEventListener("visibilitychange", onHidden);
      win?.removeEventListener("pagehide", onPageHide);
    };
  }

  /** Save pending changes now. Rejects if the save fails (it is still retried). */
  flush(): Promise<void> {
    if (this._closed) return this._closing ?? Promise.resolve();
    this._clearTimer();
    return this._enqueue(() => this._commitPending());
  }

  /**
   * Delete the saved workspace and stop saving. The running filesystem is
   * left alone; boot again to start a fresh saved workspace.
   */
  async clear(): Promise<void> {
    if (this._closed) {
      await this._closing;
      await this._store.clear();
      return;
    }
    this._shutDown();
    this._closing = this._enqueue(() => this._store.clear()).finally(() => this._release());
    this._lock?.releaseAfter(this._closing);
    await this._closing;
  }

  /**
   * Stop saving after one last save. Pending changes are captured
   * synchronously, so the volume can be disposed right after this call.
   */
  close(): Promise<void> {
    if (this._closed) return this._closing ?? Promise.resolve();
    let batches: WorkspaceBatch[] = [];
    try {
      if (this._hasPending()) batches = this._build(this._take());
    } catch (err) {
      this._reportError(err);
    }
    this._shutDown();
    this._closing = this._enqueue(async () => {
      for (const batch of batches) await this._store.commit(batch);
    })
      .catch((err) => this._reportError(err))
      .finally(() => this._release());
    this._lock?.releaseAfter(this._closing);
    return this._closing;
  }

  /* ---- mutation tracking ---- */

  private _onMutation = (m: VolumeMutation): void => {
    const dirty = this._dirty;
    switch (m.op) {
      case "write": {
        if (!this._markLinks(m.path)) return;
        const info = this._volume.inspectNode(m.path);
        // content dirtiness follows the inode, so a later rename or hardlink
        // still carries the new bytes
        if (info?.inode) {
          dirty.inodes.add(info.inode);
          this._dirtyBytes += info.size;
        }
        break;
      }
      case "meta":
        // a file's mode and times live on its inode, shared by its hardlinks
        if (!this._markLinks(m.path)) return;
        break;
      case "mkdir":
      case "symlink":
        if (this._isExcluded(m.path)) return;
        dirty.paths.add(m.path);
        break;
      case "link":
        if (this._isExcluded(m.path)) return;
        dirty.paths.add(m.path);
        // linked in from an excluded name: its content may have changed
        // unseen (or its blob been swept) since it was last saved
        if (this._isExcluded(m.existing)) this._markContent(m.path);
        break;
      case "remove":
        if (this._isExcluded(m.path)) return;
        dirty.prefixes.add(m.path);
        this._removalsSinceSweep++;
        break;
      case "rename": {
        const fromIncluded = !this._isExcluded(m.from);
        const toIncluded = !this._isExcluded(m.to);
        if (!fromIncluded && !toIncluded) return;
        if (fromIncluded) {
          dirty.prefixes.add(m.from);
          this._removalsSinceSweep++;
        }
        if (toIncluded) {
          // whatever was at `to` is gone; re-put the moved subtree. files
          // moved within the saved tree keep their blobs, so no content is
          // re-sent. files coming in from an excluded path may have changed
          // unseen (or had their blob swept) and are sent again
          dirty.prefixes.add(m.to);
          try {
            this._markTree(m.to, !fromIncluded);
          } catch {
            // moved again before we looked; that mutation marks it
          }
        }
        break;
      }
      case "mount": {
        let any = false;
        for (const { path } of m.entries) {
          if (this._isExcluded(path)) continue;
          any = true;
          dirty.paths.add(path);
          const info = this._volume.inspectNode(path);
          if (info && info.kind !== "directory") {
            // may have replaced a directory
            dirty.prefixes.add(path);
            if (info.inode) {
              dirty.inodes.add(info.inode);
              this._dirtyBytes += info.size;
            }
          }
        }
        if (!any) return;
        break;
      }
    }
    this._schedule();
  };

  // Marks the path plus every other hardlink to the same file: they share
  // the changed content/metadata and may outlive this path (an excluded
  // path, e.g. under node_modules, can be a link to saved ones). Returns
  // false when none of them is saved.
  private _markLinks(path: string): boolean {
    const excluded = this._isExcluded(path);
    if (excluded && this._volume.linkCount(path) <= 1) return false;
    const links = excluded || this._volume.linkCount(path) > 1 ? this._volume.linksOf(path) : [path];
    let any = false;
    for (const link of links) {
      if (this._isExcluded(link)) continue;
      this._dirty.paths.add(link);
      any = true;
    }
    return any;
  }

  private _markTree(root: string, content: boolean): void {
    const walk = (path: string): void => {
      if (this._isExcluded(path)) return;
      this._dirty.paths.add(path);
      const kind = this._volume.inspectNode(path)?.kind;
      if (kind === "file" && content) this._markContent(path);
      if (kind !== "directory") return;
      for (const name of this._volume.readdirSync(path)) {
        walk(path === "/" ? `/${name}` : `${path}/${name}`);
      }
    };
    walk(root);
  }

  private _markContent(path: string): void {
    const info = this._volume.inspectNode(path);
    if (info?.inode) {
      this._dirty.inodes.add(info.inode);
      this._dirtyBytes += info.size;
    }
  }

  private _schedule(): void {
    if (this._closed) return;
    if (!this._firstDirtyAt) this._firstDirtyAt = Date.now();
    if (this._failed) {
      // a retry is already scheduled; don't hammer a failing store
      if (!this._timer) this._setTimer(this._retryMs, true);
      return;
    }
    if (this._dirtyBytes >= EAGER_FLUSH_BYTES) {
      this.flush().catch(() => {});
      return;
    }
    const untilMaxWait = this._firstDirtyAt + MAX_WAIT_MS - Date.now();
    this._setTimer(Math.max(0, Math.min(this._debounceMs, untilMaxWait)), false);
  }

  private _setTimer(ms: number, unref: boolean): void {
    this._clearTimer();
    const timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch(() => {});
    }, ms);
    // don't hold a Node process open just to retry a failing store
    if (unref) (timer as { unref?: () => void }).unref?.();
    this._timer = timer;
  }

  private _clearTimer(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /* ---- saving ---- */

  private _hasPending(): boolean {
    return this._dirty.paths.size > 0 || this._dirty.prefixes.size > 0;
  }

  private _take(): DirtySet {
    const taken = this._dirty;
    this._dirty = { paths: new Set(), inodes: new Set(), prefixes: new Set() };
    this._dirtyBytes = 0;
    this._firstDirtyAt = 0;
    return taken;
  }

  private _putBack(taken: DirtySet): void {
    for (const p of taken.paths) this._dirty.paths.add(p);
    for (const i of taken.inodes) this._dirty.inodes.add(i);
    for (const p of taken.prefixes) this._dirty.prefixes.add(p);
  }

  // Reads the current state of every dirty path into commit batches. File
  // content goes first, at most maxBatchBytes per batch; the last batch
  // carries every delete and every entry. A save that stops partway leaves
  // the stored tree as it was, plus unreferenced blobs the next sweep drops.
  private _build(taken: DirtySet): WorkspaceBatch[] {
    const batches: WorkspaceBatch[] = [];
    let current = emptyBatch();
    let currentBytes = 0;
    const tree = emptyBatch();
    tree.deletePrefixes = Array.from(taken.prefixes);
    const written = new Set<object>();

    for (const path of taken.paths) {
      if (this._isExcluded(path)) continue;
      const info = this._volume.inspectNode(path);
      if (!info) {
        tree.deletePaths.push(path);
        continue;
      }
      if (info.kind !== "file") {
        tree.putEntries.push(toEntry(path, info));
        continue;
      }
      const token = info.inode!;
      let blob = this._blobOf.get(token);
      const needsContent = !blob || (taken.inodes.has(token) && !written.has(token));
      if (needsContent && !info.resident) {
        // paged-out package content moved into the saved tree and not paged
        // back in: keep it pending instead of saving nothing (or old bytes)
        this._dirty.paths.add(path);
        this._dirty.inodes.add(token);
        continue;
      }
      if (!blob) {
        blob = newBlobId();
        this._blobOf.set(token, blob);
        // the id means nothing until this save lands: if it fails, the
        // retry must send the bytes again
        taken.inodes.add(token);
      }
      if (needsContent && info.resident && info.content) {
        const data = ownBytes(info.content);
        if (currentBytes > 0 && currentBytes + data.byteLength > this._maxBatchBytes) {
          batches.push(current);
          current = emptyBatch();
          currentBytes = 0;
        }
        current.putBlobs.push({ id: blob, data });
        currentBytes += data.byteLength;
        written.add(token);
      }
      tree.putEntries.push(toEntry(path, info, blob));
    }
    // the last chunk of content rides along with the tree
    tree.putBlobs = current.putBlobs;
    batches.push(tree);
    return batches.filter((b) => !isEmptyBatch(b));
  }

  private async _commitPending(): Promise<void> {
    if (!this._hasPending()) return;
    const taken = this._take();
    this._saving = true;
    let entries = 0;
    let bytes = 0;
    let batches: WorkspaceBatch[] = [];
    let landed = 0;
    try {
      // bytes of paged-out package files that now need saving (moved or
      // linked in from node_modules) have to be in memory before _build
      const pageIn = this._pagedOutNeedingContent(taken);
      if (pageIn.length > 0) await this._volume.ensureResident(pageIn).catch(() => {});
      batches = this._build(taken);
      for (; landed < batches.length; landed++) {
        const batch = batches[landed];
        await this._store.commit(batch);
        entries += batch.putEntries.length + batch.deletePaths.length + batch.deletePrefixes.length;
        for (const blob of batch.putBlobs) bytes += blob.data.byteLength;
      }
    } catch (err) {
      if (this._closed) {
        // closed meanwhile: nothing will re-read the volume for these any
        // more, so try once more with the batches we have
        try {
          for (; landed < batches.length; landed++) await this._store.commit(batches[landed]);
          this._saving = false;
          return;
        } catch {
          // report the original failure below
        }
      }
      // everything is re-derived from the volume on the next attempt, so
      // replaying batches that did land is harmless
      this._putBack(taken);
      this._failed = true;
      this._retryMs = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, this._retryMs * 2));
      if (!this._closed) this._setTimer(this._retryMs, true);
      this._reportError(err);
      throw err;
    } finally {
      this._saving = false;
    }
    this._failed = false;
    this._retryMs = 0;
    if (entries > 0) this.emit("saved", { entries, bytes } satisfies PersistenceSavedEvent);
    if (this._removalsSinceSweep >= SWEEP_EVERY_REMOVALS) {
      this._removalsSinceSweep = 0;
      void this._enqueue(() => this._sweep()).catch(() => {});
    }
  }

  private _pagedOutNeedingContent(taken: DirtySet): string[] {
    if (!this._volume.evictionEnabled) return [];
    const out: string[] = [];
    for (const path of taken.paths) {
      if (this._isExcluded(path)) continue;
      const info = this._volume.inspectNode(path);
      if (info?.kind !== "file" || info.resident) continue;
      if (!this._blobOf.has(info.inode!) || taken.inodes.has(info.inode!)) out.push(path);
    }
    return out;
  }

  private async _sweep(): Promise<void> {
    if (!this._store.sweep) return;
    try {
      await this._store.sweep();
    } catch (err) {
      console.warn(`[Nodepod] workspace "${this.id}": blob cleanup failed`, err);
    }
  }

  private _enqueue(task: () => Promise<void>): Promise<void> {
    const run = this._queue.then(task);
    this._queue = run.catch(() => {});
    return run;
  }

  private _shutDown(): void {
    this._closed = true;
    this._clearTimer();
    this._detach?.();
    this._detach = null;
    this._dirty = { paths: new Set(), inodes: new Set(), prefixes: new Set() };
  }

  private _release(): void {
    this._store.close?.();
    this._lock?.release();
    this._lock = null;
  }

  private _reportError(err: unknown): void {
    if (this.listenerCount("error") > 0) this.emit("error", err);
    else console.warn(`[Nodepod] workspace "${this.id}" persistence:`, err);
  }
}
