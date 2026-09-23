// Path helpers shared by the persistence controller and stores.

import { isInternalVfsPath } from "../../constants/internal-vfs-paths";
import type { WorkspaceBatch } from "./types";

export const DEFAULT_EXCLUDED_DIR_NAMES = ["node_modules", ".cache", ".npm"];

/** true when a batch touches entries (not just blobs sent ahead of them) */
export function changesTree(batch: WorkspaceBatch): boolean {
  return batch.putEntries.length > 0 || batch.deletePaths.length > 0 || batch.deletePrefixes.length > 0;
}

/** true when `path` is `prefix` itself or lies below it */
export function isUnderOrAt(path: string, prefix: string): boolean {
  if (prefix === "/") return true;
  return path === prefix || (path.startsWith(prefix) && path.charCodeAt(prefix.length) === 47);
}

// Builds the "never persist this" predicate. Runs for every mutation of the
// volume (npm install included), so it is a single pass over the path with
// no allocation beyond the segment substring.
export function createPathFilter(
  excludeDirNames: readonly string[],
  exclude?: (path: string) => boolean,
): (path: string) => boolean {
  const names = new Set(excludeDirNames);
  return (path: string): boolean => {
    if (path === "/" || isUnderOrAt(path, "/tmp") || isInternalVfsPath(path)) return true;
    let start = 1;
    const len = path.length;
    while (start < len) {
      let end = path.indexOf("/", start);
      if (end === -1) end = len;
      if (names.has(path.substring(start, end))) return true;
      start = end + 1;
    }
    if (!exclude) return false;
    // excluding a directory excludes everything below it
    for (let i = path.indexOf("/", 1); i !== -1; i = path.indexOf("/", i + 1)) {
      if (exclude(path.slice(0, i))) return true;
    }
    return exclude(path);
  };
}
