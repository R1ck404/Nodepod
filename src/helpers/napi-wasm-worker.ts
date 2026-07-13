/**
 * generic support for napi-rs WASM packages in nodepod
 *
 * every napi-rs v3 WASM package (targeting wasm32-wasip1-threads) ships a
 * wasi-worker.mjs that needs a real Web Worker so Atomics.wait() can block
 *
 * we:
 * 1. detect napi-rs WASI worker scripts
 * 2. bundle them + deps into self-contained blobs
 * 3. spawn real Web Workers wrapping the Node.js worker_threads API
 *
 * no hardcoding per package
 */

import type { MemoryVolume } from "../memory-volume";
import { EventEmitter } from "../polyfills/events";
import { getRegistry, type Handle } from "./event-loop";
import { esmToCjs } from "../syntax-transforms";

/**
 * true if scriptPath is a wasi-worker script in a node_modules package that
 * also has a .wasm file next to it (i.e. an napi-rs WASM package)
 *
 * napi-rs generates these names: wasi-worker.mjs and wasi-worker-browser.mjs
 */
export function isNapiWasiWorkerScript(
  scriptPath: string,
  vol: MemoryVolume,
): boolean {
  const base = scriptPath.split("/").pop() ?? "";
  if (base !== "wasi-worker.mjs" && base !== "wasi-worker-browser.mjs") {
    return false;
  }
  // containing dir must have a .wasm file
  const dir = scriptPath.substring(0, scriptPath.lastIndexOf("/"));
  try {
    const entries = vol.readdirSync(dir);
    return entries.some(
      (e: string) => e.endsWith(".wasm") || e.endsWith(".wasi.cjs"),
    );
  } catch {
    return false;
  }
}

/**
 * builds a self-contained Web Worker script from a VFS entry point
 * recursively resolves imports/requires and inlines everything
 */
export function buildNapiWorkerBundle(
  entryPath: string,
  vol: MemoryVolume,
  resolveModule: (id: string, fromDir: string) => string,
  processEnv: Record<string, string>,
): string {
  const modules = new Map<string, string>(); // resolvedPath -> source
  const moduleIds = new Map<string, number>(); // resolvedPath -> numeric id
  const moduleDeps = new Map<string, Map<string, string>>();
  let nextId = 0;
  const visited = new Set<string>();

  function collectDeps(filePath: string): void {
    if (visited.has(filePath)) return;
    visited.add(filePath);

    let source: string;
    try {
      const raw = vol.readFileSync(filePath);
      source =
        typeof raw === "string" ? raw : new TextDecoder().decode(raw as any);
    } catch {
      return; // skip unreadable files
    }

    const id = nextId++;
    moduleIds.set(filePath, id);
    modules.set(filePath, source);
    const deps = new Map<string, string>();
    moduleDeps.set(filePath, deps);

    // simplified regex, good enough for napi-rs deps
    const importRe =
      /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|export\s+.*?\s+from\s+['"]([^'"]+)['"])/g;
    let match: RegExpExecArray | null;
    const fromDir = filePath.substring(0, filePath.lastIndexOf("/")) || "/";

    while ((match = importRe.exec(source)) !== null) {
      const dep = match[1] || match[2] || match[3];
      if (!dep) continue;

      // Node.js builtins get stubs instead
      if (isBuiltin(dep)) continue;

      try {
        const resolved = resolveModule(dep, fromDir);
        if (resolved && !isBuiltin(resolved)) {
          deps.set(dep, resolved);
          collectDeps(resolved);
        }
      } catch {
        // unresolvable, handle at runtime
      }
    }
  }

  collectDeps(entryPath);

  const parts: string[] = [];

  parts.push(WORKER_PREAMBLE(processEnv));

  parts.push(`const __modules = {};`);
  parts.push(`const __moduleCache = {};`);

  // IMPORTANT: module source is stored as a STRING, not as a function body
  // V8's parser has a recursion limit that blows up when dozens of large
  // module sources are embedded as function bodies in one script. storing
  // as strings means V8 only parses top-level string assignments at load
  // time, and each module gets lazily compiled via `new Function()` on first
  // require
  for (const [filePath, source] of modules) {
    const id = moduleIds.get(filePath)!;
    const dir = filePath.substring(0, filePath.lastIndexOf("/")) || "/";

    // keep package module semantics intact. generated napi-rs workers commonly
    // import the runtime through ESM, where a missing export becomes a corrupt
    // WebAssembly import rather than a useful JavaScript error.
    const isESM = filePath.endsWith(".mjs") ||
      (/\b(import\s+[\w{*]|export\s+(default|const|let|var|function|class|\{|\*))\b/.test(source) &&
       !source.includes("module.exports") && !source.includes("exports.__esModule"));
    let transformed = isESM
      ? esmToCjs(source.replace(/\bimport\.meta\.url\b/g, JSON.stringify(`file://${filePath}`)))
      : source;

    // generated node workers create a local require solely for import.meta.url.
    // the wrapper supplies the resolver-backed require, which must stay live.
    transformed = transformed.replace(
      /(?:const|let|var)\s+require\s*=\s*createRequire\s*\([^)]*\)\s*;?/g,
      "/* require provided by wrapper */",
    );
    // self is already the browser worker global and is read-only.
    transformed = transformed.replace(
      /self:\s*globalThis\s*,?/g,
      "/* self already set in Worker */ ",
    );

    // escape for embedding as a template literal: backtick, backslash, ${
    const escaped = transformed
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$\{/g, "\\${");

    parts.push(
      `__modules[${id}] = { dir: ${JSON.stringify(dir)}, path: ${JSON.stringify(filePath)}, esm: ${isESM}, deps: ${JSON.stringify(Object.fromEntries(moduleDeps.get(filePath) ?? []))}, src: \`${escaped}\` };`,
    );
  }

  parts.push(`const __pathToId = ${JSON.stringify(Object.fromEntries([...moduleIds.entries()]))};`);

  parts.push(REQUIRE_IMPL);

  const entryId = moduleIds.get(entryPath);
  if (entryId !== undefined) {
    parts.push(`
try {
  __require(${entryId});
} catch(e) {
  console.error('[worker] Entry point failed:', e?.message || e);
  if (e?.stack) console.error(e.stack);
}
`);
  }

  return parts.join("\n");
}

let _nextWasiThreadId = 100;

// chrome silently drops `new Worker()` if the parent web worker is about to
// enter Atomics.wait (tailwind oxide does this back to back in
// instantiateNapiModuleSync). pre-spawn empty workers while the spawned
// process boots so theyre already running before anyone blocks, then inject
// the actual bundle via importScripts when napi-rs needs one.
const _wasiPool: globalThis.Worker[] = [];
const _WASI_POOL_TARGET = 4;
const _WASI_POOL_IDLE_MS = 30_000;
let _poolPreambleUrl: string | null = null;
let _wasiPoolIdleTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePoolExpiry(): void {
  if (_wasiPoolIdleTimer) clearTimeout(_wasiPoolIdleTimer);
  if (_wasiPool.length === 0) {
    _wasiPoolIdleTimer = null;
    return;
  }
  _wasiPoolIdleTimer = setTimeout(() => {
    _wasiPoolIdleTimer = null;
    for (const worker of _wasiPool.splice(0)) {
      try { worker.terminate(); } catch { /* ignore */ }
    }
  }, _WASI_POOL_IDLE_MS);
}

function getPoolPreambleUrl(): string {
  if (_poolPreambleUrl) return _poolPreambleUrl;
  const src = `
    self.onmessage = function(e) {
      var d = e && e.data;
      if (d && d.__nodepod_init_bundle__) {
        var url = d.bundleUrl;
        // stash transferred fs port for the bundle preamble to pick up
        if (d.fsPort) {
          globalThis.__nodepodWasiFsPort = d.fsPort;
          try { d.fsPort.start(); } catch (_) {}
        }
        try {
          self.onmessage = null;
          importScripts(url);
        } catch (err) {
          try { self.postMessage({ __nodepod_pool_err__: String(err && err.message || err) }); } catch (_) {}
        }
      }
    };
  `;
  const blob = new Blob([src], { type: "application/javascript" });
  _poolPreambleUrl = URL.createObjectURL(blob);
  return _poolPreambleUrl;
}

function refillPool(): void {
  while (_wasiPool.length < _WASI_POOL_TARGET) {
    try {
      _wasiPool.push(new globalThis.Worker(getPoolPreambleUrl(), { name: "wasi-pool" }));
    } catch {
      break;
    }
  }
  schedulePoolExpiry();
}

function pullFromPool(): globalThis.Worker | null {
  if (_wasiPool.length < _WASI_POOL_TARGET / 2) {
    queueMicrotask(refillPool);
  }
  const worker = _wasiPool.shift() ?? null;
  schedulePoolExpiry();
  return worker;
}

// call early in spawned-process boot, before anything blocks
export function prewarmWasiPool(): void {
  refillPool();
}

// MessagePort pool from the tab. each port is a 1:1 fs proxy channel for one
// WASI worker. sidesteps chrome dropping BroadcastChannel messages from blob
// workers, and works when the parent is in sync wasm (oxide.scan).
const _wasiFsPortPool: MessagePort[] = [];
export function setWasiFsPortPool(ports: MessagePort[]): void {
  _wasiFsPortPool.length = 0;
  for (const p of ports) _wasiFsPortPool.push(p);
}
function pullFsPort(): MessagePort | null {
  return _wasiFsPortPool.shift() ?? null;
}

/**
 * makes a PatchedWorker constructor that spawns real browser Web Workers for
 * napi-rs WASI scripts, falling back to the standard fork-based worker otherwise
 */
export function createNapiWorkerFactory(
  vol: MemoryVolume,
  resolveModule: (id: string, fromDir: string) => string,
  processEnv: Record<string, string>,
  fsBridge: any, // for handling __fs__ proxy messages
  fallbackWorkerFn: ((...args: any[]) => any) | null,
  sabEnabled: boolean,
) {
  // bundled scripts don't change at runtime, so cache per entry path
  const bundleCache = new Map<string, string>();

  return function PatchedWorkerConstructor(
    this: any,
    script: string | URL,
    opts?: any,
  ) {
    const scriptStr = typeof script === "string" ? script : script.href;
    const isWasi = isNapiWasiWorkerScript(scriptStr, vol);

    if (isWasi) {
      // threaded wasi needs SAB for Atomics.wait, would deadlock without it
      if (!sabEnabled) {
        queueMicrotask(() => {
          this.emit?.(
            "error",
            new Error(
              `[Nodepod] ${scriptStr} needs SharedArrayBuffer (threaded wasi module). ` +
                "enable COOP/COEP headers, or drop `enableSharedArrayBuffer: false` from NodepodOptions.",
            ),
          );
        });
        return;
      }
      return createRealWebWorker.call(
        this,
        scriptStr,
        opts,
        vol,
        resolveModule,
        processEnv,
        fsBridge,
        bundleCache,
      );
    }

    // non-WASI: fall back to standard fork-based worker
    if (!fallbackWorkerFn) {
      queueMicrotask(() => {
        this.emit?.(
          "error",
          new Error(
            "[Nodepod] worker_threads.Worker requires worker mode for non-WASI scripts.",
          ),
        );
      });
      return;
    }

    const workerDataVal = opts?.workerData ?? null;
    const isEval = !!opts?.eval;
    const env =
      opts?.env && typeof opts.env !== "symbol"
        ? (opts.env as Record<string, string>)
        : {};
    const self = this;

    const handle = fallbackWorkerFn(scriptStr, {
      workerData: workerDataVal,
      threadId: this.threadId,
      isEval,
      cwd: (globalThis as any).process?.cwd?.() ?? "/",
      env,
      onMessage: (data: unknown) => self.emit("message", data),
      onError: (err: Error) => self.emit("error", err),
      onExit: (code: number) => {
        (self._elHandle as Handle | null)?.close();
        self._elHandle = null;
        self._terminated = true;
        self.emit("exit", code);
      },
    });

    this._handle = handle;
    this._elHandle = getRegistry().register("Worker");
    queueMicrotask(() => {
      if (!self._terminated) self.emit("online");
    });
  };
}

/**
 * spawns a real browser Web Worker for an napi-rs WASI script
 * the worker gets a bundled copy of the script + all its npm deps,
 * plus polyfills for Node.js builtins (worker_threads, path, fs, etc)
 */
function createRealWebWorker(
  this: any,
  scriptPath: string,
  opts: any,
  vol: MemoryVolume,
  resolveModule: (id: string, fromDir: string) => string,
  processEnv: Record<string, string>,
  fsBridge: any,
  bundleCache: Map<string, string>,
) {
  const self = this;
  self.threadId = _nextWasiThreadId++;
  self.resourceLimits = {};
  self._handle = null;
  self._terminated = false;
  self._elHandle = null;

  let bundleSource = bundleCache.get(scriptPath);
  if (!bundleSource) {
    try {
      bundleSource = buildNapiWorkerBundle(
        scriptPath,
        vol,
        resolveModule,
        processEnv,
      );
      bundleCache.set(scriptPath, bundleSource);
    } catch (err: any) {
      queueMicrotask(() =>
        self.emit(
          "error",
          new Error(`Failed to bundle WASI worker: ${err.message}`),
        ),
      );
      return;
    }
  }

  let realWorker: globalThis.Worker;
  let blobUrl: string;
  try {
    const blob = new Blob([bundleSource], { type: "application/javascript" });
    blobUrl = URL.createObjectURL(blob);
  } catch (err: any) {
    queueMicrotask(() =>
      self.emit("error", new Error(`Failed to build WASI bundle: ${err.message}`)),
    );
    return;
  }

  // create the Chrome/Atomics reserve only when a threaded WASI worker is
  // actually requested. Ordinary Node processes retain no idle WASI workers.
  refillPool();
  const pooled = pullFromPool();
  if (pooled) {
    realWorker = pooled;
    const fsPort = pullFsPort();
    try {
      const initMsg: any = { __nodepod_init_bundle__: true, bundleUrl: blobUrl };
      if (fsPort) {
        initMsg.fsPort = fsPort;
        realWorker.postMessage(initMsg, [fsPort]);
      } else {
        realWorker.postMessage(initMsg);
      }
    } catch { /* ignore */ }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  } else {
    // pool empty, direct spawn. hits the chrome quirk if parent is about to
    // block but at least non-blocking cases still work.
    try {
      realWorker = new globalThis.Worker(blobUrl, { name: `napi-wasi-${self.threadId}` });
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    } catch (err: any) {
      queueMicrotask(() =>
        self.emit(
          "error",
          new Error(`Failed to create WASI Web Worker: ${err.message}`),
        ),
      );
      return;
    }
  }

  realWorker.onmessage = (e: MessageEvent) => {
    const data = e.data;
    if (data && typeof data === "object" && data.__fs__) {
      handleFsProxy(data.__fs__, fsBridge);
      return;
    }
    self.emit("message", data);
  };

  realWorker.onerror = (e: ErrorEvent) => {
    self.emit("error", new Error(e.message || "Worker error"));
    // web workers dont emit exit, fake one so the loop ref isnt leaked
    if (!self._terminated) {
      (self._elHandle as Handle | null)?.close();
      self._elHandle = null;
      self._terminated = true;
      try { self.emit("exit", 1); } catch { /* ignore */ }
    }
  };

  self._realWorker = realWorker;
  self.postMessage = (value: unknown, transferList?: unknown[]) => {
    if (!self._terminated) {
      realWorker.postMessage(value, transferList as Transferable[]);
    }
  };
  self.terminate = () => {
    if (!self._terminated) {
      (self._elHandle as Handle | null)?.close();
      self._elHandle = null;
      self._terminated = true;
      realWorker.terminate();
    }
    return Promise.resolve(0);
  };
  self.ref = () => {
    if (!self._terminated) (self._elHandle as Handle | null)?.ref();
    return self;
  };
  // napi-rs's wasi.cjs calls worker.unref() to mirror node behavior where the
  // http server keeps the loop alive. in nodepod the spawned process loop
  // would drain before vite even binds, so we ignore unref. terminate/onExit
  // still close the handle so the loop drains once the worker is done.
  self.unref = () => self;

  // start reffed like Node.js does
  self._elHandle = getRegistry().register("Worker");

  queueMicrotask(() => {
    if (!self._terminated) self.emit("online");
  });
}

// handles __fs__ messages from WASI workers. exported so Nodepod.boot can
// subscribe to the broadcast channel and service the same protocol from the
// browser tab when the spawned process is busy in sync WASM
export function handleFsProxy(
  req: { sab: Int32Array; type: string; payload: any[] },
  fsBridge: any,
): void {
  const { sab, type, payload } = req;
  const maxPayload = sab.buffer.byteLength - 16; // minus 16-byte header

  try {
    let result: any;
    if (type === "statMany") {
      const paths = Array.isArray(payload[0]) ? payload[0] : [];
      result = paths.map((path: string) => {
        try { return flattenProxyStat(fsBridge.statSync(path)); } catch { return null; }
      });
    } else if (type === "readdirWithTypes") {
      const dir = String(payload[0] ?? "/").replace(/\/$/, "") || "/";
      const entries = fsBridge.readdirSync(dir, { withFileTypes: true });
      result = entries.map((entry: any) => {
        const child = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
        let size = 0;
        if (typeof entry.isFile === "function" && entry.isFile()) {
          try { size = fsBridge.statSync(child).size ?? 0; } catch { /* stale entry */ }
        }
        return {
          name: entry.name,
          parentPath: entry.parentPath || entry.path,
          _isFile: typeof entry.isFile === "function" ? entry.isFile() : false,
          _isDir: typeof entry.isDirectory === "function" ? entry.isDirectory() : false,
          _isSymlink: typeof entry.isSymbolicLink === "function" ? entry.isSymbolicLink() : false,
          size,
        };
      });
    } else {
      const fn = fsBridge[type];
      if (typeof fn !== "function") throw new Error(`fs.${type} is not a function`);
      result = fn.apply(fsBridge, payload);
    }

    // flatten stat objects so they survive structured clone
    if ((type === "statSync" || type === "lstatSync") && result && typeof result.isFile === "function") {
      result = flattenProxyStat(result);
    }

    // flatten Dirent[] from readdirSync({withFileTypes:true}). structured
    // clone strips the prototype methods so the worker would otherwise get
    // [{name}, ...] with no type info, and rust readdir handlers panic.
    if (type === "readdirSync" && Array.isArray(result) && result.length > 0 && typeof result[0] === "object" && result[0] !== null && typeof (result[0] as any).isFile === "function") {
      result = (result as any[]).map((d) => ({
        name: d.name,
        parentPath: d.parentPath || d.path,
        _isFile: typeof d.isFile === "function" ? d.isFile() : false,
        _isDir: typeof d.isDirectory === "function" ? d.isDirectory() : false,
        _isSymlink: typeof d.isSymbolicLink === "function" ? d.isSymbolicLink() : false,
      }));
    }

    // encode into the SAB
    const encoded = encodeValue(result);
    const resultType = getValueType(result);

    Atomics.store(sab, 1, resultType);
    Atomics.store(sab, 2, encoded.byteLength);
    // payload goes after the 16-byte header
    const writeLen = Math.min(encoded.byteLength, maxPayload);
    const payloadView = new Uint8Array(sab.buffer, 16, writeLen);
    payloadView.set(encoded.subarray(0, writeLen));

    Atomics.store(sab, 0, 0); // success
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    const errCode = err?.code || "";
    const errObj = JSON.stringify({ message: errMsg, code: errCode });
    const encoded = new TextEncoder().encode(errObj);

    Atomics.store(sab, 1, 6); // type = json/object
    Atomics.store(sab, 2, encoded.byteLength);
    const writeLen = Math.min(encoded.byteLength, maxPayload);
    const payloadView = new Uint8Array(sab.buffer, 16, writeLen);
    payloadView.set(encoded.subarray(0, writeLen));

    Atomics.store(sab, 0, 1); // error
  } finally {
    Atomics.notify(sab, 0);
  }
}

function flattenProxyStat(result: any): any {
  return {
    size: result.size,
    mode: result.mode,
    nlink: result.nlink,
    uid: result.uid,
    gid: result.gid,
    dev: result.dev,
    ino: result.ino,
    rdev: result.rdev || 0,
    blksize: result.blksize || 4096,
    blocks: result.blocks || 0,
    mtimeMs: result.mtimeMs,
    atimeMs: result.atimeMs,
    ctimeMs: result.ctimeMs,
    birthtimeMs: result.birthtimeMs,
    _isFile: result.isFile(),
    _isDir: result.isDirectory(),
    _isSymlink: typeof result.isSymbolicLink === "function" ? result.isSymbolicLink() : false,
  };
}

function getValueType(v: unknown): number {
  if (v === undefined) return 0;
  if (v === null) return 1;
  if (typeof v === "boolean") return 2;
  if (typeof v === "number") return 3;
  if (typeof v === "string") return 4;
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return 5; // buffer
  if (typeof v === "bigint") return 9;
  return 6; // json/object
}

function encodeValue(v: unknown): Uint8Array {
  const enc = new TextEncoder();
  if (v === undefined || v === null) return new Uint8Array(0);
  if (typeof v === "boolean") return enc.encode(v ? "1" : "0");
  if (typeof v === "number") return enc.encode(String(v));
  if (typeof v === "string") return enc.encode(v);
  if (typeof v === "bigint") return enc.encode(v.toString());
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  // object, fall back to JSON
  try {
    return enc.encode(JSON.stringify(v));
  } catch {
    return enc.encode("{}");
  }
}

const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster",
  "console", "constants", "crypto", "dgram", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module",
  "net", "os", "path", "perf_hooks", "process", "punycode",
  "querystring", "readline", "repl", "stream", "string_decoder",
  "test", "timers", "tls", "trace_events", "tty", "url", "util",
  "v8", "vm", "wasi", "worker_threads", "zlib",
]);

function isBuiltin(id: string): boolean {
  const bare = id.replace(/^node:/, "");
  return NODE_BUILTINS.has(bare);
}

// worker preamble: minimal Node.js stubs for running inside a Web Worker
function WORKER_PREAMBLE(env: Record<string, string>): string {
  // Generated NAPI-RS loaders interpret zero as their default pool size. Use
  // one worker here; child-thread delegation remains owned by the parent.
  // rayon/tokio thread spawning goes via emnapi's child-thread delegation:
  // child posts 'spawn-thread' to main, main creates Worker, writes TID to SAB
  const workerEnv = {
    ...env,
    UV_THREADPOOL_SIZE: "1",
    NAPI_RS_ASYNC_WORK_POOL_SIZE: "1",
    EMNAPI_WORKER_POOL_SIZE: "1",
    // don't set RAYON_NUM_THREADS here - WASM reads environ from shared
    // memory (set by the main thread's _initialize), not this process.env
  };
  return `
// === nodepod napi-rs WASI worker preamble ===
"use strict";

// Save reference to native postMessage BEFORE any override.
// In a Web Worker, self === globalThis, so overriding globalThis.postMessage
// would shadow self.postMessage causing infinite recursion.
const __nativePostMessage = self.postMessage.bind(self);

// Bridge parentPort ↔ Web Worker message API
const __parentPortListeners = [];
const __parentPort = {
  on(event, fn) {
    if (event === 'message') __parentPortListeners.push(fn);
    return __parentPort;
  },
  once(event, fn) {
    if (event === 'message') {
      const wrapped = (data) => { fn(data); const idx = __parentPortListeners.indexOf(wrapped); if (idx >= 0) __parentPortListeners.splice(idx, 1); };
      __parentPortListeners.push(wrapped);
    }
    return __parentPort;
  },
  off(event, fn) {
    if (event === 'message') {
      const idx = __parentPortListeners.indexOf(fn);
      if (idx >= 0) __parentPortListeners.splice(idx, 1);
    }
    return __parentPort;
  },
  removeListener(event, fn) { return __parentPort.off(event, fn); },
  addListener(event, fn) { return __parentPort.on(event, fn); },
  emit(event, ...args) {
    if (event === 'message') __parentPortListeners.forEach(fn => fn(...args));
    return true;
  },
  postMessage(data, transfer) { __nativePostMessage(data, transfer || []); },
  ref() {},
  unref() {},
  removeAllListeners() { __parentPortListeners.length = 0; return __parentPort; },
};

// Process stub
const process = {
  env: ${JSON.stringify(workerEnv)},
  cwd() { return "/"; },
  platform: "wasi",
  arch: "wasm32",
  version: "v20.0.0",
  versions: { node: "20.0.0" },
  exit(code) { throw new Error("process.exit(" + code + ")"); },
  nextTick(fn, ...args) { queueMicrotask(() => fn(...args)); },
  stdout: { write(s) { console.log(s); }, isTTY: false },
  stderr: { write(s) { console.error(s); }, isTTY: false },
  pid: 1,
  ppid: 0,
  argv: [],
  execArgv: [],
};
globalThis.process = process;

// Web Worker globals that napi-rs wasi-worker expects.
// self is already globalThis in a Web Worker (read-only getter, cannot set).

// WASM THREADING: emnapi's child-thread delegation model
//
// In child-thread mode (childThread: true), emnapi's WASIThreads does NOT
// create Workers directly. When WASM code calls wasi_thread_spawn, emnapi:
//   1. Posts a 'spawn-thread' message to the main thread via postMessage
//   2. Blocks with Atomics.wait() on the errorOrTid struct in shared memory
//   3. Main thread receives the message, creates a new Worker, writes TID
//   4. Atomics.notify() wakes the child, which returns the TID to WASM
//
// This means child workers don't need the Worker constructor. We keep it
// disabled as a safety net (preventing accidental direct Worker creation).
// But we do NOT neuter wasi.thread-spawn — that would break the delegation.
const __DisabledWorker = class Worker {
  constructor() { throw new Error('Direct Worker creation not available in nodepod child worker (use emnapi child-thread delegation)'); }
};
try { Object.defineProperty(globalThis, 'Worker', { value: __DisabledWorker, writable: true, configurable: true }); } catch {}
try { globalThis.Worker = __DisabledWorker; } catch {}

// DO NOT intercept WebAssembly.Instance or WebAssembly.instantiate.
// emnapi's WASIThreads provides the wasi.thread-spawn import function.
// In child-thread mode, it delegates to the main thread via postMessage.
// Neutering it would make rayon/tokio thread creation fail with EAGAIN,
// causing "The global thread pool has not been initialized" panics.

try { if (!globalThis.importScripts) globalThis.importScripts = function(f) {}; } catch {};

// Message dispatch: route Web Worker messages to EXACTLY ONE handler path.
//
// CRITICAL: emnapi's ThreadMessageHandler._start(payload) has NO idempotence
// guard — it calls wasi_thread_start(tid, arg) every time it's invoked. If a
// 'start' message is dispatched twice, wasi_thread_start runs twice with the
// same (tid, arg), which corrupts per-thread TLS / reuses the stack and
// traps at "unreachable" or "memory access out of bounds".
//
// napi-rs ships TWO worker variants, each using a different delivery model:
//
//   1. wasi-worker.mjs (Node variant): registers parentPort.on('message',
//      data => globalThis.onmessage({data})). This is a TRAMPOLINE — the
//      parentPort listener re-dispatches to globalThis.onmessage.
//
//   2. wasi-worker-browser.mjs (browser variant): NO parentPort listener,
//      only sets globalThis.onmessage = handler.handle directly.
//
// Native Web Worker dispatch uses the event handler internal slot (set when
// the original prototype setter fired at line "self.onmessage = ...", before
// we defined our accessor below). That internal slot points to THIS function.
// Our accessor shadows JS reads/writes but does NOT update the internal slot.
//
// So: this function is the ONLY callback native dispatch invokes. We must
// pick ONE path — parentPort trampoline OR direct globalThis.onmessage — but
// never both.
self.onmessage = function(e) {
  if (__parentPortListeners.length > 0) {
    // Node variant: parentPort trampoline will call globalThis.onmessage
    for (const fn of __parentPortListeners) {
      try { fn(e.data); } catch (err) { console.error('[wasi-worker] parentPort listener error:', err); }
    }
  } else if (typeof globalThis.__userOnMessage === 'function') {
    // Browser variant: no trampoline, invoke globalThis.onmessage directly
    globalThis.__userOnMessage(e);
  }
};

// Override globalThis.onmessage setter to capture user handler.
// User code (wasi-worker.mjs/wasi-worker-browser.mjs) does:
//   globalThis.onmessage = function(e) { handler.handle(e); };
// We store the handler here. The native Web Worker dispatcher can't reach it
// (its internal slot points to the function assigned at line "self.onmessage
// = function(e)" above, which was stored via the prototype setter BEFORE this
// defineProperty shadowed the property). So the stored handler is invoked
// only by our dispatch above — exactly once per message.
let __userOnMessageFn = null;
Object.defineProperty(globalThis, 'onmessage', {
  get() { return __userOnMessageFn; },
  set(fn) {
    __userOnMessageFn = fn;
    globalThis.__userOnMessage = fn;
  },
  configurable: true,
});

globalThis.postMessage = function(data, transfer) {
  __nativePostMessage(data, transfer || []);
};

// Minimal require for node builtins used by wasi-worker scripts
const __builtinRequire = function(id) {
  const bare = id.replace(/^node:/, '');
  if (bare === 'worker_threads') {
    return {
      parentPort: __parentPort,
      isMainThread: false,
      workerData: null,
      threadId: ${_nextWasiThreadId},
      Worker: __DisabledWorker,
      MessageChannel: globalThis.MessageChannel || class MessageChannel {
        constructor() { this.port1 = {}; this.port2 = {}; }
      },
      MessagePort: class MessagePort {},
    };
  }
  if (bare === 'path') return __pathStub;
  if (bare === 'fs') return __fsStub;
  if (bare === 'fs/promises') return __fsStub.promises;
  if (bare === 'os') return __osStub;
  if (bare === 'url') return __urlStub;
  if (bare === 'util') return __utilStub;
  if (bare === 'events') return __eventsStub;
  if (bare === 'wasi') return __wasiStub;
  if (bare === 'buffer') return { Buffer: __BufferStub };
  if (bare === 'string_decoder') return { StringDecoder: class StringDecoder { write(buf) { return new TextDecoder().decode(buf); } end() { return ''; } } };
  if (bare === 'assert') return Object.assign(function assert(v, msg) { if (!v) throw new Error(msg || 'assertion failed'); }, { ok(v,m){if(!v) throw new Error(m);}, strictEqual(a,b,m){if(a!==b) throw new Error(m);}, deepStrictEqual(){} });
  if (bare === 'module') return { createRequire() { return __builtinRequire; } };
  if (bare === 'crypto') return {
    randomBytes(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; },
    createHash() { return { update() { return this; }, digest() { return ''; } }; },
    getRandomValues: crypto.getRandomValues.bind(crypto),
    subtle: crypto.subtle,
  };
  if (bare === 'stream') return __eventsStub; // minimal — EventEmitter base
  if (bare === 'child_process' || bare === 'net' || bare === 'tls' ||
      bare === 'http' || bare === 'https' || bare === 'http2' ||
      bare === 'dgram' || bare === 'dns' || bare === 'cluster' ||
      bare === 'inspector' || bare === 'repl' || bare === 'readline' ||
      bare === 'tty' || bare === 'v8' || bare === 'vm' ||
      bare === 'perf_hooks' || bare === 'async_hooks' || bare === 'trace_events') return {};
  // Return undefined for unknown modules so resolution falls through
  // to the bundled module search in __require / localRequire
  return undefined;
};

// path stub
const __pathStub = {
  join(...parts) { return parts.join('/').replace(/\\/\\/+/g, '/'); },
  resolve(...parts) { return __pathStub.join(...parts); },
  dirname(p) { return p.substring(0, p.lastIndexOf('/')) || '/'; },
  basename(p, ext) { const b = p.split('/').pop() || ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
  extname(p) { const d = p.lastIndexOf('.'); return d > p.lastIndexOf('/') ? p.slice(d) : ''; },
  normalize(p) { return p.replace(/\\/\\/+/g, '/'); },
  isAbsolute(p) { return p.startsWith('/'); },
  relative(from, to) { return to; },
  parse(p) {
    const lastSlash = p.lastIndexOf('/');
    const base = lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
    const dotIdx = base.lastIndexOf('.');
    return {
      root: p.startsWith('/') ? '/' : '',
      dir: lastSlash >= 0 ? p.slice(0, lastSlash) : '',
      base: base,
      ext: dotIdx > 0 ? base.slice(dotIdx) : '',
      name: dotIdx > 0 ? base.slice(0, dotIdx) : base,
    };
  },
  format(obj) { return (obj.dir ? obj.dir + '/' : '') + (obj.base || obj.name + (obj.ext || '')); },
  sep: '/',
  delimiter: ':',
  posix: null,
};
__pathStub.posix = __pathStub;

// fs proxy — synchronous FS operations forwarded to main thread via SharedArrayBuffer + Atomics.
// The main thread handles __fs__ messages using the real nodepod VFS (MemoryVolume).
// Protocol: worker creates a SAB, posts {__fs__: {sab, type, payload}}, then Atomics.wait().
// Main thread performs the op, writes result to SAB, Atomics.notify().
// Header layout (Int32Array view, first 16 bytes):
//   [0] = status: -1 = pending, 0 = success, 1 = error
//   [1] = result type: 0=undefined, 1=null, 2=bool, 3=number, 4=string, 5=buffer, 6=json, 9=bigint
//   [2] = payload byte length
//   [3] = reserved
const __FS_DEFAULT_SAB = 16 + 65536; // 16 header + 64KB payload (enough for most ops)

// fs proxy: try dedicated MessagePort first (transferred from tab via the pool
// init message, direct 1:1 channel, works in chrome where BC from blob workers
// is broken). fall through to BC (firefox path) and parent postMessage (works
// when parent isnt in sync wasm). first one to flip the SAB status wins.
const __wasiFsPort = globalThis.__nodepodWasiFsPort || null;
const __wasiFsBC = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('nodepod-wasi-fs') : null;
if (__wasiFsBC && typeof __wasiFsBC.unref === 'function') {
  try { __wasiFsBC.unref(); } catch {}
}

function __fsSyncCall(type, args, sabSize) {
  const size = sabSize || __FS_DEFAULT_SAB;
  const sab = new SharedArrayBuffer(size);
  const ctrl = new Int32Array(sab, 0, 4);
  Atomics.store(ctrl, 0, -1); // pending

  const message = { __fs__: { sab: ctrl, type: type, payload: args || [] } };

  if (__wasiFsPort) {
    try { __wasiFsPort.postMessage(message); } catch {}
  }
  if (__wasiFsBC) {
    try { __wasiFsBC.postMessage(message); } catch {}
  }
  __nativePostMessage(message);

  const result = Atomics.wait(ctrl, 0, -1, 30000); // 30s timeout
  if (result === 'timed-out') {
    throw Object.assign(new Error('fs.' + type + ' timed out (30s)'), { code: 'ETIMEDOUT' });
  }

  const status = Atomics.load(ctrl, 0);
  const resultType = Atomics.load(ctrl, 1);
  const payloadLen = Atomics.load(ctrl, 2);

  // Read payload bytes. The view is over a SharedArrayBuffer; TextDecoder
  // rejects shared views, so copy into a regular ArrayBuffer before decoding.
  const maxPayload = size - 16;
  const payloadView = payloadLen > 0 ? new Uint8Array(sab, 16, Math.min(payloadLen, maxPayload)) : null;
  const payloadCopy = payloadView ? new Uint8Array(payloadView.length) : null;
  if (payloadView && payloadCopy) payloadCopy.set(payloadView);
  const decodePayload = () => payloadCopy ? new TextDecoder().decode(payloadCopy) : '';

  if (status === 1) {
    // Error
    let errObj;
    try { errObj = JSON.parse(decodePayload()); } catch { errObj = { message: 'fs.' + type + ' failed' }; }
    const err = new Error(errObj.message || 'fs.' + type + ' failed');
    if (errObj.code) err.code = errObj.code;
    throw err;
  }

  // Decode result based on type
  if (resultType === 0) return undefined;
  if (resultType === 1) return null;
  if (resultType === 2) return decodePayload() === '1';
  if (resultType === 3) return Number(decodePayload());
  if (resultType === 4) return decodePayload();
  if (resultType === 5) return payloadCopy ? payloadCopy : new Uint8Array(0); // non-shared buffer copy
  if (resultType === 9) return BigInt(decodePayload());
  // json/object
  try { return JSON.parse(decodePayload()); } catch { return {}; }
}

// Get an appropriately-sized SAB for readFileSync — stat the file first to
// determine how large the response buffer needs to be.
function __fsReadFileSabSize(p) {
  try {
    const stat = __fsSyncCall('statSync', [p]);
    const fileSize = (stat && stat.size) || 0;
    // Add margin for encoding overhead + header
    return Math.max(__FS_DEFAULT_SAB, 16 + fileSize + 1024);
  } catch {
    return __FS_DEFAULT_SAB; // fallback
  }
}

// Build stat-like object with methods
function __makeStatObj(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const s = Object.assign({}, raw);
  // Reconstruct Date objects from timestamps
  if (s.mtimeMs) s.mtime = new Date(s.mtimeMs);
  if (s.atimeMs) s.atime = new Date(s.atimeMs);
  if (s.ctimeMs) s.ctime = new Date(s.ctimeMs);
  if (s.birthtimeMs) s.birthtime = new Date(s.birthtimeMs);
  // Add stat methods
  s.isFile = function() { return !!s._isFile; };
  s.isDirectory = function() { return !!s._isDir; };
  s.isBlockDevice = function() { return false; };
  s.isCharacterDevice = function() { return false; };
  s.isSymbolicLink = function() { return !!s._isSymlink; };
  s.isFIFO = function() { return false; };
  s.isSocket = function() { return false; };
  return s;
}

const __fsStub = {
  readFileSync(p, opts) {
    const encoding = typeof opts === 'string' ? opts : opts?.encoding;
    // Dynamically size the SAB based on the file size — needed for large
    // files like .wasm binaries that can be 15+ MB.
    const sabSize = __fsReadFileSabSize(p);
    const result = __fsSyncCall('readFileSync', [p, encoding || null], sabSize);
    return result;
  },
  writeFileSync(p, data, opts) {
    // Normalize binary data to a fresh (non-shared, non-WASM-memory-backed) Uint8Array
    // so it survives structured clone intact. napi-rs WASM packages pass a mix of:
    //   - ArrayBuffer  -> NOT iterable; Array.from returns [] (silent data loss)
    //   - Uint8Array   -> iterable but may be backed by SAB or WASM memory that grows
    //   - Buffer       -> Uint8Array subclass; treat like Uint8Array
    //   - TypedArray   -> other views (Int32Array, etc.)
    //   - Array        -> plain JS array (rare)
    // Copy into a fresh ArrayBuffer-backed Uint8Array so the receiver gets proper
    // binary data (and downstream TextDecoder.decode doesn't throw).
    let payload = data;
    if (data != null && typeof data !== 'string') {
      if (data instanceof ArrayBuffer) {
        payload = new Uint8Array(data.slice(0));
      } else if (ArrayBuffer.isView(data)) {
        const view = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
        const copy = new Uint8Array(view.byteLength);
        copy.set(view);
        payload = copy;
      } else if (Array.isArray(data)) {
        payload = Uint8Array.from(data);
      } else if (typeof data.length === 'number') {
        // Array-like (e.g. Node Buffer polyfill that somehow isn't ArrayBufferView)
        payload = Uint8Array.from(data);
      }
    }
    return __fsSyncCall('writeFileSync', [p, payload, opts]);
  },
  existsSync(p) { try { __fsSyncCall('statSync', [p]); return true; } catch { return false; } },
  statSync(p) { return __makeStatObj(__fsSyncCall('statSync', [p])); },
  lstatSync(p) { return __makeStatObj(__fsSyncCall('lstatSync', [p])); },
  readdirSync(p, opts) {
    const result = __fsSyncCall('readdirSync', [p, opts]) || [];
    // When opts.withFileTypes is set the main thread returns flattened Dirent
    // descriptors -- objects with name, _isFile, _isDir, _isSymlink. We
    // reconstruct full Dirent-shaped objects with the methods callers expect.
    const wantTypes = opts && typeof opts === 'object' && opts.withFileTypes;
    if (wantTypes && Array.isArray(result) && result.length && typeof result[0] === 'object') {
      return result.map(function(d) {
        return {
          name: d.name,
          parentPath: d.parentPath || p,
          path: d.parentPath || p,
          isFile: function() { return !!d._isFile; },
          isDirectory: function() { return !!d._isDir; },
          isSymbolicLink: function() { return !!d._isSymlink; },
          isBlockDevice: function() { return false; },
          isCharacterDevice: function() { return false; },
          isFIFO: function() { return false; },
          isSocket: function() { return false; },
        };
      });
    }
    return result;
  },
  mkdirSync(p, opts) { return __fsSyncCall('mkdirSync', [p, opts]); },
  unlinkSync(p) { return __fsSyncCall('unlinkSync', [p]); },
  rmdirSync(p) { return __fsSyncCall('rmdirSync', [p]); },
  renameSync(o, n) { return __fsSyncCall('renameSync', [o, n]); },
  realpathSync(p) { try { return __fsSyncCall('realpathSync', [p]); } catch { return p; } },
  accessSync(p) { return __fsSyncCall('accessSync', [p]); },
  openSync(p, flags) {
    // Return a pseudo fd — actual file content goes through readFileSync
    try { __fsSyncCall('statSync', [p]); return 3; } catch { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; }
  },
  closeSync() { return; },
  readSync() { return 0; },
  fstatSync(fd) { return __makeStatObj({ mode: 0o100644, size: 0, _isFile: true }); },
  createReadStream() { throw new Error('createReadStream not supported in worker'); },
  createWriteStream() { throw new Error('createWriteStream not supported in worker'); },
  // Async variants (return promises or take callbacks)
  readFile(p, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    try { const r = __fsStub.readFileSync(p, opts); if (cb) cb(null, r); } catch(e) { if (cb) cb(e); }
  },
  stat(p, cb) { try { const r = __fsStub.statSync(p); if (cb) cb(null, r); } catch(e) { if (cb) cb(e); } },
  lstat(p, cb) { try { const r = __fsStub.lstatSync(p); if (cb) cb(null, r); } catch(e) { if (cb) cb(e); } },
  readdir(p, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    try { const r = __fsStub.readdirSync(p, opts); if (cb) cb(null, r); } catch(e) { if (cb) cb(e); }
  },
  access(p, mode, cb) {
    if (typeof mode === 'function') { cb = mode; mode = undefined; }
    try { __fsStub.accessSync(p); if (cb) cb(null); } catch(e) { if (cb) cb(e); }
  },
  // promises namespace
  promises: {
    readFile(p, opts) { try { return Promise.resolve(__fsStub.readFileSync(p, opts)); } catch(e) { return Promise.reject(e); } },
    stat(p) { try { return Promise.resolve(__fsStub.statSync(p)); } catch(e) { return Promise.reject(e); } },
    lstat(p) { try { return Promise.resolve(__fsStub.lstatSync(p)); } catch(e) { return Promise.reject(e); } },
    readdir(p, opts) { try { return Promise.resolve(__fsStub.readdirSync(p, opts)); } catch(e) { return Promise.reject(e); } },
    access(p) { try { __fsStub.accessSync(p); return Promise.resolve(); } catch(e) { return Promise.reject(e); } },
    writeFile(p, d, opts) { try { __fsStub.writeFileSync(p, d, opts); return Promise.resolve(); } catch(e) { return Promise.reject(e); } },
    mkdir(p, opts) { try { __fsStub.mkdirSync(p, opts); return Promise.resolve(); } catch(e) { return Promise.reject(e); } },
    unlink(p) { try { __fsStub.unlinkSync(p); return Promise.resolve(); } catch(e) { return Promise.reject(e); } },
  },
  // Constants
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
};

// os stub
const __osStub = {
  cpus() { return [{ model: 'wasm', speed: 0, times: {} }]; },
  platform() { return 'linux'; },
  arch() { return 'wasm32'; },
  homedir() { return '/'; },
  tmpdir() { return '/tmp'; },
  hostname() { return 'nodepod'; },
  type() { return 'Linux'; },
  release() { return '0.0.0'; },
  totalmem() { return 1073741824; },
  freemem() { return 536870912; },
  EOL: '\\n',
  endianness() { return 'LE'; },
};

// url stub
const __urlStub = {
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  fileURLToPath(u) {
    try { return decodeURIComponent(new URL(u).pathname); }
    catch { return u; }
  },
  pathToFileURL(p) { return p.startsWith('file://') ? new URL(p) : new URL('file://' + p); },
};

// util stub
const __utilStub = {
  inherits(ctor, superCtor) { Object.setPrototypeOf(ctor.prototype, superCtor.prototype); },
  types: { isTypedArray(v) { return ArrayBuffer.isView(v); }, isUint8Array(v) { return v instanceof Uint8Array; } },
  promisify(fn) { return function(...args) { return new Promise((res, rej) => fn(...args, (err, val) => err ? rej(err) : res(val))); }; },
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  deprecate(fn) { return fn; },
};

// events stub
const __eventsStub = {
  EventEmitter: class EventEmitter {
    constructor() { this._e = {}; }
    on(n, f) { (this._e[n] = this._e[n] || []).push(f); return this; }
    off(n, f) { const a = this._e[n]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } return this; }
    once(n, f) { const w = (...args) => { this.off(n, w); f(...args); }; this.on(n, w); return this; }
    emit(n, ...args) { (this._e[n] || []).forEach(f => f(...args)); return !!this._e[n]?.length; }
    removeListener(n, f) { return this.off(n, f); }
    addListener(n, f) { return this.on(n, f); }
    removeAllListeners(n) { if (n) delete this._e[n]; else this._e = {}; return this; }
    listeners(n) { return this._e[n] || []; }
    listenerCount(n) { return (this._e[n] || []).length; }
    setMaxListeners() { return this; }
    getMaxListeners() { return 10; }
    prependListener(n, f) { (this._e[n] = this._e[n] || []).unshift(f); return this; }
    prependOnceListener(n, f) { const w = (...args) => { this.off(n, w); f(...args); }; this.prependListener(n, w); return this; }
    eventNames() { return Object.keys(this._e); }
    rawListeners(n) { return this._e[n] || []; }
  }
};
__eventsStub.default = __eventsStub.EventEmitter;

// Buffer must be callable as well as constructor-like. emnapi discovers it
// from globalThis before it checks require('buffer').
function __BufferStub(src, enc, len) {
  return __BufferStub.from(src, enc, len);
}
__BufferStub.from = function(src, enc, len) {
    if (typeof src === 'string') return new TextEncoder().encode(src);
    if (src instanceof ArrayBuffer || src instanceof SharedArrayBuffer) {
      return new Uint8Array(src, typeof enc === 'number' ? enc : 0, len);
    }
    if (src instanceof Uint8Array) return new Uint8Array(src);
    return new Uint8Array(src || []);
};
__BufferStub.alloc = function(len, fill) { const b = new Uint8Array(len); if (fill) b.fill(fill); return b; };
__BufferStub.allocUnsafe = function(len) { return new Uint8Array(len); };
__BufferStub.isBuffer = function(v) { return v instanceof Uint8Array; };
__BufferStub.isEncoding = function() { return true; };
__BufferStub.concat = function(list, totalLen) {
    if (!totalLen) totalLen = list.reduce((s, b) => s + b.length, 0);
    const out = new Uint8Array(totalLen); let off = 0;
    for (const b of list) { out.set(b, off); off += b.length; }
    return out;
};
__BufferStub.byteLength = function(s, enc) { return new TextEncoder().encode(s).length; };
// emnapi probes global Buffer before falling back to require('buffer'). The
// constructor-like facade needs to exist in both places for its typed-array
// and Buffer detection to follow Node's runtime path.
globalThis.Buffer = __BufferStub;

// WASM child thread initialization is handled by emnapi's instance proxy
// which provides a no-op _initialize for child threads. No manual guard needed.

// Real WASI preview1 implementation for worker threads.
// Provides all required syscalls so WASM modules can initialize.
const __wasiStub = { WASI: class WASI {
  constructor(opts) {
    this._opts = opts || {};
    // Merge process.env into WASI env. The wasi-worker.mjs may pass env: {} or
    // omit it entirely — either way we need process.env to be visible.
    // Note: for child threads, _initialize is a no-op (emnapi proxy), so the
    // WASM code never re-reads environ — it uses the main thread's values
    // from shared memory. This env is only used by this WASI instance's JS.
    const _procEnv = (typeof process !== 'undefined' && process.env) ? process.env : {};
    const _optsEnv = this._opts.env || {};
    this._env = { ..._procEnv, ..._optsEnv };
    this._args = this._opts.args || [];
    this._preopens = [];
    this._memory = null;
    this._instance = null;
    this._nextFd = 3;
    this._fds = new Map([[0, 'stdin'], [1, 'stdout'], [2, 'stderr']]);
    const po = this._opts.preopens || {};
    for (const [virt, real] of Object.entries(po)) {
      const fd = this._nextFd++;
      this._preopens.push({ fd, virtualPath: virt, realPath: real });
      this._fds.set(fd, { kind: 'dir', path: virt });
    }
  }
  initialize(inst) {
    this._instance = inst;
    this._memory = inst.exports.memory;
    const _init = inst.exports._initialize;
    // emnapi's @emnapi/wasi-threads wraps child thread instances in a Proxy
    // that returns a no-op for _initialize. So calling _init() is safe for both
    // main thread (real _initialize) and child threads (no-op).
    // IMPORTANT: Do NOT write guard values to WASM shared memory — it corrupts
    // the stack/data segment.
    if (typeof _init === 'function') _init();
  }
  start(inst) { this.initialize(inst); return 0; }
  getImportObject() { return { wasi_snapshot_preview1: this._buildImports() }; }
  get wasiImport() { return this._buildImports(); }
  _view() { return new DataView(this._memory.buffer); }
  _bytes() { return new Uint8Array(this._memory.buffer); }
  // Read a string from WASM memory, handling SharedArrayBuffer.
  // TextDecoder.decode() rejects SharedArrayBuffer-backed views,
  // so we must copy to a non-shared buffer first.
  // Resolve a WASI path relative to a directory entry, normalizing . and ..
  _resolvePath(dirPath, rel) {
    const base = dirPath || '/';
    const raw = rel.startsWith('/') ? rel : (base.endsWith('/') ? base + rel : base + '/' + rel);
    const segs = raw.split('/');
    const out = [];
    for (const s of segs) { if (s === '.' || s === '') continue; if (s === '..') { out.pop(); continue; } out.push(s); }
    return '/' + out.join('/');
  }
  _readStr(ptr, len) {
    const src = new Uint8Array(this._memory.buffer, ptr, len);
    if (this._memory.buffer instanceof SharedArrayBuffer) {
      const copy = new Uint8Array(len);
      copy.set(src);
      return new TextDecoder().decode(copy);
    }
    return new TextDecoder().decode(src);
  }
  // Flush an fd's accumulated in-memory data back to the filesystem.
  // Called from fd_close / fd_sync / fd_datasync. Without this, every
  // WASI file write via fd_write would be silently lost.
  // Mirrors the pattern in src/polyfills/wasi.ts's flushFile().
  _flushFile(entry) {
    if (!entry || entry.kind !== 'file' || !entry.dirty || !entry.path) return;
    const data = entry.data || new Uint8Array(0);
    __fsStub.writeFileSync(entry.path, data);
    entry.dirty = false;
  }
  _buildImports() {
    const E = { SUCCESS: 0, BADF: 8, INVAL: 28, NOENT: 44, NOSYS: 52, IO: 29, ISDIR: 31, NOTDIR: 54, NOTEMPTY: 55, ACCES: 2, EXIST: 20 };
    const self = this;
    const enc = new TextEncoder();
    return {
      args_get(argv, buf) { const dv = self._view(); const b = self._bytes(); let off = buf; for (let i = 0; i < self._args.length; i++) { dv.setUint32(argv + i * 4, off, true); const a = enc.encode(self._args[i] + '\\0'); b.set(a, off); off += a.length; } return E.SUCCESS; },
      args_sizes_get(argc_out, bufsz_out) { const dv = self._view(); dv.setUint32(argc_out, self._args.length, true); let sz = 0; for (const a of self._args) sz += enc.encode(a).length + 1; dv.setUint32(bufsz_out, sz, true); return E.SUCCESS; },
      environ_get(env_ptr, buf) { const dv = self._view(); const b = self._bytes(); let off = buf; let i = 0; for (const [k, v] of Object.entries(self._env)) { dv.setUint32(env_ptr + i * 4, off, true); const e = enc.encode(k + '=' + v + '\\0'); b.set(e, off); off += e.length; i++; } return E.SUCCESS; },
      environ_sizes_get(count_out, bufsz_out) { const dv = self._view(); const entries = Object.entries(self._env); dv.setUint32(count_out, entries.length, true); let sz = 0; for (const [k, v] of entries) sz += enc.encode(k + '=' + v).length + 1; dv.setUint32(bufsz_out, sz, true); return E.SUCCESS; },
      clock_time_get(id, precision, time_out) { const dv = self._view(); const now = BigInt(Math.round(performance.now() * 1e6)); dv.setBigUint64(time_out, now, true); return E.SUCCESS; },
      clock_res_get(id, res_out) { const dv = self._view(); dv.setBigUint64(res_out, BigInt(1000000), true); return E.SUCCESS; },
      fd_prestat_get(fd, buf) { const p = self._preopens.find(x => x.fd === fd); if (!p) return E.BADF; const dv = self._view(); dv.setUint8(buf, 0); dv.setUint32(buf + 4, enc.encode(p.virtualPath).length, true); return E.SUCCESS; },
      fd_prestat_dir_name(fd, path, len) { const p = self._preopens.find(x => x.fd === fd); if (!p) return E.BADF; const e = enc.encode(p.virtualPath); self._bytes().set(e.subarray(0, Math.min(e.length, len)), path); return E.SUCCESS; },
      fd_fdstat_get(fd, buf) { const dv = self._view(); dv.setUint8(buf, fd <= 2 ? 2 : 3); dv.setUint16(buf + 2, 0, true); dv.setBigUint64(buf + 8, BigInt(0), true); dv.setBigUint64(buf + 16, BigInt(0), true); return E.SUCCESS; },
      fd_fdstat_set_flags() { return E.SUCCESS; },
      fd_fdstat_set_rights() { return E.SUCCESS; },
      fd_write(fd, iovs, iovs_len, nwritten) {
        let total = 0;
        for (let i = 0; i < iovs_len; i++) {
          // Re-acquire views each iteration (memory.grow() safety)
          const dv = self._view(); const b = self._bytes();
          const ptr = dv.getUint32(iovs + i * 8, true);
          const len = dv.getUint32(iovs + i * 8 + 4, true);
          if (ptr + len > b.length) break; // bounds check
          // Explicit copy into a non-shared buffer. TextDecoder rejects
          // SharedArrayBuffer-backed views, and while .slice() should
          // produce a non-shared copy per spec, being explicit avoids
          // any engine-specific surprises.
          const chunk = new Uint8Array(len);
          chunk.set(b.subarray(ptr, ptr + len));
          if (fd === 1 || fd === 2) {
            const txt = new TextDecoder().decode(chunk);
            if (fd === 1) console.log(txt); else console.error(txt);
          } else {
            // File fd: write to fd data at current offset (positional write).
            // WASI fd_write is positional — it uses entry.offset and advances
            // it by len. Simply appending would lose data if the app seeks.
            // If the fd was opened with FDFLAGS_APPEND, all writes go to EOF.
            const entry = self._fds.get(fd);
            if (entry) {
              if (!entry.data) entry.data = new Uint8Array(0);
              const off = entry.append ? entry.data.length : (entry.offset || 0);
              const end = off + len;
              if (end > entry.data.length) {
                const newData = new Uint8Array(end);
                newData.set(entry.data);
                entry.data = newData;
              }
              entry.data.set(chunk, off);
              entry.offset = end;
              entry.dirty = true;
            }
          }
          total += len;
        }
        self._view().setUint32(nwritten, total, true);
        return E.SUCCESS;
      },
      fd_read(fd, iovs, iovs_len, nread) {
        const entry = self._fds.get(fd);
        if (!entry || !entry.data) { self._view().setUint32(nread, 0, true); return E.SUCCESS; }
        let total = 0;
        for (let i = 0; i < iovs_len; i++) {
          // Re-acquire views each iteration — WASM memory.grow() can resize
          // the underlying buffer, invalidating previous TypedArray views.
          const dv = self._view();
          const b = self._bytes();
          const ptr = dv.getUint32(iovs + i * 8, true);
          const len = dv.getUint32(iovs + i * 8 + 4, true);
          const avail = Math.min(len, entry.data.length - (entry.offset || 0));
          if (avail <= 0) break;
          // Bounds check: don't write beyond WASM memory
          if (ptr + avail > b.length) break;
          b.set(entry.data.subarray(entry.offset || 0, (entry.offset || 0) + avail), ptr);
          entry.offset = (entry.offset || 0) + avail;
          total += avail;
        }
        self._view().setUint32(nread, total, true);
        return E.SUCCESS;
      },
      fd_close(fd) {
        const entry = self._fds.get(fd);
        // CRITICAL: flush accumulated write data before closing. Without this,
        // rolldown-wasm's bundle.write() pipeline (which uses WASI fd_write +
        // fd_close) would silently drop every byte of every binary file.
        try { self._flushFile(entry); } catch {}
        self._fds.delete(fd);
        return E.SUCCESS;
      },
      fd_seek(fd, offset, whence, newoff) {
        const entry = self._fds.get(fd);
        const dv = self._view();
        if (!entry) { dv.setBigUint64(newoff, BigInt(0), true); return E.BADF; }
        const size = entry.data ? entry.data.length : 0;
        let pos = entry.offset || 0;
        const off = Number(offset);
        if (whence === 0) pos = off;       // SEEK_SET
        else if (whence === 1) pos += off;  // SEEK_CUR
        else if (whence === 2) pos = size + off; // SEEK_END
        entry.offset = Math.max(0, pos);
        dv.setBigUint64(newoff, BigInt(entry.offset), true);
        return E.SUCCESS;
      },
      fd_tell(fd, off) {
        const dv = self._view();
        const entry = self._fds.get(fd);
        dv.setBigUint64(off, BigInt(entry ? (entry.offset || 0) : 0), true);
        return E.SUCCESS;
      },
      fd_sync(fd) { try { self._flushFile(self._fds.get(fd)); } catch {} return E.SUCCESS; },
      fd_datasync(fd) { try { self._flushFile(self._fds.get(fd)); } catch {} return E.SUCCESS; },
      fd_advise() { return E.SUCCESS; },
      fd_allocate() { return E.SUCCESS; },
      fd_filestat_get(fd, buf) {
        const dv = self._view();
        const entry = self._fds.get(fd);
        const now = BigInt(Date.now()) * BigInt(1000000);
        for (let i = 0; i < 64; i++) dv.setUint8(buf + i, 0);
        if (entry && entry.data) {
          dv.setUint8(buf + 16, 4); // FILETYPE_REGULAR_FILE
          dv.setBigUint64(buf + 32, BigInt(entry.data.length), true); // size
        } else if (entry && entry.kind === 'dir') {
          dv.setUint8(buf + 16, 3); // FILETYPE_DIRECTORY
        } else {
          dv.setUint8(buf + 16, fd <= 2 ? 2 : 4);
        }
        dv.setBigUint64(buf + 48, now, true);
        dv.setBigUint64(buf + 56, now, true);
        return E.SUCCESS;
      },
      fd_filestat_set_size(fd, size) {
        const entry = self._fds.get(fd);
        if (!entry || entry.kind !== 'file') return E.BADF;
        const newLen = Number(size);
        const cur = entry.data || new Uint8Array(0);
        if (newLen === cur.length) return E.SUCCESS;
        const newData = new Uint8Array(newLen);
        newData.set(cur.subarray(0, Math.min(cur.length, newLen)));
        entry.data = newData;
        entry.dirty = true;
        if ((entry.offset || 0) > newLen) entry.offset = newLen;
        return E.SUCCESS;
      },
      fd_filestat_set_times() { return E.SUCCESS; },
      fd_pread(fd, iovs, iovs_len, offset, nread) {
        const entry = self._fds.get(fd);
        if (!entry || !entry.data) { self._view().setUint32(nread, 0, true); return E.SUCCESS; }
        let pos = Number(offset);
        let total = 0;
        for (let i = 0; i < iovs_len; i++) {
          const dv = self._view();
          const b = self._bytes();
          const ptr = dv.getUint32(iovs + i * 8, true);
          const len = dv.getUint32(iovs + i * 8 + 4, true);
          const avail = Math.min(len, entry.data.length - pos);
          if (avail <= 0) break;
          if (ptr + avail > b.length) break;
          b.set(entry.data.subarray(pos, pos + avail), ptr);
          pos += avail;
          total += avail;
        }
        self._view().setUint32(nread, total, true);
        return E.SUCCESS;
      },
      fd_pwrite(fd, iovs, iovs_len, offset, nwritten) {
        const entry = self._fds.get(fd);
        if (!entry || entry.kind !== 'file') { self._view().setUint32(nwritten, 0, true); return E.BADF; }
        if (!entry.data) entry.data = new Uint8Array(0);
        let pos = Number(offset);
        let total = 0;
        for (let i = 0; i < iovs_len; i++) {
          const dv = self._view();
          const b = self._bytes();
          const ptr = dv.getUint32(iovs + i * 8, true);
          const len = dv.getUint32(iovs + i * 8 + 4, true);
          if (ptr + len > b.length) break;
          const end = pos + len;
          if (end > entry.data.length) {
            const newData = new Uint8Array(end);
            newData.set(entry.data);
            entry.data = newData;
          }
          // Copy non-shared (chunk) to avoid SAB view issues
          const chunk = new Uint8Array(len);
          chunk.set(b.subarray(ptr, ptr + len));
          entry.data.set(chunk, pos);
          pos += len;
          total += len;
        }
        entry.dirty = true;
        self._view().setUint32(nwritten, total, true);
        return E.SUCCESS;
      },
      fd_readdir(fd, buf, buf_len, cookie, used) {
        const dv = self._view(); const b = self._bytes();
        const entry = self._fds.get(fd);
        if (!entry || !entry.path) { dv.setUint32(used, 0, true); return E.SUCCESS; }
        try {
          // Ask for Dirent objects so we can populate d_type accurately.
          // d_type values per WASI: 3=DIRECTORY, 4=REGULAR_FILE, 7=SYMBOLIC_LINK.
          const items = __fsStub.readdirSync(entry.path, { withFileTypes: true });
          let offset = 0;
          const cookieNum = Number(cookie);
          for (let i = cookieNum; i < items.length; i++) {
            const item = items[i];
            const itemName = (item && typeof item === 'object') ? item.name : item;
            const isDir = item && typeof item.isDirectory === 'function' ? item.isDirectory() : false;
            const isSym = item && typeof item.isSymbolicLink === 'function' ? item.isSymbolicLink() : false;
            const dType = isDir ? 3 : (isSym ? 7 : 4);
            // d_ino must be unique per (parent, name) for walkdir cycle
            // detection to work correctly. statSync goes through MemoryVolume
            // which assigns stable per-path inos.
            var dino = BigInt(i + 1);
            try {
              var fullChild = entry.path === '/' ? '/' + itemName : entry.path + '/' + itemName;
              var st = __fsStub.statSync(fullChild);
              if (st && st.ino) dino = BigInt(st.ino);
            } catch (_) {}
            const name = enc.encode(itemName);
            // Stop when we cant fit the next FULL entry. Caller refills with
            // cookie = last d_next written. Don't write partial headers --
            // Rust's ReadDir gets confused by them.
            if (offset + 24 + name.length > buf_len) break;
            dv.setBigUint64(buf + offset, BigInt(i + 1), true); // d_next
            dv.setBigUint64(buf + offset + 8, dino, true); // d_ino
            dv.setUint32(buf + offset + 16, name.length, true); // d_namlen
            dv.setUint8(buf + offset + 20, dType); // d_type
            b.set(name, buf + offset + 24);
            offset += 24 + name.length;
          }
          dv.setUint32(used, offset, true);
        } catch (e) { dv.setUint32(used, 0, true); }
        return E.SUCCESS;
      },
      fd_renumber() { return E.NOSYS; },
      path_create_directory(fd, path_ptr, path_len) {
        const dirEntry = self._fds.get(fd);
        if (!dirEntry) return E.BADF;
        const rel = self._readStr(path_ptr, path_len);
        const full = self._resolvePath(dirEntry.path, rel);
        try { __fsStub.mkdirSync(full, { recursive: true }); return E.SUCCESS; } catch { return E.IO; }
      },
      path_filestat_get(fd, flags, path_ptr, path_len, buf) {
        const dv = self._view();
        const dirEntry = self._fds.get(fd);
        if (!dirEntry) return E.BADF;
        const rel = self._readStr(path_ptr, path_len);
        const full = self._resolvePath(dirEntry.path, rel);
        try {
          const stat = __fsStub.statSync(full);
          for (let i = 0; i < 64; i++) dv.setUint8(buf + i, 0);
          // ino at offset 8 -- walkdir uses (dev,ino) for cycle detection
          // when follow_links is on, so we need a unique value per path or
          // every file looks like the same identity and gets dropped.
          if (stat && stat.ino) dv.setBigUint64(buf + 8, BigInt(stat.ino), true);
          dv.setUint8(buf + 16, stat.isDirectory() ? 3 : 4);
          dv.setBigUint64(buf + 32, BigInt(stat.size || 0), true);
          dv.setBigUint64(buf + 48, BigInt(stat.mtimeMs || Date.now()) * BigInt(1000000), true);
          dv.setBigUint64(buf + 56, BigInt(stat.mtimeMs || Date.now()) * BigInt(1000000), true);
          return E.SUCCESS;
        } catch (e) {
          return E.NOENT;
        }
      },
      path_filestat_set_times() { return E.SUCCESS; },
      path_link() { return E.NOSYS; },
      path_open(fd, dirflags, path_ptr, path_len, oflags, fs_rights_base, fs_rights_inheriting, fdflags, fd_out) {
        const dv = self._view();
        const dirEntry = self._fds.get(fd);
        if (!dirEntry) return E.BADF;
        const rel = self._readStr(path_ptr, path_len);
        const full = self._resolvePath(dirEntry.path, rel);
        const wantDir = (oflags & 0x0002) !== 0;
        const wantCreate = (oflags & 0x0001) !== 0;
        const wantTrunc = (oflags & 0x0008) !== 0;
        let exists;
        try { exists = __fsStub.existsSync(full); } catch { exists = false; }
        if (wantDir) {
          if (!exists && !wantCreate) return E.NOENT;
          if (!exists) try { __fsStub.mkdirSync(full, { recursive: true }); } catch {}
          const newFd = self._nextFd++;
          self._fds.set(newFd, { kind: 'dir', path: full });
          dv.setUint32(fd_out, newFd, true);
          return E.SUCCESS;
        }
        // Regular file
        if (!exists && !wantCreate) return E.NOENT;
        const wantAppend = (fdflags & 0x0001) !== 0;
        let data;
        let dirty = false;
        try {
          if (exists && !wantTrunc) {
            const raw = __fsStub.readFileSync(full);
            // MUST copy — raw may be a view into a SharedArrayBuffer from the fs proxy.
            // new Uint8Array(sharedView) creates another VIEW, not a copy!
            if (raw instanceof Uint8Array) {
              data = new Uint8Array(raw.length);
              data.set(raw);
            } else if (typeof raw === 'string') {
              data = new TextEncoder().encode(raw);
            } else if (raw && ArrayBuffer.isView(raw)) {
              const v = new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength);
              data = new Uint8Array(v.byteLength);
              data.set(v);
            } else if (raw instanceof ArrayBuffer) {
              data = new Uint8Array(raw.slice(0));
            } else {
              data = new TextEncoder().encode(String(raw));
            }
          } else {
            data = new Uint8Array(0);
            if (!exists && wantCreate) {
              try { __fsStub.writeFileSync(full, data); } catch {}
            } else if (exists && wantTrunc) {
              // Truncating an existing file → mark dirty so the empty content
              // (or whatever gets written next) is flushed on fd_close, even
              // if no fd_write calls follow.
              dirty = true;
            }
          }
        } catch { return E.NOENT; }
        const newFd = self._nextFd++;
        // FDFLAGS_APPEND → start at end of existing data
        const initialOffset = wantAppend ? data.length : 0;
        self._fds.set(newFd, {
          kind: 'file',
          path: full,
          data: data,
          offset: initialOffset,
          dirty: dirty,
          append: wantAppend,
        });
        dv.setUint32(fd_out, newFd, true);
        return E.SUCCESS;
      },
      path_readlink() { return E.NOSYS; },
      path_remove_directory(fd, path_ptr, path_len) {
        const dirEntry = self._fds.get(fd);
        if (!dirEntry) return E.BADF;
        const rel = self._readStr(path_ptr, path_len);
        const full = self._resolvePath(dirEntry.path, rel);
        try { __fsStub.rmdirSync(full); return E.SUCCESS; } catch { return E.IO; }
      },
      path_rename(fd, old_ptr, old_len, new_fd, new_ptr, new_len) {
        const dirEntry = self._fds.get(fd);
        const newDirEntry = self._fds.get(new_fd);
        if (!dirEntry || !newDirEntry) return E.BADF;
        const oldRel = self._readStr(old_ptr, old_len);
        const newRel = self._readStr(new_ptr, new_len);
        const oldFull = self._resolvePath(dirEntry.path, oldRel);
        const newFull = self._resolvePath(newDirEntry.path, newRel);
        try { __fsStub.renameSync(oldFull, newFull); return E.SUCCESS; } catch { return E.IO; }
      },
      path_symlink() { return E.NOSYS; },
      path_unlink_file(fd, path_ptr, path_len) {
        const dirEntry = self._fds.get(fd);
        if (!dirEntry) return E.BADF;
        const rel = self._readStr(path_ptr, path_len);
        const full = self._resolvePath(dirEntry.path, rel);
        try { __fsStub.unlinkSync(full); return E.SUCCESS; } catch { return E.IO; }
      },
      poll_oneoff(in_ptr, out_ptr, nsubs, nevents_out) { const dv = self._view(); let n = 0; for (let i = 0; i < nsubs; i++) { const sp = in_ptr + i * 48; const ep = out_ptr + n * 32; const ud = dv.getBigUint64(sp, true); const ty = dv.getUint8(sp + 8); dv.setBigUint64(ep, ud, true); dv.setUint16(ep + 8, 0, true); dv.setUint8(ep + 10, ty); n++; } dv.setUint32(nevents_out, n, true); return E.SUCCESS; },
      proc_exit(code) { throw new Error('proc_exit(' + code + ')'); },
      proc_raise() { return E.NOSYS; },
      sched_yield() { return E.SUCCESS; },
      random_get(buf_ptr, buf_len) {
        const mem = self._memory;
        if (mem.buffer instanceof SharedArrayBuffer) {
          const tmp = new Uint8Array(buf_len); crypto.getRandomValues(tmp);
          new Uint8Array(mem.buffer).set(tmp, buf_ptr);
        } else {
          crypto.getRandomValues(new Uint8Array(mem.buffer, buf_ptr, buf_len));
        }
        return E.SUCCESS;
      },
      sock_recv() { return E.NOSYS; },
      sock_send() { return E.NOSYS; },
      sock_shutdown() { return E.NOSYS; },
      sock_accept() { return E.NOSYS; },
    };
  }
} };

// === end preamble ===
`;
}

// require() implementation for the bundled worker
const REQUIRE_IMPL = `
let __requireDepth = 0;
function __require(idOrPath) {
  __requireDepth++;
  if (__requireDepth > 100) {
    __requireDepth--;
    console.error('[worker] require depth > 100, circular dep? id=' + idOrPath);
    return {};
  }
  try { return __requireInner(idOrPath); } finally { __requireDepth--; }
}
function __requireInner(idOrPath) {
  // Numeric id → direct module lookup
  if (typeof idOrPath === 'number') {
    if (__moduleCache[idOrPath]) return __moduleCache[idOrPath].exports;
    const mod = __modules[idOrPath];
    if (!mod) throw new Error('Module not found: ' + idOrPath);
    // Lazily compile the module function from its source string.
    // This defers V8 parsing to first-require time, preventing parser
    // stack overflow that occurs when all modules are parsed at once.
    if (!mod.fn && mod.src !== undefined) {
      mod.fn = new Function('module', 'exports', 'require', '__filename', '__dirname', mod.src);
    }
    if (!mod.fn) throw new Error('Module has no source: ' + idOrPath);
    const m = { exports: {}, id: mod.path, filename: mod.path, loaded: false };
    if (mod.esm) Object.defineProperty(m.exports, '__esModule', { value: true });
    __moduleCache[idOrPath] = m;
    const localRequire = function(dep) {
      // Node builtins — check once, always return result (even empty object)
      const bare = dep.replace(/^node:/, '');
      const builtin = __builtinRequire(bare);
      if (builtin !== undefined) return builtin;
      // the bundle records the resolver's exact answer for each import. dont
      // infer package roots by scanning strings: nested deps can share a package
      // name but ship incompatible napi runtime exports.
      const mappedPath = mod.deps && mod.deps[dep];
      if (mappedPath) {
        const mappedId = __pathToId[mappedPath];
        if (mappedId !== undefined) return __require(mappedId);
        throw new Error('Bundled dependency missing: ' + dep + ' from ' + mod.path);
      }
      // Resolve relative paths
      if (dep.startsWith('./') || dep.startsWith('../')) {
        const resolved = __resolvePath(mod.dir, dep);
        const resolvedId = __pathToId[resolved];
        if (resolvedId !== undefined) return __require(resolvedId);
        // Try with extensions
        for (const ext of ['.js', '.cjs', '.mjs', '.json', '/index.js', '/index.cjs', '/index.mjs']) {
          const withExt = __pathToId[resolved + ext];
          if (withExt !== undefined) return __require(withExt);
        }
        throw new Error('Cannot find module: ' + dep + ' from ' + mod.dir);
      }
      // Bare specifier: search in collected modules
      for (const [p, id] of Object.entries(__pathToId)) {
        if (p.includes('/node_modules/' + dep + '/') || p.endsWith('/node_modules/' + dep)) {
          return __require(id);
        }
        // Check package.json main field
        if (p.includes('/' + dep + '/') && (p.endsWith('/index.js') || p.endsWith('/index.cjs'))) {
          return __require(id);
        }
      }
      throw new Error('Cannot find module: ' + dep + ' from ' + mod.dir);
    };
    localRequire.resolve = function(id) { return id; };
    mod.fn(m, m.exports, localRequire, mod.path, mod.dir);
    m.loaded = true;
    return m.exports;
  }
  // String path → lookup in pathToId
  const id = __pathToId[idOrPath];
  if (id !== undefined) return __require(id);
  // Bare specifier search (same as localRequire does)
  for (const [p, pid] of Object.entries(__pathToId)) {
    if (p.includes('/node_modules/' + idOrPath + '/') || p.endsWith('/node_modules/' + idOrPath)) {
      return __require(pid);
    }
  }
  // Try builtin
  const builtin = __builtinRequire(idOrPath);
  if (builtin !== undefined) return builtin;
  throw new Error('Cannot find module: ' + idOrPath);
}

function __validateNapiImports(imports) {
  for (const namespace of ['env', 'napi', 'emnapi']) {
    const values = imports && imports[namespace];
    if (!values || typeof values !== 'object') continue;
    for (const name of Object.keys(values)) {
      if ((namespace === 'napi' || namespace === 'emnapi' || /^(?:napi|emnapi)_/.test(name)) && typeof values[name] !== 'function') {
        throw new TypeError('Invalid WebAssembly import ' + namespace + '.' + name + ': expected function');
      }
    }
  }
  return imports;
}
const __nativeWasmInstantiate = WebAssembly.instantiate.bind(WebAssembly);
WebAssembly.instantiate = function(moduleOrBytes, imports) {
  return __nativeWasmInstantiate(moduleOrBytes, __validateNapiImports(imports));
};
const __nativeWasmInstance = WebAssembly.Instance;
WebAssembly.Instance = function(module, imports) {
  return new __nativeWasmInstance(module, __validateNapiImports(imports));
};
WebAssembly.Instance.prototype = __nativeWasmInstance.prototype;

function __resolvePath(base, rel) {
  const parts = (base + '/' + rel).split('/');
  const out = [];
  for (const seg of parts) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}
`;
