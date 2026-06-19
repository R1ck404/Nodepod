// timer polyfills with Handle tracking. every setTimeout/setInterval/
// setImmediate registers a typed Handle in the active HandleRegistry so the
// event loop knows about it. handles auto-close when a one-shot fires or
// the timer is cleared. script-engine's globalThis patch routes through
// here too, so `node:timers` and bare setTimeout share the same path.

import {
  getRegistry,
  isExitSentinel,
  type Handle,
  type HandleType,
} from "../helpers/event-loop";

// keep references to the raw browser timer functions. captured at import
// so later patches of globalThis.setTimeout don't recurse through us.
const _rawSetTimeout = globalThis.setTimeout.bind(globalThis);
const _rawSetInterval = globalThis.setInterval.bind(globalThis);
const _rawClearTimeout = globalThis.clearTimeout.bind(globalThis);
const _rawClearInterval = globalThis.clearInterval.bind(globalThis);

// tracked timers so process teardown can cancel the underlying browser ids.
// closeAll() only drops registry handles; without this, intervals keep firing
// in persistent shell workers after Ctrl+C.
const _activeTimers = new Set<TimeoutLike>();

function trackTimer(timer: TimeoutLike): void {
  _activeTimers.add(timer);
}

function untrackTimer(timer: TimeoutLike): void {
  _activeTimers.delete(timer);
}

/** Cancel every tracked timer. Called from child_process cleanup on exit/abort. */
export function disposeAllTimers(): void {
  for (const timer of Array.from(_activeTimers)) {
    if (timer._isInterval) {
      _rawClearInterval(timer._id);
    } else {
      const id = timer._id as unknown;
      if (id && typeof id === "object" && "cleared" in (id as object)) {
        (id as ImmediateEntry).cleared = true;
      } else {
        _rawClearTimeout(timer._id);
      }
    }
    timer._handle.close();
    timer._fired = true;
  }
  _activeTimers.clear();
}

// node's TIMEOUT_MAX = 2^31 - 1. anything outside [1, TIMEOUT_MAX] (NaN,
// negative, non-finite, non-numeric) is coerced to 1. matches
// lib/internal/timers.js#getTimerDuration in node source.
const TIMEOUT_MAX = 2147483647;

function normalizeDelay(ms: unknown): number {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > TIMEOUT_MAX) return 1;
  return n;
}

export interface TimeoutLike {
  _id: ReturnType<typeof _rawSetTimeout>;
  _handle: Handle;
  _isInterval: boolean;
  _fired: boolean;
  ref(): TimeoutLike;
  unref(): TimeoutLike;
  hasRef(): boolean;
  refresh(): TimeoutLike;
  [Symbol.toPrimitive](): number;
}

function makeTimeout(
  kind: HandleType,
  callback: (...args: unknown[]) => void,
  msRaw: number,
  args: unknown[],
  isInterval: boolean,
): TimeoutLike {
  const ms = normalizeDelay(msRaw);
  const handle = getRegistry().register(kind);
  const self = {} as TimeoutLike;
  self._isInterval = isInterval;
  self._fired = false;
  self._handle = handle;

  const fire = () => {
    if (!isInterval) {
      self._fired = true;
      handle.close();
      untrackTimer(self);
    }
    try {
      // widen the declared void return so we can duck-type async callbacks.
      // setTimeout(async () => {...}) returns a Promise and plenty of user
      // code depends on that even though node's types say void.
      const r: unknown = callback(...args);
      // if the callback is async, a process.exit() inside it becomes a
      // Promise rejection, not a sync throw, so the try/catch below can't
      // see it. filter the sentinel out of the rejection path to match
      // node (process.exit inside a timer doesn't surface as an unhandled
      // rejection). other rejections propagate normally.
      if (r && typeof (r as { then?: unknown }).then === "function") {
        (r as Promise<unknown>).then(undefined, (e: unknown) => {
          if (isExitSentinel(e)) return;
          // re-raise on the next microtask so it reaches the global
          // unhandledrejection handler, same as node.
          queueMicrotask(() => { throw e as Error; });
        });
      }
    } catch (e) {
      if (isExitSentinel(e)) return;
      throw e;
    }
  };

  self._id = isInterval
    ? _rawSetInterval(fire, ms)
    : _rawSetTimeout(fire, ms);
  trackTimer(self);

  self.ref = () => {
    if (!self._fired) handle.ref();
    return self;
  };
  self.unref = () => {
    handle.unref();
    return self;
  };
  self.hasRef = () => handle.refed;

  // Timeout.refresh() re-arms the timer with its original delay, cancelling
  // any pending fire. undici, ws heartbeats, node-fetch, socket.io and many
  // others rely on this; a no-op here breaks those libraries silently.
  self.refresh = () => {
    if (handle.closed) return self;
    if (isInterval) {
      _rawClearInterval(self._id);
      self._id = _rawSetInterval(fire, ms);
    } else {
      _rawClearTimeout(self._id);
      // refresh resurrects a one-shot Timeout: if it already fired we need
      // to re-register the handle so the loop counts it again.
      if (self._fired) {
        self._fired = false;
        handle.ref();
      }
      self._id = _rawSetTimeout(fire, ms);
    }
    return self;
  };

  self[Symbol.toPrimitive] = () => self._id as unknown as number;

  return self;
}

// setImmediate approximation of node's check phase. node runs setImmediate
// callbacks after I/O + microtasks and before the next timer tick, in
// scheduling order. we approximate this by queueing into an array and
// draining via a single MessageChannel message per flush cycle (the
// closest browser analogue to the check phase). callbacks enqueued during
// a flush run in the next cycle, not the current one, which preserves the
// scheduling order without collapsing into setTimeout(0).

interface ImmediateEntry {
  handle: Handle;
  cb: (...args: unknown[]) => void;
  args: unknown[];
  cleared: boolean;
}

const _immediateQueue: ImmediateEntry[] = [];
let _immediateScheduled = false;

// MessageChannel is the "check" trampoline. falls back to queueMicrotask
// in environments without it (sandboxed workers without structured-clone).
// both run after the current microtask queue drains, which is what matters
// for nextTick/Promise ordering.
let _scheduleCheck: () => void;
if (typeof MessageChannel !== "undefined") {
  const _mc = new MessageChannel();
  _mc.port1.onmessage = () => _flushImmediates();
  _scheduleCheck = () => _mc.port2.postMessage(0);
} else {
  _scheduleCheck = () => queueMicrotask(_flushImmediates);
}

function _flushImmediates(): void {
  _immediateScheduled = false;
  // snapshot: entries added during flush run in the next cycle
  const batch = _immediateQueue.splice(0);
  for (const entry of batch) {
    if (entry.cleared) continue;
    entry.handle.close();
    try {
      const r: unknown = entry.cb(...entry.args);
      if (r && typeof (r as { then?: unknown }).then === "function") {
        (r as Promise<unknown>).then(undefined, (e: unknown) => {
          if (isExitSentinel(e)) return;
          queueMicrotask(() => { throw e as Error; });
        });
      }
    } catch (e) {
      if (isExitSentinel(e)) continue;
      // surface other throws as unhandled errors like node does
      queueMicrotask(() => { throw e as Error; });
    }
  }
  if (_immediateQueue.length > 0 && !_immediateScheduled) {
    _immediateScheduled = true;
    _scheduleCheck();
  }
}

function makeImmediate(
  cb: (...args: unknown[]) => void,
  args: unknown[],
): TimeoutLike {
  const handle = getRegistry().register("Immediate");
  const entry: ImmediateEntry = { handle, cb, args, cleared: false };
  const self = {} as TimeoutLike;
  self._isInterval = false;
  self._fired = false;
  self._handle = handle;
  // no raw timer id here, stash the entry pointer for clearImmediate
  self._id = entry as unknown as ReturnType<typeof _rawSetTimeout>;
  trackTimer(self);
  self.ref = () => {
    if (!entry.cleared) handle.ref();
    return self;
  };
  self.unref = () => {
    handle.unref();
    return self;
  };
  self.hasRef = () => handle.refed;
  self.refresh = () => self; // setImmediate handles have no meaningful refresh
  self[Symbol.toPrimitive] = () => 0 as number;
  _immediateQueue.push(entry);
  if (!_immediateScheduled) {
    _immediateScheduled = true;
    _scheduleCheck();
  }
  return self;
}

export function setTimeout(
  callback: (...args: unknown[]) => void,
  ms?: number,
  ...args: unknown[]
): TimeoutLike {
  return makeTimeout("Timeout", callback, ms ?? 0, args, false);
}

export function setInterval(
  callback: (...args: unknown[]) => void,
  ms?: number,
  ...args: unknown[]
): TimeoutLike {
  return makeTimeout("Interval", callback, ms ?? 0, args, true);
}

export function setImmediate(
  callback: (...args: unknown[]) => void,
  ...args: unknown[]
): TimeoutLike {
  return makeImmediate(callback, args);
}

export function clearTimeout(t: unknown): void {
  if (t && typeof t === "object" && "_id" in t && "_handle" in t) {
    const timer = t as TimeoutLike;
    untrackTimer(timer);
    // setImmediate handles use the ImmediateEntry as _id; detect and mark
    const id = timer._id as unknown;
    if (id && typeof id === "object" && "cleared" in (id as object)) {
      (id as ImmediateEntry).cleared = true;
    } else {
      _rawClearTimeout(timer._id);
    }
    timer._handle.close();
    return;
  }
  // plain numeric id passthrough (legacy code paths)
  _rawClearTimeout(t as number);
}

export function clearInterval(t: unknown): void {
  if (t && typeof t === "object" && "_id" in t && "_handle" in t) {
    const timer = t as TimeoutLike;
    untrackTimer(timer);
    _rawClearInterval(timer._id);
    timer._handle.close();
    return;
  }
  _rawClearInterval(t as number);
}

export function clearImmediate(t: unknown): void {
  // clearTimeout handles the ImmediateEntry path. kept as a separate export
  // for consumers that pattern-match on the name.
  clearTimeout(t);
}

// timers/promises API. each awaited call owns a Handle for the life of the
// Promise. aborted promises release via the abort path.
export const promises = {
  setTimeout: (ms: number, value?: unknown, opts?: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const handle = getRegistry().register("Timeout");
      const id = _rawSetTimeout(() => {
        handle.close();
        resolve(value);
      }, normalizeDelay(ms));
      if (opts?.signal) {
        if (opts.signal.aborted) {
          _rawClearTimeout(id);
          handle.close();
          reject(new DOMException("The operation was aborted", "AbortError"));
          return;
        }
        opts.signal.addEventListener(
          "abort",
          () => {
            _rawClearTimeout(id);
            handle.close();
            reject(new DOMException("The operation was aborted", "AbortError"));
          },
          { once: true },
        );
      }
    }),

  setInterval: setInterval,

  // routes through the real check-phase queue so ordering matches setImmediate
  setImmediate: (value?: unknown, opts?: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      if (opts?.signal?.aborted) {
        reject(new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      const im = makeImmediate(() => resolve(value), []);
      if (opts?.signal) {
        opts.signal.addEventListener(
          "abort",
          () => {
            clearImmediate(im);
            reject(new DOMException("The operation was aborted", "AbortError"));
          },
          { once: true },
        );
      }
    }),

  scheduler: {
    wait: (ms: number) =>
      new Promise((resolve) => {
        const handle = getRegistry().register("Timeout");
        _rawSetTimeout(() => {
          handle.close();
          resolve(undefined);
        }, normalizeDelay(ms));
      }),
  },
};

export default {
  setTimeout,
  setInterval,
  setImmediate,
  clearTimeout,
  clearInterval,
  clearImmediate,
  promises,
};
