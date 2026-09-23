// Public contract for workspace persistence. The runtime filesystem stays a
// synchronous in-memory MemoryVolume; a WorkspaceStore is the async place it
// gets saved to and restored from. Implement it to persist anywhere (a
// server, S3, a native bridge); IndexedDB, filesystem and in-memory stores
// ship with Nodepod.

/** One stored filesystem entry. File content lives in a blob referenced by id. */
export interface WorkspaceEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
  mode: number;
  mtimeMs: number;
  atimeMs?: number;
  uid?: number;
  gid?: number;
  /** File size in bytes. */
  size?: number;
  /** Blob holding the file content. Hardlinks share one blob. */
  blob?: string;
  /** Symlink target. */
  target?: string;
  symlinkType?: string;
}

export interface WorkspaceManifest {
  version: 1;
  entries: WorkspaceEntry[];
}

/**
 * A set of changes to apply atomically, in this order: `deletePrefixes`,
 * `deletePaths`, `putEntries`, `putBlobs`, `deleteBlobs`. Large saves send
 * blob-only batches first; those must not make a never-saved workspace
 * load() as saved.
 */
export interface WorkspaceBatch {
  /** Delete the entry at each path and every entry below it. */
  deletePrefixes: string[];
  deletePaths: string[];
  putEntries: WorkspaceEntry[];
  /** Create or overwrite blobs. `data` is never a view into a larger buffer. */
  putBlobs: Array<{ id: string; data: Uint8Array }>;
  deleteBlobs: string[];
}

export interface WorkspaceStore {
  /** The stored workspace, or null if it was never saved. */
  load(): Promise<WorkspaceManifest | null>;
  /** Read blobs by id. Missing ids are left out of the result. */
  readBlobs(ids: string[]): Promise<Map<string, Uint8Array>>;
  /** Apply a batch atomically: all of it or none of it. */
  commit(batch: WorkspaceBatch): Promise<void>;
  /**
   * Delete blobs no entry references. Called by Nodepod between commits,
   * never concurrently with one. Optional; without it unreferenced blobs
   * stay until `clear()`.
   */
  sweep?(): Promise<void>;
  /** Delete the stored workspace. */
  clear(): Promise<void>;
  close?(): void;
}

export interface PersistenceOptions {
  /** Workspace key. Distinct ids are independent workspaces on the same origin. */
  id: string;
  /**
   * Where to save. Defaults to IndexedDB in browsers and a directory under
   * the host cache dir on Node.
   */
  store?: WorkspaceStore;
  /** Directory names never persisted, at any depth. Default `["node_modules", ".cache", ".npm"]`. */
  excludeDirNames?: string[];
  /** Extra filter; return true to skip a path. `/tmp` and `/.nodepod` are always skipped. */
  exclude?: (path: string) => boolean;
  /**
   * When `files` from the boot options are written. `"if-empty"` (default)
   * only seeds a workspace that has never been saved; `"always"` writes them
   * over the restored state on every boot.
   */
  seed?: "if-empty" | "always";
  /** Reinstall dependencies from package.json after restoring. Default true. */
  autoInstall?: boolean;
  /**
   * What to do when another tab already holds this workspace. `"error"`
   * (default) makes boot throw `EWORKSPACELOCKED`; `"steal"` takes it over
   * and the other tab stops saving.
   */
  lock?: "error" | "steal";
  /** Ask the browser not to evict this origin's storage. Default false. */
  requestPersistentStorage?: boolean;
  /** Quiet time before changes are saved. Default 250ms. */
  debounceMs?: number;
}

export type PersistenceStatus = "idle" | "pending" | "saving" | "error" | "closed";

export interface PersistenceSavedEvent {
  entries: number;
  bytes: number;
}
