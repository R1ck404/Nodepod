// Module polyfill (builtinModules, createRequire, Module class)

export const builtinModules: string[] = [
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "child_process/promises",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "inspector/promises",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "quic",
  "readline",
  "readline/promises",
  "repl",
  "sea",
  "sqlite",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "test",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
];

// every require() asks: a Set instead of scanning the list, rebuilt if a
// caller adds to or removes from the (exported, mutable) array
let builtinSet: Set<string> | null = null;
let builtinSetSize = -1;
function builtinLookup(): Set<string> {
  if (!builtinSet || builtinSetSize !== builtinModules.length) {
    builtinSet = new Set(builtinModules);
    builtinSetSize = builtinModules.length;
  }
  return builtinSet;
}

export function isBuiltin(id: string): boolean {
  const stripped = id.startsWith("node:") ? id.slice(5) : id;
  const c = stripped.charCodeAt(0);
  // relative and absolute paths are never builtins
  if (c === 46 /* . */ || c === 47 /* / */) return false;
  const set = builtinLookup();
  // Subpaths are builtins only when listed explicitly. In particular,
  // punycode/ names the npm package, not the punycode builtin.
  return set.has(stripped);
}

export function createRequire(origin: string): (specifier: string) => unknown {
  return function requireFrom(specifier: string): unknown {
    throw new Error(`Cannot resolve module '${specifier}' from '${origin}'`);
  };
}

export const _cache: Record<string, unknown> = {};

export const _extensions: Record<string, unknown> = {
  ".js": () => {},
  ".json": () => {},
  ".node": () => {},
};

export const _pathCache: Record<string, string> = {};

export function _resolveFilename(
  request: string,
  _parent?: unknown,
  _isMain?: boolean,
  _options?: unknown,
): string {
  return request;
}

export function _nodeModulePaths(from: string): string[] {
  const parts = from.split("/").filter(Boolean);
  const paths: string[] = [];
  for (let i = parts.length; i > 0; i--) {
    const dir = "/" + parts.slice(0, i).join("/");
    if (parts[i - 1] !== "node_modules") {
      paths.push(dir + "/node_modules");
    }
  }
  paths.push("/node_modules");
  return paths;
}

export function _load(
  request: string,
  _parent?: unknown,
  _isMain?: boolean,
): unknown {
  // wired up by ScriptEngine.buildResolver at runtime
  throw new Error(`Cannot load module '${request}'`);
}

export function _findPath(
  request: string,
  _paths?: string[],
  _isMain?: boolean,
): string | false {
  return request;
}

export function wrap(script: string): string {
  return (
    "(function (exports, require, module, __filename, __dirname) { " +
    script +
    "\n});"
  );
}

export const wrapper = [
  "(function (exports, require, module, __filename, __dirname) { ",
  "\n});",
];

export function syncBuiltinESMExports(): void {
}

// Node's module.findSourceMap — we don't track source maps, returning
// undefined is a valid "no source map found" answer (Next.js probes this
// when rendering dev error overlays).
export function findSourceMap(_path: string): undefined {
  return undefined;
}

// Node's module.SourceMap: decodes a Source Map v3 payload (or an index map
// with `sections`) and looks up positions in it. Tools call it on maps they
// build themselves, e.g. @solidjs/vite-plugin maps JSX locations back to the
// authored source with findEntry and checks `"originalLine" in entry`, so a
// miss must be `{}`, as in Node.

interface SourceMapPayload {
  version?: number;
  file?: string;
  sourceRoot?: string;
  sources?: (string | null)[];
  sourcesContent?: (string | null)[];
  names?: string[];
  mappings?: string;
  sections?: { offset?: { line?: number; column?: number }; map?: SourceMapPayload }[];
  [key: string]: unknown;
}

// [generatedLine, generatedColumn] for a segment without a source, or
// [generatedLine, generatedColumn, source, originalLine, originalColumn, name].
type SourceMapMapping =
  | [number, number]
  | [number, number, string | null | undefined, number, number, string | undefined];

export interface SourceMapEntry {
  generatedLine?: number;
  generatedColumn?: number;
  originalSource?: string;
  originalLine?: number;
  originalColumn?: number;
  name?: string;
}

export interface SourceMapOrigin {
  name?: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}

const BASE64_DIGITS = new Map<string, number>(
  [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map(
    (c, i) => [c, i],
  ),
);

function cloneSourceMapPayload(payload: SourceMapPayload): SourceMapPayload {
  const copy: SourceMapPayload = { ...payload };
  for (const key of ["sources", "sourcesContent", "names"] as const) {
    if (Array.isArray(copy[key])) (copy as any)[key] = [...(copy[key] as unknown[])];
  }
  if (Array.isArray(copy.sections)) {
    copy.sections = copy.sections.map((section) => ({
      ...section,
      ...(section?.offset ? { offset: { ...section.offset } } : {}),
      ...(section?.map ? { map: cloneSourceMapPayload(section.map) } : {}),
    }));
  }
  return copy;
}

function compareMappings(a: SourceMapMapping, b: SourceMapMapping): number {
  return a[0] - b[0] || a[1] - b[1];
}

export class SourceMap {
  #payload: SourceMapPayload;
  #lineLengths: number[] | undefined;
  #mappings: SourceMapMapping[] = [];

  constructor(payload: unknown, { lineLengths }: { lineLengths?: number[] } = {}) {
    if (payload === null || typeof payload !== "object") {
      const received =
        payload == null
          ? `Received ${payload}`
          : `Received type ${typeof payload} (${typeof payload === "string" ? `'${payload}'` : String(payload)})`;
      const error = new TypeError(`The "payload" argument must be of type object. ${received}`);
      (error as any).code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    this.#payload = cloneSourceMapPayload(payload as SourceMapPayload);
    if (Array.isArray(this.#payload.sections)) {
      for (const section of this.#payload.sections) {
        if (section?.map) {
          this.#parseMap(section.map, section.offset?.line ?? 0, section.offset?.column ?? 0);
        }
      }
    } else {
      this.#parseMap(this.#payload, 0, 0);
    }
    this.#mappings.sort(compareMappings);
    if (Array.isArray(lineLengths) && lineLengths.length) {
      this.#lineLengths = [...lineLengths];
    }
  }

  get payload(): SourceMapPayload {
    return cloneSourceMapPayload(this.#payload);
  }

  get lineLengths(): number[] | undefined {
    return this.#lineLengths ? [...this.#lineLengths] : undefined;
  }

  // Zero-based: the last mapping at or before (lineOffset, columnOffset), or {}.
  findEntry(lineOffset: number, columnOffset: number): SourceMapEntry {
    const mappings = this.#mappings;
    let first = 0;
    let count = mappings.length;
    while (count > 1) {
      const step = count >> 1;
      const middle = first + step;
      const mapping = mappings[middle];
      if (lineOffset < mapping[0] || (lineOffset === mapping[0] && columnOffset < mapping[1])) {
        count = step;
      } else {
        first = middle;
        count -= step;
      }
    }
    const entry = mappings[first];
    if (!entry || lineOffset < entry[0] || (lineOffset === entry[0] && columnOffset < entry[1])) {
      return {};
    }
    return {
      generatedLine: entry[0],
      generatedColumn: entry[1],
      originalSource: entry[2] as string | undefined,
      originalLine: entry[3],
      originalColumn: entry[4],
      name: entry[5],
    };
  }

  // One-based: the original position of (lineNumber, columnNumber), or {}.
  findOrigin(lineNumber: number, columnNumber: number): SourceMapOrigin {
    const entry = this.findEntry(lineNumber - 1, columnNumber - 1);
    if (entry.originalSource === undefined) return {};
    return {
      name: entry.name,
      fileName: entry.originalSource,
      lineNumber: entry.originalLine! + (lineNumber - entry.generatedLine!),
      columnNumber: entry.originalColumn! + (columnNumber - entry.generatedColumn!),
    };
  }

  #parseMap(map: SourceMapPayload, line: number, column: number): void {
    const sources = Array.isArray(map.sources) ? map.sources : [];
    const names = Array.isArray(map.names) ? map.names : [];
    const mappings = typeof map.mappings === "string" ? map.mappings : "";
    let sourceIndex = 0;
    let originalLine = 0;
    let originalColumn = 0;
    let nameIndex = 0;
    let i = 0;

    const decode = (): number => {
      let result = 0;
      let shift = 0;
      let digit: number;
      do {
        digit = BASE64_DIGITS.get(mappings[i++]) ?? 0;
        result += (digit & 31) * 2 ** shift;
        shift += 5;
      } while (digit & 32);
      return result % 2 ? -Math.floor(result / 2) : result / 2;
    };
    const atSegmentEnd = () =>
      i >= mappings.length || mappings[i] === "," || mappings[i] === ";";

    while (i < mappings.length) {
      if (mappings[i] === ";") {
        line++;
        column = 0;
        i++;
        continue;
      }
      if (mappings[i] === ",") {
        i++;
        continue;
      }
      column += decode();
      if (atSegmentEnd()) {
        this.#mappings.push([line, column]);
        continue;
      }
      sourceIndex += decode();
      originalLine += decode();
      originalColumn += decode();
      let name: string | undefined;
      if (!atSegmentEnd()) {
        nameIndex += decode();
        name = names[nameIndex];
      }
      this.#mappings.push([line, column, sources[sourceIndex], originalLine, originalColumn, name]);
    }
  }
}

export function Module(this: any, id?: string, parent?: any) {
  this.id = id || "";
  this.filename = id || "";
  this.loaded = false;
  this.parent = parent || null;
  this.children = [];
  this.exports = {};
  this.paths = [];
}

// Next.js accesses Module.prototype.require
Module.prototype.require = function (specifier: string): unknown {
  throw new Error(
    `Cannot resolve module '${specifier}' from '${this.filename}'`,
  );
};

Module.prototype.load = function (_filename: string): void {
  this.loaded = true;
};

Module.prototype._compile = function (
  _content: string,
  _filename: string,
): void {
};

Module.createRequire = createRequire;
Module.builtinModules = builtinModules;
Module.isBuiltin = isBuiltin;
Module._cache = _cache;
Module._extensions = _extensions;
Module._pathCache = _pathCache;
Module._resolveFilename = _resolveFilename;
Module._nodeModulePaths = _nodeModulePaths;
Module._load = _load;
Module._findPath = _findPath;
Module.syncBuiltinESMExports = syncBuiltinESMExports;
Module.findSourceMap = findSourceMap;
Module.SourceMap = SourceMap;
Module.wrap = wrap;
Module.wrapper = wrapper;
Module.Module = Module; 
Module.runMain = function () {}; 
Module._preloadModules = function (_requests?: string[]) {}; 
Module._initPaths = function () {}; 
Module.globalPaths = ["/node_modules"];

export default Module;
