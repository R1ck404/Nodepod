// read-only fs client for sibling workers. on main call
// nodepod.sharedFSBuffer, postMessage it to the worker, then on the worker
// side do Nodepod.attachFS(buffer) and you get this. reads hit the shared
// buffer directly so there's no IPC per call.
//
// writes aren't supported (the canonical MemoryVolume lives on the main
// thread, a sibling writing directly would desync it). send write requests
// back over a MessagePort if you need them.

import { SharedVFSReader } from "../threading/shared-vfs.js";
import type { SharedVFSStat } from "../threading/shared-vfs.js";

export class NodepodFSClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "NodepodFSClientError";
  }
}

function notSupported(op: string): never {
  throw new NodepodFSClientError(
    "ENOTSUP",
    `NodepodFSClient is read-only, ${op}() not supported from a sibling worker. ` +
      `route the call back to the thread that booted nodepod and use nodepod.fs.${op}() there.`,
  );
}

export class NodepodFSClient {
  constructor(private _reader: SharedVFSReader) {}

  async readFile(path: string, encoding: "utf-8" | "utf8"): Promise<string>;
  async readFile(path: string): Promise<Uint8Array>;
  async readFile(path: string, encoding?: string): Promise<string | Uint8Array> {
    const bytes = this._reader.readFileSync(path);
    if (bytes === null) {
      throw new NodepodFSClientError("ENOENT", `ENOENT: no such file, open '${path}'`);
    }
    if (encoding === "utf8" || encoding === "utf-8") {
      // reader already returns a non-shared copy, so TextDecoder is happy
      return new TextDecoder().decode(bytes);
    }
    return bytes;
  }

  async exists(path: string): Promise<boolean> {
    return this._reader.existsSync(path);
  }

  async stat(path: string): Promise<SharedVFSStat> {
    const s = this._reader.statSync(path);
    if (s === null) {
      throw new NodepodFSClientError("ENOENT", `ENOENT: no such file or directory, stat '${path}'`);
    }
    return s;
  }

  async readdir(path: string): Promise<string[]> {
    // match node: scandir on missing path throws ENOENT (except root)
    if (!this._reader.existsSync(path) && path !== "/") {
      throw new NodepodFSClientError("ENOENT", `ENOENT: no such file or directory, scandir '${path}'`);
    }
    return this._reader.readdirSync(path);
  }

  /** SAB version counter, bumped on every write/delete. */
  get version(): number {
    return this._reader.version;
  }

  /**
   * Block until the version changes or timeout. returns the new version, or
   * -1 on timeout. don't call this on a browser main thread, Atomics.wait
   * throws there.
   */
  waitForChange(currentVersion: number, timeoutMs: number = 5000): number {
    return this._reader.waitForChange(currentVersion, timeoutMs);
  }

  async writeFile(_path: string, _data: string | Uint8Array): Promise<void> {
    notSupported("writeFile");
  }
  async mkdir(_path: string, _opts?: { recursive?: boolean }): Promise<void> {
    notSupported("mkdir");
  }
  async unlink(_path: string): Promise<void> {
    notSupported("unlink");
  }
  async rmdir(_path: string, _opts?: { recursive?: boolean }): Promise<void> {
    notSupported("rmdir");
  }
  async rename(_from: string, _to: string): Promise<void> {
    notSupported("rename");
  }
  async appendFile(_path: string, _data: string | Uint8Array): Promise<void> {
    notSupported("appendFile");
  }

  /** escape hatch if you need the sync reader directly */
  get reader(): SharedVFSReader {
    return this._reader;
  }
}
