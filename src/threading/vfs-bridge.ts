// syncs the canonical MemoryVolume with worker VFS clones
// creates snapshots for init, applies worker writes, broadcasts changes

import type { MemoryVolume } from "../memory-volume";
import { isInternalVfsPath } from "../constants/internal-vfs-paths";
import type { VFSBinarySnapshot, VFSSnapshotEntry } from "./worker-protocol";
import type { SharedVFSController } from "./shared-vfs";

const VFS_CHUNK_SIZE = 4 * 1024 * 1024; // 4MB

export class VFSBridge {
  private _volume: MemoryVolume;
  private _broadcaster: ((path: string, content: ArrayBuffer | null, excludePid: number) => void) | null = null;
  private _sharedVFS: SharedVFSController | null = null;
  // suppressed during handleWorkerWrite/Mkdir/Delete to prevent double-broadcasting
  private _suppressWatch = false;
  private _warnedSharedVFSDrop = false;

  constructor(volume: MemoryVolume) {
    this._volume = volume;
  }

  setBroadcaster(fn: (path: string, content: ArrayBuffer | null, excludePid: number) => void): void {
    this._broadcaster = fn;
  }

  setSharedVFS(controller: SharedVFSController, hydrate = false): void {
    this._sharedVFS = controller;
    if (hydrate) this._hydrateSharedVFS();
  }

  clearSharedVFS(): void {
    this._sharedVFS = null;
  }

  private _hydrateSharedVFS(): void {
    this._walkVolume("/", (path, isDirectory, content) => {
      if (isDirectory) this._sharedVFSWriteDirectory(path);
      else if (content) this._sharedVFSWrite(path, content);
    });
  }

  // packs all files into one ArrayBuffer plus a manifest.
  // excludeDirNames (lean spawn mode): directories with these names are
  // recorded as empty dir entries but not descended into — the worker
  // hydrates their contents lazily via the fs proxy.
  createSnapshot(opts?: { excludeDirNames?: string[] }): VFSBinarySnapshot {
    const manifest: VFSSnapshotEntry[] = [];
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    const exclude =
      opts?.excludeDirNames && opts.excludeDirNames.length > 0
        ? new Set(opts.excludeDirNames)
        : null;

    this._walkVolume("/", (path, isDirectory, content) => {
      if (isDirectory) {
        manifest.push({
          path,
          offset: 0,
          length: 0,
          isDirectory: true,
        });
      } else if (content) {
        manifest.push({
          path,
          offset: totalSize,
          length: content.byteLength,
          isDirectory: false,
        });
        chunks.push(content);
        totalSize += content.byteLength;
      }
    }, exclude);

    const data = new ArrayBuffer(totalSize);
    const view = new Uint8Array(data);
    let offset = 0;
    for (const chunk of chunks) {
      view.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const snapshot: VFSBinarySnapshot = { manifest, data };
    if (exclude) snapshot.lazyDirNames = opts!.excludeDirNames!.slice();
    return snapshot;
  }

  // split into chunks for large transfers
  createChunkedSnapshots(): { chunkIndex: number; totalChunks: number; data: ArrayBuffer; manifest: VFSSnapshotEntry[] }[] {
    const fullSnapshot = this.createSnapshot();
    const totalSize = fullSnapshot.data.byteLength;

    if (totalSize <= VFS_CHUNK_SIZE) {
      return [{
        chunkIndex: 0,
        totalChunks: 1,
        data: fullSnapshot.data,
        manifest: fullSnapshot.manifest,
      }];
    }

    const chunks: { chunkIndex: number; totalChunks: number; data: ArrayBuffer; manifest: VFSSnapshotEntry[] }[] = [];
    const fullData = new Uint8Array(fullSnapshot.data);
    const totalChunks = Math.ceil(totalSize / VFS_CHUNK_SIZE);

    let currentOffset = 0;
    for (let i = 0; i < totalChunks; i++) {
      const chunkEnd = Math.min(currentOffset + VFS_CHUNK_SIZE, totalSize);
      const chunkData = fullData.slice(currentOffset, chunkEnd);

      const chunkManifest = fullSnapshot.manifest.filter(entry => {
        if (entry.isDirectory) return i === 0;
        return entry.offset >= currentOffset && entry.offset < chunkEnd;
      }).map(entry => ({
        ...entry,
        offset: entry.isDirectory ? 0 : entry.offset - currentOffset,
      }));

      // defensive copy — fullSnapshot.data is a plain ArrayBuffer today, but this keeps chunks transferable if the source ever becomes SAB-backed
      const chunkBuffer = new ArrayBuffer(chunkData.byteLength);
      new Uint8Array(chunkBuffer).set(chunkData);

      chunks.push({
        chunkIndex: i,
        totalChunks,
        data: chunkBuffer,
        manifest: chunkManifest,
      });

      currentOffset = chunkEnd;
    }

    return chunks;
  }

  handleWorkerWrite(path: string, content: Uint8Array): void {
    this._suppressWatch = true;
    try {
      const parentDir = path.substring(0, path.lastIndexOf("/")) || "/";
      if (parentDir !== "/" && !this._volume.existsSync(parentDir)) {
        this._volume.mkdirSync(parentDir, { recursive: true });
      }
      if (isInternalVfsPath(path)) {
        this._volume.writeCacheSync(path, content);
      } else {
        this._volume.writeFileSync(path, content);
      }
      if (this._sharedVFS) {
        this._sharedVFSWrite(path, content);
      }
    } finally {
      this._suppressWatch = false;
    }
  }

  handleWorkerSnapshot(snapshot: VFSBinarySnapshot): void {
    this._suppressWatch = true;
    try {
      this._volume.mountBinarySnapshot(snapshot, false);
      if (this._sharedVFS) this._hydrateSharedVFS();
    } finally {
      this._suppressWatch = false;
    }
  }

  // writeFile returns false on table/data exhaustion — silent drops mean
  // workers stop seeing updates, so surface it once per session
  private _sharedVFSWrite(path: string, content: Uint8Array): void {
    if (!this._sharedVFS!.writeFile(path, content)) {
      this._warnSharedVFSDrop(path);
    }
  }

  private _sharedVFSWriteDirectory(path: string): void {
    if (!this._sharedVFS!.writeDirectory(path)) {
      this._warnSharedVFSDrop(path);
    }
  }

  private _warnSharedVFSDrop(path: string): void {
    if (!this._warnedSharedVFSDrop) {
      this._warnedSharedVFSDrop = true;
      const stats = this._sharedVFS!.getStats();
      console.warn(
        `[VFSBridge] SharedVFS write dropped for "${path}" (entries: ${stats.entries}, data: ${stats.dataUsed}/${stats.bufferSize} bytes). ` +
          `Workers may see stale reads. Further drops counted in getStats().droppedWrites.`,
      );
    }
  }

  handleWorkerMkdir(path: string): void {
    this._suppressWatch = true;
    try {
      if (!this._volume.existsSync(path)) {
        this._volume.mkdirSync(path, { recursive: true });
      }
      if (this._sharedVFS) {
        this._sharedVFSWriteDirectory(path);
      }
    } finally {
      this._suppressWatch = false;
    }
  }

  handleWorkerDelete(path: string): void {
    this._suppressWatch = true;
    try {
      try {
        if (this._volume.existsSync(path)) {
          const stat = this._volume.statSync(path);
          if (stat.isDirectory()) {
            // recursive delete matching Node's fs.rmSync({ recursive: true })
            // workers may emit vfs-delete out of order (a rename's "from" fires before descendants are cleaned) or skip intermediate subdirs entirely — if the dir is still on main when a delete arrives, nuke it and everything under it
            this._rmTree(path);
          } else {
            this._volume.unlinkSync(path);
          }
        }
      } catch (e) {
        console.warn(`[VFSBridge] Failed to delete "${path}":`, e);
      }
      if (this._sharedVFS) {
        this._sharedVFS.deleteFile(path);
      }
    } finally {
      this._suppressWatch = false;
    }
  }

  // recursively remove a directory tree, mirroring fs.rmSync({ recursive: true })
  private _rmTree(path: string): void {
    let entries: string[] = [];
    try {
      entries = this._volume.readdirSync(path);
    } catch {
      // path already gone, or not a directory
    }
    for (const name of entries) {
      const child = path.endsWith("/") ? path + name : path + "/" + name;
      try {
        const childStat = this._volume.statSync(child);
        if (childStat.isDirectory()) {
          this._rmTree(child);
        } else {
          this._volume.unlinkSync(child);
        }
      } catch {
        // ignore per-entry errors, still try to remove the parent
      }
    }
    try {
      this._volume.rmdirSync(path);
    } catch (e) {
      // only re-throw if the directory is still there, otherwise it's a benign race
      if (this._volume.existsSync(path)) throw e;
    }
  }

  broadcastChange(path: string, content: ArrayBuffer | null, excludePid: number): void {
    if (isInternalVfsPath(path)) return;
    if (this._broadcaster) {
      this._broadcaster(path, content, excludePid);
    }
  }

  // watch the canonical volume and push changes to workers, returns unsubscribe fn
  watch(): () => void {
    const handle = this._volume.watch("/", { recursive: true }, (event, filename) => {
      if (!filename || this._suppressWatch) return;

      // watch callbacks get filenames relative to the watch root, so
      // writing /hello.txt while watching / comes through as "hello.txt".
      // SharedVFS and broadcast keys are absolute, promote it here.
      const absPath = filename.startsWith("/") ? filename : "/" + filename;
      if (isInternalVfsPath(absPath)) return;

      try {
        if (this._volume.existsSync(absPath)) {
          const stat = this._volume.statSync(absPath);
          if (stat.isDirectory()) {
            this.broadcastChange(absPath, new ArrayBuffer(0), -1);
            if (this._sharedVFS) this._sharedVFSWriteDirectory(absPath);
          } else {
            const data = this._volume.readFileSync(absPath);
            // fresh ArrayBuffer copy — VFS nodes may store SAB-backed Uint8Arrays when written from WASM threads, and SAB isn't transferable via postMessage
            const buffer = new ArrayBuffer(data.byteLength);
            new Uint8Array(buffer).set(data);
            this.broadcastChange(absPath, buffer, -1);
            if (this._sharedVFS) this._sharedVFSWrite(absPath, data);
          }
        } else {
          this.broadcastChange(absPath, null, -1);
          if (this._sharedVFS) this._sharedVFS.deleteFile(absPath);
        }
      } catch (e) {
        console.warn(`[VFSBridge] Watch error for "${absPath}":`, e);
      }
    });

    return () => handle.close();
  }

  private _walkVolume(
    dir: string,
    visitor: (path: string, isDirectory: boolean, content: Uint8Array | null) => void,
    excludeDirNames?: Set<string> | null,
  ): void {
    try {
      const entries = this._volume.readdirSync(dir);
      for (const name of entries) {
        const fullPath = dir === "/" ? `/${name}` : `${dir}/${name}`;
        if (isInternalVfsPath(fullPath)) continue;
        try {
          const stat = this._volume.statSync(fullPath);
          if (stat.isDirectory()) {
            visitor(fullPath, true, null);
            // record the dir itself but don't descend — worker fetches lazily
            if (excludeDirNames?.has(name)) continue;
            this._walkVolume(fullPath, visitor, excludeDirNames);
          } else {
            const content = this._volume.readFileSync(fullPath);
            visitor(fullPath, false, content);
          }
        } catch (e) {
          console.warn(`[VFSBridge] Failed to stat/read "${fullPath}":`, e);
        }
      }
    } catch (e) {
      console.warn(`[VFSBridge] Failed to read directory "${dir}":`, e);
    }
  }
}
