import { describe, it, expect } from "vitest";
import { MemoryVolume } from "../memory-volume";
import type { IVolume, VolumeWriteData } from "../types/volume";
import type { FileStat, FileWatchHandle, WatchCallback } from "../memory-volume";
import type { VolumeSnapshot } from "../engine-types";

/**
 * A minimal in-memory IVolume implementation that delegates to MemoryVolume.
 * Used to verify the abstraction is wired through Nodepod.boot({ volume })
 * without depending on IndexedDB (which vitest's node env doesn't have).
 */
class DelegatingVolume implements IVolume {
  private _mem = new MemoryVolume();

  existsSync(p: string): boolean { return this._mem.existsSync(p); }
  statSync(p: string): FileStat { return this._mem.statSync(p); }
  lstatSync(p: string): FileStat { return this._mem.lstatSync(p); }
  accessSync(p: string, mode?: number): void { return this._mem.accessSync(p, mode); }
  readFileSync(p: string): Uint8Array;
  readFileSync(p: string, encoding: "utf8" | "utf-8"): string;
  readFileSync(p: string, encoding?: "utf8" | "utf-8"): Uint8Array | string {
    return this._mem.readFileSync(p, encoding as any);
  }
  writeFileSync(p: string, data: VolumeWriteData): void { this._mem.writeFileSync(p, data as any); }
  appendFileSync(p: string, data: VolumeWriteData): void { this._mem.appendFileSync(p, data as any); }
  truncateSync(p: string, len?: number): void { this._mem.truncateSync(p, len); }
  copyFileSync(src: string, dest: string): void { this._mem.copyFileSync(src, dest); }
  mkdirSync(p: string, options?: { recursive?: boolean }): void { this._mem.mkdirSync(p, options); }
  readdirSync(p: string): string[] { return this._mem.readdirSync(p); }
  rmdirSync(p: string): void { this._mem.rmdirSync(p); }
  symlinkSync(target: string, linkPath: string, type?: string): void { this._mem.symlinkSync(target, linkPath, type); }
  readlinkSync(p: string): string { return this._mem.readlinkSync(p); }
  linkSync(existingPath: string, newPath: string): void { this._mem.linkSync(existingPath, newPath); }
  realpathSync(p: string): string { return this._mem.realpathSync(p); }
  unlinkSync(p: string): void { this._mem.unlinkSync(p); }
  renameSync(from: string, to: string): void { this._mem.renameSync(from, to); }
  chmodSync(p: string, mode: number): void { this._mem.chmodSync(p, mode); }
  chownSync(p: string, uid: number, gid: number): void { this._mem.chownSync(p, uid, gid); }
  readFile(p: string, optionsOrCb?: any, cb?: any): void { this._mem.readFile(p, optionsOrCb, cb); }
  stat(p: string, cb?: (err: Error | null, stats?: FileStat) => void): void { this._mem.stat(p, cb); }
  lstat(p: string, cb?: (err: Error | null, stats?: FileStat) => void): void { this._mem.lstat(p, cb); }
  readdir(p: string, optionsOrCb?: any, cb?: any): void { this._mem.readdir(p, optionsOrCb, cb); }
  realpath(p: string, cb?: (err: Error | null, resolved?: string) => void): void { this._mem.realpath(p, cb); }
  access(p: string, modeOrCb?: any, cb?: any): void { this._mem.access(p, modeOrCb, cb); }
  watch(target: string, optionsOrCb?: any, cb?: WatchCallback): FileWatchHandle {
    return this._mem.watch(target, optionsOrCb, cb);
  }
  on(event: string, handler: (...args: any[]) => void): this {
    (this._mem.on as any)(event, handler);
    return this;
  }
  off(event: string, handler: (...args: any[]) => void): this {
    (this._mem.off as any)(event, handler);
    return this;
  }
  onGlobalChange(cb: (path: string, event: string) => void): () => void {
    return this._mem.onGlobalChange(cb);
  }
  createReadStream(p: string) { return this._mem.createReadStream(p); }
  createWriteStream(p: string) { return this._mem.createWriteStream(p); }
  toSnapshot(excludePrefixes?: string[], excludeDirNames?: Set<string>): VolumeSnapshot {
    return this._mem.toSnapshot(excludePrefixes, excludeDirNames);
  }
  replaceFromSnapshot(snapshot: VolumeSnapshot): void { this._mem.replaceFromSnapshot(snapshot); }
  getStats() { return this._mem.getStats(); }
  dispose(): void { this._mem.dispose(); }
}

describe("IVolume abstraction", () => {
  it("MemoryVolume implements IVolume (structural assignability)", () => {
    const vol: IVolume = new MemoryVolume();
    expect(vol).toBeInstanceOf(MemoryVolume);
  });

  it("a custom IVolume implementation can be used in place of MemoryVolume", () => {
    const vol: IVolume = new DelegatingVolume();
    vol.writeFileSync("/a.txt", "hello");
    expect(vol.existsSync("/a.txt")).toBe(true);
    expect(vol.readFileSync("/a.txt", "utf8")).toBe("hello");
    vol.mkdirSync("/dir", { recursive: true });
    vol.writeFileSync("/dir/b.txt", "world");
    expect(vol.readdirSync("/dir")).toEqual(["b.txt"]);
    vol.unlinkSync("/a.txt");
    expect(vol.existsSync("/a.txt")).toBe(false);
  });

  it("replaceFromSnapshot swaps contents via the public contract", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/old.txt", "old");
    const snap: VolumeSnapshot = {
      entries: [
        { path: "/new.txt", kind: "file", data: btoa("new") },
        { path: "/sub", kind: "directory" },
      ],
    };
    vol.replaceFromSnapshot(snap);
    expect(vol.existsSync("/old.txt")).toBe(false);
    expect(vol.readFileSync("/new.txt", "utf8")).toBe("new");
    expect(vol.existsSync("/sub")).toBe(true);
  });

  it("NodepodOptions accepts a volume field (type-level wiring)", async () => {
    // Verify the option is accepted by the type system and that an IVolume
    // is assignable to it. We don't call Nodepod.boot() here because it pulls
    // in process-manager.ts which depends on the vite build-time virtual
    // module `virtual:process-worker-bundle` (unavailable in vitest's node
    // env). The full boot path is exercised by the browser examples.
    const opts: import("../sdk/types").NodepodOptions = {
      volume: new DelegatingVolume(),
      serviceWorker: false,
      enableSharedArrayBuffer: false,
    };
    expect(opts.volume).toBeInstanceOf(DelegatingVolume);
    expect(typeof opts.volume?.writeFileSync).toBe("function");
  });
});
