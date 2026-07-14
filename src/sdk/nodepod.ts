import { MemoryVolume } from "../memory-volume";
import { DependencyInstaller } from "../packages/installer";
import {
  RequestProxy,
  getProxyInstance,
  NodepodSWSetupError,
  type IVirtualServer,
} from "../request-proxy";
import type { VolumeSnapshot } from "../engine-types";
import { Buffer } from "../polyfills/buffer";
import type {
  NodepodOptions,
  TerminalOptions,
  Snapshot,
  SnapshotOptions,
  SpawnOptions,
} from "./types";
import { NodepodFS } from "./nodepod-fs";
import { NodepodProcess } from "./nodepod-process";
import { NodepodTerminal } from "./nodepod-terminal";
import { getCompletions } from "../shell/shell-completions";
import { parse as parseShell } from "../shell/shell-parser";
import { builtins as shellBuiltins } from "../shell/shell-builtins";
import { ProcessManager } from "../threading/process-manager";
import { setAllowedDomains } from "../cross-origin";
import type { ProcessHandle } from "../threading/process-handle";
import { VFSBridge } from "../threading/vfs-bridge";
import {
  isSharedArrayBufferAvailable,
  SharedVFSController,
  SharedVFSReader,
} from "../threading/shared-vfs";
import { NodepodFSClient } from "./nodepod-fs-client";
import { SyncChannelController } from "../threading/sync-channel";
import { MemoryHandler } from "../memory-handler";
import { openSnapshotCache } from "../persistence/idb-cache";
import { openOPFSSnapshotCache } from "../persistence/opfs-snapshot-cache";
import { getEsbuild } from "../helpers/esbuild-engine";
import { disposeEsbuild } from "../helpers/esbuild-engine";
import { disposePool, poolStats } from "../threading/offload";
import {
  disposeWasmCache,
  reclaimWasmCache,
  wasmCacheStats,
} from "../helpers/wasm-cache";
import { getWorkerTransformCache } from "../threading/worker-transform-cache";
import { invalidateBundleCache } from "../packages/browser-bundler";
import {
  PerformanceTracker,
  type PerformanceStats,
} from "../performance-tracker";

let activeNodepodCount = 0;

// the SharedVFS is the synchronous filesystem visible to WASI and nested
// workers. unlike the canonical MemoryVolume, it cannot grow after being
// passed to a worker. 64 MiB is too small for ordinary modern app dependency
// trees once build-tool WASM binaries are included.
const DEFAULT_RUNTIME_SHARED_VFS_BUFFER_SIZE = 256 * 1024 * 1024;

// short url-safe id. always starts with a letter so it can't be confused
// with a port number in /__virtual__/{id}/{port}
function makeInstanceId(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return "pod" + rand;
}

// quote args before joining so the shell doesn't retokenize them.
// without this, `sh -c 'mv /a/* /b/'` loses the body.
function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(arg)) return arg;
  // single-quote it, escape any inner quotes the posix way
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function parseSimpleCommand(
  input: string,
  env: Record<string, string>,
): { name: string; args: string[] } | null {
  const ast = parseShell(input, env);
  if (ast.entries.length !== 1 || ast.entries[0].next) return null;

  const pipeline = ast.entries[0].pipeline;
  if (pipeline.commands.length !== 1) return null;

  const command = pipeline.commands[0];
  if (command.redirects.length || command.args.length === 0) return null;

  const [name, ...args] = command.args;
  return { name, args };
}

export class Nodepod {
  readonly fs: NodepodFS;

  /** unique id used by RequestProxy + SW to route back to this Nodepod when
   *  multiple coexist on one page */
  readonly instanceId: string;

  private _volume: MemoryVolume;
  private _packages: DependencyInstaller;
  private _proxy: RequestProxy;
  private _cwd: string;
  private _env: Record<string, string>;

  private _processManager: ProcessManager;
  private _vfsBridge: VFSBridge;
  private _sharedVFS: SharedVFSController | null = null;
  private _syncChannel: SyncChannelController | null = null;
  private _unwatchVFS: (() => void) | null = null;
  private _handler: MemoryHandler;
  private _sabEnabled: boolean;
  private _sharedVFSBufferSize: number;
  private _disposed = false;
  private _unsubscribePressure: (() => void) | null = null;
  private _performance: PerformanceTracker;

  /* ---- Construction (use Nodepod.boot()) ---- */

  private constructor(
    volume: MemoryVolume,
    packages: DependencyInstaller,
    proxy: RequestProxy,
    cwd: string,
    handler: MemoryHandler,
    env: Record<string, string>,
    sabEnabled: boolean,
    sharedVFSBufferSize: number | undefined,
    instanceId: string,
    performanceTracker: PerformanceTracker,
  ) {
    this._volume = volume;
    this._packages = packages;
    this._proxy = proxy;
    this._cwd = cwd;
    this._env = env;
    this._handler = handler;
    this._unsubscribePressure = handler.onPressure(() => {
      // only discard reproducible data; live modules, processes, servers and
      // writable VFS files are deliberately untouched.
      handler.flush();
      invalidateBundleCache();
      reclaimWasmCache();
    });
    this._sabEnabled = sabEnabled;
    this._sharedVFSBufferSize =
      sharedVFSBufferSize ?? DEFAULT_RUNTIME_SHARED_VFS_BUFFER_SIZE;
    this.instanceId = instanceId;
    this._performance = performanceTracker;
    this.fs = new NodepodFS(volume);
    activeNodepodCount++;
    this._processManager = new ProcessManager(volume, performanceTracker);
    this._vfsBridge = new VFSBridge(volume);

    this._vfsBridge.setBroadcaster((path, content, excludePid) => {
      const isDirectory = content !== null && content.byteLength === 0;
      this._processManager.broadcastVFSChange(
        path,
        content,
        isDirectory,
        excludePid,
      );
    });

    this._processManager.setVFSBridge(this._vfsBridge);

    // VFS watcher broadcasts main-thread file changes to workers (needed for HMR)
    this._unwatchVFS = this._vfsBridge.watch();

    if (sabEnabled) {
      try {
        this._syncChannel = new SyncChannelController();
        this._processManager.setSyncBuffer(this._syncChannel.buffer);
      } catch (e) {
        // SyncChannel init failed
      }

      // core SAB features only depend on the small sync channel; the optional
      // SharedFS mirror is allocated lazily by sharedFSBuffer.
      if (!this._syncChannel) {
        this._sabEnabled = false;
        console.warn(
          "[Nodepod] SharedArrayBuffer init failed mid-boot, features disabled.",
        );
      }
    }

    // Bridge worker HTTP servers to the RequestProxy for preview URLs
    this._processManager.on(
      "server-listen",
      (_pid: number, port: number, _hostname: string) => {
        const proxyServer: IVirtualServer = {
          listening: true,
          address: () => ({ port, address: "0.0.0.0", family: "IPv4" }),
          dispatchRequest: async (method, url, headers, body) => {
            const bodyStr = body
              ? typeof body === "string"
                ? body
                : body.toString("utf8")
              : null;
            const result = await this._processManager.dispatchHttpRequest(
              port,
              method,
              url,
              headers,
              bodyStr,
            );
            // Body can be ArrayBuffer (binary) or string (text)
            const respBody =
              result.body instanceof ArrayBuffer
                ? Buffer.from(new Uint8Array(result.body))
                : Buffer.from(result.body);
            return {
              statusCode: result.statusCode,
              statusMessage: result.statusMessage,
              headers: result.headers,
              body: respBody,
            };
          },
        };
        this._proxy.register(this.instanceId, proxyServer, port);
      },
    );

    this._processManager.on("server-close", (_pid: number, port: number) => {
      this._proxy.unregister(this.instanceId, port);
    });

    this._proxy.attach(this.instanceId, this._processManager);
  }

  /* ---- Static factory ---- */

  static async boot(opts: NodepodOptions = {}): Promise<Nodepod> {
    const performanceTracker = new PerformanceTracker();
    const stopBoot = performanceTracker.start("boot.total");
    if (typeof Worker === "undefined") {
      throw new Error(
        "[Nodepod] Web Workers are required. Nodepod cannot run without Web Worker support.",
      );
    }

    const sabAvailable = isSharedArrayBufferAvailable();
    const sabEnabled = opts.enableSharedArrayBuffer !== false && sabAvailable;
    if (!sabEnabled) {
      const reason = !sabAvailable
        ? "unavailable (likely missing COOP/COEP headers)"
        : "disabled via enableSharedArrayBuffer: false";
      console.warn(
        `[Nodepod] SharedArrayBuffer ${reason}. ` +
          "execSync/spawnSync will throw on call, threaded wasi modules " +
          "(rolldown, lightningcss, tailwind-oxide) will refuse to load, " +
          "cross-thread vfs reads use async message passing.",
      );
    }

    const cwd = opts.workdir ?? "/";
    const env = opts.env ?? {};

    const handler = new MemoryHandler(opts.memory);
    handler.startMonitoring();
    const volume = new MemoryVolume(handler);

    // Open IDB snapshot cache for faster re-boots (opt-out via enableSnapshotCache: false)
    let snapshotCache = null;
    if (opts.enableSnapshotCache !== false && opts.packageStore !== "memory") {
      const stopCacheOpen = performanceTracker.start("boot.snapshotCache");
      try {
        if (opts.packageStore === "opfs") {
          snapshotCache = await openOPFSSnapshotCache();
          if (snapshotCache) performanceTracker.increment("storage.opfs");
        }
        if (!snapshotCache) {
          snapshotCache = await openSnapshotCache();
          if (snapshotCache) performanceTracker.increment("storage.indexedDb");
        }
      } catch {
        /* IDB unavailable */
      } finally {
        stopCacheOpen();
      }
    }

    const packages = new DependencyInstaller(volume, {
      snapshotCache,
      performanceTracker,
    });
    const proxy = getProxyInstance({
      onServerReady: opts.onServerReady,
    });

    // set up fetch domain whitelist (null = allow everything)
    if (opts.allowedFetchDomains === null) {
      setAllowedDomains(null);
    } else {
      setAllowedDomains(opts.allowedFetchDomains ?? []);
    }

    const nodepod = new Nodepod(
      volume,
      packages,
      proxy,
      cwd,
      handler,
      env,
      sabEnabled,
      opts.sharedVFSBufferSize,
      makeInstanceId(),
      performanceTracker,
    );

    if (opts.spawnSnapshot) {
      // ProcessManager double-checks SAB availability per spawn and falls
      // back to full snapshots with a one-time warning
      nodepod._processManager.setSpawnSnapshotMode(opts.spawnSnapshot);
    }

    // warm the shared esbuild instance while the rest of boot proceeds;
    // fire-and-forget — consumers await getEsbuild() themselves
    if (opts.preloadEsbuild === true && typeof window !== "undefined") {
      getEsbuild().catch(() => {});
    }

    // probe for the external worker asset so first spawn can skip the
    // embedded bundle string; fire-and-forget with embedded fallback
    ProcessManager.probeExternalWorkerBundle(opts.workerUrl).catch(() => {});

    if (opts.files) {
      for (const [path, content] of Object.entries(opts.files)) {
        const dir = path.substring(0, path.lastIndexOf("/")) || "/";
        if (dir !== "/" && !volume.existsSync(dir)) {
          volume.mkdirSync(dir, { recursive: true });
        }
        volume.writeFileSync(path, content as any);
      }
    }

    if (cwd !== "/" && !volume.existsSync(cwd)) {
      volume.mkdirSync(cwd, { recursive: true });
    }

    for (const dir of ["/tmp", "/home"]) {
      if (!volume.existsSync(dir)) {
        volume.mkdirSync(dir, { recursive: true });
      }
    }

    // SW is default-on as of 1.2. Pass `serviceWorker: false` to opt out
    // (SSR, Node tests). Pre-1.2 required `swUrl` to enable it, which
    // silently broke preview iframes for anyone who installed from npm.
    const swEnabled =
      opts.serviceWorker !== false &&
      typeof navigator !== "undefined" &&
      "serviceWorker" in navigator;

    if (swEnabled) {
      const stopServiceWorker = performanceTracker.start("boot.serviceWorker");
      try {
        await proxy.initServiceWorker({
          swUrl: opts.swUrl,
          skipPreflight: opts.skipSWPreflight,
        });
        // Watermark is on by default, only disable if explicitly set to false
        if (opts.watermark === false) {
          proxy.setWatermark(false);
        }
      } catch (e) {
        // Setup errors have an actionable hint attached, rethrow them.
        // Anything else (weird host envs, navigator vanishing mid-boot)
        // is non-fatal; warn and let boot() return so spawn/VFS still work.
        if (e instanceof NodepodSWSetupError) throw e;
        if (typeof console !== "undefined" && console.warn) {
          console.warn(
            "[nodepod] service worker registration failed " +
              "(preview iframes and virtual HTTP servers won't work):",
            e,
          );
        }
      } finally {
        stopServiceWorker();
      }
    }

    stopBoot();
    return nodepod;
  }

  /* ---- spawn() ---- */

  // Each spawn gets a dedicated worker with its own engine + shell
  async spawn(
    cmd: string,
    args?: string[],
    opts?: SpawnOptions,
  ): Promise<NodepodProcess> {
    this._assertActive();
    const proc = new NodepodProcess();
    const execCwd = opts?.cwd ?? this._cwd;
    const combinedEnv = { ...this._env, ...(opts?.env ?? {}) };

    const handle = this._processManager.spawn({
      command: cmd,
      args: args ?? [],
      cwd: execCwd,
      env: combinedEnv,
    });

    handle.on("stdout", (data: string) => {
      if (!proc.exited) proc._pushStdout(data);
    });

    handle.on("stderr", (data: string) => {
      if (!proc.exited) proc._pushStderr(data);
    });

    handle.on("exit", (exitCode: number, stdout?: string, stderr?: string) => {
      if (!proc.exited) {
        proc._mergeExitOutput(stdout, stderr);
        proc._finish(exitCode);
      }
    });

    handle.on("worker-error", (message: string) => {
      if (!proc.exited) {
        proc._pushStderr(`Worker error: ${message}\n`);
        proc._finish(1);
      }
    });

    proc._setSendStdin((data: string) => handle.sendStdin(data));
    proc._setKillFn(() => handle.kill("SIGINT"));

    if (opts?.signal) {
      opts.signal.addEventListener(
        "abort",
        () => {
          handle.kill("SIGINT");
        },
        { once: true },
      );
    }

    await new Promise<void>((resolve) => {
      if (handle.state === "running") {
        resolve();
      } else {
        handle.on("ready", () => resolve());
      }
    });

    const isNodeFileRun =
      cmd === "node" &&
      args?.length &&
      !args[0].startsWith("-");
    if (isNodeFileRun) {
      const filePath = this._resolveCommand(cmd, args);
      handle.exec({
        type: "exec",
        filePath,
        args: args?.slice(1) ?? [],
        cwd: execCwd,
        env: opts?.env,
        isShell: false,
      });
    } else {
      // quote everything so sh -c bodies survive the round-trip
      const fullCmd = args?.length
        ? `${shellQuote(cmd)} ${args.map(shellQuote).join(" ")}`
        : cmd;
      handle.exec({
        type: "exec",
        filePath: "",
        args: args ?? [],
        cwd: execCwd,
        env: opts?.env,
        isShell: true,
        shellCommand: fullCmd,
      });
    }

    return proc;
  }

  private _resolveCommand(cmd: string, args?: string[]): string {
    if (cmd === "node" && args?.length) {
      const filePath = args[0];
      if (filePath.startsWith("/")) return filePath;
      return `${this._cwd}/${filePath}`.replace(/\/+/g, "/");
    }
    return cmd;
  }

  /* ---- createTerminal() ---- */

  createTerminal(opts: TerminalOptions): NodepodTerminal {
    this._assertActive();
    const terminal = new NodepodTerminal(opts);
    terminal.setCwd(this._cwd);
    const customCommands = opts.customCommands ?? {};
    const customCommandNames = Object.keys(customCommands);

    let activeAbort: AbortController | null = null;
    let currentSendStdin: ((data: string) => void) | null = null;
    let activeCommandId = 0;
    const nextCommandId = () => {
      activeCommandId = (activeCommandId + 1) % Number.MAX_SAFE_INTEGER;
      return activeCommandId;
    };
    let isStdinRaw = false;

    // Persistent shell worker -- reused across commands so VFS state persists
    // and we skip the ~1s worker creation overhead per command
    let shellHandle: ProcessHandle | null = null;
    let shellReady: Promise<void> | null = null;

    const ensureShellWorker = (): Promise<void> => {
      if (shellHandle && shellHandle.state !== "exited") {
        return shellReady!;
      }
      shellHandle = this._processManager.spawn({
        command: "shell",
        args: [],
        cwd: terminal.getCwd(),
        env: this._env,
      });
      shellReady = new Promise<void>((resolve) => {
        const seedSize = () => {
          // seed size before the first exec so interactive CLIs see real
          // dimensions instead of the 80x24 worker defaults
          if (lastCols && lastRows && shellHandle) {
            shellHandle.resize(lastCols, lastRows);
          }
        };
        if (shellHandle!.state === "running") {
          seedSize();
          resolve();
        } else {
          shellHandle!.on("ready", () => {
            seedSize();
            resolve();
          });
        }
      });

      shellHandle.on("cwd-change", (cwd: string) => {
        this._cwd = cwd;
        terminal.setCwd(cwd);
      });

      shellHandle.on("stdin-raw-status", (raw: boolean) => {
        isStdinRaw = raw;
      });

      // Worker died -- next command will spawn a fresh one
      shellHandle.on("exit", () => {
        shellHandle = null;
        shellReady = null;
      });

      return shellReady;
    };

    // last known size, sent to the shell worker as soon as it boots so the
    // first command sees the real dimensions instead of 80x24 defaults
    let lastCols = 0;
    let lastRows = 0;

    const forwardResize = (cols: number, rows: number) => {
      lastCols = cols;
      lastRows = rows;
      // fire and forget. if no shell exists yet, the size is seeded via
      // the "ready" handler below so the first exec picks it up.
      if (shellHandle && shellHandle.state !== "exited") {
        shellHandle.resize(cols, rows);
      }
    };

    terminal._wireExecution({
      onCommand: async (cmd: string) => {
        const myAbort = new AbortController();
        activeAbort = myAbort;
        const myCommandId = nextCommandId();

        let streamed = false;
        let wroteNewline = false;

        function ensureNewline() {
          if (!wroteNewline) {
            wroteNewline = true;
            terminal.write("\r\n");
          }
        }

        const simpleCommand = parseSimpleCommand(cmd, this._env);
        if (simpleCommand && customCommands[simpleCommand.name]) {
          try {
            const output = customCommands[simpleCommand.name](
              terminal.getCwd(),
              simpleCommand.args,
            );
            if (output) {
              ensureNewline();
              terminal._writeOutput(output);
            }
          } catch (err) {
            ensureNewline();
            const message = err instanceof Error ? err.message : String(err);
            terminal._writeOutput(`${simpleCommand.name}: ${message}\n`, true);
          } finally {
            if (activeAbort === myAbort) activeAbort = null;
            currentSendStdin = null;
            if (!wroteNewline) terminal.write("\r\n");
            terminal._setRunning(false);
            terminal._writePrompt();
          }
          return;
        }

        // Ensure persistent shell worker is running
        await ensureShellWorker();
        const handle = shellHandle!;

        // Ignore output from previous commands or before exec is sent (stale child output)
        let execSent = false;
        const onStdout = (data: string) => {
          if (myCommandId !== activeCommandId) return;
          if (!execSent) return;
          streamed = true;
          ensureNewline();
          terminal._writeOutput(data);
        };
        const onStderr = (data: string) => {
          if (myCommandId !== activeCommandId) return;
          if (!execSent) return;
          streamed = true;
          ensureNewline();
          terminal._writeOutput(data, true);
        };

        handle.on("stdout", onStdout);
        handle.on("stderr", onStderr);

        currentSendStdin = (data: string) => handle.sendStdin(data);

        // PM.kill() recursively kills descendants + cleans up server ports
        myAbort.signal.addEventListener(
          "abort",
          () => {
            this._processManager.kill(handle.pid, "SIGINT");
          },
          { once: true },
        );

        handle.exec({
          type: "exec",
          filePath: "",
          args: [],
          cwd: terminal.getCwd(),
          isShell: true,
          shellCommand: cmd,
          persistent: true,
        });
        execSent = true;

        return new Promise<void>((resolve) => {
          const cleanup = () => {
            handle.removeListener("shell-done", onDone);
            handle.removeListener("exit", onExit);
            handle.removeListener("stdout", onStdout);
            handle.removeListener("stderr", onStderr);
          };

          const onDone = (exitCode: number, stdout: string, stderr: string) => {
            cleanup();
            const isStale = myCommandId !== activeCommandId;
            if (!isStale) {
              currentSendStdin = null;
            }

            const aborted = myAbort.signal.aborted;

            if (!aborted && !streamed && !isStale) {
              const outStr = String(stdout ?? "");
              const errStr = String(stderr ?? "");
              if (outStr || errStr) ensureNewline();
              if (outStr) terminal._writeOutput(outStr);
              if (errStr) terminal._writeOutput(errStr, true);
            }

            if (activeAbort === myAbort) activeAbort = null;

            if (!aborted && !isStale) {
              if (!wroteNewline) terminal.write("\r\n");
              terminal._setRunning(false);
              terminal._writePrompt();
            }
            resolve();
          };

          const onExit = (exitCode: number, stdout: string, stderr: string) => {
            cleanup();
            const isStale = myCommandId !== activeCommandId;
            if (!isStale) currentSendStdin = null;
            const aborted = myAbort.signal.aborted;
            if (!aborted && !streamed && !isStale) {
              const outStr = String(stdout ?? "");
              const errStr = String(stderr ?? "");
              if (outStr || errStr) ensureNewline();
              if (outStr) terminal._writeOutput(outStr);
              if (errStr) terminal._writeOutput(errStr, true);
            }
            if (activeAbort === myAbort) activeAbort = null;
            if (!aborted && !isStale) {
              if (!wroteNewline) terminal.write("\r\n");
              terminal._setRunning(false);
              terminal._writePrompt();
            }
            resolve();
          };

          handle.on("shell-done", onDone);
          handle.on("exit", onExit);
        });
      },

      getSendStdin: () => currentSendStdin,
      getIsStdinRaw: () => isStdinRaw,
      getActiveAbort: () => activeAbort,
      setActiveAbort: (ac) => {
        activeAbort = ac;
      },
      getCompletions: (line: string, cursorPos: number, cwd: string) =>
        getCompletions(line, cursorPos, cwd, this._volume, shellBuiltins.keys(), {
          extraCommands: customCommandNames,
        }),
      onResize: forwardResize,
    });

    return terminal;
  }

  /* ---- setPreviewScript() ---- */

  // Inject a script into every preview iframe before any page content loads.
  // Useful for setting up a communication bridge between the main window and
  // the preview iframe, injecting polyfills, analytics, etc.
  async setPreviewScript(script: string): Promise<void> {
    this._assertActive();
    this._proxy.setPreviewScript(this.instanceId, script);
  }

  async clearPreviewScript(): Promise<void> {
    this._assertActive();
    this._proxy.setPreviewScript(this.instanceId, null);
  }

  /* ---- port() ---- */

  // preview url for a server on this port, or null. scoped to instanceId so
  // multiple Nodepods on one page don't collide
  port(num: number): string | null {
    this._assertActive();
    if (this._proxy.activePorts(this.instanceId).includes(num)) {
      return this._proxy.serverUrl(this.instanceId, num);
    }
    return null;
  }

  /* ---- snapshot / restore ---- */

  /** Directory names excluded from snapshots at any depth when shallow=true. */
  private static readonly SHALLOW_EXCLUDE_DIRS = new Set([
    "node_modules",
    ".cache",
    ".npm",
  ]);

  snapshot(opts?: SnapshotOptions): Snapshot {
    this._assertActive();
    const shallow = opts?.shallow ?? true;
    return this._volume.toSnapshot(
      undefined,
      shallow ? Nodepod.SHALLOW_EXCLUDE_DIRS : undefined,
    );
  }

  async restore(snapshot: Snapshot, opts?: SnapshotOptions): Promise<void> {
    this._assertActive();
    const autoInstall = opts?.autoInstall ?? true;

    // Swap the internal tree
    const fresh = MemoryVolume.fromSnapshot(snapshot);
    (this._volume as any).tree = (fresh as any).tree;

    // Auto-install deps from package.json if requested and manifest exists
    if (autoInstall && this._volume.existsSync("/package.json")) {
      await this._packages.installFromManifest();
    }
  }

  /* ---- teardown ---- */

  teardown(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._unwatchVFS) {
      this._unwatchVFS();
      this._unwatchVFS = null;
    }
    // release our slot so sibling Nodepods on the same page keep working
    try {
      this._proxy.detach(this.instanceId);
    } catch {
      /* */
    }
    this._processManager.teardown();
    this._vfsBridge.clearSharedVFS();
    this._sharedVFS = null;
    this._syncChannel = null;
    this._volume.dispose();
    this._handler.destroy();
    this._unsubscribePressure?.();
    this._unsubscribePressure = null;
    activeNodepodCount = Math.max(0, activeNodepodCount - 1);
    if (activeNodepodCount === 0) {
      disposePool();
      disposeWasmCache();
      disposeEsbuild();
      getWorkerTransformCache().clear();
      ProcessManager.disposeGlobalResources();
    }
  }

  /* ---- Performance stats ---- */

  performanceStats(): PerformanceStats {
    return this._performance.snapshot();
  }

  memoryStats(): {
    vfs: {
      fileCount: number;
      totalBytes: number;
      dirCount: number;
      watcherCount: number;
      lazyResidentBytes: number;
    };
    engine: { moduleCacheSize: number; transformCacheSize: number };
    runtime: {
      processes: number;
      workers: number;
      messagePorts: number;
      pendingHttp: number;
      sharedFSAllocated: boolean;
      sharedFSBytes: number;
      sharedFSUsedBytes: number;
      wasmCacheEntries: number;
      budgetMB: number;
    };
    heap: { usedMB: number; totalMB: number; limitMB: number } | null;
  } {
    const vfs = this._volume.getStats();
    // Engine stats are per-worker; main thread no longer runs a ScriptEngine
    const engine = {
      moduleCacheSize: 0,
      transformCacheSize: this._handler.transformCache.size,
    };
    const resources = this._processManager.resourceStats();
    const pool = poolStats();
    const wasm = wasmCacheStats();
    const shared = this._sharedVFS?.getStats();
    let heap: { usedMB: number; totalMB: number; limitMB: number } | null =
      null;
    const perf =
      typeof performance !== "undefined" ? (performance as any) : null;
    if (perf?.memory) {
      heap = {
        usedMB: Math.round((perf.memory.usedJSHeapSize / 1048576) * 10) / 10,
        totalMB: Math.round((perf.memory.totalJSHeapSize / 1048576) * 10) / 10,
        limitMB: Math.round((perf.memory.jsHeapSizeLimit / 1048576) * 10) / 10,
      };
    }
    return {
      vfs,
      engine,
      heap,
      runtime: {
        processes: resources.processes,
        workers: resources.workers + pool.total,
        messagePorts: resources.messagePorts,
        pendingHttp: resources.pendingHttp,
        sharedFSAllocated: !!shared,
        sharedFSBytes: shared?.bufferSize ?? 0,
        sharedFSUsedBytes: shared?.dataUsed ?? 0,
        wasmCacheEntries: wasm.entries,
        budgetMB: this._handler.options.budgetMB,
      },
    };
  }

  /**
   * postMessage this to a sibling worker (one the host app spawned, not one
   * nodepod spawned via spawn()), then call Nodepod.attachFS(buffer) on the
   * other side. null if SAB is unavailable, but boot() would have thrown in
   * that case so this is mostly defensive.
   *
   * default capacity is 256 MiB (or sharedVFSBufferSize at boot), 65,536
   * entries, 248-byte paths. writes past either cap count as dropped writes
   * so callers can detect an undersized mirror.
   */
  get sharedFSBuffer(): SharedArrayBuffer | null {
    this._assertActive();
    if (!this._sabEnabled) return null;
    if (!this._sharedVFS) {
      try {
        const shared = new SharedVFSController(this._sharedVFSBufferSize);
        this._vfsBridge.setSharedVFS(shared, true);
        this._sharedVFS = shared;
      } catch {
        return null;
      }
    }
    return this._sharedVFS.buffer;
  }

  /**
   * attach to an existing nodepod from a sibling worker using the buffer
   * from nodepod.sharedFSBuffer. the returned client is read-only, writes
   * throw ENOTSUP.
   */
  static attachFS(buffer: SharedArrayBuffer): NodepodFSClient {
    if (!isSharedArrayBufferAvailable()) {
      throw new Error(
        "[Nodepod.attachFS] SharedArrayBuffer is required. Ensure COOP/COEP headers are set.",
      );
    }
    return new NodepodFSClient(new SharedVFSReader(buffer));
  }

  /* ---- Escape hatches ---- */

  get volume(): MemoryVolume {
    return this._volume;
  }
  /** @deprecated Main-thread engine removed for security. all code now runs in isolated Web Workers via spawn() <-- this removes fatal security flaws. */
  get engine(): never {
    throw new Error(
      "[Nodepod] Main-thread engine removed for security. " +
        "All code now runs in isolated Web Workers via spawn().",
    );
  }
  get packages(): DependencyInstaller {
    return this._packages;
  }
  get proxy(): RequestProxy {
    return this._proxy;
  }
  get processManager(): ProcessManager {
    return this._processManager;
  }
  get cwd(): string {
    return this._cwd;
  }
  /** true if SAB features are active on this instance */
  get isSharedArrayBufferEnabled(): boolean {
    return this._sabEnabled;
  }

  private _assertActive(): void {
    if (this._disposed) throw new Error("[Nodepod] Instance has been torn down");
  }
}
