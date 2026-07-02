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
let activeRunDepth = 0;
// Last store passed to run()/enterWith per ALS instance. Next.js calls
// workUnitAsyncStorage.run() synchronously for renderToFlightStream; React
// consumes the returned stream in later microtasks and still expects getStore().
const ambientStores = new Map<object, unknown>();
let asyncContextInstalled = false;

function captureFrame(): StoreFrame {
  return new Map(currentFrame);
}

const NativePromise = Promise;

function beginRun(frame: StoreFrame, prev: StoreFrame): () => void {
  currentFrame = frame;
  activeRunDepth++;
  return () => {
    activeRunDepth--;
    currentFrame = prev;
  };
}

function runWithFrame<R>(frame: StoreFrame, fn: () => R): R {
  const prev = currentFrame;
  currentFrame = frame;
  try {
    return fn();
  } finally {
    currentFrame = prev;
  }
}

function runScoped<R>(frame: StoreFrame, fn: () => R): R {
  const prev = currentFrame;
  const finish = beginRun(frame, prev);
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
    // Inside AsyncLocalStorage.run(), keep the run-scoped frame. Re-entering a
    // captured frame here breaks async/await because V8 runs the real continuation
    // after this wrapper returns.
    if (activeRunDepth > 0) {
      return cb.apply(this, args);
    }
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

  // Next.js captures globalThis.AsyncLocalStorage once when
  // server/app-render/async-local-storage.js first loads. Install early.
  (globalThis as any).AsyncLocalStorage = AsyncLocalStorage;
}

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

AsyncLocalStorage.prototype.disable = function disable(): void {
  this._enabled = false;
};

AsyncLocalStorage.prototype.getStore = function getStore() {
  if (this._enabled === false) return undefined;
  if (ambientStores.has(this)) return ambientStores.get(this);
  return currentFrame.get(this);
};

AsyncLocalStorage.prototype.run = function run(store: any, fn: (...args: any[]) => any, ...args: any[]) {
  const frame = captureFrame();
  frame.set(this, store);
  const prevAmbient = ambientStores.get(this);
  ambientStores.set(this, store);
  const restoreAmbient = () => {
    if (prevAmbient !== undefined) ambientStores.set(this, prevAmbient);
    else ambientStores.delete(this);
  };
  const result = runScoped(frame, () => fn(...args));
  const maybePromise = result as unknown;
  if (maybePromise != null && typeof (maybePromise as PromiseLike<unknown>).then === "function") {
    return NativePromise.resolve(maybePromise as PromiseLike<unknown>).finally(() => {
      if (ambientStores.get(this) === store) restoreAmbient();
    }) as typeof result;
  }
  // Sync run that returns a stream/object (e.g. renderToFlightStream) keeps the
  // ambient store for later React microtasks. Primitive/void sync runs restore.
  if (maybePromise === null || typeof maybePromise !== "object") {
    restoreAmbient();
  }
  return result;
};

AsyncLocalStorage.prototype.exit = function exit(fn: (...args: any[]) => any, ...args: any[]) {
  const frame = captureFrame();
  frame.delete(this);
  const prevAmbient = ambientStores.get(this);
  ambientStores.delete(this);
  const result = runScoped(frame, () => fn(...args));
  const maybePromise = result as unknown;
  if (maybePromise != null && typeof (maybePromise as PromiseLike<unknown>).then === "function") {
    return NativePromise.resolve(maybePromise as PromiseLike<unknown>).finally(() => {
      if (prevAmbient !== undefined) ambientStores.set(this, prevAmbient);
    }) as typeof result;
  }
  if (prevAmbient !== undefined) ambientStores.set(this, prevAmbient);
  return result;
};

AsyncLocalStorage.prototype.enterWith = function enterWith(store: any): void {
  currentFrame.set(this, store);
  ambientStores.set(this, store);
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

installAsyncContext();

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
