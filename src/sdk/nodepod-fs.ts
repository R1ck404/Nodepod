// Async facade over MemoryVolume. Returns Promises even though the
// underlying VFS is synchronous -- keeps the public API consistent.

import type { MemoryVolume } from "../memory-volume";
import type { StatResult } from "./types";

export class NodepodFS {
  constructor(private _vol: MemoryVolume) {}

  // Auto-creates parent dirs on write
  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const dir = path.substring(0, path.lastIndexOf("/")) || "/";
    if (dir !== "/" && !this._vol.existsSync(dir)) {
      this._vol.mkdirSync(dir, { recursive: true });
    }
    this._vol.writeFileSync(path, data as any);
  }

  async readFile(path: string, encoding?: "utf-8" | "utf8"): Promise<string>;
  async readFile(path: string): Promise<Uint8Array>;
  async readFile(
    path: string,
    encoding?: string,
  ): Promise<string | Uint8Array> {
    if (encoding) return this._vol.readFileSync(path, "utf8") as string;
    return this._vol.readFileSync(path) as any;
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    this._vol.mkdirSync(path, opts);
  }

  async readdir(path: string): Promise<string[]> {
    return this._vol.readdirSync(path) as string[];
  }

  async exists(path: string): Promise<boolean> {
    return this._vol.existsSync(path);
  }

  async stat(path: string): Promise<StatResult> {
    const s = this._vol.statSync(path);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtime: s.mtimeMs ?? Date.now(),
    };
  }

  async unlink(path: string): Promise<void> {
    this._vol.unlinkSync(path);
  }

  async rmdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    if (opts?.recursive) {
      this._removeRecursive(path);
    } else {
      this._vol.rmdirSync(path);
    }
  }

  async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const exists = this._vol.existsSync(path);
    if (!exists) {
      if (opts?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }
    const st = this._vol.statSync(path);
    if (st.isDirectory()) {
      if (opts?.recursive) this._removeRecursive(path);
      else this._vol.rmdirSync(path);
    } else {
      this._vol.unlinkSync(path);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    this._vol.renameSync(from, to);
  }

  watch(
    path: string,
    optionsOrCb?:
      | { recursive?: boolean }
      | ((event: string, filename: string | null) => void),
    cb?: (event: string, filename: string | null) => void,
  ): { close(): void } {
    if (typeof optionsOrCb === "function") {
      return this._vol.watch(path, optionsOrCb);
    }
    return this._vol.watch(path, optionsOrCb ?? {}, cb!);
  }

  get volume(): MemoryVolume {
    return this._vol;
  }

  private _removeRecursive(dir: string): void {
    for (const name of this._vol.readdirSync(dir) as string[]) {
      const full = `${dir}/${name}`;
      const st = this._vol.statSync(full);
      if (st.isDirectory()) this._removeRecursive(full);
      else this._vol.unlinkSync(full);
    }
    this._vol.rmdirSync(dir);
  }
}
