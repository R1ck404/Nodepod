// Flat binary snapshots for the persistence layer: one ArrayBuffer of file
// contents plus an offset manifest — no base64 inflation, IDB stores the
// buffer natively. Same wire shape as the spawn snapshot (VFSBinarySnapshot)
// but built/applied with a path filter so it can carry just node_modules.

import type { MemoryVolume } from "../memory-volume";
import type { VFSBinarySnapshot } from "../threading/worker-protocol";

// Collect all paths matching `filter` into a binary snapshot. Directories
// matching the filter are recorded as empty entries so restores can recreate
// empty dirs.
export function createFilteredBinarySnapshot(
  vol: MemoryVolume,
  filter: (path: string) => boolean,
): VFSBinarySnapshot {
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
      let isDir = false;
      try {
        isDir = vol.statSync(fullPath).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (filter(fullPath)) {
          manifest.push({ path: fullPath, offset: 0, length: 0, isDirectory: true });
        }
        walk(fullPath);
      } else if (filter(fullPath)) {
        let content: Uint8Array;
        try {
          content = vol.readFileSync(fullPath);
        } catch {
          continue;
        }
        manifest.push({
          path: fullPath,
          offset: totalSize,
          length: content.byteLength,
          isDirectory: false,
        });
        chunks.push(content);
        totalSize += content.byteLength;
      }
    }
  };
  walk("/");

  const data = new ArrayBuffer(totalSize);
  const view = new Uint8Array(data);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { manifest, data };
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
