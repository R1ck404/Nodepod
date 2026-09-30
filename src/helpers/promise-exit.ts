import { isExitSentinel } from "./event-loop";
import { getActiveContext, type ProcessContext } from "../threading/process-context";

// An explicit exit has already notified the process runner. Its unwind must
// not become an application rejection (or run catch/finally after termination).
// Keep that reaction pending; the runner wakes through its separate exit signal.
let intrinsic: PromiseConstructor | undefined;
const exitCleanups = new WeakMap<ProcessContext, Set<() => void>>();
const unownedCleanups = new Set<() => void>();

// Runtime cleanup must still run when exit prevents application reactions.
// Keep scopes separate between inline processes sharing the same realm.
export function registerExitCleanup(cleanup: () => void): () => void {
  const context = getActiveContext();
  let callbacks = context ? exitCleanups.get(context) : unownedCleanups;
  if (!callbacks) {
    callbacks = new Set();
    exitCleanups.set(context!, callbacks);
  }
  callbacks.add(cleanup);
  return () => {
    callbacks.delete(cleanup);
    if (context && callbacks.size === 0) exitCleanups.delete(context);
  };
}

function finishExitScopes(): void {
  const context = getActiveContext();
  const callbacks = context ? exitCleanups.get(context) : unownedCleanups;
  if (!callbacks?.size) return;
  // Restore nested scopes from the inside out.
  const pending = Array.from(callbacks);
  callbacks.clear();
  if (context) exitCleanups.delete(context);
  for (let i = pending.length - 1; i >= 0; i--) pending[i]();
}

function stopReaction(): Promise<never> {
  finishExitScopes();
  // Do not share a rooted pending promise: adoption would retain every exited
  // command's continuations for the lifetime of a persistent shell worker.
  return new intrinsic!<never>(() => {});
}

function runExitCallback<T>(this: (value: any) => T, value: any): T | Promise<never> {
  const callback = this;
  try {
    return callback(value);
  } catch (error) {
    if (isExitSentinel(error)) return stopReaction();
    throw error;
  }
}

export function guardExitCallback<T>(callback: (value: any) => T): (value: any) => T | Promise<never> {
  // Binding a shared handler avoids a closure environment for every reaction.
  return runExitCallback.bind(callback) as (value: any) => T | Promise<never>;
}

function runExitRejection<T>(this: (reason: any) => T, reason: any): T | Promise<never> {
  if (isExitSentinel(reason)) return stopReaction();
  return runExitCallback.call(this, reason) as T | Promise<never>;
}

export function guardExitRejection<T>(
  callback?: ((reason: any) => T) | null,
): (reason: any) => T | Promise<never> {
  if (typeof callback !== "function") return forwardRejection;
  return runExitRejection.bind(callback) as (reason: any) => T | Promise<never>;
}

function forwardRejection(reason: any): Promise<never> {
  if (isExitSentinel(reason)) return stopReaction();
  throw reason;
}

export function installPromiseExitGuard(PromiseCtor: PromiseConstructor): void {
  if (intrinsic) return;
  intrinsic = PromiseCtor;
  const then = PromiseCtor.prototype.then;
  // Async functions and host APIs return intrinsic promises, even when a
  // module's Promise binding is our synchronous subclass. Cover those too.
  PromiseCtor.prototype.then = function (this: Promise<unknown>, onFulfilled: any, onRejected: any) {
    return then.call(this,
      typeof onFulfilled === "function" ? guardExitCallback(onFulfilled) : onFulfilled,
      guardExitRejection(onRejected));
  } as typeof then;
}
