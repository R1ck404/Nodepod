// Event loop liveness tracking, same idea as libuv's HandleWrap model.
// Each async primitive registers a typed Handle, and the process stays
// alive as long as any Handle is refed. close() is idempotent and auto-unrefs
// so polyfills don't have to pair every register with a matching unref
// in their error paths.

import { getActiveContext } from "../threading/process-context";

// process.exit() throws this to unwind the script. We brand it so consumers
// can use isExitSentinel(e) instead of matching on err.message, which would
// break if the message ever changed and could misclassify user errors that
// happen to start with the same prefix.

const EXIT_SENTINEL_BRAND = Symbol.for("nodepod.ProcessExitSentinel");

export class ProcessExitSentinel extends Error {
  readonly exitCode: number;
  // structural brand, survives cross-realm throws where instanceof fails
  readonly [EXIT_SENTINEL_BRAND] = true as const;
  constructor(code: number) {
    super(`Process exited with code ${code}`);
    this.name = "ProcessExitSentinel";
    this.exitCode = code;
  }
}

export function isExitSentinel(e: unknown): boolean {
  if (e instanceof ProcessExitSentinel) return true;
  if (
    e &&
    typeof e === "object" &&
    (e as { [EXIT_SENTINEL_BRAND]?: true })[EXIT_SENTINEL_BRAND] === true
  ) {
    return true;
  }
  return false;
}

// handle types, roughly lines up with libuv resource names plus a few node extras

export type HandleType =
  | "Timeout"
  | "Immediate"
  | "Interval"
  | "FetchRequest"
  | "DynamicImport"
  | "TCPSocketWrap"
  | "TCPServerWrap"
  | "UDPWrap"
  | "PipeWrap"
  | "IPCChannel"
  | "TLSWrap"
  | "HTTP2Session"
  | "HTTPServer"
  | "FSReqCallback"
  | "FSWatcher"
  | "StatWatcher"
  | "WebSocket"
  | "MessagePort"
  | "BroadcastChannel"
  | "Worker"
  | "ChildProcess"
  | "TTYWrap"
  | "ReadlineInterface"
  | "EsbuildOp"
  | "WASMWork";

export interface Handle {
  readonly type: HandleType;
  readonly registry: HandleRegistry;
  readonly refed: boolean;
  readonly closed: boolean;
  ref(): this;
  unref(): this;
  close(): void;
}

export interface HandleRegistry {
  register(type: HandleType, opts?: { refed?: boolean }): Handle;
  activeRefedCount(): number;
  list(): ReadonlyArray<Handle>;
  groupedByType(): Record<string, number>;
  /** Fresh promise each drain cycle. Resolves on refed-count 1 to 0. */
  drainPromise(): Promise<void>;
  onDrain(cb: () => void): () => void;
  /** Awaits each beforeExit handler sequentially. */
  emitBeforeExit(code: number): Promise<void>;
  onBeforeExit(cb: (code: number) => void | Promise<void>): () => void;
  closeAll(): void;
}

class HandleImpl implements Handle {
  readonly type: HandleType;
  readonly registry: RegistryImpl;
  refed: boolean;
  closed = false;
  constructor(registry: RegistryImpl, type: HandleType, refed: boolean) {
    this.registry = registry;
    this.type = type;
    this.refed = refed;
  }
  ref(): this {
    if (this.closed || this.refed) return this;
    this.refed = true;
    this.registry._incRefed();
    return this;
  }
  unref(): this {
    if (this.closed || !this.refed) return this;
    this.refed = false;
    this.registry._decRefed();
    return this;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.refed) {
      this.refed = false;
      this.registry._decRefed();
    }
    this.registry._remove(this);
  }
}

class RegistryImpl implements HandleRegistry {
  private _handles = new Set<HandleImpl>();
  private _refedCount = 0;
  private _drainCbs = new Set<() => void>();
  private _beforeExitCbs: Array<(code: number) => void | Promise<void>> = [];
  private _drainPromise: Promise<void> | null = null;
  private _drainResolve: (() => void) | null = null;

  register(type: HandleType, opts?: { refed?: boolean }): Handle {
    const refed = opts?.refed !== false;
    const h = new HandleImpl(this, type, refed);
    this._handles.add(h);
    if (refed) this._refedCount++;
    return h;
  }

  activeRefedCount(): number {
    return this._refedCount;
  }

  list(): ReadonlyArray<Handle> {
    return Array.from(this._handles);
  }

  groupedByType(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const h of this._handles) {
      if (!h.refed) continue;
      out[h.type] = (out[h.type] ?? 0) + 1;
    }
    return out;
  }

  drainPromise(): Promise<void> {
    if (this._refedCount === 0) return Promise.resolve();
    if (this._drainPromise) return this._drainPromise;
    this._drainPromise = new Promise<void>((resolve) => {
      this._drainResolve = resolve;
    });
    return this._drainPromise;
  }

  onDrain(cb: () => void): () => void {
    this._drainCbs.add(cb);
    return () => this._drainCbs.delete(cb);
  }

  async emitBeforeExit(code: number): Promise<void> {
    // snapshot so handlers that register more listeners don't fire this cycle
    const snapshot = this._beforeExitCbs.slice();
    for (const cb of snapshot) {
      try {
        await cb(code);
      } catch (e) {
        // process.exit() from a handler throws the sentinel, re-throw so the
        // wait loop sees it. other errors are swallowed, same as node.
        if (isExitSentinel(e)) throw e;
      }
    }
  }

  onBeforeExit(cb: (code: number) => void | Promise<void>): () => void {
    this._beforeExitCbs.push(cb);
    return () => {
      const i = this._beforeExitCbs.indexOf(cb);
      if (i >= 0) this._beforeExitCbs.splice(i, 1);
    };
  }

  closeAll(): void {
    // snapshot first, close() mutates the set
    for (const h of Array.from(this._handles)) h.close();
  }

  _incRefed(): void {
    this._refedCount++;
  }

  _decRefed(): void {
    if (this._refedCount > 0) this._refedCount--;
    if (this._refedCount === 0) {
      const resolve = this._drainResolve;
      this._drainPromise = null;
      this._drainResolve = null;
      if (resolve) resolve();
      for (const cb of this._drainCbs) {
        try {
          cb();
        } catch {
          /* ignore */
        }
      }
    }
  }

  _remove(h: HandleImpl): void {
    this._handles.delete(h);
  }
}

// global registry is the fallback when no ProcessContext is active
const _globalRegistry = new RegistryImpl();

export function getRegistry(): HandleRegistry {
  const ctx = getActiveContext();
  return (ctx?.handles as HandleRegistry | undefined) ?? _globalRegistry;
}

export function getGlobalRegistry(): HandleRegistry {
  return _globalRegistry;
}

export function createHandleRegistry(): HandleRegistry {
  return new RegistryImpl();
}

/**
 * Hold a refed handle for the lifetime of `work`. Anything that settles from
 * a browser task rather than a tracked node handle (CDN imports, WebAssembly
 * compiles, wasm-backed engines) must go through this, or the process wait
 * loop sees an empty registry mid-await and exits early with code 0.
 */
export async function withHandle<T>(type: HandleType, work: () => Promise<T>): Promise<T> {
  const h = getRegistry().register(type);
  try {
    return await work();
  } finally {
    h.close();
  }
}
