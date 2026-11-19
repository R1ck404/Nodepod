// Regression tests for the bugs found in the 2026-11 code audit: one block
// per fix, each failing on the code before it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync as nodeGzipSync } from "node:zlib";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { MemoryVolume } from "../memory-volume";
import { ScriptEngine } from "../script-engine";
import { buildFileSystemBridge } from "../polyfills/fs";
import { promisify } from "../polyfills/util";
import { setTimeout as podSetTimeout, setImmediate as podSetImmediate, clearTimeout as podClearTimeout } from "../polyfills/timers";
import { exec, execFile, promises as cpPromises } from "../polyfills/child_process";
import { buildProcessEnv, setProcessKillRouter } from "../polyfills/process";
import * as zlib from "../polyfills/zlib";
import { Buffer } from "../polyfills/buffer";
import { getRegistry } from "../helpers/event-loop";
import { offload, TaskPriority } from "../threading/offload";
import { getProxyInstance, disposeProxy } from "../request-proxy";
import { spawnEngine } from "../engine-factory";
import { WorkerSandbox } from "../worker-sandbox";

// one-file USTAR archive, as npm packs it ("package/" prefix)
function tarball(name: string, body: string): Uint8Array {
  const data = Buffer.from(body);
  const header = new Uint8Array(512);
  const put = (s: string, off: number) => header.set(Buffer.from(s), off);
  put(name, 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(data.length.toString(8).padStart(11, "0") + "\0", 124);
  put("00000000000\0", 136);
  header[156] = 48; // '0' regular file
  put("ustar\0", 257);
  put("00", 263);
  for (let i = 148; i < 156; i++) header[i] = 32;
  let sum = 0;
  for (const b of header) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const body512 = new Uint8Array(Math.ceil(data.length / 512) * 512);
  body512.set(data);
  const out = new Uint8Array(512 + body512.length + 1024);
  out.set(header);
  out.set(body512, 512);
  return new Uint8Array(nodeGzipSync(out));
}

function engineWith(files: Record<string, string> = {}) {
  const vol = new MemoryVolume();
  vol.mkdirSync("/project", { recursive: true });
  for (const [p, c] of Object.entries(files)) vol.writeFileSync(p, c);
  return new ScriptEngine(vol, { cwd: "/project" });
}

describe("tarball integrity on the main-thread extract path", () => {
  const gz = tarball("package/index.js", "module.exports = 1;\n");
  const sha1 = createHash("sha1").update(gz).digest("hex");
  const task = (expectedShasum: string) => ({
    type: "extract" as const,
    id: 1,
    tarballUrl: "https://registry.example/pkg.tgz",
    stripComponents: 1,
    priority: TaskPriority.NORMAL,
    expectedShasum,
    tarballBytes: gz.slice().buffer,
  });

  it("rejects a tarball whose SHA-1 doesn't match instead of installing it", async () => {
    await expect(offload(task("0".repeat(40)))).rejects.toThrow(/Integrity check failed/);
  });

  it("extracts a tarball whose SHA-1 matches", async () => {
    const result = await offload(task(sha1));
    expect(result.files.map((f) => f.path)).toEqual(["index.js"]);
  });
});

describe("util.promisify", () => {
  it("uses a function's util.promisify.custom implementation", async () => {
    const fn: any = (cb: (e: Error | null, v: number) => void) => cb(null, 1);
    fn[promisify.custom] = () => Promise.resolve("custom");
    expect(promisify.custom).toBe(Symbol.for("nodejs.util.promisify.custom"));
    await expect(promisify(fn)()).resolves.toBe("custom");
  });

  it("calls the original with the promisified function's this", async () => {
    const obj = {
      value: 7,
      get(cb: (e: Error | null, v: number) => void) {
        cb(null, this.value);
      },
    };
    const get = promisify(obj.get);
    await expect(get.call(obj)).resolves.toBe(7);
  });

  it("exec/execFile resolve with { stdout, stderr } and setTimeout/setImmediate with the value", async () => {
    expect(promisify(exec)).toBe(cpPromises.exec);
    expect(promisify(execFile)).toBe(cpPromises.execFile);
    await expect((promisify(podSetTimeout) as any)(1, "late")).resolves.toBe("late");
    await expect((promisify(podSetImmediate) as any)("soon")).resolves.toBe("soon");
  });
});

describe("Timeout.refresh()", () => {
  it("re-arms a timer from inside its own callback, and keeps the loop alive again", async () => {
    let fired = 0;
    await new Promise<void>((resolve) => {
      const t = podSetTimeout(() => {
        fired++;
        if (fired < 3) t.refresh();
        else resolve();
      }, 1);
    });
    expect(fired).toBe(3);
  });

  it("counts a refreshed one-shot timer as a ref'd handle again", async () => {
    const t = podSetTimeout(() => {}, 1);
    await new Promise((r) => globalThis.setTimeout(r, 10));
    const before = getRegistry().activeRefedCount();
    t.refresh();
    expect(getRegistry().activeRefedCount()).toBe(before + 1);
    podClearTimeout(t);
    expect(getRegistry().activeRefedCount()).toBe(before);
  });

  it("does not revive a cleared timer", async () => {
    let fired = 0;
    const t = podSetTimeout(() => fired++, 1);
    podClearTimeout(t);
    t.refresh();
    await new Promise((r) => globalThis.setTimeout(r, 15));
    expect(fired).toBe(0);
  });
});

describe("process.kill", () => {
  afterEach(() => setProcessKillRouter(null));

  it("signal 0 probes the own pid without delivering anything", () => {
    const proc = buildProcessEnv({ pid: 4242 });
    const onTerm = vi.fn();
    proc.on("SIGTERM", onTerm);
    expect(proc.kill(4242, 0)).toBe(true);
    expect(onTerm).not.toHaveBeenCalled();
  });

  it("delivers a named or numeric signal to itself", () => {
    const proc = buildProcessEnv({ pid: 4242 });
    const onUsr2 = vi.fn();
    const onInt = vi.fn();
    proc.on("SIGUSR2", onUsr2);
    proc.on("SIGINT", onInt);
    proc.kill(4242, "SIGUSR2");
    proc.kill(4242, 2);
    expect(onUsr2).toHaveBeenCalledOnce();
    expect(onInt).toHaveBeenCalledOnce();
  });

  it("routes other pids to their owner and never signals the caller", () => {
    const proc = buildProcessEnv({ pid: 4242 });
    const onTerm = vi.fn();
    proc.on("SIGTERM", onTerm);
    const routed: Array<[number, string | 0]> = [];
    setProcessKillRouter((pid, sig) => {
      if (pid !== 7) return null;
      routed.push([pid, sig]);
      return true;
    });
    expect(proc.kill(7)).toBe(true);
    expect(proc.kill(7, 0)).toBe(true);
    expect(routed).toEqual([[7, "SIGTERM"], [7, 0]]);
    expect(() => proc.kill(8, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(onTerm).not.toHaveBeenCalled();
  });

  it("rejects unknown signals", () => {
    const proc = buildProcessEnv({ pid: 4242 });
    expect(() => proc.kill(4242, "SIGNOPE")).toThrow(expect.objectContaining({ code: "ERR_UNKNOWN_SIGNAL" }));
  });
});

describe("assert/strict", () => {
  it("require('assert/strict') compares with ===", () => {
    const engine = engineWith();
    const out = engine.execute(`
      const assert = require('assert/strict');
      let threw = false;
      try { assert.equal(1, '1'); } catch { threw = true; }
      let deepThrew = false;
      try { assert.deepEqual({ a: 1 }, { a: '1' }); } catch { deepThrew = true; }
      module.exports = { threw, deepThrew, same: require('node:assert/strict') === require('assert').strict };
    `, "/project/a.js");
    expect(out.exports).toEqual({ threw: true, deepThrew: true, same: true });
  });
});

describe("fs readdir { recursive: true }", () => {
  function tree() {
    const vol = new MemoryVolume();
    vol.mkdirSync("/r/a/b", { recursive: true });
    vol.writeFileSync("/r/top.txt", "1");
    vol.writeFileSync("/r/a/mid.txt", "2");
    vol.writeFileSync("/r/a/b/deep.txt", "3");
    return buildFileSystemBridge(vol);
  }
  const expected = ["a", "a/b", "a/b/deep.txt", "a/mid.txt", "top.txt"];

  it("readdirSync lists every descendant as a relative path", () => {
    const fs = tree();
    expect((fs.readdirSync("/r", { recursive: true }) as string[]).slice().sort()).toEqual(expected);
  });

  it("withFileTypes gives each Dirent its own parentPath", () => {
    const fs = tree();
    const dirents = fs.readdirSync("/r", { recursive: true, withFileTypes: true }) as any[];
    const deep = dirents.find((d) => d.name === "deep.txt");
    expect(deep.parentPath).toBe("/r/a/b");
    expect(dirents).toHaveLength(5);
  });

  it("the promise and callback forms agree", async () => {
    const fs = tree();
    expect(((await fs.promises.readdir("/r", { recursive: true })) as string[]).slice().sort()).toEqual(expected);
    const viaCb = await new Promise<string[]>((resolve, reject) =>
      fs.readdir("/r", { recursive: true }, (err, files) => (err ? reject(err) : resolve(files as string[]))),
    );
    expect(viaCb.slice().sort()).toEqual(expected);
  });

  it("without recursive still lists one level", () => {
    const fs = tree();
    expect((fs.readdirSync("/r") as string[]).slice().sort()).toEqual(["a", "top.txt"]);
  });
});

describe("zlib one-shot APIs", () => {
  const text = "hello hello hello hello";

  it("accept an options argument before the callback, and call back asynchronously", async () => {
    let sync = true;
    const out = await new Promise<Buffer>((resolve, reject) => {
      zlib.gzip(text, { level: 9 }, (err, res) => {
        expect(sync).toBe(false);
        err ? reject(err) : resolve(res);
      });
      sync = false;
    });
    expect(zlib.gunzipSync(out).toString()).toBe(text);
  });

  it("pass options through the sync and promise forms", async () => {
    const raw = zlib.deflateRawSync(text, { level: 1 });
    expect(zlib.inflateRawSync(raw).toString()).toBe(text);
    const gz = await zlib.promises.gzip(text, { level: 1 });
    expect((await zlib.promises.gunzip(gz)).toString()).toBe(text);
  });

  it("unzip detects gzip and deflate", async () => {
    expect(zlib.unzipSync(zlib.gzipSync(text)).toString()).toBe(text);
    expect(zlib.unzipSync(zlib.deflateSync(text)).toString()).toBe(text);
    const viaCb = await new Promise<Buffer>((resolve, reject) =>
      zlib.unzip(zlib.gzipSync(text), (err, res) => (err ? reject(err) : resolve(res))),
    );
    expect(viaCb.toString()).toBe(text);
  });

  it("reports corrupt input as an Error through the callback", async () => {
    const err = await new Promise<Error | null>((resolve) =>
      zlib.gunzip(Buffer.from("not gzip"), (e) => resolve(e)),
    );
    expect(err).toBeInstanceOf(Error);
  });

  it("crc32 matches Node", () => {
    expect(zlib.crc32("hello")).toBe(907060870);
    expect(zlib.crc32("world", zlib.crc32("hello "))).toBe(zlib.crc32("hello world"));
  });
});

describe("snapshot cache open when another tab blocks the upgrade", () => {
  const saved = { indexedDB: (globalThis as any).indexedDB, IDBKeyRange: (globalThis as any).IDBKeyRange };
  afterEach(() => {
    (globalThis as any).indexedDB = saved.indexedDB;
    (globalThis as any).IDBKeyRange = saved.IDBKeyRange;
  });

  it("resolves (without a cache) instead of hanging", async () => {
    const factory = new IDBFactory();
    (globalThis as any).indexedDB = factory;
    (globalThis as any).IDBKeyRange = IDBKeyRange;
    // an older build's connection that never closes on versionchange
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open("nodepod-snapshots", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const { openSnapshotCache } = await import("../persistence/idb-cache");
    const result = await Promise.race([
      openSnapshotCache(),
      new Promise((resolve) => globalThis.setTimeout(() => resolve("hung"), 2000)),
    ]);
    expect(result).toBeNull();
    old.close();
  });
});

describe("disposeProxy", () => {
  it("stops the heartbeat and WS channel and forgets the singleton", () => {
    const proxy = getProxyInstance() as any;
    const heartbeat = globalThis.setInterval(() => {}, 60_000);
    const channel = new BroadcastChannel("nodepod-ws-test");
    const close = vi.spyOn(channel, "close");
    const clear = vi.spyOn(globalThis, "clearInterval");
    proxy.heartbeat = heartbeat;
    proxy._wsBridge = channel;
    disposeProxy();
    expect(clear).toHaveBeenCalledWith(heartbeat);
    expect(close).toHaveBeenCalled();
    expect(proxy.heartbeat).toBeNull();
    expect(getProxyInstance()).not.toBe(proxy);
    clear.mockRestore();
    disposeProxy();
  });
});

describe("WorkerSandbox when its worker can't load", () => {
  const savedWorker = (globalThis as any).Worker;
  afterEach(() => {
    (globalThis as any).Worker = savedWorker;
  });

  class MissingWorker extends EventTarget {
    static urls: string[] = [];
    constructor(url: string | URL) {
      super();
      MissingWorker.urls.push(String(url));
      queueMicrotask(() => {
        this.dispatchEvent(Object.assign(new Event("error"), { message: "404 Not Found" }));
      });
    }
    postMessage(): void {}
    terminate(): void {}
    start(): void {}
  }

  it("rejects instead of waiting forever", async () => {
    (globalThis as any).Worker = MissingWorker;
    const sandbox = new WorkerSandbox(new MemoryVolume());
    await expect(sandbox.execute("module.exports = 1")).rejects.toThrow(/failed to start: 404 Not Found/);
    sandbox.terminate();
  });

  it("uses an explicit workerUrl", async () => {
    (globalThis as any).Worker = MissingWorker;
    MissingWorker.urls.length = 0;
    const sandbox = new WorkerSandbox(new MemoryVolume(), { workerUrl: "https://cdn.example/engine.js" });
    await sandbox.execute("1").catch(() => {});
    expect(MissingWorker.urls).toEqual(["https://cdn.example/engine.js"]);
    sandbox.terminate();
  });

  it("spawnEngine({ useWorker: 'auto' }) falls back to the main thread; true reports the failure", async () => {
    (globalThis as any).Worker = MissingWorker;
    const auto = await spawnEngine(new MemoryVolume(), { allowUnsafeEval: true, useWorker: "auto" });
    expect((await auto.execute("module.exports = 6 * 7", "/x.js")).exports).toBe(42);
    await expect(
      spawnEngine(new MemoryVolume(), { allowUnsafeEval: true, useWorker: true }),
    ).rejects.toThrow(/failed to start/);
  });
});
