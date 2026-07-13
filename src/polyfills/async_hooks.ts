// AsyncLocalStorage polyfill with async-context propagation.
// Next.js app-router stores per-request state in workUnitAsyncStorage and
// expects getStore() to survive await boundaries and concurrent requests.
//
// V8 async/await schedules continuations through the global Promise constructor
// but bypasses Promise.prototype.then on the builtin prototype. Replacing
// globalThis.Promise with a subclass whose then/catch/finally capture the
// current store frame makes await participate in context propagation. run()
// keeps the active frame until an async callback's returned promise settles so
// the frame is still current when await registers its continuation handler.

type StoreFrame = Map<object, unknown>;

let currentFrame: StoreFrame = new Map();
let asyncContextInstalled = false;

function captureFrame(): StoreFrame {
  return new Map(currentFrame);
}

const NativePromise = Promise;

// consumers bridging native async functions across an ABI need the intrinsic
// constructor. installAsyncContext() replaces globalThis.Promise below, but
// async functions still create intrinsic native promises; instanceof checks
// against the replacement would reject valid results.
export function getNativePromiseConstructor(): typeof Promise {
  return NativePromise;
}

// Synchronous frame switch. Always restores in finally: continuations
// registered outside an active run() fire interleaved with the run's awaits,
// and leaving their (often empty) frame current would clobber the run's store
// for every subsequent native-await resumption.
function runWithFrame<R>(frame: StoreFrame, fn: () => R): R {
  const prev = currentFrame;
  currentFrame = frame;
  try {
    return fn();
  } finally {
    currentFrame = prev;
  }
}

// Frame switch that survives native async/await inside fn. If fn returns a
// promise, the frame is held current until it settles, because V8 resumes
// async function bodies through internal promise reactions that bypass any
// user-visible then(). Restore is guarded so a scope that settles while a
// newer scope's frame is current doesn't stomp it.
function runScoped<R>(frame: StoreFrame, fn: () => R): R {
  const prev = currentFrame;
  currentFrame = frame;
  const finish = () => {
    if (currentFrame === frame) {
      currentFrame = prev;
    }
  };
  try {
    const result = fn();
    const maybePromise = result as unknown;
    if (maybePromise != null && typeof (maybePromise as PromiseLike<unknown>).then === "function") {
      return NativePromise.resolve(maybePromise as PromiseLike<unknown>).finally(finish) as R;
    }
    finish();
    return result;
  } catch (err) {
    finish();
    throw err;
  }
}

function wrapCallback<T extends (...args: any[]) => any>(
  cb: T | undefined | null,
  frame: StoreFrame,
): T | undefined | null {
  if (typeof cb !== "function") return cb;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    // Sync restore (runWithFrame, NOT runScoped): if this callback captured
    // an empty/stale frame and held it across its own awaits, it would be
    // current when an active run()'s native-await resumptions fire and would
    // clobber the run's store. The run's frame is held by runScoped instead,
    // so restoring here hands control straight back to it.
    return runWithFrame(frame, () => cb.apply(this, args));
  } as T;
  return wrapped;
}

class ContextPromise<T = unknown> extends NativePromise<T> {
  static get [Symbol.species]() {
    return ContextPromise;
  }

  then<TResult1 = T, TResult2 = never>(
    onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): ContextPromise<TResult1 | TResult2> {
    const frame = captureFrame();
    return super.then(
      wrapCallback(onFulfilled, frame),
      wrapCallback(onRejected, frame),
    ) as ContextPromise<TResult1 | TResult2>;
  }

  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): ContextPromise<T | TResult> {
    const frame = captureFrame();
    return super.catch(wrapCallback(onRejected, frame)) as ContextPromise<T | TResult>;
  }

  finally(onFinally?: (() => void) | null): ContextPromise<T> {
    const frame = captureFrame();
    return super.finally(wrapCallback(onFinally, frame)) as ContextPromise<T>;
  }

  static resolve<T>(value?: T | PromiseLike<T>): ContextPromise<T> {
    if (value instanceof ContextPromise) {
      return value;
    }
    if (value != null && typeof (value as PromiseLike<T>).then === "function") {
      return new ContextPromise((resolve, reject) => {
        NativePromise.resolve(value).then(resolve, reject);
      });
    }
    return new ContextPromise((resolve) => {
      resolve(value as T);
    });
  }

  static reject<T = never>(reason?: unknown): ContextPromise<T> {
    return new ContextPromise((_resolve, reject) => {
      reject(reason);
    });
  }

  static all<T extends readonly unknown[] | []>(
    values: T,
  ): ContextPromise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
    return ContextPromise.resolve(
      NativePromise.all(values),
    ) as ContextPromise<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
  }

  static race<T extends readonly unknown[] | []>(
    values: T,
  ): ContextPromise<Awaited<T[number]>> {
    return ContextPromise.resolve(
      NativePromise.race(values),
    ) as ContextPromise<Awaited<T[number]>>;
  }

  static allSettled<T extends readonly unknown[] | []>(
    values: T,
  ): ContextPromise<{ -readonly [P in keyof T]: PromiseSettledResult<Awaited<T[P]>> }> {
    return ContextPromise.resolve(
      NativePromise.allSettled(values),
    ) as ContextPromise<{ -readonly [P in keyof T]: PromiseSettledResult<Awaited<T[P]>> }>;
  }

  static any<T extends readonly unknown[] | []>(
    values: T,
  ): ContextPromise<Awaited<T[number]>> {
    return ContextPromise.resolve(
      NativePromise.any(values),
    ) as ContextPromise<Awaited<T[number]>>;
  }
}

function patchTimerContext(): void {
  const wrapTimer = <F extends (...args: any[]) => void>(fn: F): F => {
    const frame = captureFrame();
    return ((...args: unknown[]) => {
      // Sync restore for the same reason as wrapCallback.
      runWithFrame(frame, () => fn(...args));
    }) as F;
  };

  if (!(globalThis.queueMicrotask as any)?.__nodepodAsyncCtx) {
    const orig = globalThis.queueMicrotask.bind(globalThis);
    globalThis.queueMicrotask = ((cb: () => void) => {
      orig(wrapTimer(cb));
    }) as typeof queueMicrotask;
    (globalThis.queueMicrotask as any).__nodepodAsyncCtx = true;
  }

  if (!(globalThis.setTimeout as any)?.__nodepodAsyncCtx) {
    const origSetTimeout = globalThis.setTimeout.bind(globalThis);
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const wrapped =
        typeof handler === "function" ? wrapTimer(handler as (...a: unknown[]) => void) : handler;
      return origSetTimeout(wrapped, timeout as number, ...args);
    }) as typeof setTimeout;
    (globalThis.setTimeout as any).__nodepodAsyncCtx = true;
  }

  if (typeof globalThis.setImmediate === "function" && !(globalThis.setImmediate as any).__nodepodAsyncCtx) {
    const origSetImmediate = globalThis.setImmediate.bind(globalThis);
    globalThis.setImmediate = ((handler: (...args: unknown[]) => void, ...args: unknown[]) => {
      return origSetImmediate(wrapTimer(handler), ...args);
    }) as typeof setImmediate;
    (globalThis.setImmediate as any).__nodepodAsyncCtx = true;
  }
}

export function installAsyncContext(): void {
  if (asyncContextInstalled) return;
  asyncContextInstalled = true;

  if (!(globalThis.Promise as any)?.__nodepodAsyncCtx) {
    (globalThis as any).Promise = ContextPromise;
    (ContextPromise as any).__nodepodAsyncCtx = true;
  }

  patchTimerContext();
}

installAsyncContext();

/* ------------------------------------------------------------------ */
/*  AsyncResource                                                      */
/* ------------------------------------------------------------------ */

export interface AsyncResource {
  runInAsyncScope<R>(fn: (...a: any[]) => R, thisArg?: unknown, ...args: any[]): R;
  emitDestroy(): this;
  asyncId(): number;
  triggerAsyncId(): number;
}

export const AsyncResource = function AsyncResource(this: any, _kind: string, _opts?: object) {
  if (!this) return;
} as unknown as { new(_kind: string, _opts?: object): AsyncResource; prototype: any; bind<F extends (...a: any[]) => any>(fn: F, _kind?: string): F };

AsyncResource.prototype.runInAsyncScope = function runInAsyncScope<R>(
  fn: (...a: any[]) => R,
  thisArg?: unknown,
  ...args: any[]
): R {
  return fn.apply(thisArg, args);
};
AsyncResource.prototype.emitDestroy = function emitDestroy() { return this; };
AsyncResource.prototype.asyncId = function asyncId(): number { return 0; };
AsyncResource.prototype.triggerAsyncId = function triggerAsyncId(): number { return 0; };

AsyncResource.bind = function bind<F extends (...a: any[]) => any>(fn: F, _kind?: string): F {
  const frame = captureFrame();
  return function (this: unknown, ...args: unknown[]) {
    return runWithFrame(frame, () => fn.apply(this, args));
  } as F;
};

/* ------------------------------------------------------------------ */
/*  AsyncLocalStorage                                                  */
/* ------------------------------------------------------------------ */

export interface AsyncLocalStorage<T> {
  disable(): void;
  getStore(): T | undefined;
  run<R>(store: T, fn: (...args: any[]) => R, ...args: any[]): R;
  exit<R>(fn: (...args: any[]) => R, ...args: any[]): R;
  enterWith(store: T): void;
}

export const AsyncLocalStorage = function AsyncLocalStorage(this: any) {
  if (!this) return;
  this._enabled = true;
} as unknown as {
  new<T>(): AsyncLocalStorage<T>;
  prototype: any;
  snapshot(): <R>(fn: (...args: any[]) => R, ...args: any[]) => R;
  bind<F extends (...a: any[]) => any>(fn: F): F;
};

(AsyncLocalStorage as any).__nodepodAsyncCtx = true;

AsyncLocalStorage.snapshot = function snapshot() {
  const frame = captureFrame();
  return function runSnapshot(fn: (...args: any[]) => any, ...args: any[]) {
    return runWithFrame(frame, () => fn(...args));
  };
};

AsyncLocalStorage.bind = function bind<F extends (...a: any[]) => any>(fn: F): F {
  const frame = captureFrame();
  return function (this: unknown, ...args: unknown[]) {
    return runWithFrame(frame, () => fn.apply(this, args));
  } as F;
};

// Marks "explicitly no store" inside exit() frames, so the sticky fallback
// below doesn't resurrect a store the caller asked to leave.
const EXCLUDED: unique symbol = Symbol("nodepod.als.excluded");

AsyncLocalStorage.prototype.disable = function disable(): void {
  this._enabled = false;
  this._stickyStore = undefined;
};

// Sticky fallback: when the current frame has no entry for this storage,
// return the store of the most recent run(). Real AsyncLocalStorage carries
// context per-continuation, so work spawned inside run() (e.g. Next.js
// streaming Suspense chunks that flush AFTER the awaited response promise
// settled) still sees the request store. We can't observe native async/await
// resumptions from a polyfill, so without this fallback that late work reads
// undefined and Next throws "Expected workUnitAsyncStorage to have a store".
// Trade-off: code running truly outside any run() sees the last run's store
// instead of undefined — acceptable for a dev sandbox, where a missing store
// is fatal but a stale one is not.
AsyncLocalStorage.prototype.getStore = function getStore() {
  if (this._enabled === false) return undefined;
  if (currentFrame.has(this)) {
    const value = currentFrame.get(this);
    return value === EXCLUDED ? undefined : value;
  }
  return this._stickyStore;
};

AsyncLocalStorage.prototype.run = function run(store: any, fn: (...args: any[]) => any, ...args: any[]) {
  this._stickyStore = store;
  const frame = captureFrame();
  frame.set(this, store);
  return runScoped(frame, () => fn(...args));
};

AsyncLocalStorage.prototype.exit = function exit(fn: (...args: any[]) => any, ...args: any[]) {
  const frame = captureFrame();
  frame.set(this, EXCLUDED);
  return runScoped(frame, () => fn(...args));
};

AsyncLocalStorage.prototype.enterWith = function enterWith(store: any): void {
  this._stickyStore = store;
  currentFrame.set(this, store);
};

/* ------------------------------------------------------------------ */
/*  Hook API                                                           */
/* ------------------------------------------------------------------ */

export interface AsyncHook {
  enable(): AsyncHook;
  disable(): AsyncHook;
}

export function createHook(_callbacks: object): AsyncHook {
  const hook: AsyncHook = {
    enable() {
      return hook;
    },
    disable() {
      return hook;
    },
  };
  return hook;
}

export function executionAsyncId(): number {
  return 0;
}
export function executionAsyncResource(): object {
  return {};
}
export function triggerAsyncId(): number {
  return 0;
}

/* ------------------------------------------------------------------ */
/*  Default export                                                     */
/* ------------------------------------------------------------------ */

export default {
  AsyncResource,
  AsyncLocalStorage,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
  installAsyncContext,
};
