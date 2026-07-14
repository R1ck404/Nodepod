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
import { parse } from "acorn";
import { getWasiRuntimeSource } from "../polyfills/wasi";

function scanWorkerDependencies(source: string): { dependencies: string[]; esm: boolean } {
  let ast: any;
  let esm = true;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  } catch {
    esm = false;
    ast = parse(source, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true });
  }
  const dependencies = new Set<string>();
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if ((node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
        typeof node.source?.value === "string") {
      dependencies.add(node.source.value);
      esm = true;
    } else if (node.type === "ImportExpression" && typeof node.source?.value === "string") {
      dependencies.add(node.source.value);
      esm = true;
    } else if (node.type === "CallExpression" && node.callee?.type === "Identifier" &&
        node.callee.name === "require" && typeof node.arguments?.[0]?.value === "string") {
      dependencies.add(node.arguments[0].value);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      if (Array.isArray(value)) for (const child of value) visit(child);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  return { dependencies: [...dependencies], esm };
}

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
  const moduleEsm = new Map<string, boolean>();
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

    const scanned = scanWorkerDependencies(source);
    moduleEsm.set(filePath, scanned.esm || filePath.endsWith(".mjs"));
    const fromDir = filePath.substring(0, filePath.lastIndexOf("/")) || "/";

    for (const dep of scanned.dependencies) {

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
    const isESM = moduleEsm.get(filePath) ?? filePath.endsWith(".mjs");
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
        fallbackWorkerFn,
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
  brokerWorkerFn: ((...args: any[]) => any) | null,
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
  const workerBundleSource = bundleSource.replaceAll("__NODEPOD_THREAD_ID__", String(self.threadId));

  if (brokerWorkerFn) {
    let unrefTimer: ReturnType<typeof setTimeout> | null = null;
    const close = (code: number): void => {
      if (self._terminated) return;
      if (unrefTimer) clearTimeout(unrefTimer);
      unrefTimer = null;
      (self._elHandle as Handle | null)?.close();
      self._elHandle = null;
      self._terminated = true;
      self.emit("exit", code);
    };
    const handle = brokerWorkerFn(workerBundleSource, {
      workerData: opts?.workerData ?? null,
      threadId: self.threadId,
      isEval: true,
      rawWasi: true,
      cwd: (globalThis as any).process?.cwd?.() ?? "/",
      env: processEnv,
      onOnline: () => {
        if (!self._terminated) self.emit("online");
      },
      onMessage: (data: unknown) => self.emit("message", data),
      onError: (error: Error) => self.emit("error", error),
      onExit: close,
    });
    self._handle = handle;
    self._elHandle = getRegistry().register("Worker");
    self.postMessage = (value: unknown) => {
      if (!self._terminated) handle.postMessage(value);
    };
    self.terminate = () => {
      if (!self._terminated) {
        handle.terminate();
        close(1);
      }
      return Promise.resolve(1);
    };
    self.ref = () => {
      if (unrefTimer) clearTimeout(unrefTimer);
      unrefTimer = null;
      if (!self._terminated) (self._elHandle as Handle | null)?.ref();
      return self;
    };
    self.unref = () => {
      // napi-rs unrefs its bootstrap worker before Vite binds the HTTP server.
      // Delay that transition through the startup gap, then honor Node's
      // unref semantics so one-shot native-module processes can drain.
      if (!self._terminated && !unrefTimer) {
        unrefTimer = setTimeout(() => {
          unrefTimer = null;
          (self._elHandle as Handle | null)?.unref();
        }, 3_000);
        (unrefTimer as any)?.unref?.();
      }
      return self;
    };
    return;
  }

  queueMicrotask(() => self.emit("error", new Error(
    "WASI worker broker is unavailable in this execution context",
  )));
}

// handles one sequenced synchronous filesystem request from a brokered worker
export function handleFsProxy(
  req: { sab: Int32Array; type: string; payload: any[]; requestId?: number },
  fsBridge: any,
): void {
  const { sab, type, payload } = req;
  const requestId = req.requestId ?? Atomics.load(sab, 3);
  if (Atomics.load(sab, 0) !== -1 || Atomics.load(sab, 3) !== requestId) return;
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

    Atomics.store(sab, 2, encoded.byteLength);
    if (encoded.byteLength > maxPayload) {
      Atomics.store(sab, 0, 2);
      Atomics.notify(sab, 0);
      return;
    }
    Atomics.store(sab, 1, resultType);
    // payload goes after the 16-byte header
    const writeLen = encoded.byteLength;
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
  const defaultPoolSize = String(Math.max(1, Math.min(4,
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4,
  )));
  const workerEnv = { ...env };
  workerEnv.UV_THREADPOOL_SIZE ??= defaultPoolSize;
  workerEnv.NAPI_RS_ASYNC_WORK_POOL_SIZE ??= defaultPoolSize;
  workerEnv.EMNAPI_WORKER_POOL_SIZE ??= defaultPoolSize;
  return `
// === nodepod napi-rs WASI worker preamble ===
"use strict";

// retain the native sender before installing node-compatible globals
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

// emnapi delegates child threads through parentPort while the caller waits
const __DisabledWorker = class Worker {
  constructor() { throw new Error('Direct Worker creation not available in nodepod child worker (use emnapi child-thread delegation)'); }
};
try { Object.defineProperty(globalThis, 'Worker', { value: __DisabledWorker, writable: true, configurable: true }); } catch {}
try { globalThis.Worker = __DisabledWorker; } catch {}

try { if (!globalThis.importScripts) globalThis.importScripts = function(f) {}; } catch {};

// node and browser worker variants use different handlers; dispatch once
self.onmessage = function(e) {
  if (__parentPortListeners.length > 0) {
    for (const fn of __parentPortListeners) {
      try { fn(e.data); } catch (err) { console.error('[wasi-worker] parentPort listener error:', err); }
    }
  } else if (typeof globalThis.__userOnMessage === 'function') {
    globalThis.__userOnMessage(e);
  }
};

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
      workerData: globalThis.__nodepodWorkerData ?? null,
      threadId: __NODEPOD_THREAD_ID__,
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

let __fsRequestSequence = 0;
let __fsReusableSab = null;

function __nextFsCapacity(required) {
  let capacity = __FS_DEFAULT_SAB;
  while (capacity < required) capacity *= 2;
  return capacity;
}

function __getFsSab(required) {
  const capacity = __nextFsCapacity(required);
  if (capacity > 4 * 1024 * 1024) return new SharedArrayBuffer(capacity);
  if (!__fsReusableSab || __fsReusableSab.byteLength < capacity) {
    __fsReusableSab = new SharedArrayBuffer(capacity);
  }
  return __fsReusableSab;
}

function __fsSyncCall(type, args, sabSize) {
  const size = sabSize || __FS_DEFAULT_SAB;
  const sab = __getFsSab(size);
  const ctrl = new Int32Array(sab, 0, 4);
  const requestId = ++__fsRequestSequence;
  Atomics.store(ctrl, 0, -1); // pending
  Atomics.store(ctrl, 1, 0);
  Atomics.store(ctrl, 2, 0);
  Atomics.store(ctrl, 3, requestId);

  const message = { __fs__: { sab: ctrl, type: type, payload: args || [], requestId: requestId } };
  __nativePostMessage(message);

  const result = Atomics.wait(ctrl, 0, -1, 30000); // 30s timeout
  if (result === 'timed-out') {
    throw Object.assign(new Error('fs.' + type + ' timed out (30s)'), { code: 'ETIMEDOUT' });
  }

  const status = Atomics.load(ctrl, 0);
  const resultType = Atomics.load(ctrl, 1);
  const payloadLen = Atomics.load(ctrl, 2);
  if (status === 2) {
    if (payloadLen > 256 * 1024 * 1024) {
      throw Object.assign(new Error('fs.' + type + ' response exceeds 256 MB'), { code: 'EOVERFLOW' });
    }
    return __fsSyncCall(type, args, 16 + payloadLen);
  }

  // Read payload bytes. The view is over a SharedArrayBuffer; TextDecoder
  // rejects shared views, so copy into a regular ArrayBuffer before decoding.
  const maxPayload = sab.byteLength - 16;
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
let __wasiStub;
${getWasiRuntimeSource("__nodepodSharedWasi")}
const __SharedWASI = globalThis.__nodepodSharedWasi.WASI;
__wasiStub = { WASI: class WASI extends __SharedWASI {
  constructor(options) {
    const opts = options || {};
    const inheritedEnv = typeof process !== 'undefined' && process.env ? process.env : {};
    super({ ...opts, env: { ...inheritedEnv, ...(opts.env || {}) }, fs: __fsStub });
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
