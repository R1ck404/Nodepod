// worker_threads polyfill using fork infrastructure for real Web Workers
// enhanced with generic napi-rs WASI worker support


import { EventEmitter } from "./events";
import { PassThrough } from "./stream";
import { getRegistry, type Handle } from "../helpers/event-loop";

// shared defaults for main thread; child workers get per-engine overrides via buildResolver
export let isMainThread = true;
export let parentPort: MessagePort | null = null;
export let workerData: unknown = null;
export let threadId = 0;

// fork callback, set by process-worker-entry.ts

export type WorkerThreadForkFn = (
  modulePath: string,
  opts: {
    workerData: unknown;
    threadId: number;
    isEval?: boolean;
    /** extra process.argv entries after the script, like node's `argv` option */
    argv?: string[];
    cwd: string;
    env: Record<string, string>;
    onMessage: (data: unknown) => void;
    onError: (err: Error) => void;
    onExit: (code: number) => void;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  },
) => {
  postMessage: (data: unknown) => void;
  sendStdin: (data: string) => void;
  endStdin: () => void;
  terminate: () => void;
  requestId: number;
};

let _workerThreadForkFn: WorkerThreadForkFn | null = null;

export function setWorkerThreadForkCallback(fn: WorkerThreadForkFn): void {
  _workerThreadForkFn = fn;
}

// returns the fork callback set by setWorkerThreadForkCallback. adapters use
// this instead of depending on this module's private storage.
export function getWorkerThreadForkCallback(): WorkerThreadForkFn | null {
  return _workerThreadForkFn;
}

// script-engine injects a PatchedWorker factory here for napi-rs WASI worker support, factory gets (script, opts) like the constructor
let _workerConstructorOverride: ((self: any, script: string | URL, opts?: any) => void) | null = null;

export function setWorkerConstructorOverride(fn: ((self: any, script: string | URL, opts?: any) => void) | null): void {
  _workerConstructorOverride = fn;
}

let _nextThreadId = 1;


export interface MessagePort extends EventEmitter {
  postMessage(_val: unknown, _transfer?: unknown[]): void;
  start(): void;
  close(): void;
  ref(): void;
  unref(): void;
}

interface MessagePortConstructor {
  new (): MessagePort;
  (this: any): void;
  prototype: any;
}

export const MessagePort = function MessagePort(this: any) {
  if (!this) return;
  EventEmitter.call(this);
  // starts unref'd, node refs on start()
  this._elHandle = null;
} as unknown as MessagePortConstructor;

Object.setPrototypeOf(MessagePort.prototype, EventEmitter.prototype);

MessagePort.prototype.postMessage = function postMessage(_val: unknown, _transfer?: unknown[]): void {};
MessagePort.prototype.start = function start(this: any): void {
  if (!this._elHandle) this._elHandle = getRegistry().register("MessagePort");
};
MessagePort.prototype.close = function close(this: any): void {
  (this._elHandle as Handle | null)?.close();
  this._elHandle = null;
};
MessagePort.prototype.ref = function ref(this: any): void {
  if (!this._elHandle) this._elHandle = getRegistry().register("MessagePort");
  else this._elHandle.ref();
};
MessagePort.prototype.unref = function unref(this: any): void {
  (this._elHandle as Handle | null)?.unref();
};

// Node starts delivering and refs a MessagePort when a message listener is
// attached. Keeping that reference listener-aware lets one-shot workers exit,
// while workers waiting for parent messages remain alive.
MessagePort.prototype.addListener = function addListener(
  this: any,
  name: string,
  handler: (...args: any[]) => void,
): any {
  EventEmitter.prototype.addListener.call(this, name, handler);
  if (name === "message") this.ref();
  return this;
};
MessagePort.prototype.on = MessagePort.prototype.addListener;
MessagePort.prototype.once = function once(
  this: any,
  name: string,
  handler: (...args: any[]) => void,
): any {
  EventEmitter.prototype.once.call(this, name, handler);
  if (name === "message") this.ref();
  return this;
};
MessagePort.prototype.removeListener = function removeListener(
  this: any,
  name: string,
  handler: (...args: any[]) => void,
): any {
  EventEmitter.prototype.removeListener.call(this, name, handler);
  if (name === "message" && this.listenerCount("message") === 0) this.unref();
  return this;
};
MessagePort.prototype.off = MessagePort.prototype.removeListener;
MessagePort.prototype.removeAllListeners = function removeAllListeners(
  this: any,
  name?: string,
): any {
  EventEmitter.prototype.removeAllListeners.call(this, name);
  if (name === undefined || name === "message") this.unref();
  return this;
};
MessagePort.prototype.prependListener = function prependListener(
  this: any,
  name: string,
  handler: (...args: any[]) => void,
): any {
  EventEmitter.prototype.prependListener.call(this, name, handler);
  if (name === "message") this.ref();
  return this;
};
MessagePort.prototype.prependOnceListener = function prependOnceListener(
  this: any,
  name: string,
  handler: (...args: any[]) => void,
): any {
  EventEmitter.prototype.prependOnceListener.call(this, name, handler);
  if (name === "message") this.ref();
  return this;
};

// emnapi (@emnapi/runtime) keeps Node alive during napi async work /
// ThreadsafeFunction activity via:
//   refHandle = new MessageChannel().port1
//   increaseWaitingRequestCounter → refHandle.ref()
//   decreaseWaitingRequestCounter → refHandle.unref()
// It prefers globalThis.MessageChannel when present. In the browser that is
// the host MessageChannel, whose MessagePort has no ref/unref — so the
// keep-alive is a silent no-op and fire-and-forget CLIs (vite's bin calls
// start() without await; cac actions are floating promises) drain mid-build.
// Install Node-shaped ref/unref only when missing; never replace a working
// implementation (real Node, or a prior install). Does not touch readline,
// stdin, or Worker unref semantics.
const _hostPortHandles = new WeakMap<object, Handle>();

export function installHostMessagePortKeepAlive(opts?: {
  force?: boolean;
}): void {
  const MP = (globalThis as { MessagePort?: { prototype: object } }).MessagePort;
  if (typeof MP !== "function" && typeof MP !== "object") return;
  const proto = MP.prototype as {
    ref?: () => void;
    unref?: () => void;
    __nodepodRefPatched?: boolean;
  };
  if (!proto) return;
  if (proto.__nodepodRefPatched && !opts?.force) return;
  // leave Node's (or any existing) ref/unref alone unless tests force a reinstall
  if (
    !opts?.force &&
    typeof proto.ref === "function" &&
    typeof proto.unref === "function"
  ) {
    return;
  }

  proto.ref = function ref(this: object): void {
    let h = _hostPortHandles.get(this);
    if (!h) {
      h = getRegistry().register("MessagePort");
      _hostPortHandles.set(this, h);
    } else {
      h.ref();
    }
  };
  proto.unref = function unref(this: object): void {
    _hostPortHandles.get(this)?.unref();
  };
  proto.__nodepodRefPatched = true;
}

export interface MessageChannel {
  port1: MessagePort;
  port2: MessagePort;
}

interface MessageChannelConstructor {
  new (): MessageChannel;
  (this: any): void;
  prototype: any;
}

export const MessageChannel = function MessageChannel(this: any) {
  if (!this) return;
  this.port1 = new MessagePort();
  this.port2 = new MessagePort();

  // wire the two ports together
  const p1 = this.port1;
  const p2 = this.port2;
  p1.postMessage = (val: unknown) => {
    queueMicrotask(() => p2.emit("message", val));
  };
  p2.postMessage = (val: unknown) => {
    queueMicrotask(() => p1.emit("message", val));
  };
} as unknown as MessageChannelConstructor;


export interface Worker extends EventEmitter {
  threadId: number;
  resourceLimits: object;
  _handle: ReturnType<WorkerThreadForkFn> | null;
  _terminated: boolean;
  _elHandle: Handle | null;
  stdin: InstanceType<typeof PassThrough> | null;
  stdout: InstanceType<typeof PassThrough>;
  stderr: InstanceType<typeof PassThrough>;
  postMessage(value: unknown, _transferListOrOptions?: unknown): void;
  terminate(): Promise<number>;
  ref(): this;
  unref(): this;
  getHeapSnapshot(): Promise<unknown>;
}

interface WorkerConstructor {
  new (
    script: string | URL,
    opts?: {
      workerData?: unknown;
      eval?: boolean;
      env?: Record<string, string> | symbol;
      argv?: string[];
      execArgv?: string[];
      resourceLimits?: Record<string, number>;
      name?: string;
      transferList?: unknown[];
      stdin?: boolean;
      stdout?: boolean;
      stderr?: boolean;
    },
  ): Worker;
  (this: any, script: string | URL, opts?: any): void;
  prototype: any;
}

export const Worker = function Worker(
  this: any,
  script: string | URL,
  opts?: {
    workerData?: unknown;
    eval?: boolean;
    env?: Record<string, string> | symbol;
    argv?: string[];
    execArgv?: string[];
    resourceLimits?: Record<string, number>;
    name?: string;
    transferList?: unknown[];
    stdin?: boolean;
    stdout?: boolean;
    stderr?: boolean;
  },
) {
  if (!this) return;
  EventEmitter.call(this);

  this.threadId = _nextThreadId++;
  this.resourceLimits = {};
  this._handle = null;
  this._terminated = false;
  this._elHandle = null;
  this.stdin = null;
  this.stdout = new PassThrough();
  this.stderr = new PassThrough();

  // if override is installed (napi-rs WASI worker factory), delegate — it handles both WASI workers and fork-based fallback
  if (_workerConstructorOverride) {
    _workerConstructorOverride(this, script, opts);
    return;
  }

  const scriptStr = typeof script === "string" ? script : script.href;
  const self = this;

  if (!_workerThreadForkFn) {
    // no fork callback wired
    queueMicrotask(() => {
      self.emit(
        "error",
        new Error(
          "[Nodepod] worker_threads.Worker requires worker mode. " +
            "Ensure the process is running in a worker context.",
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

  const handle = _workerThreadForkFn(scriptStr, {
    workerData: workerDataVal,
    threadId: this.threadId,
    isEval,
    argv: Array.isArray(opts?.argv) ? opts.argv.map(String) : [],
    cwd: (globalThis as any).process?.cwd?.() ?? "/",
    env,
    onMessage: (data: unknown) => {
      self.emit("message", data);
    },
    onError: (err: Error) => {
      self.emit("error", err);
    },
    onExit: (code: number) => {
      self.stdout.end();
      self.stdout.push(null);
      self.stderr.end();
      self.stderr.push(null);
      self._elHandle?.close();
      self._elHandle = null;
      self._terminated = true;
      self.emit("exit", code);
    },
    onStdout: (data: string) => {
      self.stdout.write(data);
      if (!opts?.stdout) {
        const sink = (globalThis as any).process?.stdout?.write;
        if (typeof sink === "function") sink.call((globalThis as any).process.stdout, data);
      }
    },
    onStderr: (data: string) => {
      self.stderr.write(data);
      if (!opts?.stderr) {
        const sink = (globalThis as any).process?.stderr?.write;
        if (typeof sink === "function") sink.call((globalThis as any).process.stderr, data);
      }
    },
  });

  this._handle = handle;

  if (opts?.stdin) {
    this.stdin = new PassThrough();
    this.stdin.on("data", (chunk: unknown) => {
      if (!self._terminated) handle.sendStdin(String(chunk));
    });
    this.stdin.once("finish", () => {
      if (!self._terminated) handle.endStdin();
    });
  }

  // workers are refed by default in node, keeps parent alive
  this._elHandle = getRegistry().register("Worker");

  queueMicrotask(() => {
    if (!self._terminated) self.emit("online");
  });
} as unknown as WorkerConstructor;

Object.setPrototypeOf(Worker.prototype, EventEmitter.prototype);

Worker.prototype.postMessage = function postMessage(this: any, value: unknown, _transferListOrOptions?: unknown): void {
  if (this._handle && !this._terminated) {
    this._handle.postMessage(value);
  }
};

Worker.prototype.terminate = function terminate(this: any): Promise<number> {
  if (this._handle && !this._terminated) {
    this._elHandle?.close();
    this._elHandle = null;
    this._terminated = true;
    this._handle.terminate();
    this.stdin?.end?.();
    this.stdout.end();
    this.stdout.push(null);
    this.stderr.end();
    this.stderr.push(null);
  }
  return Promise.resolve(0);
};

Worker.prototype.ref = function ref(this: any): any {
  if (!this._terminated) (this._elHandle as Handle | null)?.ref();
  return this;
};

Worker.prototype.unref = function unref(this: any): any {
  (this._elHandle as Handle | null)?.unref();
  return this;
};

Worker.prototype.getHeapSnapshot = function getHeapSnapshot(): Promise<unknown> {
  return Promise.resolve({});
};

// direct onmessage/onerror/onexit setters, napi-rs .wasi.cjs loaders use worker.onmessage = ... instead of .on('message', ...)
//
// CRITICAL: the onmessage setter must NOT add an EventEmitter listener
// emnapi (ENVIRONMENT_IS_NODE=true) already calls worker.on('message', data => worker.onmessage?.({data}))
// if this setter ALSO added a listener, each message would fire twice. for 'spawn-thread' that means
// duplicate workers calling wasi_thread_start with the same startArg, then TLS corruption / "current thread handle already set"
// fix: setter just stores the handler, emnapi's explicit on('message') dispatches exactly once
{
  const _onmessageSym = Symbol("onmessage");
  Object.defineProperty(Worker.prototype, "onmessage", {
    get() { return this[_onmessageSym] ?? null; },
    set(fn: Function | null) {
      this[_onmessageSym] = fn;
      // do NOT add as EventEmitter listener, emnapi's worker.on('message') already calls worker.onmessage()
    },
    configurable: true,
  });

  const _onerrorSym = Symbol("onerror");
  Object.defineProperty(Worker.prototype, "onerror", {
    get() { return this[_onerrorSym] ?? null; },
    set(fn: Function | null) {
      this[_onerrorSym] = fn;
      // same as onmessage, do NOT add as EventEmitter listener
    },
    configurable: true,
  });

  const _onexitSym = Symbol("onexit");
  Object.defineProperty(Worker.prototype, "onexit", {
    get() { return this[_onexitSym] ?? null; },
    set(fn: Function | null) {
      if (this[_onexitSym]) this.off("exit", this[_onexitSym]);
      this[_onexitSym] = fn;
      if (fn) this.on("exit", fn);
    },
    configurable: true,
  });
}


export interface BroadcastChannel extends EventEmitter {
  name: string;
  postMessage(_msg: unknown): void;
  close(): void;
  ref(): void;
  unref(): void;
}

interface BroadcastChannelConstructor {
  new (label: string): BroadcastChannel;
  (this: any, label: string): void;
  prototype: any;
}

export const BroadcastChannel = function BroadcastChannel(this: any, label: string) {
  if (!this) return;
  EventEmitter.call(this);
  this.name = label;
  this._elHandle = getRegistry().register("BroadcastChannel");
} as unknown as BroadcastChannelConstructor;

Object.setPrototypeOf(BroadcastChannel.prototype, EventEmitter.prototype);

BroadcastChannel.prototype.postMessage = function postMessage(_msg: unknown): void {};
BroadcastChannel.prototype.close = function close(this: any): void {
  (this._elHandle as Handle | null)?.close();
  this._elHandle = null;
};
BroadcastChannel.prototype.ref = function ref(this: any): void {
  (this._elHandle as Handle | null)?.ref();
};
BroadcastChannel.prototype.unref = function unref(this: any): void {
  (this._elHandle as Handle | null)?.unref();
};


export function moveMessagePortToContext(
  port: MessagePort,
  _ctx: unknown,
): MessagePort {
  return port;
}

export function receiveMessageOnPort(
  _port: MessagePort,
): { message: unknown } | undefined {
  return undefined;
}

export const SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");

export function markAsUntransferable(_obj: unknown): void {}
export function getEnvironmentData(_key: unknown): unknown {
  return undefined;
}
export function setEnvironmentData(_key: unknown, _val: unknown): void {}


export default {
  isMainThread,
  parentPort,
  workerData,
  threadId,
  Worker,
  MessageChannel,
  MessagePort,
  BroadcastChannel,
  moveMessagePortToContext,
  receiveMessageOnPort,
  SHARE_ENV,
  markAsUntransferable,
  getEnvironmentData,
  setEnvironmentData,
  setWorkerThreadForkCallback,
  getWorkerThreadForkCallback,
  setWorkerConstructorOverride,
  installHostMessagePortKeepAlive,
};
