// Flat binary snapshots for the persistence layer: one ArrayBuffer of file
// contents plus an offset manifest — no base64 inflation, IDB stores the
// buffer natively. Same wire shape as the spawn snapshot (VFSBinarySnapshot)
// but built/applied with a path filter so it can carry just node_modules.

import type { MemoryVolume } from "../memory-volume";
import type { VFSBinarySnapshot } from "../threading/worker-protocol";
import type { IDBSnapshotCache } from "./idb-cache";

// Collect all paths matching `filter` into a binary snapshot. Directories
// matching the filter are recorded as empty entries so restores can recreate
// empty dirs.
export function createFilteredBinarySnapshot(
  vol: MemoryVolume,
  filter: (path: string) => boolean,
  // only this subtree is walked (the filter still decides what's kept)
  root = "/",
): VFSBinarySnapshot {
  return joinSnapshotParts(collectBinarySnapshotParts(vol, filter, root));
}

/** A snapshot's manifest and its files' bytes, not yet joined into one buffer. */
export interface BinarySnapshotParts {
  manifest: VFSBinarySnapshot["manifest"];
  parts: Uint8Array[];
  byteLength: number;
}

export function collectBinarySnapshotParts(
  vol: MemoryVolume,
  filter: (path: string) => boolean,
  root = "/",
): BinarySnapshotParts {
  const manifest: VFSBinarySnapshot["manifest"] = [];
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = vol.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const fullPath = dir === "/" ? `/${name}` : `${dir}/${name}`;
      let stat;
      try {
        stat = vol.lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (filter(fullPath)) {
          manifest.push({
            path: fullPath,
            offset: 0,
            length: 0,
            isDirectory: true,
            inode: stat.ino,
            mode: stat.mode,
            atimeMs: stat.atimeMs,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
            nlink: stat.nlink,
          });
        }
        walk(fullPath);
      } else if (stat.isSymbolicLink()) {
        if (filter(fullPath)) {
          manifest.push({
            path: fullPath,
            offset: totalSize,
            length: 0,
            isDirectory: false,
            symlinkTarget: vol.readlinkSync(fullPath),
          });
        }
      } else if (filter(fullPath)) {
        let content: Uint8Array;
        try {
          // a bulk copy: packed package files stay packed
          content = vol.peekFileSync(fullPath);
        } catch {
          continue;
        }
        manifest.push({
          path: fullPath,
          offset: totalSize,
          length: content.byteLength,
          isDirectory: false,
          inode: stat.ino,
          mode: stat.mode,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          nlink: stat.nlink,
        });
        chunks.push(content);
        totalSize += content.byteLength;
      }
    }
  };
  walk(root);

  return { manifest, parts: chunks, byteLength: totalSize };
}

export function joinSnapshotParts(snapshot: BinarySnapshotParts): VFSBinarySnapshot {
  const data = new ArrayBuffer(snapshot.byteLength);
  const view = new Uint8Array(data);
  let offset = 0;
  for (const chunk of snapshot.parts) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { manifest: snapshot.manifest, data };
}

/** Store a snapshot, joining its parts only if the cache can't take them as they are. */
export function saveSnapshotParts(cache: IDBSnapshotCache, key: string, snapshot: BinarySnapshotParts): Promise<void> {
  if (cache.setParts) return cache.setParts(key, snapshot.manifest, snapshot.parts, snapshot.byteLength);
  return cache.set(key, joinSnapshotParts(snapshot));
}

// Merge a binary snapshot into a live volume: creates dirs/files from the
// snapshot, overwrites files it carries, leaves everything else untouched.
// (fromBinarySnapshot builds a NEW volume — the spawn path keeps that
// semantics; this is the merge-into-existing variant.)
export function restoreBinarySnapshot(
  vol: MemoryVolume,
  snapshot: VFSBinarySnapshot,
): number {
  return vol.mountBinarySnapshot(snapshot);
}
