// main-thread process lifecycle manager
// spawns Web Worker processes, routes I/O, syncs VFS, tracks process tree

import { EventEmitter } from "../polyfills/events";
import type { IVolume } from "../types/volume";
import { ProcessHandle } from "./process-handle";
import { buildFileSystemBridge } from "../polyfills/fs";
import { handleFsProxy } from "../helpers/napi-wasm-worker";
import type {
  SpawnConfig,
  ProcessInfo,
  MainToWorker_Init,
  VFSBinarySnapshot,
  WorkerToMain_SpawnRequest,
  WorkerToMain_ForkRequest,
  WorkerToMain_WorkerThreadRequest,
  WorkerToMain_SpawnSync,
  WorkerToMain_HttpResponse,
} from "./worker-protocol";
import type { VFSBridge } from "./vfs-bridge";
import { PROCESS_WORKER_BUNDLE } from "virtual:process-worker-bundle";
import { SLOT_SIZE } from "./sync-channel";

const MAX_PROCESS_DEPTH = 10;
const MAX_PROCESSES = 50;

export class ProcessManager extends EventEmitter {
  private _processes = new Map<number, ProcessHandle>();
  private _nextPid = 100;
  private _volume: IVolume;
  private _vfsBridge: VFSBridge | null = null;
  private _sharedBuffer: SharedArrayBuffer | null = null;
  private _syncBuffer: SharedArrayBuffer | null = null;

  // port → owning pid
  private _serverPorts = new Map<number, number>();
  // parent pid → child pids, used for exit deferral
  private _childPids = new Map<number, Set<number>>();
  // pids of children that inherit their parent's stdin. stdin-forward only
  // routes to pids in this set. stdio:'pipe' kids get their own isolated stdin.
  private _inheritStdinChildren = new Set<number>();
  private _httpCallbacks = new Map<number, (resp: WorkerToMain_HttpResponse) => void>();
  private _nextHttpRequestId = 1;

  constructor(volume: IVolume) {
    super();
    this._volume = volume;
  }

  setVFSBridge(bridge: VFSBridge): void {
    this._vfsBridge = bridge;
  }

  setSharedBuffer(buf: SharedArrayBuffer): void {
    this._sharedBuffer = buf;
  }

  setSyncBuffer(buf: SharedArrayBuffer): void {
    this._syncBuffer = buf;
  }

  spawn(config: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    parentPid?: number;
  }): ProcessHandle {
    if (this._processes.size >= MAX_PROCESSES) {
      throw new Error(`Process limit exceeded (max ${MAX_PROCESSES})`);
    }

    if (config.parentPid !== undefined) {
      let depth = 0;
      let pid: number | undefined = config.parentPid;
      while (pid !== undefined && depth < MAX_PROCESS_DEPTH) {
        const parent = this._processes.get(pid);
        pid = parent?.parentPid;
        depth++;
      }
      if (depth >= MAX_PROCESS_DEPTH) {
        throw new Error(`Process tree depth limit exceeded (max ${MAX_PROCESS_DEPTH})`);
      }
    }

    const pid = this._nextPid++;

    const snapshot = this._vfsBridge
      ? this._vfsBridge.createSnapshot()
      : this._createEmptySnapshot();

    const spawnConfig: SpawnConfig = {
      command: config.command,
      args: config.args ?? [],
      cwd: config.cwd ?? "/",
      env: config.env ?? {},
      snapshot,
      sharedBuffer: this._sharedBuffer ?? undefined,
      syncBuffer: this._syncBuffer ?? undefined,
      parentPid: config.parentPid,
    };

    const worker = this._createWorker();
    const handle = new ProcessHandle(worker, spawnConfig);
    handle._setPid(pid);

    this._processes.set(pid, handle);
    this._wireHandleEvents(handle);

    // pool of fs proxy MessagePorts for the spawned process to hand out to
    // its WASI workers. one port per worker, tab side handles each. chrome
    // drops BroadcastChannel delivery from blob workers so we cant rely on
    // that as the only route (#54 follow-up).
    const wasiFsPorts: MessagePort[] = [];
    const transferPorts: MessagePort[] = [];
    {
      const tabFsBridge = buildFileSystemBridge(this._volume, () => "/");
      const POOL_SIZE = 16;
      for (let i = 0; i < POOL_SIZE; i++) {
        const ch = new MessageChannel();
        ch.port1.onmessage = (e: MessageEvent) => {
          const data = e.data;
          if (!data || typeof data !== "object" || !data.__fs__) return;
          handleFsProxy(data.__fs__, tabFsBridge);
        };
        ch.port1.start();
        transferPorts.push(ch.port2);
        wasiFsPorts.push(ch.port2);
      }
    }

    const initMsg: MainToWorker_Init = {
      type: "init",
      pid,
      cwd: spawnConfig.cwd,
      env: spawnConfig.env,
      snapshot: spawnConfig.snapshot,
      sharedBuffer: spawnConfig.sharedBuffer,
      syncBuffer: spawnConfig.syncBuffer,
      wasiFsPorts,
    };
    handle.init(initMsg, transferPorts);

    this.emit("spawn", pid, config.command, config.args);
    return handle;
  }

  getProcess(pid: number): ProcessHandle | undefined {
    return this._processes.get(pid);
  }

  listProcesses(): ProcessInfo[] {
    const result: ProcessInfo[] = [];
    for (const [pid, handle] of this._processes) {
      result.push({
        pid,
        command: handle.command,
        args: handle.args,
        state: handle.state,
        exitCode: handle.exitCode,
        parentPid: handle.parentPid,
      });
    }
    return result;
  }

  // kills process and all descendants recursively, cleans up server ports
  kill(pid: number, signal: string = "SIGTERM"): boolean {
    const handle = this._processes.get(pid);
    if (!handle) return false;
    handle.kill(signal);
    this._killDescendants(pid, signal);
    this._cleanupServerPorts(pid);
    return true;
  }

  private _cleanupServerPorts(pid: number): void {
    for (const [port, ownerPid] of this._serverPorts) {
      if (ownerPid === pid) {
        this._serverPorts.delete(port);
        this.emit("server-close", pid, port);
      }
    }
    const children = this._childPids.get(pid);
    if (children) {
      for (const childPid of children) {
        this._cleanupServerPorts(childPid);
      }
    }
  }

  private _killDescendants(pid: number, signal: string): void {
    const children = this._childPids.get(pid);
    if (!children) return;
    for (const childPid of children) {
      const childHandle = this._processes.get(childPid);
      if (childHandle && childHandle.state !== "exited") {
        childHandle.kill(signal);
        // stop stale output from dying workers leaking into the terminal
        childHandle.removeAllListeners("stdout");
        childHandle.removeAllListeners("stderr");
      }
      this._killDescendants(childPid, signal);
    }
  }

  teardown(): void {
    for (const [pid, handle] of this._processes) {
      try { handle.kill("SIGKILL"); } catch {
        /* ignore */
      }
    }
    this._processes.clear();
  }

  get processCount(): number {
    return this._processes.size;
  }

  registerServerPort(port: number, pid: number): void {
    this._serverPorts.set(port, pid);
  }

  unregisterServerPort(port: number): void {
    this._serverPorts.delete(port);
  }

  getServerPorts(): number[] {
    return [...this._serverPorts.keys()];
  }

  // send HTTP request to the worker that owns the port
  dispatchHttpRequest(
    port: number,
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string | null,
  ): Promise<{ statusCode: number; statusMessage: string; headers: Record<string, string>; body: string | ArrayBuffer }> {
    const pid = this._serverPorts.get(port);
    if (pid === undefined) {
      return Promise.resolve({
        statusCode: 503,
        statusMessage: "Service Unavailable",
        headers: { "Content-Type": "text/plain" },
        body: `No server on port ${port}`,
      });
    }

    const handle = this._processes.get(pid);
    if (!handle || handle.state === "exited") {
      this._serverPorts.delete(port);
      return Promise.resolve({
        statusCode: 503,
        statusMessage: "Service Unavailable",
        headers: { "Content-Type": "text/plain" },
        body: `Server process exited (pid ${pid})`,
      });
    }

    const requestId = this._nextHttpRequestId++;
    // console.log(`[PM] dispatchHttpRequest #${requestId} ${method} ${path} → pid ${pid}`);
    return new Promise((resolve) => {
      this._httpCallbacks.set(requestId, (resp) => {
        this._httpCallbacks.delete(requestId);
        // console.log(`[PM] http-response #${requestId} status=${resp.statusCode}`);
        resolve({
          statusCode: resp.statusCode,
          statusMessage: resp.statusMessage,
          headers: resp.headers,
          body: resp.body,
        });
      });

      handle.postMessage({
        type: "http-request",
        requestId,
        port,
        method,
        path,
        headers,
        body: body ?? null,
      });
    });
  }

  // returns owning pid, or -1 if no server found
  dispatchWsUpgrade(
    port: number,
    uid: string,
    path: string,
    headers: Record<string, string>,
  ): number {
    const pid = this._serverPorts.get(port);
    if (pid === undefined) {
      return -1;
    }

    const handle = this._processes.get(pid);
    if (!handle || handle.state === "exited") {
      this._serverPorts.delete(port);
      return -1;
    }

    handle.postMessage({ type: "ws-upgrade", uid, port, path, headers });
    return pid;
  }

  dispatchWsData(pid: number, uid: string, frame: number[]): void {
    const handle = this._processes.get(pid);
    if (!handle || handle.state === "exited") return;
    handle.postMessage({ type: "ws-data", uid, frame });
  }

  dispatchWsClose(pid: number, uid: string, code: number): void {
    const handle = this._processes.get(pid);
    if (!handle || handle.state === "exited") return;
    handle.postMessage({ type: "ws-close", uid, code });
  }

  private static _workerBlobUrl: string | null = null;

  private _createWorker(): Worker {
    // blob URL from pre-bundled source works in any environment
    if (!ProcessManager._workerBlobUrl) {
      const blob = new Blob([PROCESS_WORKER_BUNDLE], { type: "application/javascript" });
      ProcessManager._workerBlobUrl = URL.createObjectURL(blob);
    }
    return new Worker(ProcessManager._workerBlobUrl);
  }

  private _wireHandleEvents(handle: ProcessHandle): void {
    // forward signals to all descendants, works whether parent is running or exited
    handle.on("signal", (signal: string) => {
      this._killDescendants(handle.pid, signal);
    });

    // forward stdin to children even when parent is blocked on Atomics.wait.
    // only routes to stdio:'inherit' children; stdio:'pipe' kids are isolated.
    handle.on("stdin-forward", (data: string) => {
      const children = this._childPids.get(handle.pid);
      if (children) {
        for (const childPid of children) {
          if (!this._inheritStdinChildren.has(childPid)) continue;
          const childHandle = this._processes.get(childPid);
          if (childHandle && childHandle.state !== "exited") {
            childHandle.sendStdin(data);
          }
        }
      }
    });

    handle.on("exit", (exitCode: number) => {
      for (const [port, pid] of this._serverPorts) {
        if (pid === handle.pid) {
          this._serverPorts.delete(port);
          this.emit("server-close", handle.pid, port);
        }
      }
      // drain pending HTTP callbacks for this worker so they don't leak
      for (const [reqId, cb] of this._httpCallbacks) {
        cb({
          type: "http-response",
          requestId: reqId,
          statusCode: 503,
          statusMessage: "Worker Exited",
          headers: {},
          body: "Worker process exited before completing the request",
        } as WorkerToMain_HttpResponse);
      }
      this.emit("exit", handle.pid, exitCode);
      // delayed so event handlers finish first
      setTimeout(() => {
        this._processes.delete(handle.pid);
      }, 100);
    });

    handle.on("vfs-write", (path: string, content: ArrayBuffer, isDirectory: boolean) => {
      if (this._vfsBridge) {
        if (isDirectory) {
          this._vfsBridge.handleWorkerMkdir(path);
        } else {
          this._vfsBridge.handleWorkerWrite(path, new Uint8Array(content));
        }
        this._vfsBridge.broadcastChange(path, content, handle.pid);
      }
    });

    handle.on("vfs-delete", (path: string) => {
      if (this._vfsBridge) {
        this._vfsBridge.handleWorkerDelete(path);
        this._vfsBridge.broadcastChange(path, null, handle.pid);
      }
    });

    handle.on("vfs-read", (requestId: number, path: string) => {
      try {
        if (this._volume.existsSync(path)) {
          const stat = this._volume.statSync(path);
          if (stat.isDirectory()) {
            handle.postMessage({
              type: "vfs-sync",
              path,
              content: null,
              isDirectory: true,
            });
          } else {
            const data = this._volume.readFileSync(path);
            // must copy into a fresh ArrayBuffer — .buffer.slice() returns SAB when storage is shared, and SAB can't be transferred via postMessage (throws DataCloneError)
            const buffer = new ArrayBuffer(data.byteLength);
            new Uint8Array(buffer).set(data);
            handle.postMessage({
              type: "vfs-sync",
              path,
              content: buffer,
              isDirectory: false,
            }, [buffer]);
          }
        } else {
          handle.postMessage({
            type: "vfs-sync",
            path,
            content: null,
            isDirectory: false,
          });
        }
      } catch {
        // send null so the worker doesn't hang
        try {
          handle.postMessage({
            type: "vfs-sync",
            path,
            content: null,
            isDirectory: false,
          });
        } catch { /* worker may have died */ }
      }
    });

    handle.on("spawn-request", (msg: WorkerToMain_SpawnRequest) => {
      const fullCmd = msg.args.length ? `${msg.command} ${msg.args.join(" ")}` : msg.command;
      try {
        const childHandle = this.spawn({
          command: msg.command,
          args: msg.args,
          cwd: msg.cwd,
          env: msg.env,
          parentPid: handle.pid,
        });

        if (!this._childPids.has(handle.pid)) {
          this._childPids.set(handle.pid, new Set());
        }
        this._childPids.get(handle.pid)!.add(childHandle.pid);

        // remember stdio:inherit so stdin-forward routes parent's stdin here.
        // msg.stdio can be the legacy string or node's [stdin, stdout, stderr].
        const inheritsStdin = msg.stdio === "inherit"
          || (Array.isArray(msg.stdio) && msg.stdio[0] === "inherit");
        if (inheritsStdin) this._inheritStdinChildren.add(childHandle.pid);

        // defer parent exit/done until child finishes (e.g. create-vite -> vite dev)
        handle.holdExit();
        handle.holdShellDone();

        handle.postMessage({
          type: "spawn-result",
          requestId: msg.requestId,
          pid: childHandle.pid,
        });

        // bare `node` invocations go through as direct execution
        const isNodeBin = /(?:^|\/)node$/.test(msg.command);
        const sendExec = () => {
          if (isNodeBin && msg.args.length > 0) {
            childHandle.exec({
              type: "exec",
              filePath: msg.args[0],
              args: msg.args.slice(1),
              cwd: msg.cwd,
              env: msg.env,
              isShell: false,
            });
          } else {
            childHandle.exec({
              type: "exec",
              filePath: "",
              args: msg.args,
              cwd: msg.cwd,
              env: msg.env,
              isShell: true,
              shellCommand: fullCmd,
            });
          }
        };

        if (childHandle.state === "running") {
          sendExec();
        } else {
          childHandle.on("ready", sendExec);
        }

        // relay child output — direct emit if parent is done, postMessage otherwise
        childHandle.on("stdout", (data: string) => {
          if (handle.workerExited || handle.shellCommandDone) {
            handle.emit("stdout", data);
          } else {
            handle.postMessage({
              type: "child-output",
              requestId: msg.requestId,
              stream: "stdout",
              data,
            });
          }
        });
        childHandle.on("stderr", (data: string) => {
          if (handle.workerExited || handle.shellCommandDone) {
            handle.emit("stderr", data);
          } else {
            handle.postMessage({
              type: "child-output",
              requestId: msg.requestId,
              stream: "stderr",
              data,
            });
          }
        });

        childHandle.on("stdin-raw-status", (isRaw: boolean) => {
          handle.emit("stdin-raw-status", isRaw);
        });

        childHandle.on("exit", (exitCode: number) => {
          if (!handle.workerExited) {
            handle.postMessage({
              type: "child-exit",
              requestId: msg.requestId,
              exitCode,
              stdout: childHandle.stdout,
              stderr: childHandle.stderr,
            });
          }
          const children = this._childPids.get(handle.pid);
          if (children) {
            children.delete(childHandle.pid);
            if (children.size === 0) this._childPids.delete(handle.pid);
          }
          this._inheritStdinChildren.delete(childHandle.pid);
          handle.releaseExit();
          handle.releaseShellDone();
        });
      } catch (e) {
        handle.postMessage({
          type: "spawn-result",
          requestId: msg.requestId,
          pid: -1,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });

    handle.on("fork-request", (msg: WorkerToMain_ForkRequest) => {
      try {
        const childHandle = this.spawn({
          command: "node",
          args: [msg.modulePath, ...msg.args],
          cwd: msg.cwd,
          env: msg.env,
          parentPid: handle.pid,
        });

        if (!this._childPids.has(handle.pid)) {
          this._childPids.set(handle.pid, new Set());
        }
        this._childPids.get(handle.pid)!.add(childHandle.pid);
        handle.holdExit();
        handle.holdShellDone();

        handle.postMessage({
          type: "spawn-result",
          requestId: msg.requestId,
          pid: childHandle.pid,
        });

        const sendExec = () => {
          childHandle.exec({
            type: "exec",
            filePath: msg.modulePath,
            args: msg.args,
            cwd: msg.cwd,
            env: msg.env,
            isShell: false,
            isFork: true,
          });
        };

        if (childHandle.state === "running") {
          sendExec();
        } else {
          childHandle.on("ready", sendExec);
        }

        childHandle.on("stdout", (data: string) => {
          if (handle.workerExited || handle.shellCommandDone) {
            handle.emit("stdout", data);
          } else {
            handle.postMessage({
              type: "child-output",
              requestId: msg.requestId,
              stream: "stdout",
              data,
            });
          }
        });
        childHandle.on("stderr", (data: string) => {
          if (handle.workerExited || handle.shellCommandDone) {
            handle.emit("stderr", data);
          } else {
            handle.postMessage({
              type: "child-output",
              requestId: msg.requestId,
              stream: "stderr",
              data,
            });
          }
        });

        // IPC child → parent
        childHandle.on("ipc-message", (ipcMsg: any) => {
          const payload = ipcMsg?.data ?? ipcMsg;
          if (!handle.workerExited) {
            handle.postMessage({
              type: "ipc-message",
              targetRequestId: msg.requestId,
              data: payload,
            } as any);
          }
        });

        // IPC parent → child
        handle.on("ipc-message", (ipcMsg: any) => {
          if (ipcMsg.targetRequestId === msg.requestId) {
            childHandle.postMessage({
              type: "ipc-message",
              data: ipcMsg.data,
            });
          }
        });

        childHandle.on("exit", (exitCode: number) => {
          if (!handle.workerExited) {
            handle.postMessage({
              type: "child-exit",
              requestId: msg.requestId,
              exitCode,
              stdout: childHandle.stdout,
              stderr: childHandle.stderr,
            });
          }
          const children = this._childPids.get(handle.pid);
          if (children) {
            children.delete(childHandle.pid);
            if (children.size === 0) this._childPids.delete(handle.pid);
          }
          this._inheritStdinChildren.delete(childHandle.pid);
          handle.releaseExit();
          handle.releaseShellDone();
        });
      } catch (e) {
        handle.postMessage({
          type: "spawn-result",
          requestId: msg.requestId,
          pid: -1,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });

    handle.on("workerthread-request", (msg: WorkerToMain_WorkerThreadRequest) => {
      try {
        let modulePath = msg.modulePath;
        // eval mode — write code to a temp VFS file
        if (msg.isEval) {
          const evalPath = `/__wt_eval_${msg.threadId}__.js`;
          this._volume.writeFileSync(evalPath, msg.modulePath);
          modulePath = evalPath;
          if (this._vfsBridge) {
            const encoder = new TextEncoder();
            const content = encoder.encode(msg.modulePath).buffer as ArrayBuffer;
            this._vfsBridge.handleWorkerWrite(evalPath, new Uint8Array(content));
            this._vfsBridge.broadcastChange(evalPath, content, handle.pid);
          }
        }

        const childHandle = this.spawn({
          command: "node",
          args: [modulePath],
          cwd: msg.cwd,
          env: msg.env,
          parentPid: handle.pid,
        });

        if (!this._childPids.has(handle.pid)) {
          this._childPids.set(handle.pid, new Set());
        }
        this._childPids.get(handle.pid)!.add(childHandle.pid);
        handle.holdExit();
        handle.holdShellDone();

        handle.postMessage({
          type: "spawn-result",
          requestId: msg.requestId,
          pid: childHandle.pid,
        });

        const sendExec = () => {
          childHandle.exec({
            type: "exec",
            filePath: modulePath,
            args: msg.args || [],
            cwd: msg.cwd,
            env: msg.env,
            isShell: false,
            isFork: true,
            isWorkerThread: true,
            workerData: msg.workerData,
            threadId: msg.threadId,
          });
        };

        if (childHandle.state === "running") {
          sendExec();
        } else {
          childHandle.on("ready", sendExec);
        }

        childHandle.on("stdout", (data: string) => {
          if (handle.workerExited || handle.shellCommandDone) {
            handle.emit("stdout", data);
          } else {
            handle.postMessage({
              type: "child-output",
              requestId: msg.requestId,
              stream: "stdout",
              data,
            });
          }
        });
        childHandle.on("stderr", (data: string) => {
          if (handle.workerExited || handle.shellCommandDone) {
            handle.emit("stderr", data);
          } else {
            handle.postMessage({
              type: "child-output",
              requestId: msg.requestId,
              stream: "stderr",
              data,
            });
          }
        });

        childHandle.on("ipc-message", (ipcMsg: any) => {
          const payload = ipcMsg?.data ?? ipcMsg;
          if (!handle.workerExited) {
            handle.postMessage({
              type: "ipc-message",
              targetRequestId: msg.requestId,
              data: payload,
            } as any);
          }
        });

        handle.on("ipc-message", (ipcMsg: any) => {
          if (ipcMsg.targetRequestId === msg.requestId) {
            childHandle.postMessage({
              type: "ipc-message",
              data: ipcMsg.data,
            });
          }
        });

        childHandle.on("exit", (exitCode: number) => {
          if (msg.isEval) {
            try {
              this._volume.unlinkSync(`/__wt_eval_${msg.threadId}__.js`);
            } catch {
              /* ignore */
            }
          }

          if (!handle.workerExited) {
            handle.postMessage({
              type: "child-exit",
              requestId: msg.requestId,
              exitCode,
              stdout: childHandle.stdout,
              stderr: childHandle.stderr,
            });
          }
          const children = this._childPids.get(handle.pid);
          if (children) {
            children.delete(childHandle.pid);
            if (children.size === 0) this._childPids.delete(handle.pid);
          }
          this._inheritStdinChildren.delete(childHandle.pid);
          handle.releaseExit();
          handle.releaseShellDone();
        });
      } catch (e) {
        handle.postMessage({
          type: "spawn-result",
          requestId: msg.requestId,
          pid: -1,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });

    handle.on("spawn-sync", (msg: WorkerToMain_SpawnSync) => {
      if (!this._syncBuffer) {
        return;
      }

      const fullCmd = msg.shellCommand ??
        (msg.args.length ? `${msg.command} ${msg.args.join(" ")}` : msg.command);
      const maxStdoutLen = (SLOT_SIZE - 3) * 4;

      const signalError = (exitCode: number) => {
        try {
          const int32 = new Int32Array(this._syncBuffer!);
          const slotBase = msg.syncSlot * SLOT_SIZE;
          Atomics.store(int32, slotBase + 1, exitCode);
          Atomics.store(int32, slotBase + 2, 0);
          Atomics.store(int32, slotBase, 2); // STATUS_ERROR
          Atomics.notify(int32, slotBase);
        } catch {
          // buffer unusable, worker will time out
        }
      };

      try {
        const childHandle = this.spawn({
          command: msg.command,
          args: msg.args,
          cwd: msg.cwd,
          env: msg.env,
          parentPid: handle.pid,
        });

        // must track for Ctrl+C signal propagation via _killDescendants
        if (!this._childPids.has(handle.pid)) {
          this._childPids.set(handle.pid, new Set());
        }
        this._childPids.get(handle.pid)!.add(childHandle.pid);

        // spawnSync defaults to 'inherit' when stdio is omitted (matches node,
        // since it's usually used for interactive children like npm install
        // under create-vite).
        const stdinInherits = !msg.stdio || msg.stdio[0] === "inherit";
        if (stdinInherits) this._inheritStdinChildren.add(childHandle.pid);

        handle.holdExit();
        handle.holdShellDone();
        handle.holdSync(); // parent is blocked on Atomics.wait — stdin has to bypass

        const sendExec = () => {
          childHandle.exec({
            type: "exec",
            filePath: "",
            args: msg.args,
            cwd: msg.cwd,
            env: msg.env,
            isShell: true,
            shellCommand: fullCmd,
          });
        };

        if (childHandle.state === "running") {
          sendExec();
        } else {
          childHandle.on("ready", sendExec);
        }

        // parent is blocked on Atomics.wait, can't process postMessage — emit directly
        childHandle.on("stdout", (data: string) => {
          handle.emit("stdout", data);
        });
        childHandle.on("stderr", (data: string) => {
          handle.emit("stderr", data);
        });

        childHandle.on("stdin-raw-status", (isRaw: boolean) => {
          handle.emit("stdin-raw-status", isRaw);
        });

        childHandle.on("exit", (exitCode: number) => {
          try {
            const int32 = new Int32Array(this._syncBuffer!);
            const encoder = new TextEncoder();
            const slotBase = msg.syncSlot * SLOT_SIZE;
            const stdoutBytes = encoder.encode(childHandle.stdout);
            const truncatedLen = Math.min(stdoutBytes.byteLength, maxStdoutLen);

            Atomics.store(int32, slotBase + 1, exitCode);
            Atomics.store(int32, slotBase + 2, truncatedLen);

            const uint8 = new Uint8Array(this._syncBuffer!);
            const dataOffset = (slotBase + 3) * 4;
            uint8.set(stdoutBytes.subarray(0, truncatedLen), dataOffset);

            // last store wakes the waiting worker
            Atomics.store(int32, slotBase, 1);
            Atomics.notify(int32, slotBase);
          } catch {
            signalError(1);
          }

          const children = this._childPids.get(handle.pid);
          if (children) {
            children.delete(childHandle.pid);
            if (children.size === 0) this._childPids.delete(handle.pid);
          }
          this._inheritStdinChildren.delete(childHandle.pid);

          handle.releaseSync();
          handle.releaseExit();
          handle.releaseShellDone();
        });

        childHandle.on("worker-error", () => {
          signalError(1);
          const children = this._childPids.get(handle.pid);
          if (children) {
            children.delete(childHandle.pid);
            if (children.size === 0) this._childPids.delete(handle.pid);
          }
          this._inheritStdinChildren.delete(childHandle.pid);
          handle.releaseSync();
          handle.releaseExit();
          handle.releaseShellDone();
        });
      } catch {
        signalError(1);
      }
    });

    handle.on("server-listen", (port: number, hostname: string) => {
      this.registerServerPort(port, handle.pid);
      this.emit("server-listen", handle.pid, port, hostname);
    });

    handle.on("server-close", (port: number) => {
      this.unregisterServerPort(port);
      this.emit("server-close", handle.pid, port);
    });

    handle.on("http-response", (msg: WorkerToMain_HttpResponse) => {
      const cb = this._httpCallbacks.get(msg.requestId);
      if (cb) cb(msg);
    });

    handle.on("ws-frame", (msg: any) => {
      this.emit("ws-frame", msg);
    });

    handle.on("cwd-change", (cwd: string) => {
      this.emit("cwd-change", handle.pid, cwd);
    });

    handle.on("stdin-raw-status", (isRaw: boolean) => {
      this.emit("stdin-raw-status", handle.pid, isRaw);
    });

    handle.on("worker-error", (message: string, stack?: string) => {
      this.emit("error", handle.pid, message, stack);
    });
  }

  private _createEmptySnapshot(): VFSBinarySnapshot {
    return {
      manifest: [],
      data: new ArrayBuffer(0),
    };
  }

  broadcastVFSChange(path: string, content: ArrayBuffer | null, isDirectory: boolean, excludePid: number): void {
    for (const [pid, handle] of this._processes) {
      if (pid === excludePid || handle.state === "exited") continue;
      try {
        // ArrayBuffer can only be transferred once, so clone per recipient
        // explicit copy rather than .slice(0) — if `content` is actually SAB (TypeScript lets SAB satisfy ArrayBuffer), SAB.prototype.slice() returns SAB which can't be transferred
        let clonedContent: ArrayBuffer | null = null;
        if (content) {
          clonedContent = new ArrayBuffer(content.byteLength);
          new Uint8Array(clonedContent).set(new Uint8Array(content));
        }
        handle.postMessage({
          type: "vfs-sync",
          path,
          content: clonedContent,
          isDirectory,
        }, clonedContent ? [clonedContent] : []);
      } catch {
        /* ignore */
      }
    }
  }
}

