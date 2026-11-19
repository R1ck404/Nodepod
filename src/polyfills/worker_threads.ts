// worker_threads polyfill using fork infrastructure for real Web Workers
// enhanced with generic napi-rs WASI worker support


import { EventEmitter } from "./events.js";
import { PassThrough } from "./stream.js";
import { getRegistry, type Handle } from "../helpers/event-loop.js";

const uncloneable = new WeakSet<object>();

export function markAsUncloneable(value: unknown): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return;
  }
  if (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)
  ) {
    return;
  }
  uncloneable.add(value);
}

// Snapshot enumerable properties while checking marks, so the transport's
// structured clone does not invoke message getters a second time. Leave
// native cloneable types (buffers, dates, ports, etc.) to the transport.
export function prepareWorkerMessage(
  value: unknown,
  seen = new Map<object, unknown>(),
): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  if (uncloneable.has(value)) {
    throw new DOMException("Cannot clone a marked object", "DataCloneError");
  }
  if (seen.has(value)) return seen.get(value);
  // a transferable port must reach encodeTransfer as the same object
  if (value instanceof MessagePort) return value;
  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [key, item] of value) {
      copy.set(prepareWorkerMessage(key, seen), prepareWorkerMessage(item, seen));
    }
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    for (const item of value) copy.add(prepareWorkerMessage(item, seen));
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    Array.isArray(value) ||
    prototype === Object.prototype ||
    prototype === null ||
    Object.prototype.toString.call(value) === "[object Object]"
  ) {
    const copy: Record<string, unknown> | unknown[] = Array.isArray(value)
      ? new Array(value.length)
      : {};
    seen.set(value, copy);
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        value: prepareWorkerMessage((value as Record<string, unknown>)[key], seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  }
  return value;
}

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
  /** `transferList` may hold MessagePorts; see encodeTransfer */
  postMessage: (data: unknown, transferList?: readonly unknown[]) => void;
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
  // browser MessagePort behind a MessageChannel port (see wrapHostPort)
  this._host = null;
  this._closed = false;
} as unknown as MessagePortConstructor;

Object.setPrototypeOf(MessagePort.prototype, EventEmitter.prototype);

// A MessageChannel's ports are backed by a browser MessageChannel, so they
// can be transferred to another worker thread (each thread is a Web Worker):
// tinypool, and Vitest's threads pool on it, hand a port to every worker.
// Messages travel in an envelope; ports inside them are encoded by
// encodeTransfer and rebuilt by decodeTransfer on the receiving side.
const PORT_MARKER = "__nodepodMessagePort__";
const CLOSE_MARKER = "__nodepodMessagePortClose__";

type HostPort = {
  postMessage(data: unknown, transfer?: Transferable[]): void;
  close(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onmessageerror: ((e: unknown) => void) | null;
};

function hostChannel(): { port1: HostPort; port2: HostPort } | null {
  const HostChannel = (globalThis as { MessageChannel?: new () => { port1: HostPort; port2: HostPort } })
    .MessageChannel;
  // installed polyfills (or Node itself) may put this module's class there
  if (typeof HostChannel !== "function" || (HostChannel as unknown) === MessageChannel) return null;
  return new HostChannel();
}

/** Wrap a browser MessagePort in a Node-style one. */
export function wrapHostPort(host: HostPort): MessagePort {
  const port = new MessagePort() as any;
  port._host = host;
  return port;
}

function startHost(port: any): void {
  const host = port._host as HostPort | null;
  if (!host || host.onmessage || port._closed) return;
  // setting onmessage starts the browser port; it queues messages until then,
  // as Node does until a 'message' listener is attached or start() is called
  host.onmessage = (e) => {
    const env = e.data as { data?: unknown; ports?: HostPort[]; [CLOSE_MARKER]?: true } | null;
    if (env && env[CLOSE_MARKER]) {
      closePort(port, false);
      return;
    }
    port.emit("message", decodeTransfer(env?.data, env?.ports));
  };
  host.onmessageerror = (e) => port.emit("messageerror", e);
}

function closePort(port: any, notifyPeer: boolean): void {
  if (port._closed) return;
  port._closed = true;
  const host = port._host as HostPort | null;
  if (host) {
    if (notifyPeer) {
      try {
        host.postMessage({ [CLOSE_MARKER]: true });
      } catch {
        /* peer already gone */
      }
    }
    host.onmessage = null;
    host.close();
  }
  (port._elHandle as Handle | null)?.close();
  port._elHandle = null;
  queueMicrotask(() => port.emit("close"));
}

/**
 * Prepare a message for a browser postMessage: every MessagePort in
 * `transferList` is replaced inside `value` by a marker, and its browser port
 * is returned for the transfer list. Without ports the value is unchanged.
 */
export function encodeTransfer(
  value: unknown,
  transferList?: readonly unknown[] | { transfer?: readonly unknown[] } | null,
): { data: unknown; ports: HostPort[] } {
  const list = Array.isArray(transferList)
    ? transferList
    : ((transferList as { transfer?: readonly unknown[] } | null | undefined)?.transfer ?? []);
  const indices = new Map<object, number>();
  const ports: HostPort[] = [];
  for (const item of list) {
    if (!(item instanceof MessagePort) || indices.has(item)) continue;
    const port = item as any;
    if (!port._host) {
      throw new DOMException("MessagePort cannot be transferred: it has no browser port", "DataCloneError");
    }
    if (port._closed) {
      throw new DOMException("MessagePort in transfer list is already detached", "DataCloneError");
    }
    indices.set(item, ports.length);
    ports.push(port._host);
    // the browser port moves to the receiver; this side is detached
    port._closed = true;
    port._host = null;
    (port._elHandle as Handle | null)?.close();
    port._elHandle = null;
  }
  if (ports.length === 0) return { data: value, ports };
  const copies = new Map<object, unknown>();
  const replace = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    const index = indices.get(v as object);
    if (index !== undefined) return { [PORT_MARKER]: index };
    if (copies.has(v as object)) return copies.get(v as object);
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      copies.set(v, out);
      for (const item of v) out.push(replace(item));
      return out;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    const out: Record<string, unknown> = {};
    copies.set(v as object, out);
    for (const key of Object.keys(v as object)) out[key] = replace((v as Record<string, unknown>)[key]);
    return out;
  };
  return { data: replace(value), ports };
}

/** Undo encodeTransfer on the receiving side. */
export function decodeTransfer(data: unknown, ports?: readonly HostPort[] | null): unknown {
  if (!ports || ports.length === 0) return data;
  const wrapped = ports.map((p) => wrapHostPort(p));
  const seen = new Set<object>();
  const restore = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    const marker = (v as Record<string, unknown>)[PORT_MARKER];
    if (typeof marker === "number" && Object.keys(v as object).length === 1) return wrapped[marker];
    if (seen.has(v as object)) return v;
    seen.add(v as object);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = restore(v[i]);
    } else {
      const proto = Object.getPrototypeOf(v);
      if (proto === Object.prototype || proto === null) {
        for (const key of Object.keys(v as object)) {
          (v as Record<string, unknown>)[key] = restore((v as Record<string, unknown>)[key]);
        }
      }
    }
    return v;
  };
  return restore(data);
}

MessagePort.prototype.postMessage = function postMessage(
  this: any,
  val: unknown,
  transfer?: readonly unknown[] | { transfer?: readonly unknown[] },
): void {
  const host = this._host as HostPort | null;
  if (!host || this._closed) return;
  const { data, ports } = encodeTransfer(prepareWorkerMessage(val), transfer);
  host.postMessage({ data, ports }, ports as unknown as Transferable[]);
};
MessagePort.prototype.start = function start(this: any): void {
  if (this._closed) return;
  if (!this._elHandle) this._elHandle = getRegistry().register("MessagePort");
  startHost(this);
};
MessagePort.prototype.close = function close(this: any): void {
  if (!this._host) {
    (this._elHandle as Handle | null)?.close();
    this._elHandle = null;
    return;
  }
  closePort(this, true);
};
MessagePort.prototype.ref = function ref(this: any): void {
  if (this._closed) return;
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
  if (name === "message") {
    this.ref();
    startHost(this);
  }
  return this;
};
MessagePort.prototype.on = MessagePort.prototype.addListener;
MessagePort.prototype.once = function once(
  this: any,
  name: string,
  handler: (...args: any[]) => void,
): any {
  EventEmitter.prototype.once.call(this, name, handler);
  if (name === "message") {
    this.ref();
    startHost(this);
  }
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
  if (name === "message") {
    this.ref();
    startHost(this);
  }
  return this;
};
MessagePort.prototype.prependOnceListener = function prependOnceListener(
  this: any,
  name: string,
  handler: (...args: any[]) => void,
): any {
  EventEmitter.prototype.prependOnceListener.call(this, name, handler);
  if (name === "message") {
    this.ref();
    startHost(this);
  }
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
  const host = hostChannel();
  if (host) {
    this.port1 = wrapHostPort(host.port1);
    this.port2 = wrapHostPort(host.port2);
    return;
  }
  this.port1 = new MessagePort();
  this.port2 = new MessagePort();

  // no browser MessageChannel: wire the two ports together in memory
  const p1 = this.port1;
  const p2 = this.port2;
  p1.postMessage = (val: unknown) => {
    const message = prepareWorkerMessage(val);
    queueMicrotask(() => p2.emit("message", message));
  };
  p2.postMessage = (val: unknown) => {
    const message = prepareWorkerMessage(val);
    queueMicrotask(() => p1.emit("message", message));
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

  if (opts && "workerData" in opts) {
    opts = { ...opts, workerData: prepareWorkerMessage(opts.workerData) };
  }

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

Worker.prototype.postMessage = function postMessage(this: any, value: unknown, transferListOrOptions?: unknown): void {
  if (this._handle && !this._terminated) {
    this._handle.postMessage(prepareWorkerMessage(value), transferListOrOptions);
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
  markAsUncloneable,
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
  encodeTransfer,
  decodeTransfer,
};
