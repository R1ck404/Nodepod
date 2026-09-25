// The script engine's synchronous unwrap scope, shared with the polyfills.
//
// A module with top-level await, and everything it imports, is loaded with
// its awaits unwrapped on the spot (the engine's syncAwait): that only works
// for promises that settle synchronously. Polyfill APIs that do their work
// synchronously anyway (fs.promises) return such a promise while a scope is
// open, and an ordinary one otherwise.

let depth = 0;
let SyncPromiseCtor: PromiseConstructor | null = null;

export function inSyncScope<T>(fn: () => T): T {
  depth++;
  try {
    return fn();
  } finally {
    depth--;
  }
}

export function syncScopeDepth(): number {
  return depth;
}

/** The engine's promise whose .then() runs synchronously inside a scope. */
export function setSyncPromiseClass(ctor: PromiseConstructor): void {
  SyncPromiseCtor = ctor;
}

/** A promise for work done synchronously: already settled for syncAwait inside a scope. */
export function settledPromise<T>(
  executor: (resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
): Promise<T> {
  if (depth > 0 && SyncPromiseCtor) return new SyncPromiseCtor<T>(executor);
  return new Promise<T>(executor);
}

export function settledResolve<T = void>(value?: T): Promise<T> {
  return settledPromise<T>((resolve) => resolve(value as T));
}

export function settledReject<T = never>(reason: unknown): Promise<T> {
  return settledPromise<T>((_resolve, reject) => reject(reason));
}
