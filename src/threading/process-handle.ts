// ProcessHandle — per-process main-thread state.
// Tracks lifecycle, routes I/O, emits events for each spawned worker.

import { EventEmitter } from "../polyfills/events";
import type { HostWorker } from "../host/types";
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  SpawnConfig,
  MainToWorker_Init,
  MainToWorker_Exec,
} from "./worker-protocol";

const MAX_HANDLE_OUTPUT_BYTES = 5_000_000;
const PROCESS_READY_TIMEOUT_MS = 30_000;

/* ------------------------------------------------------------------ */
/*  ProcessHandle                                                      */
/* ------------------------------------------------------------------ */

export type ProcessState = "starting" | "running" | "exited";

export class ProcessHandle extends EventEmitter {
  readonly pid: number;
  worker: HostWorker;
  readonly command: string;
  readonly args: string[];
  readonly parentPid?: number;

  private _state: ProcessState = "starting";
  private _exitCode: number | undefined;
  private _stdout = "";
  private _stderr = "";
  private _fallbackWorker: (() => HostWorker) | null;
  private _pendingInit: { msg: MainToWorker_Init; transfer: Transferable[] } | null = null;
  private _probeTimer: ReturnType<typeof setTimeout> | null = null;
  private _readyTimer: ReturnType<typeof setTimeout> | null = null;

  // When > 0, "exit" is deferred — children still running, output keeps flowing
  private _exitHoldCount = 0;
  private _deferredExit: { exitCode: number; stdout: string; stderr: string } | null = null;

  // Same deferral for "shell-done" in persistent mode
  private _shellDoneHoldCount = 0;
  private _deferredShellDone: { exitCode: number; stdout: string; stderr: string } | null = null;

  // When > 0, worker is blocked on Atomics.wait() — stdin can't be delivered via postMessage
  private _syncBlockedCount = 0;

  get workerExited(): boolean { return this._deferredExit !== null || this._state === "exited"; }
  get shellCommandDone(): boolean { return this._deferredShellDone !== null; }
  get syncBlocked(): boolean { return this._syncBlockedCount > 0; }
  holdSync(): void { this._syncBlockedCount++; }
  releaseSync(): void { this._syncBlockedCount = Math.max(0, this._syncBlockedCount - 1); }

  get stdout(): string { return this._stdout; }
  get stderr(): string { return this._stderr; }

  private _trim(s: string): string {
    return s.length > MAX_HANDLE_OUTPUT_BYTES
      ? s.slice(-Math.floor(MAX_HANDLE_OUTPUT_BYTES * 0.75))
      : s;
  }

  get state(): ProcessState { return this._state; }
  get exitCode(): number | undefined { return this._exitCode; }

  constructor(worker: HostWorker, config: SpawnConfig, fallbackWorker?: () => HostWorker) {
    super();
    this.pid = config.snapshot ? Math.floor(Math.random() * 90000) + 10000 : 0; // will be set properly
    this.worker = worker;
    this.command = config.command;
    this.args = config.args;
    this.parentPid = config.parentPid;
    this._fallbackWorker = fallbackWorker ?? null;

    this._setupWorkerListeners(worker);
  }

  _setPid(pid: number): void {
    (this as any).pid = pid;
  }

  postMessage(msg: MainToWorkerMessage, transfer?: Transferable[]): void {
    this.worker.postMessage(msg, transfer ?? []);
  }

  init(initMsg: MainToWorker_Init, extraTransfer?: Transferable[]): void {
    const transfer: Transferable[] = [];
    if (initMsg.snapshot.data.byteLength > 0) {
      transfer.push(initMsg.snapshot.data);
    }
    if (extraTransfer) transfer.push(...extraTransfer);
    this._readyTimer = setTimeout(() => {
      this.emit("worker-error", `Process did not become ready within ${PROCESS_READY_TIMEOUT_MS}ms`, undefined);
      this._terminate(1);
    }, PROCESS_READY_TIMEOUT_MS);
    if (this._fallbackWorker) {
      this._pendingInit = { msg: initMsg, transfer };
      this.worker.postMessage({ type: "probe" });
      this._probeTimer = setTimeout(() => this._activateFallback(), 2_000);
      return;
    }
    this.postMessage(initMsg, transfer);
  }

  // whether this process's stdout is a terminal (a child spawned with
  // stdio "inherit" gets the same)
  stdoutIsTTY = true;

  exec(execMsg: MainToWorker_Exec): void {
    if (execMsg.stdoutIsTTY !== undefined) this.stdoutIsTTY = execMsg.stdoutIsTTY;
    this.postMessage(execMsg);
  }

  sendStdin(data: string): void {
    // Forward to children via ProcessManager
    this.emit("stdin-forward", data);

    // Skip postMessage if blocked on Atomics.wait() or already exited
    if (!this.workerExited && !this.syncBlocked) {
      this.postMessage({ type: "stdin", data });
    }
  }

  endStdin(): void {
    if (!this.workerExited && !this.syncBlocked) {
      this.postMessage({ type: "stdin", data: "", end: true });
    }
  }

  kill(signal: string = "SIGTERM"): void {
    this.postMessage({ type: "signal", signal });
    this.emit("signal", signal);
    if (signal === "SIGKILL") {
      this._terminate(137);
    }
  }

  // last terminal size sent to this process; children that share its tty
  // start from it (ProcessManager relays later resizes to them)
  private _terminalSize: { cols: number; rows: number } | null = null;

  get terminalSize(): { cols: number; rows: number } | null {
    return this._terminalSize;
  }

  resize(cols: number, rows: number): void {
    this._terminalSize = { cols, rows };
    this.postMessage({ type: "resize", cols, rows });
    this.emit("resize", cols, rows);
  }

  holdExit(): void {
    this._exitHoldCount++;
  }

  releaseExit(): void {
    this._exitHoldCount = Math.max(0, this._exitHoldCount - 1);
    if (this._exitHoldCount === 0 && this._deferredExit) {
      const { exitCode, stdout, stderr } = this._deferredExit;
      this._deferredExit = null;
      this._state = "exited";
      this._exitCode = exitCode;
      this.emit("exit", exitCode, stdout, stderr);
      // kill the worker so late callbacks can't post back after exit
      try { this.worker.terminate(); } catch { /* ignore */ }
    }
  }

  holdShellDone(): void {
    this._shellDoneHoldCount++;
  }

  releaseShellDone(): void {
    this._shellDoneHoldCount = Math.max(0, this._shellDoneHoldCount - 1);
    if (this._shellDoneHoldCount === 0 && this._deferredShellDone) {
      const { exitCode, stdout, stderr } = this._deferredShellDone;
      this._deferredShellDone = null;
      this.emit("shell-done", exitCode, stdout, stderr);
    }
  }

  private _terminate(exitCode: number = 1): void {
    if (this._state === "exited") return;
    this._state = "exited";
    this._exitCode = exitCode;
    this._deferredExit = null;
    this._exitHoldCount = 0;
    if (this._probeTimer) clearTimeout(this._probeTimer);
    if (this._readyTimer) clearTimeout(this._readyTimer);
    this._probeTimer = null;
    this._readyTimer = null;
    try { this.worker.terminate(); } catch {
      /* ignore */
    }
    this.emit("exit", exitCode, this._stdout, this._stderr);
  }

  private _setupWorkerListeners(worker: HostWorker): void {
    worker.addEventListener("message", (ev) => {
      if (worker !== this.worker) return;
      const msg = ev.data as WorkerToMainMessage;
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case "probe-ready":
          if (this._probeTimer) clearTimeout(this._probeTimer);
          this._probeTimer = null;
          this._fallbackWorker = null;
          if (this._pendingInit) {
            const pending = this._pendingInit;
            this._pendingInit = null;
            this.postMessage(pending.msg, pending.transfer);
          }
          break;

        case "ready":
          if (this._readyTimer) clearTimeout(this._readyTimer);
          this._readyTimer = null;
          this._state = "running";
          this.emit("ready");
          break;

        case "stdout":
          this._stdout = this._trim(this._stdout + msg.data);
          this.emit("stdout", msg.data);
          break;

        case "stderr":
          this._stderr = this._trim(this._stderr + msg.data);
          this.emit("stderr", msg.data);
          break;

        case "exit": {
          if (this._readyTimer) clearTimeout(this._readyTimer);
          this._readyTimer = null;
          const stdout = msg.stdout || this._stdout;
          const stderr = msg.stderr || this._stderr;
          this._stdout = this._trim(stdout);
          this._stderr = this._trim(stderr);
          if (this._exitHoldCount > 0) {
            // Children still running — defer exit, keep output flowing
            this._deferredExit = { exitCode: msg.exitCode, stdout, stderr };
            this.emit("worker-done", msg.exitCode);
          } else {
            this._state = "exited";
            this._exitCode = msg.exitCode;
            this.emit("exit", msg.exitCode, stdout, stderr);
            // kill the worker so late callbacks can't post back after exit
            try { this.worker.terminate(); } catch { /* ignore */ }
          }
          break;
        }

        case "console":
          this.emit("console", msg.method, msg.args);
          break;

        case "vfs-write":
          this.emit("vfs-write", msg.path, msg.content, msg.isDirectory);
          break;

        case "vfs-delete":
          this.emit("vfs-delete", msg.path);
          break;

        case "vfs-snapshot":
          this.emit("vfs-snapshot", msg.snapshot);
          break;

        case "vfs-meta":
          this.emit("vfs-meta", msg);
          break;

        case "spawn-request":
          this.emit("spawn-request", msg);
          break;

        case "child-signal":
          this.emit("child-signal", msg);
          break;

        case "child-stdin":
          this.emit("child-stdin", msg);
          break;

        case "fork-request":
          this.emit("fork-request", msg);
          break;

        case "workerthread-request":
          this.emit("workerthread-request", msg);
          break;

        case "wasiworker-request":
          this.emit("wasiworker-request", msg);
          break;

        case "wasiworker-terminate":
          this.emit("wasiworker-terminate", msg);
          break;

        case "ipc-message":
          this.emit("ipc-message", msg);
          break;

        case "spawn-sync":
          this.emit("spawn-sync", msg);
          break;

        case "sync-more":
          this.emit("sync-more", msg.syncSlot);
          break;

        case "sqlite-preload":
          this.emit("sqlite-preload", msg);
          break;

        case "pack-save":
          this.emit("pack-save", msg);
          break;

        case "esbuild-module-request":
          this.emit("esbuild-module-request");
          break;

        case "server-listen":
          this.emit("server-listen", msg.port, msg.hostname);
          break;

        case "server-close":
          this.emit("server-close", msg.port);
          break;

        case "http-request":
          this.emit("http-request", msg);
          break;

        case "http-client-request":
          this.emit("http-client-request", msg);
          break;

        case "http-response":
          this.emit("http-response", msg);
          break;

        case "shell-done": {
          const sd = msg as any;
          if (this._shellDoneHoldCount > 0) {
            this._deferredShellDone = { exitCode: sd.exitCode, stdout: sd.stdout, stderr: sd.stderr };
          } else {
            this.emit("shell-done", sd.exitCode, sd.stdout, sd.stderr);
          }
          break;
        }

        case "cwd-change":
          this.emit("cwd-change", msg.cwd);
          break;

        case "stdin-raw-status":
          this.emit("stdin-raw-status", msg.isRaw);
          break;

        case "ws-frame":
          this.emit("ws-frame", msg);
          break;

        case "error":
          this.emit("worker-error", msg.message, msg.stack);
          break;

        default:
          break;
      }
    });

    worker.addEventListener("error", (ev) => {
      if (worker !== this.worker) return;
      if (this._fallbackWorker && this._state === "starting") {
        this._activateFallback();
        return;
      }
      this.emit("worker-error", ev.message ?? "Worker error", undefined);
      if (this._state !== "exited") {
        this._terminate(1);
      }
    });
  }

  private _activateFallback(): void {
    const factory = this._fallbackWorker;
    if (!factory || this._state !== "starting") return;
    this._fallbackWorker = null;
    if (this._probeTimer) clearTimeout(this._probeTimer);
    this._probeTimer = null;
    try { this.worker.terminate(); } catch { /* ignore */ }
    try {
      this.worker = factory();
      this._setupWorkerListeners(this.worker);
      if (this._pendingInit) {
        const pending = this._pendingInit;
        this._pendingInit = null;
        this.postMessage(pending.msg, pending.transfer);
      }
    } catch (error) {
      this.emit("worker-error", error instanceof Error ? error.message : String(error), undefined);
      this._terminate(1);
    }
  }
}
