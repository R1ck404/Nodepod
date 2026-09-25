// Build-tool caches that live inside node_modules (Vite's pre-bundled
// dependencies in node_modules/.vite) survive across sessions the way they
// do on disk: saved into the package snapshot cache next to the pack they
// were built from, and restored when `npm install` restores that pack.
//
// The key is the installed tree (node_modules/.package-lock.json), so a
// cache only comes back on top of the exact packages it was built from.
// Whether it is still valid for the project is the tool's own call: Vite
// compares the lockfile and config hashes in deps/_metadata.json and
// re-optimizes on any mismatch, like it does with a cache on disk.

import type { MemoryVolume } from "../memory-volume";
import type { IDBSnapshotCache } from "./idb-cache";
import {
  collectBinarySnapshotParts,
  saveSnapshotParts,
  type BinarySnapshotParts,
} from "./binary-snapshot";
import { contentDigest } from "../helpers/digest";

const SCHEMA = 1;
const CACHE_DIR = ".vite";
// a complete cache has this file; a tool that is still writing doesn't
const COMPLETE_MARKER = "deps/_metadata.json";
// in-flight output (Vite writes deps_temp_<hash> and renames it to deps)
const TEMP_DIR = /^deps_temp/;
const MAX_BYTES = 96 * 1024 * 1024;
const SAVE_DELAY_MS = 600;

function lockfilePath(nodeModules: string): string {
  return `${nodeModules}/.package-lock.json`;
}

/** Cache key for the tool caches built on top of this node_modules, or null. */
export async function toolCacheKey(vol: MemoryVolume, nodeModules: string): Promise<string | null> {
  const lockPath = lockfilePath(nodeModules);
  let lock: string;
  try {
    // a restored tree can be paged out (memory.evictPackageContent): bring
    // the lockfile in rather than read it synchronously
    if (vol.isPagedOut(lockPath)) await vol.ensureResident(lockPath);
    lock = vol.readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  return `toolcache:${SCHEMA}:${contentDigest(nodeModules + "\0" + lock)}`;
}

/** The tool cache under `nodeModules`, or null if there is none worth keeping. */
export function snapshotToolCache(vol: MemoryVolume, nodeModules: string): BinarySnapshotParts | null {
  const root = `${nodeModules}/${CACHE_DIR}`;
  try {
    if (!vol.statSync(`${root}/${COMPLETE_MARKER}`).isFile()) return null;
  } catch {
    return null;
  }
  const snapshot = collectBinarySnapshotParts(
    vol,
    (p) => !TEMP_DIR.test(p.slice(root.length + 1)),
    root,
  );
  if (snapshot.byteLength > MAX_BYTES) return null;
  snapshot.manifest.unshift({ path: root, offset: 0, length: 0, isDirectory: true });
  return snapshot;
}

/**
 * Restore the tool cache saved for this node_modules, if there is one and
 * the volume has none yet. Returns the number of entries restored.
 */
export async function restoreToolCache(
  vol: MemoryVolume,
  cache: IDBSnapshotCache,
  nodeModules: string,
): Promise<number> {
  const key = await toolCacheKey(vol, nodeModules);
  if (!key) return 0;
  const snapshot = await cache.get(key);
  if (!snapshot || !snapshot.manifest.length) return 0;
  const root = `${nodeModules}/${CACHE_DIR}`;
  // a cache this session already has is newer than the saved one
  if (vol.existsSync(root)) return 0;
  // every entry must sit under the cache dir: never touch anything else
  if (!snapshot.manifest.every((e) => e.path === root || e.path.startsWith(root + "/"))) return 0;
  return vol.mountBinarySnapshot(snapshot);
}

/**
 * Watches the volume for tool cache writes and saves each cache once its
 * writer has been quiet for a moment. Returns a disposer.
 */
export function watchToolCaches(vol: MemoryVolume, cache: IDBSnapshotCache): () => void {
  const marker = `/node_modules/${CACHE_DIR}/`;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  const save = async (nodeModules: string): Promise<void> => {
    timers.delete(nodeModules);
    if (disposed) return;
    try {
      const key = await toolCacheKey(vol, nodeModules);
      if (!key || disposed) return;
      const snapshot = snapshotToolCache(vol, nodeModules);
      if (snapshot) void saveSnapshotParts(cache, key, snapshot).catch(() => {});
    } catch {
      /* best effort */
    }
  };

  const off = vol.onGlobalChange((path) => {
    const at = path.indexOf(marker);
    if (at < 0) return;
    const nodeModules = path.slice(0, at + "/node_modules".length);
    const pending = timers.get(nodeModules);
    if (pending) clearTimeout(pending);
    timers.set(nodeModules, setTimeout(() => void save(nodeModules), SAVE_DELAY_MS));
  });

  return () => {
    disposed = true;
    off();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
