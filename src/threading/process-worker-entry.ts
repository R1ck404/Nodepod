// per-process Web Worker entry — each worker gets its own MemoryVolume, ScriptEngine, and NodepodShell
// I/O flows through postMessage using the protocol in worker-protocol.ts

import { MemoryVolume } from "../memory-volume";
import type { CompletedResponse } from "../polyfills/http";
import {
  installFetchHeadersSetCookieParity,
  installNodeFetchClassParity,
} from "../polyfills/fetch-response";
import { ScriptEngine, setChildProcessPolyfill } from "../script-engine";
import {
  setSqliteHostBridge,
  warmSqliteEngine,
  warmSqliteWasmBytes,
  WASM_CACHE_PATH,
  WASM_SAB_HEADER_BYTES,
  WASM_SAB_MAX_BYTES,
} from "../polyfills/sqlite";
import { isInternalVfsPath } from "../constants/internal-vfs-paths";

installFetchHeadersSetCookieParity();
installNodeFetchClassParity();
import { SyncChannelWorker } from "./sync-channel";
import { createLazyFsClient } from "./lazy-fs-client";
import type {
  MainToWorkerMessage,
  MainToWorker_Init,
  MainToWorker_Exec,
  VFSSnapshotEntry,
  WorkerToMainMessage,
} from "./worker-protocol";

let _pid = 0;
let _cwd = "/";
let _env: Record<string, string> = {};
let _volume: MemoryVolume | null = null;
let _initialized = false;
let _abortController: AbortController | null = null;

// prevents echo loops — suppress vfs-write/delete while applying inbound vfs-sync
let _suppressVFSWatch = false;

let _shellInitialized = false;
let _shellMod: typeof import("../polyfills/child_process") | null = null;
let _syncChannelWorker: SyncChannelWorker | null = null;
let _sabEnabled = true;
let _ipcMessageHandler: ((data: unknown) => void) | null = null;
let _cols = 80;
let _rows = 24;

const _spawnCallbacks = new Map<number, (result: any) => void>();
const _childOutputCallbacks = new Map<number, (stream: string, data: string) => void>();
const _childExitCallbacks = new Map<number, (exitCode: number, stdout: string, stderr: string) => void>();
const _ipcCallbacks = new Map<number, (data: unknown) => void>();
let _nextRequestId = 1;
let _nextHttpClientId = 1;
const MAX_CHILD_CAPTURE_CHARS = 4 * 1024 * 1024;

function appendCaptured(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_CHILD_CAPTURE_CHARS
    ? next.slice(-Math.floor(MAX_CHILD_CAPTURE_CHARS * 0.75))
    : next;
}

const SQLITE_SAB_PENDING = 0;
const SQLITE_SAB_OK = 1;
const SQLITE_SAB_FAIL = 2;
const SQLITE_LOAD_TIMEOUT_MS = 30_000;

function installSqliteHostBridge(): void {
  if (typeof SharedArrayBuffer === "undefined" || !_volume) {
    setSqliteHostBridge(null);
    return;
  }
  setSqliteHostBridge({
    ensureWasmCached() {
      const sab = new SharedArrayBuffer(WASM_SAB_HEADER_BYTES + WASM_SAB_MAX_BYTES);
      const ctrl = new Int32Array(sab, 0, 4);
      Atomics.store(ctrl, 0, SQLITE_SAB_PENDING);
      Atomics.store(ctrl, 1, 0);
      post({ type: "sqlite-preload", sab: ctrl });
      const waited = Atomics.wait(
        ctrl,
        0,
        SQLITE_SAB_PENDING,
        SQLITE_LOAD_TIMEOUT_MS,
      );
      if (waited === "timed-out") {
        throw new Error(
          `[node:sqlite] timed out waiting for ${WASM_CACHE_PATH} preload`,
        );
      }
      const status = Atomics.load(ctrl, 0);
      if (status !== SQLITE_SAB_OK) {
        throw new Error("[node:sqlite] host WASM preload failed");
      }
      const byteLength = Atomics.load(ctrl, 1);
      if (byteLength > 0) {
        const bytes = new Uint8Array(sab, WASM_SAB_HEADER_BYTES, byteLength);
        const parent = WASM_CACHE_PATH.substring(
          0,
          WASM_CACHE_PATH.lastIndexOf("/"),
        );
        if (parent && parent !== "/" && !_volume!.existsSync(parent)) {
          _volume!.mkdirSync(parent, { recursive: true });
        }
        _volume!.writeCacheSync(WASM_CACHE_PATH, bytes.slice());
      }
    },
  });
}

const _httpClientCallbacks = new Map<
  number,
  {
    resolve: (resp: CompletedResponse) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function post(msg: WorkerToMainMessage, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

function postStdout(data: string): void {
  post({ type: "stdout", data });
}

function postStderr(data: string): void {
  post({ type: "stderr", data });
}

function postExit(exitCode: number, stdout: string, stderr: string): void {
  post({ type: "exit", exitCode, stdout, stderr });
}

function postError(message: string, stack?: string): void {
  post({ type: "error", message, stack });
}

function postCwdChange(cwd: string): void {
  post({ type: "cwd-change", cwd });
}

function postStdinRawStatus(isRaw: boolean): void {
  post({ type: "stdin-raw-status", isRaw });
}

self.addEventListener("message", (ev: MessageEvent) => {
  if (!ev?.data?.type) return;
  const msg = ev.data as MainToWorkerMessage;

  switch (msg.type) {
    case "probe":
      post({ type: "probe-ready" });
      break;
    case "init":
      void handleInit(msg);
      break;
    case "exec":
      handleExec(msg);
      break;
    case "stdin":
      handleStdin(msg.data);
      break;
    case "signal":
      handleSignal(msg);
      break;
    case "resize":
      _cols = msg.cols;
      _rows = msg.rows;
      // push to the currently running script's process.stdout/stderr/stdin
      // so TUI libraries (blessed, ink etc.) get a 'resize' event mid-run
      if (_shellMod) {
        try {
          _shellMod.notifyTerminalResize?.(msg.cols, msg.rows);
        } catch {
          // swallow, size sync isn't critical enough to crash the worker
        }
      }
      break;
    case "vfs-sync":
      handleVFSSync(msg);
      break;
    case "vfs-snapshot":
      if (_volume) {
        _suppressVFSWatch = true;
        try {
          _volume.mountBinarySnapshot(msg.snapshot, false);
        } finally {
          _suppressVFSWatch = false;
        }
      }
      break;
    case "vfs-invalidate":
      // large-file change: drop local copy, re-pull lazily on next access
      if (_volume) {
        _suppressVFSWatch = true;
        try {
          _volume.markLazyInvalidated(msg.path);
        } finally {
          _suppressVFSWatch = false;
        }
      }
      break;
    case "vfs-chunk":
      handleVFSChunk(msg);
      break;
    case "spawn-result":
      _spawnCallbacks.get(msg.requestId)?.(msg);
      _spawnCallbacks.delete(msg.requestId);
      break;
    case "child-output": {
      const cb = _childOutputCallbacks.get(msg.requestId);
      if (cb) cb(msg.stream, msg.data);
      break;
    }
    case "child-exit": {
      const cb = _childExitCallbacks.get(msg.requestId);
      if (cb) {
        _childExitCallbacks.delete(msg.requestId);
        _childOutputCallbacks.delete(msg.requestId);
        cb(msg.exitCode, msg.stdout, msg.stderr);
      }
      break;
    }
    case "ipc-message": {
      const ipcMsg = msg as any;
      if (ipcMsg.targetRequestId !== undefined) {
        // we're the parent — route to the fork callback for a child
        const ipcCb = _ipcCallbacks.get(ipcMsg.targetRequestId);
        if (ipcCb) ipcCb(ipcMsg.data);
      } else {
        // we're the forked child — emit on the process object
        handleIPCMessage(ipcMsg.data);
      }
      break;
    }
    case "http-request":
      handleHttpRequest(msg as any);
      break;
    case "http-client-response":
      handleHttpClientResponse(msg as any);
      break;
    case "ws-upgrade":
      handleWsUpgrade(msg as any);
      break;
    case "ws-data":
      handleWsData(msg as any);
      break;
    case "ws-close":
      handleWsClose(msg as any);
      break;
    default:
      break;
  }
});

async function handleInit(msg: MainToWorker_Init): Promise<void> {
  _pid = msg.pid;
  _cwd = msg.cwd || "/";
  _env = msg.env || {};

  _volume = MemoryVolume.fromBinarySnapshot(msg.snapshot);
  _volume.setBulkMountHandler((snapshot) => {
    const data = snapshot.data.slice(0);
    post({ type: "vfs-snapshot", snapshot: { ...snapshot, data } }, [data]);
  });

  // lean spawn mode: snapshot excluded heavy dirs (node_modules etc.) —
  // install a synchronous fallback that pulls misses from the main thread.
  // needs SAB for Atomics.wait; without it main falls back to full snapshots.
  if (
    msg.snapshot.lazyDirNames &&
    msg.snapshot.lazyDirNames.length > 0 &&
    msg.lazyFsPort &&
    typeof SharedArrayBuffer !== "undefined"
  ) {
    _volume.setMissHandler(
      createLazyFsClient(msg.lazyFsPort),
      msg.snapshot.lazyDirNames,
    );
  }

  // watch local writes and forward to main — suppressed during inbound vfs-sync to prevent echo
  _volume.watch("/", { recursive: true }, (event, filename) => {
    if (!filename || _suppressVFSWatch || isInternalVfsPath(filename)) return;
    try {
      if (_volume!.existsSync(filename)) {
        const stat = _volume!.statSync(filename);
        if (stat.isDirectory()) {
          post({
            type: "vfs-write",
            path: filename,
            content: new ArrayBuffer(0),
            isDirectory: true,
          });
        } else {
          const data = _volume!.readFileSync(filename);
          // must copy into a fresh ArrayBuffer — if the Uint8Array is backed by SAB (e.g. esbuild-wasm or any napi-rs wasm32-wasip1-threads module writing from shared memory), both .buffer.slice() and .slice() return SAB, which isn't transferable
          // postMessage would throw DataCloneError, the catch swallows it, main-thread VFS never learns about the write — this was what caused Vite dep-optimizer 504s (.vite/deps/*.js missing) and downstream 404s
          const buffer = new ArrayBuffer(data.byteLength);
          new Uint8Array(buffer).set(data);
          post({ type: "vfs-write", path: filename, content: buffer, isDirectory: false }, [buffer]);
        }
      } else {
        post({ type: "vfs-delete", path: filename });
      }
    } catch {
      /* ignore */
    }
  });

  if (msg.syncBuffer) {
    _syncChannelWorker = new SyncChannelWorker(msg.syncBuffer);
  }
  // if main had SAB off, neither buffer was sent
  _sabEnabled = !!msg.syncBuffer;

  installSqliteHostBridge();

  if (msg.sqliteStartup === "bytes") {
    warmSqliteWasmBytes();
  } else {
    // DatabaseSync must be ready before synchronous user code can construct it
    try {
      await warmSqliteEngine();
    } catch (err) {
      console.warn("[node:sqlite] automatic initialization failed:", err);
    }
  }

  _initialized = true;
  post({ type: "ready", pid: _pid });
}

async function ensureShell(): Promise<typeof import("../polyfills/child_process")> {
  if (!_shellMod) {
    _shellMod = await import("../polyfills/child_process");
    // must be eager — sync require('child_process') needs this before any microtask fires
    setChildProcessPolyfill(_shellMod);
  }
  if (!_shellInitialized && _volume) {
    _shellMod.initShellExec(_volume, { cwd: _cwd, env: _env });
    if (_syncChannelWorker) {
      _shellMod.setSyncChannel(_syncChannelWorker);
    }
    _shellMod.setSabEnabled(_sabEnabled);
    _shellMod.setSpawnChildCallback(spawnChild);
    _shellMod.setForkChildCallback(forkChild);
    const wtMod = await import("../polyfills/worker_threads");
    wtMod.setWorkerThreadForkCallback(workerThreadFork);
    const httpMod = await import("../polyfills/http");
    httpMod.setServerListenCallback((port: number) => {
      post({ type: "server-listen", port, hostname: "0.0.0.0" });
    });
    httpMod.setServerCloseCallback((port: number) => {
      post({ type: "server-close", port });
    });
    httpMod.setHttpClientBridge((port, method, path, headers, body) =>
      new Promise((resolve, reject) => {
        const requestId = _nextHttpClientId++;
        const timer = setTimeout(() => {
          _httpClientCallbacks.delete(requestId);
          reject(new Error(`HTTP client request timed out for localhost:${port}${path}`));
        }, 30_000);
        _httpClientCallbacks.set(requestId, {
          resolve: (resp) => {
            clearTimeout(timer);
            resolve(resp);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
          timer,
        });
        post({
          type: "http-client-request",
          requestId,
          port,
          method,
          path,
          headers,
          body: body ? body.toString("utf8") : null,
        });
      }),
    );
    _shellInitialized = true;
  }
  return _shellMod;
}

async function handleExec(msg: MainToWorker_Exec): Promise<void> {
  if (!_volume) {
    postStderr("Error: VFS not initialized\n");
    postExit(1, "", "Error: VFS not initialized\n");
    return;
  }

  _abortController = new AbortController();

  if (msg.cwd) {
    _cwd = msg.cwd;
    // sync shell cwd too, otherwise it keeps its old one
    if (_shellMod) _shellMod.setShellCwd(msg.cwd);
  }
  if (msg.env) Object.assign(_env, msg.env);

  if (msg.isShell) {
    await handleShellExec(msg);
  } else {
    await handleFileExec(msg);
  }
}

async function handleShellExec(msg: MainToWorker_Exec): Promise<void> {
  const shellCmd = msg.shellCommand || "";
  const persistent = !!msg.persistent;

  try {
    const shell = await ensureShell();

    shell.setStreamingCallbacks({
      onStdout: postStdout,
      onStderr: postStderr,
      signal: _abortController!.signal,
      getCols: () => _cols,
      getRows: () => _rows,
      onRawModeChange: postStdinRawStatus,
    });

    // shellExec(), NOT child_process.exec() — the latter spawns a new worker and recurses
    shell.shellExec(shellCmd, {}, (error, stdout, stderr) => {
      // don't clearStreamingCallbacks here — background children (e.g. vite dev) still need the sinks, cleaned up on worker termination

      const newCwd = shell.getShellCwd();
      if (newCwd !== _cwd) {
        _cwd = newCwd;
        postCwdChange(newCwd);
      }

      postStdinRawStatus(false);

      const exitCode = error ? ((error as any).code ?? 1) : 0;
      const outStr = String(stdout ?? "");
      const errStr = String(stderr ?? "");

      if (persistent) {
        post({ type: "shell-done", exitCode, stdout: outStr, stderr: errStr });
      } else {
        postExit(exitCode, outStr, errStr);
      }
    });
  } catch (e: any) {
    postError(e?.message || String(e), e?.stack);
    if (persistent) {
      post({ type: "shell-done", exitCode: 1, stdout: "", stderr: e?.message || String(e) });
    } else {
      postExit(1, "", e?.message || String(e));
    }
  }
}

function handleIPCMessage(data: unknown): void {
  if (_shellMod) {
    _shellMod.handleIPCFromParent(data);
  } else if (_ipcMessageHandler) {
    _ipcMessageHandler(data);
  }
}

// file execution (node script.js)
async function handleFileExec(msg: MainToWorker_Exec): Promise<void> {
  const filePath = msg.filePath;
  const args = msg.args || [];

  try {
    const shell = await ensureShell();

    // enable IPC for forks — process.send() goes out as postMessage to main
    if (msg.isFork) {
      shell.setIPCSend((data: unknown) => {
        post({ type: "ipc-message", data });
      });
    }

    let workerThreadsOverride: {
      isMainThread: boolean;
      parentPort: unknown;
      workerData: unknown;
      threadId: number;
    } | undefined;

    if (msg.isWorkerThread) {
      const { MessagePort } = await import("../polyfills/worker_threads");
      const pp = new MessagePort();
      pp.postMessage = (data: unknown) => {
        post({ type: "ipc-message", data });
      };

      shell.setIPCReceiveHandler((data: unknown) => {
        pp.emit("message", data);
      });

      workerThreadsOverride = {
        isMainThread: false,
        parentPort: pp,
        workerData: msg.workerData ?? null,
        threadId: msg.threadId ?? 0,
      };
    }

    shell.setStreamingCallbacks({
      onStdout: postStdout,
      onStderr: postStderr,
      signal: _abortController!.signal,
      getCols: () => _cols,
      getRows: () => _rows,
      onRawModeChange: postStdinRawStatus,
    });

    const ctx = {
      cwd: _cwd,
      env: _env,
      volume: _volume!,
      exec: async (cmd: string, opts?: { cwd?: string; env?: Record<string, string> }) => {
        // needed for ShellContext type compat
        return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
          shell.exec(cmd, opts ?? {}, (error: any, stdout: any, stderr: any) => {
            resolve({
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              exitCode: error ? (error.code ?? 1) : 0,
            });
          });
        });
      },
    };

    const result = await shell.executeNodeBinary(filePath, args, ctx, {
      isFork: !!msg.isFork,
      workerThreadsOverride,
    });

    shell.clearStreamingCallbacks();
    postExit(result.exitCode, result.stdout, result.stderr);
  } catch (e: any) {
    // safety net — executeNodeBinary handles its own errors, but just in case
    const errMsg = e?.message || String(e);
    postStderr(`Error: ${errMsg}\n`);
    postExit(1, "", errMsg);
  }
}

function handleStdin(data: string): void {
  if (!_shellMod) return;
  try {
    _shellMod.sendStdin(data);
  } catch {
    /* ignore */
  }
}

function handleSignal(msg: { signal: string }): void {
  if (msg.signal === "SIGINT" || msg.signal === "SIGTERM") {
    if (_abortController) {
      _abortController.abort();
    }
  }
}

function handleVFSSync(msg: { path: string; content: ArrayBuffer | null; isDirectory: boolean }): void {
  if (!_volume) return;
  // suppress watcher — these came from another worker, don't echo back
  _suppressVFSWatch = true;
  try {
    if (msg.content === null) {
      if (_volume.existsSync(msg.path)) {
        const stat = _volume.statSync(msg.path);
        if (stat.isDirectory()) {
          _volume.rmdirSync(msg.path);
        } else {
          _volume.unlinkSync(msg.path);
        }
      }
    } else if (msg.isDirectory) {
      if (!_volume.existsSync(msg.path)) {
        _volume.mkdirSync(msg.path, { recursive: true });
      }
    } else {
      const parentDir = msg.path.substring(0, msg.path.lastIndexOf("/")) || "/";
      if (parentDir !== "/" && !_volume.existsSync(parentDir)) {
        _volume.mkdirSync(parentDir, { recursive: true });
      }
      _volume.writeFileSync(msg.path, new Uint8Array(msg.content));
    }
  } catch {
    /* ignore */
  } finally {
    _suppressVFSWatch = false;
  }
}

let _vfsChunks: Array<{ data: ArrayBuffer; manifest: VFSSnapshotEntry[] } | null> = [];

function handleVFSChunk(msg: { chunkIndex: number; totalChunks: number; data: ArrayBuffer; manifest: VFSSnapshotEntry[] }): void {
  _vfsChunks[msg.chunkIndex] = { data: msg.data, manifest: msg.manifest };
  const received = _vfsChunks.filter(Boolean).length;
  if (received === msg.totalChunks) {
    _suppressVFSWatch = true;
    try {
      if (_volume) {
        const totalBytes = _vfsChunks.reduce((sum, chunk) => sum + (chunk?.data.byteLength ?? 0), 0);
        const combined = new ArrayBuffer(totalBytes);
        const combinedView = new Uint8Array(combined);
        const manifest: VFSSnapshotEntry[] = [];
        let baseOffset = 0;
        for (const chunk of _vfsChunks) {
          if (!chunk) continue;
          combinedView.set(new Uint8Array(chunk.data), baseOffset);
          for (const entry of chunk.manifest) {
            manifest.push({ ...entry, offset: entry.isDirectory ? 0 : entry.offset + baseOffset });
          }
          baseOffset += chunk.data.byteLength;
        }
        _volume.mountBinarySnapshot({ data: combined, manifest }, false);
      }
    } finally {
      _suppressVFSWatch = false;
    }
    _vfsChunks = [];
  }
}

async function handleHttpRequest(msg: {
  requestId: number;
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}): Promise<void> {
  try {
    const httpMod = await import("../polyfills/http");
    const server = httpMod.getServer(msg.port);
    if (!server) {
      post({
        type: "http-response",
        requestId: msg.requestId,
        statusCode: 503,
        statusMessage: "Service Unavailable",
        headers: { "Content-Type": "text/plain" },
        body: `No server on port ${msg.port}`,
      } as any);
      return;
    }

    const { Buffer } = await import("../polyfills/buffer");
    const bodyBuf = msg.body ? Buffer.from(msg.body) : undefined;
    const result = await server.dispatchRequest(
      msg.method,
      msg.path,
      msg.headers,
      bodyBuf,
    );
    // transfer body as ArrayBuffer so UTF-8 doesn't corrupt binary data
    // the copy below is load-bearing: if result.body is a Uint8Array over SAB (e.g. bytes from rolldown-WASM transforms or any napi-rs wasm32-wasip1-threads module), bytes.buffer.slice() returns a new SAB, not a regular ArrayBuffer
    // SAB isn't transferable per the structured-clone spec, so postMessage throws DataCloneError, the catch returns 500 text/plain, and the browser rejects it as JS module with NS_ERROR_CORRUPTED_CONTENT
    // fresh ArrayBuffer + Uint8Array.set guarantees a plain ArrayBuffer regardless of source backing
    let bodyVal: string | ArrayBuffer = "";
    const transferList: Transferable[] = [];
    if (result.body) {
      if (typeof result.body === "string") {
        bodyVal = result.body;
      } else if (result.body instanceof Uint8Array || Buffer.isBuffer(result.body)) {
        const bytes = result.body instanceof Uint8Array ? result.body : new Uint8Array(result.body);
        const ab = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(ab).set(bytes);
        bodyVal = ab;
        transferList.push(ab);
      } else {
        bodyVal = String(result.body);
      }
    }

    post({
      type: "http-response",
      requestId: msg.requestId,
      statusCode: result.statusCode,
      statusMessage: result.statusMessage,
      headers: result.headers,
      body: bodyVal,
    } as any, transferList);
  } catch (e: any) {
    console.error(`[DEBUG] handleHttpRequest caught:`, e?.message, "\nStack:", e?.stack?.split?.("\n")?.slice(0, 8)?.join("\n"));
    post({
      type: "http-response",
      requestId: msg.requestId,
      statusCode: 500,
      statusMessage: "Internal Server Error",
      headers: { "Content-Type": "text/plain" },
      body: e?.message || "Internal Server Error",
    } as any);
  }
}

function handleHttpClientResponse(msg: {
  requestId: number;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
  body: string | ArrayBuffer;
}): void {
  const entry = _httpClientCallbacks.get(msg.requestId);
  if (!entry) return;
  _httpClientCallbacks.delete(msg.requestId);
  clearTimeout(entry.timer);
  void (async () => {
    const { Buffer } = await import("../polyfills/buffer");
    let bodyVal: Buffer | string | null = null;
    if (msg.body instanceof ArrayBuffer) {
      bodyVal = Buffer.from(new Uint8Array(msg.body));
    } else if (typeof msg.body === "string") {
      bodyVal = msg.body.length > 0 ? msg.body : null;
    }
    entry.resolve({
      statusCode: msg.statusCode,
      statusMessage: msg.statusMessage,
      headers: msg.headers,
      body:
        bodyVal == null
          ? Buffer.alloc(0)
          : typeof bodyVal === "string"
            ? Buffer.from(bodyVal)
            : bodyVal,
    });
  })().catch((err) => {
    entry.reject(err instanceof Error ? err : new Error(String(err)));
  });
}

// active WS connections: uid → socket (TcpSocket in the worker)
const _wsConnections = new Map<string, any>();

async function handleWsUpgrade(msg: {
  uid: string;
  port: number;
  path: string;
  headers: Record<string, string>;
}): Promise<void> {
  try {
    const httpMod = await import("../polyfills/http");
    const { encodeFrame, decodeFrame } = httpMod;
    const { Buffer } = await import("../polyfills/buffer");

    const server = httpMod.getServer(msg.port);
    if (!server) {
      post({ type: "ws-frame", uid: msg.uid, kind: "error", message: `No server on port ${msg.port}` } as any);
      return;
    }

    const { socket } = server.dispatchUpgrade(msg.path || "/", msg.headers);

    let outboundBuf = new Uint8Array(0);
    let handshakeDone = false;

    // intercept socket.write, decode WS frames, relay to main thread
    socket.write = ((
      chunk: Uint8Array | string,
      encOrCb?: string | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean => {
      const raw = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
      const fn = typeof encOrCb === "function" ? encOrCb : cb;

      if (!handshakeDone) {
        const text = new TextDecoder().decode(raw);
        if (text.startsWith("HTTP/1.1 101")) {
          handshakeDone = true;
          post({ type: "ws-frame", uid: msg.uid, kind: "open" } as any);
          if (fn) queueMicrotask(() => fn(null));
          return true;
        }
      }

      const merged = new Uint8Array(outboundBuf.length + raw.length);
      merged.set(outboundBuf, 0);
      merged.set(raw, outboundBuf.length);
      outboundBuf = merged;

      while (outboundBuf.length >= 2) {
        const frame = decodeFrame(outboundBuf);
        if (!frame) break;
        outboundBuf = outboundBuf.slice(frame.consumed);

        switch (frame.op) {
          case 0x01: { // TEXT
            const text = new TextDecoder().decode(frame.data);
            post({ type: "ws-frame", uid: msg.uid, kind: "text", data: text } as any);
            break;
          }
          case 0x02: // BINARY
            post({ type: "ws-frame", uid: msg.uid, kind: "binary", bytes: Array.from(frame.data) } as any);
            break;
          case 0x08: { // CLOSE
            const code = frame.data.length >= 2 ? (frame.data[0] << 8) | frame.data[1] : 1000;
            post({ type: "ws-frame", uid: msg.uid, kind: "close", code } as any);
            _wsConnections.delete(msg.uid);
            break;
          }
          case 0x09: // ping, send pong back
            socket._feedData(Buffer.from(encodeFrame(0x0A, frame.data, true)));
            break;
        }
      }

      if (fn) queueMicrotask(() => fn(null));
      return true;
    }) as any;

    _wsConnections.set(msg.uid, socket);
  } catch (e: any) {
    post({ type: "ws-frame", uid: msg.uid, kind: "error", message: e?.message || "WS upgrade failed" } as any);
  }
}

function handleWsData(msg: { uid: string; frame: number[] }): void {
  const socket = _wsConnections.get(msg.uid);
  if (!socket) return;
  try {
    const { Buffer } = require("../polyfills/buffer");
    socket._feedData(Buffer.from(new Uint8Array(msg.frame)));
  } catch { /* ignore */ }
}

function handleWsClose(msg: { uid: string; code: number }): void {
  const socket = _wsConnections.get(msg.uid);
  if (!socket) return;
  try {
    const codeBuf = new Uint8Array(2);
    codeBuf[0] = (msg.code >> 8) & 0xff;
    codeBuf[1] = msg.code & 0xff;
    const { encodeFrame } = require("../polyfills/http");
    const { Buffer } = require("../polyfills/buffer");
    socket._feedData(Buffer.from(encodeFrame(0x08, codeBuf, true)));
  } catch { /* ignore */ }
  try { socket.destroy(); } catch { /* ignore */ }
  _wsConnections.delete(msg.uid);
}

// forks a child process via main thread — returns IPC handles immediately, output and exit arrive via callbacks
export function forkChild(
  modulePath: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
    onIPC?: (data: unknown) => void;
    onExit?: (exitCode: number) => void;
  },
): { sendIPC: (data: unknown) => void; disconnect: () => void; requestId: number } {
  const requestId = _nextRequestId++;

  if (opts.onIPC) {
    _ipcCallbacks.set(requestId, opts.onIPC);
  }

  _spawnCallbacks.set(requestId, (result: any) => {
    if (result.error) {
      _ipcCallbacks.delete(requestId);
      opts.onStderr?.(`Fork error: ${result.error}\n`);
      opts.onExit?.(1);
      return;
    }

    _childOutputCallbacks.set(requestId, (stream: string, data: string) => {
      if (stream === "stdout") {
        opts.onStdout?.(data);
      } else {
        opts.onStderr?.(data);
      }
    });

    _childExitCallbacks.set(requestId, (exitCode: number) => {
      _ipcCallbacks.delete(requestId);
      opts.onExit?.(exitCode);
    });
  });

  post({
    type: "fork-request",
    requestId,
    modulePath,
    args,
    cwd: opts.cwd,
    env: opts.env,
  });

  return {
    requestId,
    sendIPC: (data: unknown) => {
      post({
        type: "ipc-message",
        targetRequestId: requestId,
        data,
      });
    },
    disconnect: () => {
      _ipcCallbacks.delete(requestId);
      _childOutputCallbacks.delete(requestId);
      _childExitCallbacks.delete(requestId);
    },
  };
}

// like forkChild but for worker_threads — posts "workerthread-request" with workerData/threadId
function workerThreadFork(
  modulePath: string,
  opts: {
    workerData: unknown;
    threadId: number;
    isEval?: boolean;
    rawWasi?: boolean;
    cwd: string;
    env: Record<string, string>;
    onMessage: (data: unknown) => void;
    onError: (err: Error) => void;
    onExit: (code: number) => void;
    onOnline?: () => void;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  },
): { postMessage: (data: unknown) => void; terminate: () => void; requestId: number } {
  const requestId = _nextRequestId++;

  _ipcCallbacks.set(requestId, (data: unknown) => {
    if (data && typeof data === "object" && "__nodepod_broker_ready__" in data) {
      opts.onOnline?.();
      return;
    }
    if (data && typeof data === "object" && "__nodepod_worker_error__" in data) {
      opts.onError(new Error(String((data as any).__nodepod_worker_error__)));
      return;
    }
    opts.onMessage(data);
  });

  _spawnCallbacks.set(requestId, (result: any) => {
    if (result.error) {
      _ipcCallbacks.delete(requestId);
      opts.onError(new Error(result.error));
      return;
    }

    _childOutputCallbacks.set(requestId, (stream: string, data: string) => {
      if (stream === "stdout") {
        opts.onStdout?.(data);
      } else {
        opts.onStderr?.(data);
      }
    });

    _childExitCallbacks.set(requestId, (exitCode: number) => {
      _ipcCallbacks.delete(requestId);
      opts.onExit(exitCode);
    });
  });

  if (opts.rawWasi) {
    post({
      type: "wasiworker-request",
      requestId,
      source: modulePath,
      name: `napi-wasi-${opts.threadId}`,
      workerData: opts.workerData,
    } as any);
  } else {
    post({
      type: "workerthread-request",
      requestId,
      modulePath,
      isEval: opts.isEval,
      args: [],
      cwd: opts.cwd,
      env: opts.env,
      workerData: opts.workerData,
      threadId: opts.threadId,
    } as any);
  }

  return {
    requestId,
    postMessage: (data: unknown) => {
      post({
        type: "ipc-message",
        targetRequestId: requestId,
        data,
      });
    },
    terminate: () => {
      if (opts.rawWasi) post({ type: "wasiworker-terminate", requestId } as any);
      _ipcCallbacks.delete(requestId);
      _childOutputCallbacks.delete(requestId);
      _childExitCallbacks.delete(requestId);
    },
  };
}

// spawns a child via main thread, resolves when child exits — onStdout/onStderr fire in real time as child-output messages arrive
export function spawnChild(
  command: string,
  args: string[],
  opts?: {
    cwd?: string;
    env?: Record<string, string>;
    stdio?: "pipe" | "inherit" | Array<"pipe" | "inherit" | "ignore">;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  },
): Promise<{ pid: number; exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const requestId = _nextRequestId++;
    let stdout = "";
    let stderr = "";

    _spawnCallbacks.set(requestId, (result: any) => {
      if (result.error) {
        reject(new Error(result.error));
        return;
      }

      _childOutputCallbacks.set(requestId, (stream: string, data: string) => {
        if (stream === "stdout") {
          stdout = appendCaptured(stdout, data);
          opts?.onStdout?.(data);
        } else {
          stderr = appendCaptured(stderr, data);
          opts?.onStderr?.(data);
        }
      });

      _childExitCallbacks.set(requestId, (exitCode: number, fullStdout: string, fullStderr: string) => {
        resolve({
          pid: result.pid,
          exitCode,
          stdout: fullStdout || stdout,
          stderr: fullStderr || stderr,
        });
      });
    });

    post({
      type: "spawn-request",
      requestId,
      command,
      args,
      cwd: opts?.cwd || _cwd,
      env: opts?.env || _env,
      stdio: opts?.stdio || "pipe",
    });
  });
}
