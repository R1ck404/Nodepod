// Module polyfill (builtinModules, createRequire, Module class)

export const builtinModules: string[] = [
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
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

export function isBuiltin(id: string): boolean {
  const stripped = id.startsWith("node:") ? id.slice(5) : id;
  if (builtinModules.includes(stripped)) return true;
  const slash = stripped.indexOf("/");
  if (slash !== -1) {
    return builtinModules.includes(stripped.slice(0, slash));
  }
  return false;
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

export class SourceMap {
  payload: unknown;
  constructor(payload: unknown) {
    this.payload = payload;
  }
  findEntry(_line: number, _column: number): undefined {
    return undefined;
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
