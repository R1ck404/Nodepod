// Console class matching Node.js constructor (accepts stdout/stderr streams)

import { inspect } from "./util.js";

/* ------------------------------------------------------------------ */
/*  Console class                                                      */
/* ------------------------------------------------------------------ */

export interface Console {
  _out: { write: (s: string) => void } | null;
  _err: { write: (s: string) => void } | null;
  _emit(target: "out" | "err", args: unknown[]): void;
  log(...a: unknown[]): void;
  error(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  info(...a: unknown[]): void;
  debug(...a: unknown[]): void;
  trace(...a: unknown[]): void;
  dir(o: unknown): void;
  time(): void;
  timeEnd(): void;
  timeLog(): void;
  assert(v: unknown, ...a: unknown[]): void;
  clear(): void;
  count(): void;
  countReset(): void;
  group(): void;
  groupCollapsed(): void;
  groupEnd(): void;
  table(d: unknown): void;
}

interface ConsoleConstructor {
  new (stdout?: unknown, stderr?: unknown): Console;
  (this: any, stdout?: unknown, stderr?: unknown): void;
  prototype: any;
}

export const Console = function Console(this: any, stdout?: unknown, stderr?: unknown) {
  if (!this) return;
  const o = stdout as Record<string, unknown> | undefined;
  if (o && typeof o === "object" && "write" in o) {
    // new Console(stream) or new Console(stdout, stderr)
    this._out = o as unknown as { write: (s: string) => void };
    this._err =
      (stderr as { write: (s: string) => void }) || this._out;
  } else if (o && typeof o === "object" && "stdout" in o) {
    // new Console({ stdout, stderr })
    this._out = (o.stdout as { write: (s: string) => void }) || null;
    this._err = (o.stderr as { write: (s: string) => void }) || this._out;
  } else {
    this._out = null;
    this._err = null;
  }
} as unknown as ConsoleConstructor;

Console.prototype._emit = function _emit(this: any, target: "out" | "err", args: unknown[]) {
  const text =
    args
      .map((a: unknown) => {
        if (typeof a === "string") return a;
        try {
          return inspect(a);
        } catch {
          return String(a);
        }
      })
      .join(" ") + "\n";
  const dest = target === "err" ? this._err : this._out;
  if (dest) dest.write(text);
  else if (target === "err") globalThis.console.error(...args);
  else globalThis.console.log(...args);
};

Console.prototype.log = function log(this: any, ...a: unknown[]) { this._emit("out", a); };
Console.prototype.error = function error(this: any, ...a: unknown[]) { this._emit("err", a); };
Console.prototype.warn = function warn(this: any, ...a: unknown[]) { this._emit("err", a); };
Console.prototype.info = function info(this: any, ...a: unknown[]) { this._emit("out", a); };
Console.prototype.debug = function debug(this: any, ...a: unknown[]) { this._emit("out", a); };
Console.prototype.trace = function trace(this: any, ...a: unknown[]) { this._emit("err", a); };
Console.prototype.dir = function dir(this: any, o: unknown) { this._emit("out", [o]); };
Console.prototype.time = function time() {};
Console.prototype.timeEnd = function timeEnd() {};
Console.prototype.timeLog = function timeLog() {};
Console.prototype.assert = function assert(this: any, v: unknown, ...a: unknown[]) {
  if (!v) this._emit("err", ["Assertion failed:", ...a]);
};
Console.prototype.clear = function clear() {};
Console.prototype.count = function count() {};
Console.prototype.countReset = function countReset() {};
Console.prototype.group = function group() {};
Console.prototype.groupCollapsed = function groupCollapsed() {};
Console.prototype.groupEnd = function groupEnd() {};
Console.prototype.table = function table(this: any, d: unknown) { this._emit("out", [d]); };

/* ------------------------------------------------------------------ */
/*  Named re-exports from global console                               */
/* ------------------------------------------------------------------ */

const _gc = globalThis.console;

export const log = _gc.log.bind(_gc);
export const error = _gc.error.bind(_gc);
export const warn = _gc.warn.bind(_gc);
export const info = _gc.info.bind(_gc);
export const debug = _gc.debug.bind(_gc);
export const trace = _gc.trace.bind(_gc);
export const dir = _gc.dir.bind(_gc);
export const time = _gc.time.bind(_gc);
export const timeEnd = _gc.timeEnd.bind(_gc);
export const timeLog = _gc.timeLog.bind(_gc);
export const clear = _gc.clear.bind(_gc);
export const count = _gc.count.bind(_gc);
export const countReset = _gc.countReset.bind(_gc);
export const group = _gc.group.bind(_gc);
export const groupCollapsed = _gc.groupCollapsed.bind(_gc);
export const groupEnd = _gc.groupEnd.bind(_gc);
export const table = _gc.table.bind(_gc);

/* ------------------------------------------------------------------ */
/*  Default export                                                     */
/* ------------------------------------------------------------------ */

export default {
  Console,
  log,
  error,
  warn,
  info,
  debug,
  trace,
  dir,
  time,
  timeEnd,
  timeLog,
  assert: _gc.assert.bind(_gc),
  clear,
  count,
  countReset,
  group,
  groupCollapsed,
  groupEnd,
  table,
};
