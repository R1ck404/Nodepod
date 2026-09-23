// Pages package content in and out of the main-thread volume.
//
// Installed packages are cached as packs (manifest + one data blob). With
// eviction on, a restored pack is mounted from its manifest only: every
// file is a stub pointing at its byte range, and MemoryVolume reads the
// range back through this source when something needs the bytes. The pack's
// data buffer is never held in memory as a whole.

import type { BinaryVolumeEntry, MemoryVolume, MountEntry, VolumeContentSource } from "../memory-volume";
import type { IDBSnapshotCache, PackHead } from "./idb-cache";
import type { VFSSnapshotEntry } from "../threading/worker-protocol";

// concurrent range reads while mounting a pack's pinned files
const PINNED_READ_CONCURRENCY = 32;

export type PackReader = Required<Pick<IDBSnapshotCache, "getManifest" | "readRange">>;

export function canPageFrom(cache: IDBSnapshotCache | null | undefined): cache is IDBSnapshotCache & PackReader {
  return !!cache && typeof cache.getManifest === "function" && typeof cache.readRange === "function";
}

/**
 * Files that stay resident: main-thread code (the installer, bin stubs,
 * lockfile) reads package manifests synchronously.
 */
export function isPinnedPackPath(path: string): boolean {
  return path.endsWith("/package.json");
}

export class PackContentSource implements VolumeContentSource {
  private _reader: PackReader;
  private _packs: Array<{ key: string; version: string }> = [];
  private _ids = new Map<string, number>();

  constructor(reader: PackReader) {
    this._reader = reader;
  }

  /** Stable small id for one version of a pack, used in ContentRef.pack. */
  register(key: string, version: string): number {
    const name = `${key}\u0000${version}`;
    let id = this._ids.get(name);
    if (id === undefined) {
      id = this._packs.length;
      this._packs.push({ key, version });
      this._ids.set(name, id);
    }
    return id;
  }

  async read(pack: number, offset: number, length: number): Promise<Uint8Array> {
    const entry = this._packs[pack];
    const bytes = entry ? await this._reader.readRange(entry.key, entry.version, offset, length) : null;
    if (!bytes || bytes.byteLength !== length) {
      throw new Error(`[Nodepod] package pack ${entry?.key ?? pack} is missing, rewritten or truncated`);
    }
    return bytes;
  }

  /**
   * Mount a cached pack without loading its data: pinned files are read now,
   * everything else becomes a paged-out stub.
   */
  async mountPaged(volume: MemoryVolume, key: string, head: PackHead): Promise<number> {
    const { manifest } = head;
    const pack = this.register(key, head.version);
    const pinned = manifest.filter(
      (e) => !e.isDirectory && e.symlinkTarget === undefined && isPinnedPackPath(e.path),
    );
    const pinnedContent = new Map<string, Uint8Array>();
    for (let i = 0; i < pinned.length; i += PINNED_READ_CONCURRENCY) {
      await Promise.all(pinned.slice(i, i + PINNED_READ_CONCURRENCY).map(async (e) => {
        pinnedContent.set(e.path, await this.read(pack, e.offset, e.length));
      }));
    }
    return volume.mountEntries(manifest.map((e) => toMountEntry(e, pack, pinnedContent)));
  }
}

function toMountEntry(
  entry: VFSSnapshotEntry,
  pack: number,
  pinnedContent: Map<string, Uint8Array>,
): MountEntry {
  if (entry.isDirectory) {
    return { path: entry.path, kind: "directory", mode: entry.mode, mtimeMs: entry.mtimeMs };
  }
  if (entry.symlinkTarget !== undefined) {
    return {
      path: entry.path,
      kind: "symlink",
      target: entry.symlinkTarget,
      mode: entry.mode,
      atimeMs: entry.atimeMs,
      mtimeMs: entry.mtimeMs,
    };
  }
  const content = pinnedContent.get(entry.path);
  return {
    path: entry.path,
    kind: "file",
    content,
    src: content ? undefined : { pack, offset: entry.offset, length: entry.length },
    linkGroup: (entry.nlink ?? 1) > 1 ? entry.inode : undefined,
    mode: entry.mode,
    atimeMs: entry.atimeMs,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
    nlink: entry.nlink,
  };
}

/**
 * A pack a worker already mounted into the main volume in full (worker-side
 * `npm install` cache hit): page its files out again so the forwarded data
 * buffer can be collected. Only files still backed by exactly that buffer
 * are touched, so anything written since is left alone.
 */
export function adoptMountedPack(
  volume: MemoryVolume,
  source: PackContentSource,
  key: string,
  head: PackHead,
  manifest: ReadonlyArray<BinaryVolumeEntry>,
  buffer: ArrayBufferLike,
): number {
  // only if the cached pack is the one the worker mounted
  if (!sameManifest(head.manifest, manifest)) return 0;
  return volume.adoptPackContent(source.register(key, head.version), manifest, buffer, isPinnedPackPath);
}

function sameManifest(a: ReadonlyArray<VFSSnapshotEntry>, b: ReadonlyArray<BinaryVolumeEntry>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.path !== y.path || x.offset !== y.offset || x.length !== y.length || x.isDirectory !== y.isDirectory) {
      return false;
    }
  }
  return true;
}
