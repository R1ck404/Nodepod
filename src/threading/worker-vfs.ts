// worker-side filesystem proxy
// reads are instant from a local Map, writes go to both the local store and main thread

import type { VFSBinarySnapshot, VFSSnapshotEntry } from "./worker-protocol.js";

export class WorkerVFS {
  private _files = new Map<string, Uint8Array>();
  private _dirs = new Set<string>();
  private _onWrite: ((path: string, content: Uint8Array, isDir: boolean) => void) | null = null;
  private _onDelete: ((path: string) => void) | null = null;
  private _decoder = new TextDecoder();
  private _encoder = new TextEncoder();

  constructor() {
    this._dirs.add("/");
  }

  initFromSnapshot(snapshot: VFSBinarySnapshot): void {
    const data = new Uint8Array(snapshot.data);

    for (const entry of snapshot.manifest) {
      if (entry.isDirectory) {
        this._dirs.add(entry.path);
      } else {
        this._files.set(entry.path, data.slice(entry.offset, entry.offset + entry.length));
        this._ensureParentDirs(entry.path);
      }
    }
  }

  setWriteCallback(cb: (path: string, content: Uint8Array, isDir: boolean) => void): void {
    this._onWrite = cb;
  }

  setDeleteCallback(cb: (path: string) => void): void {
    this._onDelete = cb;
  }

  readFileSync(path: string, encoding?: string): string | Uint8Array {
    const data = this._files.get(path);
    if (!data) {
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & { code: string; errno: number };
      err.code = "ENOENT";
      err.errno = -2;
      throw err;
    }
    if (encoding === "utf8" || encoding === "utf-8") {
      // defensive copy — TextDecoder rejects SAB-backed views, snapshots usually come via postMessage (non-shared) but worker VFS can be initialized from shared memory in some paths
      if (typeof SharedArrayBuffer !== "undefined" && data.buffer instanceof SharedArrayBuffer) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        return this._decoder.decode(copy);
      }
      return this._decoder.decode(data);
    }
    return new Uint8Array(data);
  }

  existsSync(path: string): boolean {
    return this._files.has(path) || this._dirs.has(path);
  }

  statSync(path: string): { isFile: () => boolean; isDirectory: () => boolean; size: number } {
    if (this._dirs.has(path)) {
      return {
        isFile: () => false,
        isDirectory: () => true,
        size: 0,
      };
    }
    const data = this._files.get(path);
    if (data) {
      return {
        isFile: () => true,
        isDirectory: () => false,
        size: data.byteLength,
      };
    }
    const err = new Error(`ENOENT: no such file or directory, stat '${path}'`) as Error & { code: string; errno: number };
    err.code = "ENOENT";
    err.errno = -2;
    throw err;
  }

  readdirSync(path: string): string[] {
    if (!this._dirs.has(path)) {
      const err = new Error(`ENOENT: no such file or directory, scandir '${path}'`) as Error & { code: string; errno: number };
      err.code = "ENOENT";
      err.errno = -2;
      throw err;
    }

    const prefix = path === "/" ? "/" : path + "/";
    const entries = new Set<string>();

    for (const filePath of this._files.keys()) {
      if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        const slashIdx = rest.indexOf("/");
        entries.add(slashIdx === -1 ? rest : rest.slice(0, slashIdx));
      }
    }

    for (const dirPath of this._dirs) {
      if (dirPath.startsWith(prefix) && dirPath !== path) {
        const rest = dirPath.slice(prefix.length);
        const slashIdx = rest.indexOf("/");
        entries.add(slashIdx === -1 ? rest : rest.slice(0, slashIdx));
      }
    }

    return Array.from(entries).filter(Boolean).sort();
  }

  writeFileSync(path: string, content: string | Uint8Array): void {
    const bytes = typeof content === "string" ? this._encoder.encode(content) : new Uint8Array(content);
    this._files.set(path, bytes);
    this._ensureParentDirs(path);
    if (this._onWrite) this._onWrite(path, bytes, false);
  }

  mkdirSync(path: string, opts?: { recursive?: boolean }): void {
    if (this._dirs.has(path)) return;
    if (opts?.recursive) {
      const parts = path.split("/").filter(Boolean);
      let current = "";
      for (const part of parts) {
        current += "/" + part;
        if (!this._dirs.has(current)) {
          this._dirs.add(current);
          if (this._onWrite) this._onWrite(current, new Uint8Array(0), true);
        }
      }
    } else {
      this._dirs.add(path);
      if (this._onWrite) this._onWrite(path, new Uint8Array(0), true);
    }
  }

  unlinkSync(path: string): void {
    if (!this._files.has(path)) {
      const err = new Error(`ENOENT: no such file or directory, unlink '${path}'`) as Error & { code: string; errno: number };
      err.code = "ENOENT";
      err.errno = -2;
      throw err;
    }
    this._files.delete(path);
    if (this._onDelete) this._onDelete(path);
  }

  rmdirSync(path: string): void {
    this._dirs.delete(path);
    if (this._onDelete) this._onDelete(path);
  }

  renameSync(src: string, dest: string): void {
    const data = this._files.get(src);
    if (data) {
      this._files.delete(src);
      this._files.set(dest, data);
      if (this._onDelete) this._onDelete(src);
      if (this._onWrite) this._onWrite(dest, data, false);
    } else if (this._dirs.has(src)) {
      this._dirs.delete(src);
      this._dirs.add(dest);
      if (this._onDelete) this._onDelete(src);
      if (this._onWrite) this._onWrite(dest, new Uint8Array(0), true);
    }
  }

  appendFileSync(path: string, content: string | Uint8Array): void {
    const existing = this._files.get(path) ?? new Uint8Array(0);
    const bytes = typeof content === "string" ? this._encoder.encode(content) : new Uint8Array(content);
    const merged = new Uint8Array(existing.byteLength + bytes.byteLength);
    merged.set(existing, 0);
    merged.set(bytes, existing.byteLength);
    this._files.set(path, merged);
    this._ensureParentDirs(path);
    if (this._onWrite) this._onWrite(path, merged, false);
  }

  copyFileSync(src: string, dest: string): void {
    const data = this._files.get(src);
    if (!data) {
      const err = new Error(`ENOENT: no such file or directory, copyfile '${src}'`) as Error & { code: string; errno: number };
      err.code = "ENOENT";
      err.errno = -2;
      throw err;
    }
    const copy = new Uint8Array(data);
    this._files.set(dest, copy);
    this._ensureParentDirs(dest);
    if (this._onWrite) this._onWrite(dest, copy, false);
  }

  applySync(path: string, content: ArrayBuffer | null, isDirectory: boolean): void {
    if (content === null) {
      this._files.delete(path);
      this._dirs.delete(path);
    } else if (isDirectory) {
      this._dirs.add(path);
    } else {
      this._files.set(path, new Uint8Array(content));
      this._ensureParentDirs(path);
    }
  }

  private _ensureParentDirs(path: string): void {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      this._dirs.add(current);
    }
  }

  get fileCount(): number {
    return this._files.size;
  }

  get dirCount(): number {
    return this._dirs.size;
  }
}
