// Utility helpers: format, inspect, inherits, promisify, deprecate, type checks, etc.

import { Buffer } from "./buffer";

export function format(template?: unknown, ...values: unknown[]): string {
  // console.log() prints an empty line; format(undefined) is "undefined"
  if (arguments.length === 0) return "";
  if (typeof template !== "string") {
    // non-string first arg: inspect all args
    return [template, ...values].map((v) => typeof v === "string" ? v : inspect(v)).join(" ");
  }

  let idx = 0;
  let result = template.replace(/%[sdjifoO%]/g, (token) => {
    if (token === "%%") return "%";
    if (idx >= values.length) return token;

    const val = values[idx++];
    switch (token) {
      case "%s":
        return String(val);
      case "%d":
      case "%i":
        return String(parseInt(String(val), 10));
      case "%f":
        return String(parseFloat(String(val)));
      case "%j":
        try {
          return JSON.stringify(val);
        } catch {
          return "[Circular]";
        }
      case "%o":
      case "%O":
        return inspect(val);
      default:
        return token;
    }
  });

  // append extra args beyond what format specifiers consumed (matches Node.js)
  while (idx < values.length) {
    const v = values[idx++];
    result += " " + (typeof v === "string" ? v : inspect(v));
  }

  return result;
}

export function inspect(
  target: unknown,
  opts?: { depth?: number; colors?: boolean },
): string {
  const visited = new WeakSet();
  const maxDepth = opts?.depth ?? 2;

  function render(val: unknown, level: number): string {
    if (val === null) return "null";
    if (val === undefined) return "undefined";

    const kind = typeof val;
    if (kind === "string") return `'${val}'`;
    if (kind === "number" || kind === "boolean") return String(val);
    if (kind === "bigint") return `${val as bigint}n`;
    if (kind === "symbol") return (val as symbol).toString();
    if (kind === "function") {
      const fname = (val as Function).name || "anonymous";
      return `[Function: ${fname}]`;
    }
    if (kind !== "object") return String(val);

    if (visited.has(val as object)) return "[Circular]";
    visited.add(val as object);

    if (level > maxDepth) {
      return Array.isArray(val) ? "[Array]" : "[Object]";
    }

    if (Array.isArray(val)) {
      if (val.length === 0) return "[]";
      const items = val.map((item) => render(item, level + 1));
      return `[ ${items.join(", ")} ]`;
    }

    if (val instanceof Date) return val.toISOString();
    if (val instanceof RegExp) return val.toString();
    if (val instanceof Error) return `${val.name}: ${val.message}`;

    if (val instanceof Map) {
      const pairs = [...val.entries()].map(
        ([k, v]) => `${render(k, level + 1)} => ${render(v, level + 1)}`,
      );
      return `Map(${val.size}) { ${pairs.join(", ")} }`;
    }

    if (val instanceof Set) {
      const items = [...val].map((v) => render(v, level + 1));
      return `Set(${val.size}) { ${items.join(", ")} }`;
    }

    const keys = Object.keys(val as object);
    if (keys.length === 0) return "{}";
    const fields = keys.map((k) => {
      const v = (val as Record<string, unknown>)[k];
      return `${k}: ${render(v, level + 1)}`;
    });
    return `{ ${fields.join(", ")} }`;
  }

  return render(target, 0);
}

export function inherits(child: Function, parent: Function): void {
  if (child === undefined || child === null) {
    throw new TypeError("inherits: child constructor must be provided");
  }
  if (parent === undefined || parent === null) return;
  if (parent.prototype === undefined) return;
  (child as any).super_ = parent;
  Object.setPrototypeOf(child.prototype, parent.prototype);
}

// deprecated, equivalent to Object.assign
export function _extend(target: any, source: any): any {
  if (source == null) return target;
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    target[keys[i]] = source[keys[i]];
  }
  return target;
}

export function deprecate<T extends Function>(
  fn: T,
  message: string,
  code?: string,
): T {
  let alerted = false;
  const wrapper = function (this: unknown, ...args: unknown[]) {
    if (!alerted) {
      console.warn(`DeprecationWarning: ${message}${code ? ` (${code})` : ""}`);
      alerted = true;
    }
    return fn.apply(this, args);
  };
  return wrapper as unknown as T;
}

export function promisify<T>(
  fn: (...args: any[]) => void,
): (...args: any[]) => Promise<T> {
  return (...args: any[]) =>
    new Promise((ok, fail) => {
      fn(...args, (err: Error | null, result: T) => {
        if (err) fail(err);
        else ok(result);
      });
    });
}

export function callbackify<T>(
  fn: (...args: any[]) => Promise<T>,
): (...args: any[]) => void {
  return (...args: any[]) => {
    const cb = args.pop() as (err: Error | null, result: T) => void;
    fn(...args)
      .then((result) => cb(null, result))
      .catch((err) => cb(err, undefined as unknown as T));
  };
}

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  return deepStrictEqualInner(a, b, new WeakMap());
}

function deepStrictEqualInner(
  a: unknown,
  b: unknown,
  seen: WeakMap<object, WeakSet<object>>,
): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a !== "object" || typeof b !== "object") {
    return false;
  }

  const objA = a as object;
  const objB = b as object;

  const seenB = seen.get(objA);
  if (seenB?.has(objB)) return true;
  if (!seenB) seen.set(objA, new WeakSet([objB]));
  else seenB.add(objB);

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }
  if (a instanceof Error && b instanceof Error) {
    return (
      a.name === b.name &&
      a.message === b.message &&
      deepStrictEqualInner(a.cause, b.cause, seen)
    );
  }

  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (a.constructor !== b.constructor) return false;
    const bytesA = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const bytesB = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (bytesA.length !== bytesB.length) return false;
    for (let i = 0; i < bytesA.length; i++) {
      if (bytesA[i] !== bytesB[i]) return false;
    }
    return true;
  }

  if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
    if (a.byteLength !== b.byteLength) return false;
    const bytesA = new Uint8Array(a);
    const bytesB = new Uint8Array(b);
    for (let i = 0; i < bytesA.length; i++) {
      if (bytesA[i] !== bytesB[i]) return false;
    }
    return true;
  }

  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, val] of a) {
      if (!b.has(key)) return false;
      if (!deepStrictEqualInner(val, b.get(key), seen)) return false;
    }
    return true;
  }

  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const item of a) {
      let found = false;
      for (const other of b) {
        if (deepStrictEqualInner(item, other, seen)) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepStrictEqualInner(a[i], b[i], seen)) return false;
    }
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const protoA = Object.getPrototypeOf(a);
  const protoB = Object.getPrototypeOf(b);
  if (protoA !== protoB) return false;

  const keysA = Reflect.ownKeys(objA);
  const keysB = Reflect.ownKeys(objB);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false;
    if (
      !deepStrictEqualInner(
        (objA as Record<PropertyKey, unknown>)[key],
        (objB as Record<PropertyKey, unknown>)[key],
        seen,
      )
    ) {
      return false;
    }
  }
  return true;
}

export function isArray(val: unknown): val is unknown[] {
  return Array.isArray(val);
}
export function isBoolean(val: unknown): val is boolean {
  return typeof val === "boolean";
}
export function isNull(val: unknown): val is null {
  return val === null;
}
export function isNullOrUndefined(val: unknown): val is null | undefined {
  return val == null;
}
export function isNumber(val: unknown): val is number {
  return typeof val === "number";
}
export function isString(val: unknown): val is string {
  return typeof val === "string";
}
export function isUndefined(val: unknown): val is undefined {
  return val === undefined;
}
export function isRegExp(val: unknown): val is RegExp {
  return val instanceof RegExp;
}
export function isObject(val: unknown): val is object {
  return typeof val === "object" && val !== null;
}
export function isDate(val: unknown): val is Date {
  return val instanceof Date;
}
export function isError(val: unknown): val is Error {
  return val instanceof Error;
}
export function isFunction(val: unknown): val is Function {
  return typeof val === "function";
}
export function isPrimitive(val: unknown): boolean {
  return val === null || (typeof val !== "object" && typeof val !== "function");
}
export function isBuffer(val: unknown): boolean {
  return Buffer.isBuffer(val);
}
export function isPromise(val: unknown): val is Promise<unknown> {
  return (
    typeof val === "object" &&
    val !== null &&
    typeof (val as Promise<unknown>).then === "function"
  );
}

// returns a logger when NODE_DEBUG includes the given section
export function debuglog(section: string): (...args: unknown[]) => void {
  const envDebug =
    (typeof process !== "undefined" && process.env?.NODE_DEBUG) || "";
  const active = envDebug.toLowerCase().includes(section.toLowerCase());

  if (active) {
    return (...args: unknown[]) => {
      console.error(`${section.toUpperCase()} ${process?.pid || 0}:`, ...args);
    };
  }
  return () => {};
}

export const debug = debuglog;

export function stripVTControlCharacters(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(
    /\x1B\[[0-9;]*[a-zA-Z]|\x1B\].*?(\x07|\x1B\\)|\x1B[()][A-Z0-9]|\x1B[#=]|\x1B./g,
    "",
  );
}

function isTypedArray(val: unknown): val is ArrayBufferView {
  return ArrayBuffer.isView(val) && !(val instanceof DataView);
}

function isUint8Array(val: unknown): val is Uint8Array {
  return val instanceof Uint8Array;
}

function isArrayBuffer(val: unknown): val is ArrayBuffer {
  return val instanceof ArrayBuffer;
}

function isDataView(val: unknown): val is DataView {
  return val instanceof DataView;
}

function isAnyArrayBuffer(val: unknown): boolean {
  return (
    val instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && val instanceof SharedArrayBuffer)
  );
}

function isMap(val: unknown): val is Map<unknown, unknown> {
  return val instanceof Map;
}

function isSet(val: unknown): val is Set<unknown> {
  return val instanceof Set;
}

function isBooleanObject(val: unknown): boolean {
  return (
    typeof val === "object" &&
    val !== null &&
    Object.prototype.toString.call(val) === "[object Boolean]"
  );
}

function isNumberObject(val: unknown): boolean {
  return (
    typeof val === "object" &&
    val !== null &&
    Object.prototype.toString.call(val) === "[object Number]"
  );
}

function isStringObject(val: unknown): boolean {
  return (
    typeof val === "object" &&
    val !== null &&
    Object.prototype.toString.call(val) === "[object String]"
  );
}

function isSymbolObject(val: unknown): boolean {
  return (
    typeof val === "object" &&
    val !== null &&
    Object.prototype.toString.call(val) === "[object Symbol]"
  );
}

function isBoxedPrimitive(val: unknown): boolean {
  return (
    isBooleanObject(val) ||
    isNumberObject(val) ||
    isStringObject(val) ||
    isSymbolObject(val) ||
    (typeof val === "object" &&
      val !== null &&
      Object.prototype.toString.call(val) === "[object BigInt]")
  );
}

function isAsyncFunction(val: unknown): boolean {
  return Object.prototype.toString.call(val) === "[object AsyncFunction]";
}

function isGeneratorFunction(val: unknown): boolean {
  return Object.prototype.toString.call(val) === "[object GeneratorFunction]";
}

function isGeneratorObject(val: unknown): boolean {
  return Object.prototype.toString.call(val) === "[object Generator]";
}

function isNativeError(val: unknown): val is Error {
  return (
    val instanceof Error ||
    (typeof val === "object" &&
      val !== null &&
      Object.prototype.toString.call(val).endsWith("Error]"))
  );
}

function isProxy(val: unknown): boolean {
  try {
    // Best-effort: only detectable via Proxy revocable / no reliable runtime check.
    // Match Node's util.types.isProxy when unavailable by returning false.
    void val;
    return false;
  } catch {
    return false;
  }
}

export const types = {
  isDate,
  isRegExp,
  isNativeError,
  isError: isNativeError,
  isMap,
  isSet,
  isPromise,
  isTypedArray,
  isUint8Array,
  isArrayBuffer,
  isDataView,
  isAnyArrayBuffer,
  isBoxedPrimitive,
  isBooleanObject,
  isNumberObject,
  isStringObject,
  isSymbolObject,
  isAsyncFunction,
  isGeneratorFunction,
  isGeneratorObject,
  isProxy,
  isBuffer,
};

// styleText (Node.js 21.7+)

const ANSI_STYLES: Record<string, [number, number]> = {
  // Modifiers
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],
  hidden: [8, 28],
  strikethrough: [9, 29],
  // Foreground colors
  black: [30, 39],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  white: [37, 39],
  gray: [90, 39],
  grey: [90, 39],
  blackBright: [90, 39],
  redBright: [91, 39],
  greenBright: [92, 39],
  yellowBright: [93, 39],
  blueBright: [94, 39],
  magentaBright: [95, 39],
  cyanBright: [96, 39],
  whiteBright: [97, 39],
  // Background colors
  bgBlack: [40, 49],
  bgRed: [41, 49],
  bgGreen: [42, 49],
  bgYellow: [43, 49],
  bgBlue: [44, 49],
  bgMagenta: [45, 49],
  bgCyan: [46, 49],
  bgWhite: [47, 49],
  bgBlackBright: [100, 49],
  bgRedBright: [101, 49],
  bgGreenBright: [102, 49],
  bgYellowBright: [103, 49],
  bgBlueBright: [104, 49],
  bgMagentaBright: [105, 49],
  bgCyanBright: [106, 49],
  bgWhiteBright: [107, 49],
};

export function styleText(format: string | string[], text: string): string {
  const formats = Array.isArray(format) ? format : [format];
  let result = text;
  for (const f of formats) {
    const style = ANSI_STYLES[f];
    if (style) {
      result = `\x1b[${style[0]}m${result}\x1b[${style[1]}m`;
    }
  }
  return result;
}

// parseArgs (Node.js 18.3+)

interface ParseArgsOptionConfig {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  default?: string | boolean | string[] | boolean[];
}

interface ParseArgsConfig {
  args?: string[];
  options?: Record<string, ParseArgsOptionConfig>;
  strict?: boolean;
  allowPositionals?: boolean;
  tokens?: boolean;
}

interface ParseArgsResult {
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  positionals: string[];
  tokens?: Array<{
    kind: string;
    name?: string;
    value?: string | boolean;
    index: number;
  }>;
}

export function parseArgs(config?: ParseArgsConfig): ParseArgsResult {
  const args =
    config?.args ??
    (typeof process !== "undefined" ? process.argv.slice(2) : []);
  const optDefs = config?.options ?? {};
  const allowPositionals = config?.allowPositionals ?? !config?.options;
  const strict = config?.strict ?? true;
  const wantTokens = config?.tokens ?? false;

  // Build short → long name map
  const shortMap: Record<string, string> = {};
  for (const [name, def] of Object.entries(optDefs)) {
    if (def.short) shortMap[def.short] = name;
  }

  const values: Record<
    string,
    string | boolean | (string | boolean)[] | undefined
  > = {};
  const positionals: string[] = [];
  const tokens: Array<{
    kind: string;
    name?: string;
    value?: string | boolean;
    index: number;
  }> = [];

  // Initialize defaults
  for (const [name, def] of Object.entries(optDefs)) {
    if (def.default !== undefined) {
      values[name] = def.default;
    }
  }

  let i = 0;
  let afterDash = false;
  while (i < args.length) {
    const arg = args[i];

    if (afterDash || !arg.startsWith("-") || arg === "-") {
      if (!allowPositionals && strict && !afterDash) {
        throw new Error(`Unexpected argument '${arg}'`);
      }
      positionals.push(arg);
      if (wantTokens) tokens.push({ kind: "positional", value: arg, index: i });
      i++;
      continue;
    }

    if (arg === "--") {
      afterDash = true;
      if (wantTokens) tokens.push({ kind: "option-terminator", index: i });
      i++;
      continue;
    }

    // --long or --long=value
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      const rawName = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);
      const def = optDefs[rawName];

      if (!def && strict) {
        throw new Error(`Unknown option '--${rawName}'`);
      }

      const type = def?.type ?? "boolean";
      let val: string | boolean;

      if (type === "boolean") {
        val = eqIdx !== -1 ? arg.slice(eqIdx + 1) !== "false" : true;
      } else {
        if (eqIdx !== -1) {
          val = arg.slice(eqIdx + 1);
        } else if (i + 1 < args.length) {
          val = args[++i];
        } else {
          throw new Error(`Option '--${rawName}' requires a value`);
        }
      }

      if (def?.multiple) {
        const arr = (values[rawName] as (string | boolean)[] | undefined) ?? [];
        arr.push(val);
        values[rawName] = arr;
      } else {
        values[rawName] = val;
      }

      if (wantTokens)
        tokens.push({ kind: "option", name: rawName, value: val, index: i });
      i++;
      continue;
    }

    // -s (short options)
    if (arg.startsWith("-") && arg.length > 1) {
      // Handle combined short flags: -abc → -a -b -c
      const chars = arg.slice(1);
      for (let c = 0; c < chars.length; c++) {
        const ch = chars[c];
        const longName = shortMap[ch];

        if (!longName && strict) {
          throw new Error(`Unknown option '-${ch}'`);
        }

        const name = longName ?? ch;
        const def = longName ? optDefs[longName] : undefined;
        const type = def?.type ?? "boolean";

        let val: string | boolean;
        if (type === "boolean") {
          val = true;
        } else {
          // Rest of chars is the value, or next arg
          const rest = chars.slice(c + 1);
          if (rest.length > 0) {
            val = rest;
            c = chars.length; // break inner loop
          } else if (i + 1 < args.length) {
            val = args[++i];
          } else {
            throw new Error(`Option '-${ch}' requires a value`);
          }
        }

        if (def?.multiple) {
          const arr = (values[name] as (string | boolean)[] | undefined) ?? [];
          arr.push(val);
          values[name] = arr;
        } else {
          values[name] = val;
        }

        if (wantTokens)
          tokens.push({ kind: "option", name, value: val, index: i });
      }
      i++;
      continue;
    }

    i++;
  }

  const result: ParseArgsResult = { values, positionals };
  if (wantTokens) result.tokens = tokens;
  return result;
}

export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;

export default {
  format,
  inspect,
  inherits,
  _extend,
  deprecate,
  promisify,
  callbackify,
  isDeepStrictEqual,
  debuglog,
  debug,
  stripVTControlCharacters,
  isArray,
  isBoolean,
  isNull,
  isNullOrUndefined,
  isNumber,
  isString,
  isUndefined,
  isRegExp,
  isObject,
  isDate,
  isError,
  isFunction,
  isPrimitive,
  isBuffer,
  isPromise,
  styleText,
  parseArgs,
  types,
  TextEncoder,
  TextDecoder,
};
