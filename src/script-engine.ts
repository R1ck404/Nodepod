// ScriptEngine — JS execution engine with require(), module resolution,
// ESM-to-CJS conversion, and Node.js polyfills. Runs in the browser.

import { MemoryVolume } from "./memory-volume";
import type {
  IScriptEngine,
  ExecutionOutcome,
  EngineConfig,
  LoadedModule,
} from "./engine-types";
import type { PackageManifest } from "./types/manifest";
import { quickDigest, contentDigest } from "./helpers/digest";
import { createImportMeta } from "./helpers/import-meta";
import { LRUCache as _LRUCache } from "./memory-handler";
import { bytesToBase64, bytesToHex } from "./helpers/byte-encoding";
import { buildFileSystemBridge, FsBridge } from "./polyfills/fs";
import * as pathPolyfill from "./polyfills/path";
import {
  RESOLVE_EXTENSIONS,
  MAIN_FIELD_EXTENSIONS,
  INDEX_FILES,
  IMPORTS_FIELD_EXTENSIONS,
} from "./constants/config";
import { buildProcessEnv, ProcessObject } from "./polyfills/process";
import * as httpPolyfill from "./polyfills/http";
import {
  installFetchHeadersSetCookieParity,
  installNodeFetchClassParity,
  patchFetchNodeAdapterExports,
} from "./polyfills/fetch-response";

installFetchHeadersSetCookieParity();
installNodeFetchClassParity();
import * as httpsPolyfill from "./polyfills/https";
import * as tcpPolyfill from "./polyfills/net";
import eventBusPolyfill from "./polyfills/events";
import streamPolyfill from "./polyfills/stream";
import * as urlPolyfill from "./polyfills/url";
import * as qsPolyfill from "./polyfills/querystring";
import * as helpersPolyfill from "./polyfills/util";
import * as ttyPolyfill from "./polyfills/tty";
import * as osPolyfill from "./polyfills/os";
import * as hashingPolyfill from "./polyfills/crypto";
import * as compressionPolyfill from "./polyfills/zlib";
import * as dnsPolyfill from "./polyfills/dns";
import bufferPolyfill, { Buffer as NodeBuffer } from "./polyfills/buffer";
// child_process is lazy-loaded to avoid pulling in the shell at import time
let _shellExecPolyfill: any = null;
let _initShellExec: ((vol: any) => void) | null = null;
const shellExecProxy = new Proxy({} as any, {
  get(_target, prop) {
    if (!_shellExecPolyfill) return undefined;
    return _shellExecPolyfill[prop];
  },
  ownKeys() {
    if (!_shellExecPolyfill) return [];
    return Reflect.ownKeys(_shellExecPolyfill);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (!_shellExecPolyfill) return undefined;
    return Object.getOwnPropertyDescriptor(_shellExecPolyfill, prop);
  },
  has(_target, prop) {
    if (!_shellExecPolyfill) return false;
    return prop in _shellExecPolyfill;
  },
});

// Set eagerly so require('child_process') works sync in workers.
// The async .then() in the constructor fires too late for top-level require() calls.
export function setChildProcessPolyfill(mod: any): void {
  _shellExecPolyfill = mod;
  _initShellExec = mod.initShellExec;
}
import { getProxyInstance } from "./request-proxy";
import * as watcherPolyfill from "./polyfills/chokidar";
import * as wsPolyfill from "./polyfills/ws";
import * as macEventsPolyfill from "./polyfills/fsevents";
import * as scannerPolyfill from "./polyfills/readdirp";
import * as moduleSysPolyfill from "./polyfills/module";
import * as perfPolyfill from "./polyfills/perf_hooks";
import * as threadPoolPolyfill from "./polyfills/worker_threads";
import * as esbuildPolyfill from "./polyfills/esbuild";
import * as rollupPolyfill from "./polyfills/rollup";
import * as v8Polyfill from "./polyfills/v8";
import * as lineReaderPolyfill from "./polyfills/readline";
import * as tlsPolyfill from "./polyfills/tls";
import * as http2Polyfill from "./polyfills/http2";
import * as clusterPolyfill from "./polyfills/cluster";
import * as udpPolyfill from "./polyfills/dgram";
import * as vmPolyfill from "./polyfills/vm";
import * as debugPolyfill from "./polyfills/inspector";
import * as asyncCtxPolyfill from "./polyfills/async_hooks";
import * as domainPolyfill from "./polyfills/domain";
import * as tracePolyfill from "./polyfills/diagnostics_channel";
import * as consolePolyfill from "./polyfills/console";
import * as replPolyfill from "./polyfills/repl";
import * as testPolyfill from "./polyfills/test";
import * as traceEventsPolyfill from "./polyfills/trace_events";
import * as wasiPolyfill from "./polyfills/wasi";
import * as seaPolyfill from "./polyfills/sea";
import * as sqlitePolyfill from "./polyfills/sqlite";
import * as quicPolyfill from "./polyfills/quic";
import * as lightningcssPolyfill from "./polyfills/lightningcss";
import { createNapiWorkerFactory, isNapiWasiWorkerScript } from "./helpers/napi-wasm-worker";
import {
  promises as streamPromises,
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
} from "./polyfills/stream";
import { promises as dnsPromises } from "./polyfills/dns";
import { promises as readlinePromises } from "./polyfills/readline";

import assertPolyfill from "./polyfills/assert";
import stringDecoderPolyfill from "./polyfills/string_decoder";
import timersPolyfill from "./polyfills/timers";
import { promises as timersPromises } from "./polyfills/timers";
import * as punycodePolyfill from "./polyfills/punycode";
import constantsPolyfill from "./polyfills/constants";
import {
  resolve as resolveExports,
  imports as resolveImports,
} from "resolve.exports";
import {
  esmToCjs,
  applyPatches,
  collectEsmCjsPatches,
  hasTopLevelAwait,
  stripTopLevelAwait,
} from "./syntax-transforms";
import {
  getCachedModule,
  precompileWasm,
  compileWasmInWorker,
  registerCompiledModule,
  PRECOMPILE_THRESHOLD,
} from "./helpers/wasm-cache";
import {
  buildCdnWasmUrl,
  resolveWasmAssetPath,
} from "./helpers/wasm-cdn";
import { getRegistry } from "./helpers/event-loop";
import * as acorn from "acorn";
import { isTypeScriptFile, stripTypeScript } from "./strip-typescript";
import {
  lexModule,
  hasStaticModuleSyntax,
  patchDynamicImports,
} from "./helpers/module-lexer";

// CSS files must never go through stripTypeScript
function isCSSFile(filename: string): boolean {
  const clean = filename.split("?")[0];
  if (
    clean.endsWith(".css") ||
    clean.endsWith(".scss") ||
    clean.endsWith(".sass") ||
    clean.endsWith(".less") ||
    clean.endsWith(".styl") ||
    clean.endsWith(".stylus") ||
    clean.endsWith(".postcss")
  )
    return true;
  if (filename.includes("type=style")) return true;
  if (/lang[.=](?:css|scss|sass|less|styl|stylus|postcss)/.test(filename))
    return true;
  return false;
}

// Fallback heuristic when filename doesn't indicate TS
function looksLikeTypeScript(source: string): boolean {
  return (
    /\b(?:interface|type)\s+\w+/.test(source) ||
    /:\s*(?:string|number|boolean|void|any|never|unknown|Record|Array|Promise)\b/.test(
      source,
    ) ||
    /(?:as\s+(?:string|number|boolean|any|const)\b)/.test(source)
  );
}

// ── AST walk helper ──
function traverseAst(node: any, visitor: (n: any) => void): void {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visitor(node);
  for (const key in node) {
    if (
      key === "type" ||
      key === "start" ||
      key === "end" ||
      key === "loc" ||
      key === "range"
    )
      continue;
    const val = node[key];
    if (val && typeof val === "object") {
      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          const item = val[i];
          if (item && typeof item === "object" && typeof item.type === "string")
            traverseAst(item, visitor);
        }
      } else if (typeof val.type === "string") {
        traverseAst(val, visitor);
      }
    }
  }
}

// ── Dynamic import regex fallback ──
function rewriteDynamicImportsRegex(source: string): string {
  return source.replace(/(?<![.$\w])import\s*\(/g, "__asyncLoad(");
}

// ── ESM → CJS conversion ──
function convertModuleSyntax(
  source: string,
  filePath: string,
  moduleExportName = "module",
): string {
  return convertModuleSyntaxDetailed(source, filePath, moduleExportName).code;
}

// ESM can legally declare/import `module`. Pure default exports historically
// compiled to `module.exports`, which then wrote to that user binding instead
// of the CommonJS module record. Keep the generated binding out of the source
// namespace and use it consistently in both the transform and wrapper.
function pickModuleExportName(source: string): string {
  const base = "__nodepodModule";
  let candidate = base;
  let suffix = 0;
  while (source.includes(candidate)) {
    suffix++;
    candidate = `${base}_${suffix}`;
  }
  return candidate;
}

function convertModuleSyntaxDetailed(
  source: string,
  filePath: string,
  moduleExportName = "module",
): { code: string; hasTLA: boolean } {
  if (!/\bimport\b|\bexport\b/.test(source)) {
    return { code: source, hasTLA: hasTopLevelAwait(source) };
  }
  try {
    return convertViaAst(source, filePath, moduleExportName);
  } catch (astErr) {
    _nativeConsole.warn(
      "[convertModuleSyntax] AST parse failed for",
      filePath,
      "falling back to regex:",
      astErr instanceof Error ? astErr.message : String(astErr),
    );
    const code = convertViaRegex(source, filePath, moduleExportName);
    return { code, hasTLA: hasTopLevelAwait(code) };
  }
}

function convertViaAst(
  source: string,
  filePath: string,
  moduleExportName: string,
): { code: string; hasTLA: boolean } {
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  }) as any;
  const patches: Array<[number, number, string]> = [];

  // collect import.meta and import() patches: the lexer finds them in one
  // tokenizer pass, where walking every node of the AST cost about as much
  // again as a large chunk's parse
  const lexed = source.length <= LEXER_MAX_CHARS ? lexModule(source) : null;
  if (lexed) {
    for (const imp of lexed[0]) {
      if (imp.d === -2) patches.push([imp.ss, imp.se, "import_meta"]);
      else if (imp.t === 2 && imp.d > -1) patches.push([imp.ss, imp.ss + 6, "__asyncLoad"]);
    }
  } else {
    traverseAst(ast, (node: any) => {
      if (
        node.type === "MetaProperty" &&
        node.meta?.name === "import" &&
        node.property?.name === "meta"
      ) {
        patches.push([node.start, node.end, "import_meta"]);
      }
      if (node.type === "ImportExpression") {
        patches.push([node.start, node.start + 6, "__asyncLoad"]);
      }
    });
  }

  const hasImportDecl = ast.body.some(
    (n: any) => n.type === "ImportDeclaration",
  );
  const hasExportDecl = ast.body.some((n: any) => n.type?.startsWith("Export"));

  // collect ESM→CJS patches from the same AST (no second parse)
  if (hasImportDecl || hasExportDecl) {
    collectEsmCjsPatches(ast, source, patches, {
      exportTarget: `${moduleExportName}.exports`,
    });
  }

  // apply all patches in one pass
  let output = applyPatches(source, patches);

  if (hasExportDecl) {
    // wrapper sets __esModule in outer scope (see ESM_SENTINEL). doing it
    // here breaks if user code shadows Object (eg typebox 1.x). #56
    output = ESM_SENTINEL + output;
  }

  // .mjs files with `const require = createRequire(...)` hit TDZ after esmToCjs
  output = demoteLexicalRequire(output);

  return {
    code: output,
    hasTLA: RE_AWAIT_WORD.test(source) && moduleAstHasTopLevelAwait(ast),
  };
}

// Top-level await in a module AST. Function bodies are skipped outright: in
// module code `await` inside any non-async function is a parse error, and
// inside an async one it isn't top level, so only statements outside
// functions can hold it. Most of a module's code sits in functions, which
// makes this a small fraction of a full walk.
function moduleAstHasTopLevelAwait(ast: any): boolean {
  let found = false;
  const walk = (node: any): void => {
    if (found || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    switch (node.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return;
      case "AwaitExpression":
        found = true;
        return;
      case "ForOfStatement":
        if (node.await) {
          found = true;
          return;
        }
        break;
      default:
        if (typeof node.type !== "string") return;
    }
    for (const key in node) {
      if (key === "type" || key === "start" || key === "end") continue;
      const value = node[key];
      if (value && typeof value === "object") walk(value);
    }
  };
  walk(ast);
  return found;
}

// stamped by convertModuleSyntax, stripped by buildModuleWrapper. #56
const ESM_SENTINEL = "/*@nodepod-esm*/\n";

const RE_AWAIT_WORD = /\bawait\b/;
// `await (x)` / `await [x]` at the start of a line, outside any function:
// sloppy-mode script parses it as a call of a function named await, so
// nothing flags it; the full path detects and strips top-level await
const RE_TOPLEVEL_AWAIT_CALL = /^(?:(?:const|let|var)\s+[\w$]+\s*=\s*|[\w$.]+\s*=\s*)?await\s*[([]/m;
// the lexer's memory grows to about 4 bytes per source char and stays at
// its peak: bigger sources take the AST path (their parse is transient)
const LEXER_MAX_CHARS = 2_000_000;

declare const __NODEPOD_BUILD_ID__: string | undefined;

// Transform caches store this instead of code when the transform left the
// source unchanged (most CommonJS in node_modules): the loader has the source
// in hand already, so a second copy would only cost memory and transfer.
const SAME_AS_SOURCE = "\u0000=";
// shared-pack flag: see SAME_AS_SOURCE
const FLAG_SAME_AS_SOURCE = 4;

// ── Shared transform store (see threading/transform-store.ts) ──

type SharedTransformClient = {
  loadPack(scope: string): Array<[string, string, number]>;
  put(scope: string, key: string, code: string, flags: number): void;
};

function getSharedTransformClient(): SharedTransformClient | null {
  return (
    (globalThis as { __nodepodSharedTransforms?: SharedTransformClient })
      .__nodepodSharedTransforms ?? null
  );
}

// packs fetched over each client (one per process); entries are handed out
// once (each module loads once per process) so a pack's strings don't
// outlive their use
const _sharedPacks = new WeakMap<SharedTransformClient, Map<string, Map<string, [string, number]>>>();
// the entries a process never takes (modules of a package it doesn't load)
// are dropped once it stops loading modules; a later load asks again
const SHARED_PACK_IDLE_MS = 5000;
const _sharedPackRelease = new WeakMap<SharedTransformClient, { timer: ReturnType<typeof setTimeout>; at: number }>();

function scheduleSharedPackRelease(client: SharedTransformClient): void {
  const now = Date.now();
  const pending = _sharedPackRelease.get(client);
  if (pending && now - pending.at < 1000) return;
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    _sharedPackRelease.delete(client);
    _sharedPacks.delete(client);
  }, SHARED_PACK_IDLE_MS);
  // in process workers setTimeout is the node timers polyfill: this timer
  // must not keep the process alive
  (timer as unknown as { unref?: () => void }).unref?.();
  _sharedPackRelease.set(client, { timer, at: now });
}

function takeSharedTransform(
  client: SharedTransformClient,
  scope: string,
  key: string,
): [string, number] | null {
  scheduleSharedPackRelease(client);
  let packs = _sharedPacks.get(client);
  if (!packs) _sharedPacks.set(client, (packs = new Map()));
  let pack = packs.get(scope);
  if (!pack) {
    pack = new Map();
    for (const [k, code, flags] of client.loadPack(scope)) pack.set(k, [code, flags]);
    packs.set(scope, pack);
  }
  const hit = pack.get(key);
  if (!hit) return null;
  pack.delete(key);
  return hit;
}

// Digest of the transform implementation itself: persisted transforms made
// by different transform code never match.
let _transformSalt: string | null = null;
function transformSalt(): string {
  if (_transformSalt === null) {
    // the build id changes with every build (a helper not listed below may
    // change); the digest covers unbundled runs such as tests
    const build = typeof __NODEPOD_BUILD_ID__ === "string" ? __NODEPOD_BUILD_ID__ : "dev";
    _transformSalt = build + "." + quickDigest(
      [
        convertModuleSyntaxDetailed,
        convertViaAst,
        convertViaRegex,
        collectEsmCjsPatches,
        applyPatches,
        demoteLexicalRequire,
        pickModuleExportName,
        fastCommonJsTransform,
        patchDynamicImports,
        stripTypeScript,
      ]
        .map(String)
        .join("|"),
    );
  }
  return _transformSalt;
}

/**
 * Loader fast path for CommonJS: when the lexer finds no static
 * import/export, the module only needs `import()` / `import.meta` rewritten,
 * which the lexer's positions give directly. Returns null when the module
 * needs the full AST transform: it has module syntax, or it lives in an ESM
 * context (.mjs, `"type": "module"`) and may use top-level await.
 */
function fastCommonJsTransform(
  code: string,
  filePath: string,
  isTypeModuleDir: (dir: string) => boolean,
): string | null {
  if (code.length > LEXER_MAX_CHARS) return null;
  // .cts may keep import/export after type stripping: check it like .js
  const explicitCjs = filePath.endsWith(".cjs");
  if (!explicitCjs && RE_AWAIT_WORD.test(code)) {
    if (/\.m[jt]s$/.test(filePath)) return null;
    if (isTypeModuleDir(pathPolyfill.dirname(filePath))) return null;
    if (RE_TOPLEVEL_AWAIT_CALL.test(code)) return null;
  }
  const lexed = lexModule(code);
  if (!lexed) return null;
  if (!explicitCjs && hasStaticModuleSyntax(lexed)) return null;
  return patchDynamicImports(code, lexed);
}

// Demote `const/let require =` to plain assignment to avoid TDZ with esmToCjs-generated require() calls
function demoteLexicalRequire(code: string): string {
  if (!/\b(?:const|let)\s+require\s*=/.test(code)) return code;
  return code.replace(/\b(const|let)\s+(require)\s*=/g, "require =");
}

// Builds the IIFE wrapper that sandboxes user code with shimmed globals
function buildModuleWrapper(
  code: string,
  opts: {
    async?: boolean;
    useNativePromise?: boolean;
    includeViteVars?: boolean;
    hideBrowserGlobals?: boolean;
    wasmHelpers?: boolean;
    moduleExportName?: string;
  } = {},
): string {
  const {
    async: isAsync = false,
    useNativePromise = false,
    includeViteVars = true,
    hideBrowserGlobals = true,
    wasmHelpers = false,
    moduleExportName,
  } = opts;

  const promiseVar = useNativePromise ? "globalThis.Promise" : "$SyncPromise";
  const fnKeyword = isAsync ? "async function" : "function";

  // strip sentinel, emit __esModule in outer scope below
  const isEsmModule = code.startsWith(ESM_SENTINEL);
  if (isEsmModule) code = code.slice(ESM_SENTINEL.length);

  let vars = `var exports = $exports;
var require = $require;
var module = $module;
${moduleExportName ? `var ${moduleExportName} = $module;\n` : ""}var __filename = $filename;
var __dirname = $dirname;
`;
  if (includeViteVars) {
    vars += `var __vite_injected_original_filename = $filename;
var __vite_injected_original_dirname = $dirname;
var __vite_injected_original_import_meta_url = "file://" + $filename;
`;
  }
  vars += `var process = $process;
var console = $console;
var import_meta = $importMeta;
var __asyncLoad = $asyncLoad;
var Function = ($asyncLoad && $asyncLoad.Function) || globalThis.Function;
var __syncAwait = $syncAwait;
var __syncAwaitFn = $syncAwaitFn;
var Promise = ${promiseVar};
var global = globalThis;
`;
  if (hideBrowserGlobals) {
    vars += `var document = undefined;
var window = undefined;
var HTMLElement = undefined;
`;
  }
  vars += `globalThis.process = $process;
globalThis.console = $console;
globalThis.require = $require;
global.process = $process;
global.console = $console;
global.require = $require;
`;
  if (wasmHelpers) {
    vars += `async function __wasmCompile(bytes) { return WebAssembly.compile(bytes); }
async function __wasmInstantiate(moduleOrBytes, imports) {
  var mod = moduleOrBytes;
  if (moduleOrBytes instanceof ArrayBuffer || ArrayBuffer.isView(moduleOrBytes)) {
    mod = await WebAssembly.compile(moduleOrBytes);
  }
  var result = await WebAssembly.instantiate(mod, imports);
  return result.instance || result;
}
`;
  }
  if (isEsmModule) {
    // runs in outer scope, above the inner IIFE that holds user code
    vars += `Object.defineProperty($exports, "__esModule", { value: true });
`;
  }

  return `(function($exports, $require, $module, $filename, $dirname, $process, $console, $importMeta, $asyncLoad, $syncAwait, $syncAwaitFn, $SyncPromise) {
${vars}return (${fnKeyword}() {
${code}
}).call(this);
})`;
}

/**
 * Replace import.meta references without touching string/template/comment
 * contents. The naive /\bimport\.meta\b/g fallback corrupts Vite's own
 * guards like code.includes("import.meta.glob"), which then skips the
 * compile-time glob expand and leaves a runtime .glob() call.
 */
function replaceImportMetaOutsideLiterals(
  source: string,
  replace: (matched: string) => string,
): string {
  let out = "";
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    const next = i + 1 < len ? source[i + 1] : "";

    // line comment
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? len : end;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    // block comment
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? len : end + 2;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    // string / template literal
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          j++;
          break;
        }
        // template: skip ${ ... } with naive depth so nested braces in
        // expressions don't truncate the literal early
        if (quote === "`" && source[j] === "$" && source[j + 1] === "{") {
          j += 2;
          let depth = 1;
          while (j < len && depth > 0) {
            if (source[j] === "\\") {
              j += 2;
              continue;
            }
            if (source[j] === '"' || source[j] === "'") {
              const q = source[j++];
              while (j < len) {
                if (source[j] === "\\") {
                  j += 2;
                  continue;
                }
                if (source[j] === q) {
                  j++;
                  break;
                }
                j++;
              }
              continue;
            }
            if (source[j] === "{") depth++;
            else if (source[j] === "}") depth--;
            j++;
          }
          continue;
        }
        j++;
      }
      out += source.slice(i, j);
      i = j;
      continue;
    }

    if (
      ch === "i" &&
      source.startsWith("import.meta", i) &&
      (i === 0 || !/[\w$]/.test(source[i - 1]!))
    ) {
      const after = i + "import.meta".length;
      if (after >= len || !/[\w$]/.test(source[after]!)) {
        // longest suffix first
        if (source.startsWith("import.meta.filename", i)) {
          out += replace("import.meta.filename");
          i += "import.meta.filename".length;
          continue;
        }
        if (source.startsWith("import.meta.dirname", i)) {
          out += replace("import.meta.dirname");
          i += "import.meta.dirname".length;
          continue;
        }
        if (source.startsWith("import.meta.url", i)) {
          out += replace("import.meta.url");
          i += "import.meta.url".length;
          continue;
        }
        out += replace("import.meta");
        i += "import.meta".length;
        continue;
      }
    }

    out += ch;
    i++;
  }
  return out;
}

function convertViaRegex(
  source: string,
  filePath: string,
  moduleExportName: string,
): string {
  let output = source;
  const dir = pathPolyfill.dirname(filePath);
  output = replaceImportMetaOutsideLiterals(output, (matched) => {
    if (matched === "import.meta.url") return `"file://${filePath}"`;
    if (matched === "import.meta.dirname") return `"${dir}"`;
    if (matched === "import.meta.filename") return `"${filePath}"`;
    // Keep the identifier form so the module wrapper's $importMeta binding
    // (url/dirname/filename/resolve/main) is what user code sees — same as AST.
    return "import_meta";
  });
  output = rewriteDynamicImportsRegex(output);

  const hasImport = /\bimport\s+[\w{*'"]/m.test(source);
  const hasExport =
    /\bexport\s+(?:default|const|let|var|function|class|{|\*)/m.test(source);
  if (hasImport || hasExport) {
    output = esmToCjs(output, {
      exportTarget: `${moduleExportName}.exports`,
    });
    if (hasExport) {
      // see ESM_SENTINEL above. #56
      output = ESM_SENTINEL + output;
    }
  }

  output = demoteLexicalRequire(output);

  return output;
}

// ── fetch body lifetime ──
// A fetch() Handle covers the request until headers arrive. Reading the body
// afterwards (`await r.text()`, `.json()`, a reader loop) completes from
// browser tasks that no tracked Handle refs, so a script whose last live work
// is a body read would be judged drained and exit before the bytes land.
// Node keeps the socket alive until the body is consumed; mirror that by
// holding a Handle for the duration of each body-consuming call. Nothing is
// registered while the body sits unread, so a script that only inspects
// `r.status` still exits promptly.
const BODY_CONSUMERS = ["text", "json", "arrayBuffer", "blob", "bytes", "formData"] as const;

function trackFetchBodyConsumption(resp: Response): Response {
  if (!resp || typeof resp !== "object" || !resp.body) return resp;
  const define = (target: object, name: string, value: unknown) => {
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        writable: true,
        value,
      });
    } catch {
      /* frozen/exotic response: leave native behavior */
    }
  };
  const holdUntilSettled = <T>(p: Promise<T>): Promise<T> => {
    const handle = getRegistry().register("FetchRequest");
    return p.then(
      (v) => {
        handle.close();
        return v;
      },
      (e) => {
        handle.close();
        throw e;
      },
    );
  };
  for (const name of BODY_CONSUMERS) {
    const orig = (resp as unknown as Record<string, unknown>)[name];
    if (typeof orig !== "function") continue;
    define(resp, name, function (this: Response, ...args: unknown[]) {
      return holdUntilSettled(
        (orig as (...a: unknown[]) => Promise<unknown>).apply(this, args),
      );
    });
  }
  // clone(): the copy gets its own tracking.
  const origClone = resp.clone;
  if (typeof origClone === "function") {
    define(resp, "clone", function (this: Response) {
      return trackFetchBodyConsumption(origClone.call(this));
    });
  }
  // Manual streaming: a reader or pipe holds the Handle until the stream
  // closes, errors, or is cancelled.
  const body = resp.body;
  const origGetReader = body.getReader;
  if (typeof origGetReader === "function") {
    define(body, "getReader", function (this: ReadableStream, ...args: unknown[]) {
      const reader = (origGetReader as (...a: unknown[]) => ReadableStreamDefaultReader).apply(this, args);
      const handle = getRegistry().register("FetchRequest");
      const release = () => handle.close();
      reader.closed.then(release, release);
      return reader;
    });
  }
  const origPipeTo = body.pipeTo;
  if (typeof origPipeTo === "function") {
    define(body, "pipeTo", function (this: ReadableStream, ...args: unknown[]) {
      return holdUntilSettled(
        (origPipeTo as (...a: unknown[]) => Promise<void>).apply(this, args),
      );
    });
  }
  return resp;
}

// ── fetch() → virtual server ──

interface LoopbackTarget {
  port: number;
  path: string;
}

function parseLoopbackHttpUrl(url: string): LoopbackTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!httpPolyfill.isLoopbackHostname(parsed.hostname)) return null;
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  if (!Number.isFinite(port) || port <= 0) return null;
  return { port, path: parsed.pathname + parsed.search };
}

const MAX_LOCAL_REDIRECTS = 20;

/**
 * Serve a fetch() aimed at a loopback port from the virtual server bound to
 * it. Resolves `null` when nothing listens there so the caller can fall back
 * to the network. Follows same-loopback redirects like a real fetch would.
 */
async function fetchVirtualServer(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  target: LoopbackTarget,
): Promise<Response | null> {
  const request = new Request(input as RequestInfo, init);
  const method = request.method.toUpperCase();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > 0) body = NodeBuffer.from(bytes);
  }
  const redirectMode = request.redirect ?? "follow";

  let current = target;
  let currentMethod = method;
  let currentBody = body;
  for (let hop = 0; hop <= MAX_LOCAL_REDIRECTS; hop++) {
    if (!headers.host) headers.host = `localhost:${current.port}`;
    const result = await httpPolyfill.dispatchLocalRequest(
      current.port,
      currentMethod,
      current.path,
      headers,
      currentBody,
    );
    if (!result) return hop === 0 ? null : Response.error();

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(result.headers ?? {})) {
      if (Array.isArray(value)) {
        for (const item of value) responseHeaders.append(key, String(item));
      } else if (value != null) {
        responseHeaders.append(key, String(value));
      }
    }
    // Response() rejects statuses outside 200-599; anything else from a
    // virtual server is a protocol error, report it as a bad gateway
    const rawStatus = result.statusCode || 200;
    const status = rawStatus >= 200 && rawStatus <= 599 ? rawStatus : 502;
    const location = responseHeaders.get("location");
    const isRedirect = [301, 302, 303, 307, 308].includes(status) && !!location;
    if (isRedirect && redirectMode === "follow") {
      let next: LoopbackTarget | null = null;
      try {
        next = parseLoopbackHttpUrl(
          new URL(location, `http://localhost:${current.port}${current.path}`).href,
        );
      } catch {
        next = null;
      }
      // redirect off the loopback: hand the rest to the network
      if (!next) return null;
      if (status === 303 || ((status === 301 || status === 302) && currentMethod === "POST")) {
        currentMethod = "GET";
        currentBody = undefined;
        delete headers["content-length"];
        delete headers["content-type"];
      }
      delete headers.host;
      current = next;
      continue;
    }
    if (isRedirect && redirectMode === "error") {
      throw new TypeError("Failed to fetch: redirect not allowed");
    }

    // null-body statuses cannot carry a body in a Response
    const nullBody = status === 204 || status === 205 || status === 304 || currentMethod === "HEAD";
    const payload = result.body;
    const bodyInit =
      nullBody || !payload || payload.byteLength === 0
        ? null
        : (payload.buffer.slice(
            payload.byteOffset,
            payload.byteOffset + payload.byteLength,
          ) as ArrayBuffer);
    const response = new Response(bodyInit, {
      status,
      statusText: result.statusMessage || "",
      headers: responseHeaders,
    });
    try {
      Object.defineProperty(response, "url", {
        configurable: true,
        value: `http://localhost:${current.port}${current.path}`,
      });
    } catch {
      /* url stays "" */
    }
    return response;
  }
  throw new TypeError("Failed to fetch: too many redirects");
}

// ── Sync promise infrastructure ──
// SyncThenable and SyncPromise let __syncAwait unwrap values without hitting
// the microtask queue. This is how require() can work synchronously even when
// modules use async patterns internally.

// .then() fires synchronously when value is already resolved
class SyncThenable<T> {
  private _value: T;
  constructor(value: T) {
    this._value = value;
  }
  then<R>(
    onFulfilled?: ((v: T) => R) | null,
    _onRejected?: ((e: any) => R) | null,
  ): SyncThenable<R> | this {
    if (onFulfilled) return new SyncThenable(onFulfilled(this._value));
    return this;
  }
  catch(_onRejected?: ((e: any) => unknown) | null): this {
    return this;
  }
  finally(onFinally?: (() => void) | null): this {
    if (onFinally) onFinally();
    return this;
  }
}

// Try to synchronously unwrap a thenable. Returns the value if .then() fires sync,
// otherwise returns the original value (possibly a native Promise).
// The synchronous fast-path in SyncPromise.then below is gated on this scope:
// user-code .then calls outside of it keep native microtask timing (Node parity),
// while require() machinery unwrapping inside it keeps working synchronously.
let syncScopeDepth = 0;
function inSyncScope<T>(fn: () => T): T {
  syncScopeDepth++;
  try {
    return fn();
  } finally {
    syncScopeDepth--;
  }
}
function syncAwait(val: unknown): unknown {
  if (val && typeof (val as any).then === "function") {
    let resolved: unknown;
    let gotSync = false;
    let rejected = false;
    let error: unknown;
    // only a SyncPromise can report a rejection synchronously; a rejection
    // handler on a pending native promise would just swallow its error
    const onRejected =
      (val as any)._force === (SyncPromiseClass.prototype as any)._force
        ? (e: unknown) => {
            error = e;
            rejected = true;
          }
        : undefined;
    inSyncScope(() =>
      (val as any).then((v: unknown) => {
        resolved = v;
        gotSync = true;
      }, onRejected),
    );
    if (gotSync) return resolved;
    // `await` of a rejected promise throws at the await site
    if (rejected) throw error;
  }
  return val;
}

/**
 * Thunk form emitted by the TLA transform: `await EXPR` compiles to
 * `__syncAwaitFn(() => (EXPR))`. The whole argument — including any
 * `.then` chains — evaluates inside the sync scope, so chained promises
 * unwrap synchronously exactly like values passed to `syncAwait`.
 * Genuinely async values behave as before (returned pending).
 */
function syncAwaitFn(thunk: () => unknown): unknown {
  return inSyncScope(() => syncAwait(thunk()));
}

// Promise subclass that resolves .then() synchronously when the executor resolves sync.
// Needed because async functions always return native Promises, but when their body
// resolves synchronously we want __syncAwait to unwrap the result.
// Injected as `Promise` inside module wrappers.
function createSyncPromise(): typeof Promise {
  // async_hooks installs a context-propagating global Promise during module
  // initialization. async functions still return promises from the intrinsic
  // constructor, and napi-rs uses instanceof Promise to identify callback
  // results. keep that check anchored to the intrinsic constructor so native
  // async plugin hooks (rolldown/vite and other napi clients) are awaited
  // instead of being decoded as ordinary objects.
  const NativePromise = asyncCtxPolyfill.getNativePromiseConstructor();
  const noop = (): void => {};
  const markHandled = (p: Promise<unknown>): void => {
    NativePromise.prototype.then.call(p, undefined, noop);
  };
  const isSyncPromise = (v: unknown): v is SyncPromise<any> =>
    !!v &&
    typeof v === "object" &&
    (v as any)._force === SyncPromise.prototype._force;

  class SyncPromise<T> extends NativePromise<T> {
    private _syncValue: T | undefined;
    private _syncResolved = false;
    private _syncRejected = false;
    private _syncError: any;

    // Set on promises whose value can be computed ahead of native timing:
    // .then() results created outside a sync scope, and promises adopting
    // one of those. syncAwait forces them so a chain built before a
    // top-level `await` still unwraps synchronously.
    private _lazy?: () => void;

    constructor(
      executor: (
        resolve: (value: T | PromiseLike<T>) => void,
        reject: (reason?: any) => void,
      ) => void,
    ) {
      let syncVal: T | undefined;
      let syncResolved = false;
      let syncRejected = false;
      let syncErr: any;
      let adopted: SyncPromise<T> | undefined;

      super((resolve, reject) => {
        executor(
          (value) => {
            // Adopting a SyncPromise outside a sync scope: keep native
            // adoption timing, but remember the source so it can be forced.
            if (syncScopeDepth === 0 && isSyncPromise(value)) {
              adopted = value;
              resolve(value);
              return;
            }
            // Try sync unwrap. If it can't resolve sync, let native handle it.
            // Without this, p-limit's resolve(asyncPromise) gets treated as
            // sync-resolved with the Promise object as the value.
            if (
              value &&
              typeof value === "object" &&
              typeof (value as any).then === "function"
            ) {
              let innerResolved = false;
              let innerVal: T | undefined;
              let innerRejected = false;
              let innerErr: any;
              (value as any).then(
                (v: T) => {
                  innerVal = v;
                  innerResolved = true;
                },
                (e: any) => {
                  innerErr = e;
                  innerRejected = true;
                },
              );
              if (innerResolved) {
                syncVal = innerVal;
                syncResolved = true;
                resolve(innerVal!);
                return;
              }
              if (innerRejected) {
                syncRejected = true;
                syncErr = innerErr;
                reject(innerErr);
                return;
              }
              resolve(value);
              return;
            }
            syncVal = value as T;
            syncResolved = true;
            resolve(value);
          },
          (reason) => {
            syncRejected = true;
            syncErr = reason;
            reject(reason);
          },
        );
      });

      this._syncValue = syncVal;
      this._syncResolved = syncResolved;
      this._syncRejected = syncRejected;
      this._syncError = syncErr;

      // No blanket rejection suppression here: an unhandled rejection has to
      // reach the host's unhandledrejection event (node exits 1 on it).
      // Rejections consumed on a sync path are marked handled there instead.
      if (adopted) {
        const src = adopted;
        this._lazy = () => {
          src._force();
          if (src._syncResolved) {
            this._syncResolved = true;
            this._syncValue = src._syncValue;
          } else if (src._syncRejected) {
            this._syncRejected = true;
            this._syncError = src._syncError;
          }
        };
      }
    }

    _force(): void {
      const lazy = this._lazy;
      if (lazy && !this._syncResolved && !this._syncRejected) {
        lazy();
        // settled: drop the link so a long chain doesn't keep its parents alive
        if (this._syncResolved || this._syncRejected) this._lazy = undefined;
      }
    }

    // .then() outside a sync scope on a promise whose value is (or can be)
    // known synchronously. The reaction is a real native one, so timing
    // matches node; _lazy lets syncAwait compute the same result early.
    // Either way the callback runs at most once.
    private _lazyThen(
      onFulfilled?: ((value: T) => any) | null,
      onRejected?: ((reason: any) => any) | null,
    ): Promise<any> {
      let state = 0; // 0 pending, 1 fulfilled, 2 rejected
      let out: any;
      const settle = (ok: boolean, v: any): void => {
        if (state !== 0) return;
        try {
          if (ok) out = onFulfilled ? onFulfilled(v) : v;
          else if (onRejected) out = onRejected(v);
          else {
            state = 2;
            out = v;
            return;
          }
          state = 1;
        } catch (e) {
          state = 2;
          out = e;
        }
      };
      // runs as the native reaction: the result is final now, so record it
      // and drop the lazy link (which holds the parent) — a queue built as
      // `q = q.then(task)` must not keep every earlier step reachable
      const result = (): any => {
        derived._lazy = undefined;
        if (state === 2) {
          derived._syncRejected = true;
          derived._syncError = out;
          throw out;
        }
        if (!(out && typeof out.then === "function")) {
          derived._syncResolved = true;
          derived._syncValue = out;
        }
        return out;
      };
      const derived: SyncPromise<any> = super.then(
        (v) => {
          settle(true, v);
          return result();
        },
        (e) => {
          settle(false, e);
          return result();
        },
      ) as SyncPromise<any>;
      const parent = this;
      derived._lazy = () => {
        parent._force();
        if (parent._syncResolved) settle(true, parent._syncValue);
        else if (parent._syncRejected) settle(false, parent._syncError);
        else return;
        if (state === 2) {
          derived._syncRejected = true;
          derived._syncError = out;
          return;
        }
        if (out && typeof out.then === "function") {
          let ok = false;
          let bad = false;
          let v: any;
          out.then(
            (x: any) => {
              ok = true;
              v = x;
            },
            (e: any) => {
              bad = true;
              v = e;
            },
          );
          if (ok) {
            derived._syncResolved = true;
            derived._syncValue = v;
          } else if (bad) {
            derived._syncRejected = true;
            derived._syncError = v;
          }
          return;
        }
        derived._syncResolved = true;
        derived._syncValue = out;
      };
      return derived;
    }

    then<TResult1 = T, TResult2 = never>(
      onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      // Sync fast-path ONLY inside an explicit sync scope (syncAwait above):
      // it exists so require() machinery can unwrap synchronously. Everywhere
      // else, fall through to native microtask timing so user-visible .then
      // ordering matches Node (sync statements, then nextTick, then promises).
      if (syncScopeDepth > 0) this._force();
      if (syncScopeDepth > 0 && this._syncResolved && onFulfilled) {
        try {
          const result = onFulfilled(this._syncValue as T);
          if (
            result &&
            typeof result === "object" &&
            typeof (result as any).then === "function"
          ) {
            let innerVal: any;
            let innerResolved = false;
            let innerRejected = false;
            let innerErr: any;
            (result as any).then(
              (v: any) => {
                innerVal = v;
                innerResolved = true;
              },
              (e: any) => {
                innerErr = e;
                innerRejected = true;
              },
            );
            if (innerResolved) {
              return new SyncPromise<TResult1>((res) => res(innerVal)) as any;
            }
            if (innerRejected) {
              if (onRejected) {
                return new SyncPromise<TResult2>((res) =>
                  res(onRejected(innerErr) as TResult2),
                ) as any;
              }
              return new SyncPromise<TResult2>((_, rej) =>
                rej(innerErr),
              ) as any;
            }
            return NativePromise.resolve(result).then(null, onRejected) as any;
          }
          return new SyncPromise<TResult1>((res) =>
            res(result as TResult1),
          ) as any;
        } catch (e) {
          if (onRejected) {
            return new SyncPromise<TResult2>((res) =>
              res(onRejected(e) as TResult2),
            ) as any;
          }
          // Must be SyncPromise so downstream .catch() fires sync (p-locate depends on this)
          return new SyncPromise<TResult2>((_, rej) => rej(e)) as any;
        }
      }
      if (this._syncRejected && syncScopeDepth > 0) {
        // consumed synchronously: the native promise must not also report
        // an unhandled rejection
        markHandled(this);
        if (!onRejected) {
          return new SyncPromise<TResult2>((_, rej) =>
            rej(this._syncError),
          ) as any;
        }
        try {
          const result = onRejected(this._syncError);
          return new SyncPromise<TResult2>((res) =>
            res(result as TResult2),
          ) as any;
        } catch (e) {
          return new SyncPromise<TResult2>((_, rej) => rej(e)) as any;
        }
      }
      if (this._lazy || this._syncResolved || this._syncRejected) {
        return this._lazyThen(onFulfilled, onRejected);
      }
      return super.then(onFulfilled, onRejected);
    }
  }

  // instanceof must work for native Promises too since we inject SyncPromise as `Promise`
  Object.defineProperty(SyncPromise, Symbol.hasInstance, {
    value: (instance: any) => instance instanceof NativePromise,
    configurable: true,
  });

  (SyncPromise as any).resolve = (value: any) => {
    if (
      value &&
      typeof value === "object" &&
      typeof (value as any).then === "function"
    ) {
      return new SyncPromise((res) => res(value));
    }
    return new SyncPromise((res) => res(value));
  };
  (SyncPromise as any).reject = (reason: any) =>
    new SyncPromise((_, rej) => rej(reason));

  // Inside a sync scope, lazy .then() results are forced so a combinator over
  // promises built earlier can still settle synchronously.
  const collect = (iterable: Iterable<any>): any[] => {
    const arr = Array.from(iterable);
    if (syncScopeDepth > 0) {
      for (const v of arr) if (isSyncPromise(v)) v._force();
    }
    return arr;
  };
  // A sync result stands in for the native combinator, which would have
  // attached a handler to every input: do the same so a rejected input
  // doesn't also surface as an unhandled rejection.
  const consumed = (arr: any[]): void => {
    for (const v of arr) if (v instanceof NativePromise) markHandled(v);
  };

  // all/race/allSettled/any return SyncPromise so __syncAwait can unwrap them
  (SyncPromise as any).all = (iterable: Iterable<any>) => {
    const arr = collect(iterable);
    const results: any[] = new Array(arr.length);
    let allSync = true;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v instanceof SyncPromise) {
        if ((v as any)._syncResolved) {
          results[i] = (v as any)._syncValue;
        } else if ((v as any)._syncRejected) {
          consumed(arr);
          return new SyncPromise((_, rej) => rej((v as any)._syncError));
        } else {
          allSync = false;
          break;
        }
      } else if (v && typeof v === "object" && typeof v.then === "function") {
        let probed = false,
          pVal: any;
        v.then((x: any) => {
          pVal = x;
          probed = true;
        });
        if (probed) {
          results[i] = pVal;
        } else {
          allSync = false;
          break;
        }
      } else {
        results[i] = v;
      }
    }
    if (allSync) {
      return new SyncPromise((res: any) => res(results));
    }
    return new SyncPromise((res: any, rej: any) => {
      NativePromise.all(arr).then(res, rej);
    });
  };

  (SyncPromise as any).allSettled = (iterable: Iterable<any>) => {
    const arr = collect(iterable);
    const results: any[] = new Array(arr.length);
    let allSync = true;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v instanceof SyncPromise) {
        if ((v as any)._syncResolved) {
          results[i] = { status: "fulfilled", value: (v as any)._syncValue };
        } else if ((v as any)._syncRejected) {
          results[i] = { status: "rejected", reason: (v as any)._syncError };
        } else {
          allSync = false;
          break;
        }
      } else if (v && typeof v === "object" && typeof v.then === "function") {
        allSync = false;
        break;
      } else {
        results[i] = { status: "fulfilled", value: v };
      }
    }
    if (allSync) {
      consumed(arr);
      return new SyncPromise((res: any) => res(results));
    }
    return new SyncPromise((res: any, rej: any) => {
      NativePromise.allSettled(arr).then(res, rej);
    });
  };

  (SyncPromise as any).race = (iterable: Iterable<any>) => {
    const arr = collect(iterable);
    for (const v of arr) {
      if (v instanceof SyncPromise) {
        if ((v as any)._syncResolved) {
          consumed(arr);
          return new SyncPromise((res: any) => res((v as any)._syncValue));
        }
        if ((v as any)._syncRejected) {
          consumed(arr);
          return new SyncPromise((_, rej: any) => rej((v as any)._syncError));
        }
      } else if (
        !(v && typeof v === "object" && typeof v.then === "function")
      ) {
        consumed(arr);
        return new SyncPromise((res: any) => res(v));
      }
    }
    return new SyncPromise((res: any, rej: any) => {
      NativePromise.race(arr).then(res, rej);
    });
  };

  (SyncPromise as any).any = (iterable: Iterable<any>) => {
    const arr = collect(iterable);
    for (const v of arr) {
      if (v instanceof SyncPromise && (v as any)._syncResolved) {
        consumed(arr);
        return new SyncPromise((res: any) => res((v as any)._syncValue));
      }
      if (!(v && typeof v === "object" && typeof v.then === "function")) {
        consumed(arr);
        return new SyncPromise((res: any) => res(v));
      }
    }
    let allSyncRejected = true;
    const errors: any[] = [];
    for (const v of arr) {
      if (v instanceof SyncPromise && (v as any)._syncRejected) {
        errors.push((v as any)._syncError);
      } else {
        allSyncRejected = false;
        break;
      }
    }
    if (allSyncRejected && arr.length > 0) {
      consumed(arr);
      return new SyncPromise((_, rej: any) =>
        rej(new AggregateError(errors, "All promises were rejected")),
      );
    }
    return new SyncPromise((res: any, rej: any) => {
      NativePromise.any(arr).then(res, rej);
    });
  };

  return SyncPromise as any;
}

const SyncPromiseClass = createSyncPromise();

function toImportNamespace(loaded: unknown): Record<string, unknown> {
  if (loaded == null || (typeof loaded !== "object" && typeof loaded !== "function")) {
    return { default: loaded };
  }

  const mod = loaded as Record<string, unknown>;
  const ns: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(mod)) {
    ns[key] = mod[key];
  }

  // native import() exposes CommonJS module.exports as default. without this,
  // dynamic imports of callable CJS modules become a namespace of the function's
  // own properties (length, name, ...), so vite's react plugin passes that
  // namespace to babel as a plugin object.
  if ((mod as any).__esModule !== true) {
    ns.default = loaded;
    return ns;
  }

  // import() should yield a module namespace like Node. Hoist named exports
  // off default when the CJS interop layer only put them there.
  const def = mod.default;
  if (def && (typeof def === "object" || typeof def === "function")) {
    for (const key of Object.getOwnPropertyNames(def)) {
      if (key === "default") continue;
      if (ns[key] === undefined) ns[key] = (def as Record<string, unknown>)[key];
    }
    if (ns.default === undefined) ns.default = def;
  }

  return ns;
}

type DynamicLoader = ((specifier: string) => SyncThenable<unknown> | Promise<unknown>) & {
  /** Module-scoped `Function` whose bodies route import() through this loader. */
  Function: FunctionConstructor;
};

function makeDynamicLoader(resolver: ResolverFn): DynamicLoader {
  const load = (specifier: string): SyncThenable<unknown> | Promise<unknown> => {
    try {
      const loaded = resolver(specifier);
      return new SyncThenable(toImportNamespace(loaded));
    } catch (err) {
      if (!(err instanceof AsyncModuleInitializationRequired)) throw err;

      // Dynamic imports can happen from async callbacks after the entry module
      // has already returned. Await and retry at this boundary so those late
      // imports cannot receive an uninitialized synchronous polyfill.
      return err.ready.then(() => {
        const loaded = resolver(specifier);
        return toImportNamespace(loaded);
      });
    }
  };
  return Object.assign(load, { Function: makeScopedFunction(load) });
}

const NativeFunction = Function;

// `new Function("m", "return import(m)")` is how CommonJS builds keep an
// ESM-only dependency loadable (@preact/preset-vite, import-meta-resolve,
// ...): the body is assembled at runtime, so the AST rewrite of import() ->
// __asyncLoad() never sees it and the worker's native import() receives a
// bare specifier it cannot resolve ("Failed to resolve module specifier").
// Each module gets a Function whose bodies get the same rewrite, with
// __asyncLoad bound to that module's resolver. Bodies without import() go
// to the native constructor untouched.
function makeScopedFunction(asyncLoad: (specifier: string) => unknown): FunctionConstructor {
  const Scoped = function Function(this: unknown, ...args: unknown[]): unknown {
    const body = args.length ? String(args[args.length - 1]) : "";
    if (!/\bimport\s*\(/.test(body)) return NativeFunction(...(args as string[]));
    const params = args.slice(0, -1).map(String);
    const inner = NativeFunction("__asyncLoad", ...params, rewriteDynamicImportsRegex(body));
    const wrapped = function (this: unknown, ...callArgs: unknown[]) {
      return inner.call(this, asyncLoad, ...callArgs);
    };
    Object.defineProperty(wrapped, "length", { value: Math.max(0, inner.length - 1) });
    Object.defineProperty(wrapped, "toString", { value: () => inner.toString() });
    return wrapped;
  };
  Scoped.prototype = NativeFunction.prototype;
  return Scoped as unknown as FunctionConstructor;
}

// ── Types ──
export interface RunFileOptions {
  /** Directory relative specifiers resolve from (default: dirname(filename)). */
  resolveDir?: string;
}

export interface ModuleRecord {
  id: string;
  filename: string;
  exports: unknown;
  loaded: boolean;
  children: ModuleRecord[];
  paths: string[];
  parent: ModuleRecord | null;
}

export interface EngineOptions {
  cwd?: string;
  env?: Record<string, string>;
  onConsole?: (method: string, args: unknown[]) => void;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  workerThreadsOverride?: {
    isMainThread: boolean;
    parentPort: unknown;
    workerData: unknown;
    threadId: number;
  };
  handler?: import("./memory-handler").MemoryHandler;
  enableSharedArrayBuffer?: boolean;
  /** Injected transform cache (e.g. the shared worker LRU). Takes precedence
   *  over `handler`'s cache. Must behave like Map<string, string>. */
  transformCache?: Map<string, string>;
}

export interface ResolverFn {
  (id: string): unknown;
  resolve: (id: string, options?: { paths?: string[] }) => string;
  cache: Record<string, ModuleRecord>;
  extensions: Record<string, unknown>;
  main: ModuleRecord | null;
  _ownerRecord?: ModuleRecord;
}

/** Build the Node-compatible import.meta object for a module under `resolver`. */
function importMetaForModule(
  resolver: ResolverFn,
  filename: string,
  dirname: string,
) {
  return createImportMeta({
    filename,
    dirname,
    isMain: resolver.main != null && resolver.main.filename === filename,
    isBuiltin: moduleSysPolyfill.isBuiltin,
    resolvePath: (specifier, fromDir) =>
      resolver.resolve(specifier, { paths: [fromDir] }),
  });
}

// Mutable copy so packages can monkey-patch frozen polyfill namespaces
function shallowCopy(source: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const k of Object.keys(source)) copy[k] = source[k];
  return copy;
}

// ── Core module registry ──
const CORE_MODULES: Record<string, unknown> = {
  path: pathPolyfill,
  http: shallowCopy(httpPolyfill as unknown as Record<string, unknown>),
  https: shallowCopy(httpsPolyfill as unknown as Record<string, unknown>),
  net: tcpPolyfill,
  events: eventBusPolyfill,
  stream: streamPolyfill,
  buffer: bufferPolyfill,
  url: urlPolyfill,
  querystring: qsPolyfill,
  util: helpersPolyfill,
  tty: ttyPolyfill,
  os: osPolyfill,
  crypto: shallowCopy(hashingPolyfill as unknown as Record<string, unknown>),
  zlib: compressionPolyfill,
  dns: dnsPolyfill,
  child_process: shellExecProxy,
  "child_process/promises": new Proxy({} as any, {
    get(_t, prop) {
      if (!_shellExecPolyfill?.promises) return undefined;
      return _shellExecPolyfill.promises[prop];
    },
    ownKeys() {
      if (!_shellExecPolyfill?.promises) return [];
      return Reflect.ownKeys(_shellExecPolyfill.promises);
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (!_shellExecPolyfill?.promises) return undefined;
      return Object.getOwnPropertyDescriptor(_shellExecPolyfill.promises, prop);
    },
    has(_t, prop) {
      if (!_shellExecPolyfill?.promises) return false;
      return prop in _shellExecPolyfill.promises;
    },
  }),
  assert: assertPolyfill,
  string_decoder: stringDecoderPolyfill,
  timers: timersPolyfill,
  constants: constantsPolyfill,
  punycode: punycodePolyfill,
  _http_common: {},
  _http_incoming: {},
  _http_outgoing: {},
  chokidar: watcherPolyfill,
  ws: wsPolyfill,
  fsevents: macEventsPolyfill,
  readdirp: scannerPolyfill,
  module: moduleSysPolyfill.Module,
  perf_hooks: perfPolyfill,
  worker_threads: threadPoolPolyfill,
  esbuild: esbuildPolyfill,
  rollup: rollupPolyfill,
  v8: v8Polyfill,
  readline: lineReaderPolyfill,
  tls: tlsPolyfill,
  http2: http2Polyfill,
  cluster: clusterPolyfill,
  dgram: udpPolyfill,
  vm: vmPolyfill,
  inspector: debugPolyfill,
  "inspector/promises": debugPolyfill,
  async_hooks: asyncCtxPolyfill,
  domain: domainPolyfill,
  diagnostics_channel: tracePolyfill,
  console: { ...console, Console: consolePolyfill.Console },
  repl: replPolyfill,
  test: testPolyfill,
  trace_events: traceEventsPolyfill,
  wasi: wasiPolyfill,
  sea: seaPolyfill,
  sqlite: sqlitePolyfill,
  quic: quicPolyfill,
  // native packages (lightningcss, tailwindcss/oxide, rolldown, @node-rs/*) load via generic WASM fallback, no hardcoded polyfills
  sys: helpersPolyfill,
  "util/types": helpersPolyfill.types,
  "path/posix": pathPolyfill,
  "path/win32": pathPolyfill.win32,
  "timers/promises": timersPromises,
  "stream/promises": streamPromises,
  "zlib/promises": compressionPolyfill.promises,
  "stream/web": {
    ReadableStream: globalThis.ReadableStream,
    WritableStream: globalThis.WritableStream,
    TransformStream: globalThis.TransformStream,
    ByteLengthQueuingStrategy: globalThis.ByteLengthQueuingStrategy,
    CountQueuingStrategy: globalThis.CountQueuingStrategy,
  },
  "stream/consumers": {
    async arrayBuffer(stream: any): Promise<ArrayBuffer> {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        chunks.push(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
        );
      }
      let len = 0;
      for (const c of chunks) len += c.byteLength;
      const buf = new Uint8Array(len);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.byteLength;
      }
      return buf.buffer;
    },
    async blob(stream: any): Promise<Blob> {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        chunks.push(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
        );
      }
      return new Blob(chunks as unknown as BlobPart[]);
    },
    async buffer(stream: any): Promise<Uint8Array> {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        chunks.push(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
        );
      }
      let len = 0;
      for (const c of chunks) len += c.byteLength;
      const buf = new Uint8Array(len);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.byteLength;
      }
      return buf;
    },
    async json(stream: any): Promise<unknown> {
      const chunks: string[] = [];
      for await (const chunk of stream) {
        chunks.push(
          typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
        );
      }
      return JSON.parse(chunks.join(""));
    },
    async text(stream: any): Promise<string> {
      const chunks: string[] = [];
      for await (const chunk of stream) {
        chunks.push(
          typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
        );
      }
      return chunks.join("");
    },
  },
  "dns/promises": dnsPromises,
  "assert/strict": assertPolyfill,
  "readline/promises": readlinePromises,
  _stream_readable: Readable,
  _stream_writable: Writable,
  _stream_duplex: Duplex,
  _stream_transform: Transform,
  _stream_passthrough: PassThrough,
  // Vite imports rollup/parseAst which normally uses native bindings
  "rollup/parseAst": {
    parseAst: rollupPolyfill.parseAst,
    parseAstAsync: rollupPolyfill.parseAstAsync,
  },
  // Vite 8+ imports rolldown/parseAst → oxc wrap(binding.parse()). The WASM
  // binding's parse can return undefined, so wrap crashes on `.errors`. Serve
  // the same acorn Program AST rollup/parseAst already provides.
  "rolldown/parseAst": {
    parseAst: rollupPolyfill.parseAst,
    parseAstAsync: rollupPolyfill.parseAstAsync,
  },
};

// last-resort CDN polyfills used only when a native package fails to load and no WASM npm alt works
// installed WASM packages always win, loaded on-demand
const NATIVE_PACKAGE_POLYFILLS: Record<string, unknown> = {
  // lightningcss-wasm is tried first but its 15.9MB .wasm often fails to extract, so we fall back to loading from CDN
  lightningcss: lightningcssPolyfill,
};

class AsyncModuleInitializationRequired extends Error {
  constructor(
    readonly moduleId: string,
    readonly ready: Promise<unknown>,
  ) {
    super(`Asynchronous initialization is required before loading '${moduleId}'`);
    this.name = "AsyncModuleInitializationRequired";
  }
}

// ── Console wrapper ──
// Captured at module load time to avoid infinite recursion when globalThis.console is overridden
const _nativeConsole = console;

function wrapConsole(
  onConsole?: (method: string, args: unknown[]) => void,
): Console {
  // Route through onConsole callback exclusively when provided, else fall back to browser console
  const nc = _nativeConsole;
  const wrapped = {
    // require("node:console") returns the same callable Console constructor as
    // the core-module namespace, in addition to the process console methods.
    Console: consolePolyfill.Console,
    log: (...args: unknown[]) => {
      if (onConsole) onConsole("log", args);
      else nc.log(...args);
    },
    error: (...args: unknown[]) => {
      if (onConsole) onConsole("error", args);
      else nc.error(...args);
    },
    warn: (...args: unknown[]) => {
      if (onConsole) onConsole("warn", args);
      else nc.warn(...args);
    },
    info: (...args: unknown[]) => {
      if (onConsole) onConsole("info", args);
      else nc.info(...args);
    },
    debug: (...args: unknown[]) => {
      if (onConsole) onConsole("debug", args);
      else nc.debug(...args);
    },
    trace: (...args: unknown[]) => {
      if (onConsole) onConsole("trace", args);
      else nc.trace(...args);
    },
    dir: (obj: unknown) => {
      if (onConsole) onConsole("dir", [obj]);
      else nc.dir(obj);
    },
    time: nc.time.bind(nc),
    timeEnd: nc.timeEnd.bind(nc),
    timeLog: nc.timeLog.bind(nc),
    assert: (...args: unknown[]) => {
      const [v, ...rest] = args;
      if (!v) {
        if (onConsole) onConsole("error", ["Assertion failed:", ...rest]);
        else nc.assert(v as boolean, ...rest);
      }
    },
    clear: nc.clear.bind(nc),
    count: nc.count.bind(nc),
    countReset: nc.countReset.bind(nc),
    group: nc.group.bind(nc),
    groupCollapsed: nc.groupCollapsed.bind(nc),
    groupEnd: nc.groupEnd.bind(nc),
    table: (...args: unknown[]) => {
      if (onConsole) onConsole("log", args);
      else nc.table(...args);
    },
    timeStamp: nc.timeStamp ? nc.timeStamp.bind(nc) : () => {},
    profile: nc.profile ? nc.profile.bind(nc) : () => {},
    profileEnd: nc.profileEnd ? nc.profileEnd.bind(nc) : () => {},
  };
  return wrapped as unknown as Console;
}

// ── Module resolver & loader ──
function buildResolver(
  vol: MemoryVolume,
  fsBridge: FsBridge,
  proc: ProcessObject,
  baseDir: string,
  cache: Record<string, ModuleRecord>,
  opts: EngineOptions,
  codeCache?: Map<string, string>,
  deAsyncImports = false,
): ResolverFn {
  // Shared across all resolvers — avoids re-resolving the same paths/manifests per module
  // Use bounded LRU when a memory handler is available, else plain Map
  const resolveCache: Map<string, string | null> =
    (cache as any).__resolveCache ??
    ((cache as any).__resolveCache = opts.handler
      ? new _LRUCache<string, string | null>(
          opts.handler.options.resolveCacheSize,
        )
      : new Map());
  const manifestCache: Map<string, PackageManifest | null> =
    (cache as any).__manifestCache ??
    ((cache as any).__manifestCache = opts.handler
      ? new _LRUCache<string, PackageManifest | null>(
          opts.handler.options.manifestCacheSize,
        )
      : new Map());
  // Shared across all resolvers — deduplicates same-version packages from nested node_modules
  const _pkgIdentityMap: Record<string, string> =
    (cache as any).__pkgIdentityMap ?? ((cache as any).__pkgIdentityMap = {});

  const readManifest = (manifestPath: string): PackageManifest | null => {
    if (manifestCache.has(manifestPath))
      return manifestCache.get(manifestPath)!;
    // most lookups probe directories without a package.json; skip the ENOENT
    if (!vol.existsSync(manifestPath)) {
      manifestCache.set(manifestPath, null);
      return null;
    }
    try {
      const raw = vol.readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as PackageManifest;
      manifestCache.set(manifestPath, parsed);
      return parsed;
    } catch {
      manifestCache.set(manifestPath, null);
      return null;
    }
  };

  // dir -> whether the nearest package.json declares "type": "module"
  const typeModuleCache: Map<string, boolean> =
    (cache as any).__typeModuleCache ??
    ((cache as any).__typeModuleCache = new Map());
  const isTypeModuleDir = (dir: string): boolean => {
    const cached = typeModuleCache.get(dir);
    if (cached !== undefined) return cached;
    const mf = readManifest(dir === "/" ? "/package.json" : dir + "/package.json");
    let result: boolean;
    if (mf) result = mf.type === "module";
    else if (dir === "/" || dir === "") result = false;
    else result = isTypeModuleDir(pathPolyfill.dirname(dir));
    typeModuleCache.set(dir, result);
    return result;
  };

  const resolveId = (
    id: string,
    fromDir: string,
    preferEsm: boolean = false,
  ): string => {
    if (typeof id !== "string") {
      throw new TypeError(
        `The "id" argument must be of type string. Received ${typeof id}`,
      );
    }
    if (id.startsWith("node:")) id = id.slice(5);

    if (id.startsWith("file:///")) {
      id = decodeURIComponent(id.slice(7));
      if (/^[A-Za-z]:[\\/]/.test(id)) {
        id = "/" + id.slice(2).replace(/\\/g, "/");
      }
    } else if (id.startsWith("file://")) {
      id = decodeURIComponent(id.slice(7));
      if (/^[A-Za-z]:[\\/]/.test(id)) {
        id = "/" + id.slice(2).replace(/\\/g, "/");
      }
    }

    const qIdx = id.indexOf("?");
    if (qIdx !== -1) id = id.slice(0, qIdx);

    const hashIdx = id.indexOf("#");
    if (hashIdx !== -1 && !id.startsWith("#")) id = id.slice(0, hashIdx);

    if (id.includes("\\")) id = id.replace(/\\/g, "/");

    // Only actual Node builtins resolve to their symbolic module id. Other
    // entries in CORE_MODULES are runtime load shims for packages such as
    // rollup and esbuild; require.resolve() must still return their VFS path
    // so callers can derive package metadata from it.
    if (moduleSysPolyfill.isBuiltin(id)) {
      return id;
    }

    // Native Rust bindings can't run in browser — provide JS stubs
    if (id.startsWith("@rollup/rollup-")) {
      if (!CORE_MODULES[id]) {
        CORE_MODULES[id] = {
          parse: rollupPolyfill.parseAst,
          parseAsync: rollupPolyfill.parseAstAsync,
        };
      }
      return id;
    }

    if (id.startsWith("@rolldown/binding-") && !id.includes("wasm32-wasi")) {
      // platform-specific native binding (e.g. @rolldown/binding-linux-x64-gnu) — redirect to the wasm32-wasi variant via the generic napi-rs fallback below
      const e = new Error(
        `Cannot load native addon '${id}' — install @rolldown/binding-wasm32-wasi`,
      ) as Error & { code: string };
      e.code = "MODULE_NOT_FOUND";
      throw e;
    }

    if (id.startsWith("#")) {
      let dir = fromDir;
      while (dir !== "/" && dir) {
        const mf = readManifest(pathPolyfill.join(dir, "package.json"));
        if (mf?.imports) {
          for (const conds of [
            { browser: true, require: true },
            { require: true },
            { browser: true, import: true },
            {},
          ] as const) {
            try {
              const resolved = resolveImports(mf, id, conds);
              if (resolved?.length) {
                const full = pathPolyfill.join(dir, resolved[0]);
                if (vol.existsSync(full)) return full;
                for (const ext of IMPORTS_FIELD_EXTENSIONS) {
                  if (vol.existsSync(full + ext)) return full + ext;
                }
              }
            } catch {
              /* try next condition set */
            }
          }
        }
        const parent = pathPolyfill.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      // Unresolvable # imports get a stub (many are just feature-detection flags)
      const stubPath = `/node_modules/.nodepod-stubs/${id.slice(1)}.js`;
      if (!vol.existsSync(stubPath)) {
        vol.mkdirSync(pathPolyfill.dirname(stubPath), { recursive: true });
        vol.writeFileSync(stubPath, "module.exports = {};");
      }
      return stubPath;
    }

    const cacheKey = `${fromDir}|${id}`;
    const cached = resolveCache.get(cacheKey);
    if (cached !== undefined) {
      if (cached === null) {
        const e = new Error(`Cannot find module '${id}'`) as Error & {
          code: string;
        };
        e.code = "MODULE_NOT_FOUND";
        throw e;
      }
      return cached;
    }

    const tryFile = (base: string): string | null => {
      if (vol.existsSync(base)) {
        const s = vol.statSync(base);
        if (s.isFile()) return base;
        const localMf = readManifest(pathPolyfill.join(base, "package.json"));
        if (localMf?.main) {
          const mainPath = pathPolyfill.join(base, localMf.main);
          if (vol.existsSync(mainPath)) {
            const ms = vol.statSync(mainPath);
            if (ms.isFile()) return mainPath;
          }
          for (const ext of MAIN_FIELD_EXTENSIONS) {
            const withExt = mainPath + ext;
            if (vol.existsSync(withExt)) return withExt;
          }
        }
        for (const idx of INDEX_FILES) {
          const idxPath = pathPolyfill.join(base, idx);
          if (vol.existsSync(idxPath)) return idxPath;
        }
      }
      for (const ext of [...MAIN_FIELD_EXTENSIONS, ".node"]) {
        const withExt = base + ext;
        if (vol.existsSync(withExt)) return withExt;
      }
      return null;
    };

    if (id === "." || id === "..") id = id + "/";
    if (id.startsWith("./") || id.startsWith("../") || id.startsWith("/")) {
      const abs = id.startsWith("/") ? id : pathPolyfill.resolve(fromDir, id);
      const found = tryFile(abs);
      if (found) {
        resolveCache.set(cacheKey, found);
        return found;
      }

      resolveCache.set(cacheKey, null);
      const e = new Error(
        `Cannot find module '${id}' from '${fromDir}'`,
      ) as Error & { code: string };
      e.code = "MODULE_NOT_FOUND";
      throw e;
    }

    const applyBrowserRemap = (
      resolved: string,
      manifest: PackageManifest,
      pkgRoot: string,
    ): string | null => {
      if (!manifest.browser || typeof manifest.browser !== "object")
        return resolved;
      const map = manifest.browser as Record<string, string | false>;
      const rel = "./" + pathPolyfill.relative(pkgRoot, resolved);
      const relNoExt = rel.replace(/\.(js|json|cjs|mjs)$/, "");
      for (const k of [rel, relNoExt]) {
        if (k in map) {
          if (map[k] === false) return null;
          return tryFile(pathPolyfill.join(pkgRoot, map[k] as string));
        }
      }
      return resolved;
    };

    const tryNodeModules = (nmDir: string, moduleId: string): string | null => {
      const parts = moduleId.split("/");
      const pkgName =
        parts[0].startsWith("@") && parts.length > 1
          ? `${parts[0]}/${parts[1]}`
          : parts[0];

      const pkgRoot = pathPolyfill.join(nmDir, pkgName);
      const mfPath = pathPolyfill.join(pkgRoot, "package.json");
      const manifest = readManifest(mfPath);

      if (manifest) {
        let exportsResolved = false;
        if (manifest.exports) {
          const subpath =
            moduleId === pkgName
              ? "."
              : "./" + moduleId.slice(pkgName.length + 1);

          // Custom export conditions from --conditions flag / NODE_OPTIONS
          const extraConditions: string[] = [];
          const execArgv: string[] = proc.execArgv || [];
          for (let ai = 0; ai < execArgv.length; ai++) {
            const arg = execArgv[ai];
            if (arg === "--conditions" || arg === "-C") {
              if (ai + 1 < execArgv.length)
                extraConditions.push(execArgv[++ai]);
            } else if (arg.startsWith("--conditions=")) {
              extraConditions.push(arg.slice("--conditions=".length));
            }
          }
          const nodeOpts = proc.env?.NODE_OPTIONS || "";
          const condMatch = nodeOpts.matchAll(/(?:--conditions[= ]|-C )(\S+)/g);
          for (const m of condMatch) extraConditions.push(m[1]);
          const condExtra =
            extraConditions.length > 0 ? { conditions: extraConditions } : {};

          // for WASM packages prefer Node.js conditions — browser entry needs native Worker(url) or async init, Node.js entry uses polyfilled worker_threads and sync init
          const isWasmPkg = pkgName.includes("wasm32-wasi") || pkgName.endsWith("-wasm") || (Array.isArray((manifest as any).cpu) && (manifest as any).cpu.includes("wasm32"));
          const baseSets: Record<string, unknown>[] = isWasmPkg
            ? [
                { node: true, require: true, ...condExtra },
                { require: true, ...condExtra },
                { node: true, import: true, ...condExtra },
                { import: true, ...condExtra },
              ]
            : preferEsm
            ? [
                { node: true, import: true, ...condExtra },
                { browser: true, import: true, ...condExtra },
                { import: true, ...condExtra },
                { node: true, require: true, ...condExtra },
                { browser: true, require: true, ...condExtra },
                { require: true, ...condExtra },
              ]
            : [
                { node: true, require: true, ...condExtra },
                { browser: true, require: true, ...condExtra },
                { require: true, ...condExtra },
                { node: true, import: true, ...condExtra },
                { browser: true, import: true, ...condExtra },
                { import: true, ...condExtra },
              ];

          for (const conds of baseSets) {
            try {
              const resolved = resolveExports(manifest, subpath, conds);
              if (resolved?.length) {
                const full = pathPolyfill.join(pkgRoot, resolved[0]);
                const found = tryFile(full);
                if (found) {
                  if (found.endsWith(".cjs")) {
                    try {
                      const content = vol.readFileSync(found, "utf8");
                      if (content.trimStart().startsWith("throw ")) continue;
                    } catch {
                      /* proceed */
                    }
                  }
                  exportsResolved = true;
                  return found;
                }
              }
            } catch {
              /* try next */
            }
          }
        }

        if (!exportsResolved && pkgName === moduleId) {
          let entry: string | undefined;
          // for WASM packages prefer Node.js "main" over "browser" — same reason as above (browser entry needs native Worker(url) or async init)
          const isWasmPkg = pkgName.includes("wasm32-wasi") || pkgName.endsWith("-wasm") || (Array.isArray((manifest as any).cpu) && (manifest as any).cpu.includes("wasm32"));
          if (!isWasmPkg && typeof manifest.browser === "string") entry = manifest.browser;
          if (!entry && manifest.module) entry = manifest.module as string;
          if (!entry) entry = manifest.main || "index.js";
          let found = tryFile(pathPolyfill.join(pkgRoot, entry));
          // apply browser field object remapping (e.g. lightningcss maps "./node/index.js" to "./browser.js")
          if (found && !isWasmPkg) {
            const remapped = applyBrowserRemap(found, manifest, pkgRoot);
            if (remapped === null) found = null; // browser: { "./file": false } means "ignore"
            else if (remapped !== found) found = remapped;
          }
          if (found) return found;
        }
      }

      const directPath = pathPolyfill.join(nmDir, moduleId);
      return tryFile(directPath);
    };

    let searchDir = fromDir;
    while (searchDir !== "/") {
      const nmDir = pathPolyfill.join(searchDir, "node_modules");
      const found = tryNodeModules(nmDir, id);
      if (found) {
        resolveCache.set(cacheKey, found);
        return found;
      }
      searchDir = pathPolyfill.dirname(searchDir);
    }

    const rootFound = tryNodeModules("/node_modules", id);
    if (rootFound) {
      resolveCache.set(cacheKey, rootFound);
      return rootFound;
    }

    // Fallback: resolve from cwd (handles modules loaded from temp/bundled locations)
    const cwd = proc.cwd();
    if (cwd !== fromDir && cwd !== "/") {
      let fallbackDir = cwd;
      while (fallbackDir !== "/" && fallbackDir !== fromDir) {
        const nmDir = pathPolyfill.join(fallbackDir, "node_modules");
        const found = tryNodeModules(nmDir, id);
        if (found) {
          resolveCache.set(cacheKey, found);
          return found;
        }
        fallbackDir = pathPolyfill.dirname(fallbackDir);
      }
    }

    resolveCache.set(cacheKey, null);
    const e = new Error(
      `Cannot find module '${id}' from '${fromDir}'`,
    ) as Error & { code: string };
    e.code = "MODULE_NOT_FOUND";
    throw e;
  };

  const loadModule = (
    resolved: string,
    parentRecord?: ModuleRecord,
  ): ModuleRecord => {
    if (cache[resolved]) return cache[resolved];

    // Package dedup: reuse first instance of name@version:path to prevent
    // "Cannot use X from another module or realm" errors
    const nmIdx = resolved.lastIndexOf("/node_modules/");
    // installed package this module belongs to: its transforms are shared
    // with other processes through the main thread's transform store
    let sharedScope: string | null = null;
    let sharedRel = "";
    if (nmIdx !== -1) {
      const afterNm = resolved.slice(nmIdx + "/node_modules/".length);
      const parts = afterNm.split("/");
      const pkgName = parts[0].startsWith("@")
        ? parts[0] + "/" + parts[1]
        : parts[0];
      const pkgDir = resolved.slice(0, nmIdx) + "/node_modules/" + pkgName;
      const pkgJson = readManifest(pkgDir + "/package.json");
      if (pkgJson) {
        sharedScope = `${transformSalt()}|${pkgName}@${pkgJson.version || "0.0.0"}`;
        sharedRel = afterNm.slice(pkgName.length + 1);
        // Include file path so different subpath exports (svelte vs svelte/compiler) aren't deduped
        const identity =
          pkgName + "@" + (pkgJson.version || "0.0.0") + ":" + afterNm;
        if (!_pkgIdentityMap[identity]) {
          _pkgIdentityMap[identity] = resolved;
        } else if (_pkgIdentityMap[identity] !== resolved) {
          // Only reuse fully-loaded modules — returning mid-execution ones causes "X is not a function"
          const canonical = _pkgIdentityMap[identity];
          if (cache[canonical] && cache[canonical].loaded) {
            cache[resolved] = cache[canonical];
            return cache[canonical];
          }
        }
      }
    }

    const _loadDepth = ((globalThis as any).__loadModuleDepth ?? 0) + 1;
    (globalThis as any).__loadModuleDepth = _loadDepth;

    const record: ModuleRecord = {
      id: resolved,
      filename: resolved,
      exports: {},
      loaded: false,
      children: [],
      paths: [],
      parent: parentRecord ?? null,
    };
    if (parentRecord) parentRecord.children.push(record);

    cache[resolved] = record;

    if (resolved.endsWith(".json")) {
      const raw = vol.readFileSync(resolved, "utf8");
      record.exports = JSON.parse(raw);
      record.loaded = true;
      return record;
    }

    // Native .node addons cannot run in the browser — throw so that
    // callers (e.g. napi-rs packages) fall back to their WASM build.
    if (resolved.endsWith(".node")) {
      delete cache[resolved];
      const e = new Error(
        `Cannot load native addon '${resolved}' — native .node binaries are not supported in the browser`,
      ) as Error & { code: string };
      e.code = "ERR_DLOPEN_FAILED";
      throw e;
    }

    // raw .wasm bytes — napi-rs loaders read these via fs.readFileSync and feed them to WebAssembly.instantiate
    if (resolved.endsWith(".wasm")) {
      record.exports = vol.readFileSync(resolved);
      record.loaded = true;
      return record;
    }

    const rawSource = vol.readFileSync(resolved, "utf8");
    const dir = pathPolyfill.dirname(resolved);
    const moduleExportName = pickModuleExportName(rawSource);

    const sourceDigest = contentDigest(rawSource);
    const codeCacheKey = `${resolved}|${sourceDigest}`;
    let processedCode = codeCache?.get(codeCacheKey);
    if (processedCode === SAME_AS_SOURCE) processedCode = rawSource;
    let moduleHasTLA = codeCache?.get(`${codeCacheKey}|tla`) === "1";
    // "f" marks output of the lexer fast path, which is re-derived through
    // the full AST path if V8 rejects it (see the eval below).
    let usedFastPath = codeCache?.get(`${codeCacheKey}|fast`) === "1";

    const transformSource = (allowFast: boolean): void => {
      processedCode = rawSource;
      usedFastPath = false;
      if (processedCode.startsWith("#!")) {
        processedCode = processedCode.slice(processedCode.indexOf("\n") + 1);
      }
      if (isTypeScriptFile(resolved)) {
        processedCode = stripTypeScript(processedCode, resolved);
      }
      const fast =
        allowFast && !deAsyncImports
          ? fastCommonJsTransform(processedCode, resolved, isTypeModuleDir)
          : null;
      if (fast !== null) {
        processedCode = fast;
        moduleHasTLA = false;
        usedFastPath = true;
      } else if (resolved.endsWith(".cjs")) {
        // CJS: only rewrite import()/import.meta via AST, skip full ESM conversion
        try {
          const cjsAst = acorn.parse(processedCode, {
            ecmaVersion: "latest",
            sourceType: "script",
            allowImportExportEverywhere: true,
          });
          const cjsPatches: Array<[number, number, string]> = [];
          const walkCjs = (node: any) => {
            if (!node || typeof node !== "object") return;
            if (Array.isArray(node)) {
              for (const c of node) walkCjs(c);
              return;
            }
            if (typeof node.type !== "string") return;
            if (node.type === "ImportExpression") {
              cjsPatches.push([node.start, node.start + 6, "__asyncLoad"]);
            }
            if (
              node.type === "MetaProperty" &&
              node.meta?.name === "import" &&
              node.property?.name === "meta"
            ) {
              // Use the wrapper's $importMeta binding (resolve/main included)
              cjsPatches.push([node.start, node.end, "import_meta"]);
            }
            for (const key of Object.keys(node)) {
              if (key === "type" || key === "start" || key === "end") continue;
              const val = node[key];
              if (val && typeof val === "object") walkCjs(val);
            }
          };
          walkCjs(cjsAst);
          processedCode = applyPatches(processedCode!, cjsPatches);
        } catch {
          /* can't parse — leave untransformed */
        }
      } else {
        const converted = convertModuleSyntaxDetailed(
          processedCode,
          resolved,
          moduleExportName,
        );
        processedCode = converted.code;
        moduleHasTLA = converted.hasTLA;
      }
      codeCache?.set(
        codeCacheKey,
        processedCode === rawSource ? SAME_AS_SOURCE : processedCode!,
      );
      codeCache?.set(`${codeCacheKey}|tla`, moduleHasTLA ? "1" : "0");
      codeCache?.set(`${codeCacheKey}|fast`, usedFastPath ? "1" : "0");
    };

    const sharedTransforms = sharedScope ? getSharedTransformClient() : null;
    const sharedKey = sharedTransforms
      ? `${sharedRel}|${rawSource.length}|${sourceDigest}`
      : "";
    if (processedCode === undefined && sharedTransforms) {
      const hit = takeSharedTransform(sharedTransforms, sharedScope!, sharedKey);
      if (hit) {
        const same = (hit[1] & FLAG_SAME_AS_SOURCE) !== 0;
        processedCode = same ? rawSource : hit[0];
        moduleHasTLA = (hit[1] & 1) !== 0;
        usedFastPath = (hit[1] & 2) !== 0;
        codeCache?.set(codeCacheKey, same ? SAME_AS_SOURCE : processedCode);
        codeCache?.set(`${codeCacheKey}|tla`, moduleHasTLA ? "1" : "0");
        codeCache?.set(`${codeCacheKey}|fast`, usedFastPath ? "1" : "0");
      }
    }
    const publishTransform = (): void => {
      if (!sharedTransforms) return;
      const same = processedCode === rawSource;
      // a transform that baked this file's absolute location in (the regex
      // fallback's import.meta values) only fits this path: keep it local
      if (!same && processedCode!.includes(dir) && !rawSource.includes(dir)) return;
      sharedTransforms.put(
        sharedScope!,
        sharedKey,
        same ? "" : processedCode!,
        (moduleHasTLA ? 1 : 0) | (usedFastPath ? 2 : 0) | (same ? FLAG_SAME_AS_SOURCE : 0),
      );
    };
    if (processedCode === undefined) {
      transformSource(true);
      publishTransform();
    }

    const isCjs = resolved.endsWith(".cjs");
    let useFullDeAsync = false;
    let childResolver!: ResolverFn;
    const finishTransform = (): void => {
      if (!isCjs && !codeCache?.has(`${codeCacheKey}|tla`)) {
        moduleHasTLA = hasTopLevelAwait(processedCode!);
      }
      useFullDeAsync = deAsyncImports || moduleHasTLA;
      // Without top-level await (and outside de-async mode) the top-level-only
      // strip is a no-op, so skip its full re-parse.
      if (!isCjs && useFullDeAsync)
        processedCode = stripTopLevelAwait(
          processedCode!,
          deAsyncImports ? "full" : "topLevelOnly",
        );

      childResolver = buildResolver(
        vol,
        fsBridge,
        proc,
        dir,
        cache,
        opts,
        codeCache,
        useFullDeAsync,
      );
      childResolver.cache = cache;
      childResolver._ownerRecord = record;
    };
    finishTransform();

    const wrappedConsole = wrapConsole(opts.onConsole);

    try {
      let wrapper = buildModuleWrapper(processedCode!, { moduleExportName });

      let fn;
      try {
        fn = (0, eval)(wrapper);
      } catch (syntaxErr) {
        if (usedFastPath && syntaxErr instanceof SyntaxError) {
          // The lexer classified this as CommonJS but V8 disagrees (e.g.
          // top-level await in a script-looking file). Re-derive it through
          // the full AST transform.
          transformSource(false);
          publishTransform();
          finishTransform();
          wrapper = buildModuleWrapper(processedCode!, { moduleExportName });
          try {
            fn = (0, eval)(wrapper);
          } catch (retryErr) {
            const msg =
              retryErr instanceof Error ? retryErr.message : String(retryErr);
            throw new SyntaxError(`${msg} (in ${resolved})`);
          }
        } else {
          const msg =
            syntaxErr instanceof Error ? syntaxErr.message : String(syntaxErr);
          throw new SyntaxError(`${msg} (in ${resolved})`);
        }
      }

      const asyncLoader = makeDynamicLoader(childResolver);
      fn(
        record.exports,
        childResolver,
        record,
        resolved,
        dir,
        proc,
        wrappedConsole,
        importMetaForModule(childResolver, resolved, dir),
        asyncLoader,
        syncAwait,
        syncAwaitFn,
        SyncPromiseClass,
      );

      record.loaded = true;
      patchFetchNodeAdapterExports(
        record.exports as Record<string, unknown>,
      );
      (globalThis as any).__loadModuleDepth = _loadDepth - 1;
    } catch (err) {
      (globalThis as any).__loadModuleDepth = _loadDepth - 1;
      delete cache[resolved];
      // >8MB WASM: retry with async compilation APIs
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        errMsg.includes("disallowed on the main thread") ||
        errMsg.includes("buffer size is larger than") ||
        errMsg.includes("__WASM_COMPILE_PENDING__")
      ) {
        let asyncCode = processedCode!;
        asyncCode = asyncCode.replace(
          /new\s+WebAssembly\.Module\b/g,
          "await __wasmCompile",
        );
        asyncCode = asyncCode.replace(
          /new\s+WebAssembly\.Instance\b/g,
          "await __wasmInstantiate",
        );

        const asyncWrapper = buildModuleWrapper(asyncCode, {
          async: true,
          useNativePromise: true,
          includeViteVars: false,
          hideBrowserGlobals: false,
          wasmHelpers: true,
          moduleExportName,
        });
        try {
          const asyncFn = (0, eval)(asyncWrapper);
          const asyncLoader = makeDynamicLoader(childResolver);
          const wasmReady = asyncFn(
            record.exports,
            childResolver,
            record,
            resolved,
            dir,
            proc,
            wrappedConsole,
            importMetaForModule(childResolver, resolved, dir),
            asyncLoader,
            syncAwait,
            syncAwaitFn,
            SyncPromiseClass,
          );
          record.loaded = true;
          patchFetchNodeAdapterExports(
            record.exports as Record<string, unknown>,
          );
          (record as any).__wasmReady = wasmReady;
          cache[resolved] = record;
        } catch (retryErr) {
          if (err instanceof Error && !err.message.includes("(in /")) {
            err.message = `${err.message} (in ${resolved})`;
          }
          throw err;
        }
        return record;
      }

      if (err instanceof Error && !err.message.includes("(in /")) {
        err.message = `${err.message} (in ${resolved})`;
      }
      throw err;
    }

    return record;
  };

  // Typed as ResolverFn only after resolve/cache/extensions/main are attached
  // below — defineProperty(main) is invisible to the checker at declaration.
  const resolver = ((id: string): unknown => {
    if (typeof id !== "string") {
      // Match real Node.js error: TypeError with ERR_INVALID_ARG_TYPE code
      const err: any = new TypeError(
        `The "id" argument must be of type string. Received ${id === null ? "null" : typeof id}`,
      );
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    if (id.startsWith("node:")) id = id.slice(5);

    if (id === "fs") return fsBridge;
    if (id === "fs/promises") return fsBridge.promises;
    if (id === "process") return proc;
    if (id === "console") return wrapConsole(opts.onConsole);
    if (id === "zlib") {
      // brotli WASM is lazy now — kick the load on first require so sync
      // brotli APIs are usually ready by the time code calls them
      compressionPolyfill.preloadBrotli().catch(() => {});
      return CORE_MODULES["zlib"];
    }
    if (id === "sqlite") {
      sqlitePolyfill.preloadSqlite().catch(() => {});
      return CORE_MODULES["sqlite"];
    }
    if (id === "worker_threads") {
      if (opts.workerThreadsOverride) {
        const base = CORE_MODULES["worker_threads"];
        const override = Object.assign(
          Object.create(null),
          base,
          opts.workerThreadsOverride,
        );
        override.default = override;
        return override;
      }
      return CORE_MODULES["worker_threads"];
    }
    if (id === "module") {
      // Per-engine Module so fork() doesn't clobber parent's _resolveFilename
      const OrigModule = moduleSysPolyfill.Module;

      function PerEngineModule(this: any, mid?: string, parent?: any) {
        OrigModule.call(this, mid, parent);
      }
      PerEngineModule.prototype = OrigModule.prototype;

      const liveCreateRequire = (from: string) => {
        let fromPath = from;
        if (from.startsWith("file://")) {
          fromPath = decodeURIComponent(from.slice(7));
          if (fromPath.startsWith("/") && fromPath[2] === ":")
            fromPath = fromPath.slice(1);
        }
        const childDir = pathPolyfill.dirname(fromPath);
        const child = buildResolver(
          vol,
          fsBridge,
          proc,
          childDir,
          cache,
          opts,
          codeCache,
          deAsyncImports,
        );
        child.cache = cache;
        return child;
      };

      PerEngineModule.createRequire = liveCreateRequire;
      PerEngineModule._cache = cache;
      PerEngineModule._resolveFilename = (
        request: string,
        parent?: any,
        isMain?: boolean,
        options?: any,
      ) => {
        if (typeof request !== "string") {
          const err: any = new Error(`Cannot find module '${request}'`);
          err.code = "MODULE_NOT_FOUND";
          throw err;
        }
        if (options?.paths && Array.isArray(options.paths)) {
          for (const p of options.paths) {
            try {
              return resolveId(request, p);
            } catch {
              /* try next */
            }
          }
        }
        if (parent?.paths && Array.isArray(parent.paths)) {
          for (const p of parent.paths) {
            try {
              const dir = p.endsWith("/node_modules")
                ? pathPolyfill.dirname(p)
                : p;
              return resolveId(request, dir);
            } catch {
              /* try next */
            }
          }
        }
        const fromDir = parent?.filename
          ? pathPolyfill.dirname(parent.filename)
          : baseDir;
        try {
          return resolveId(request, fromDir);
        } catch {
          const err: any = new Error(`Cannot find module '${request}'`);
          err.code = "MODULE_NOT_FOUND";
          throw err;
        }
      };
      PerEngineModule._load = (
        request: string,
        parent?: any,
        isMain?: boolean,
      ) => {
        try {
          return resolver(request);
        } catch {
          return moduleSysPolyfill._load(request, parent, isMain);
        }
      };

      PerEngineModule.builtinModules = moduleSysPolyfill.builtinModules;
      PerEngineModule.isBuiltin = moduleSysPolyfill.isBuiltin;
      PerEngineModule._extensions = moduleSysPolyfill._extensions;
      PerEngineModule._pathCache = moduleSysPolyfill._pathCache;
      PerEngineModule._nodeModulePaths = moduleSysPolyfill._nodeModulePaths;
      PerEngineModule._findPath = moduleSysPolyfill._findPath;
      PerEngineModule.syncBuiltinESMExports =
        moduleSysPolyfill.syncBuiltinESMExports;
      PerEngineModule.findSourceMap = moduleSysPolyfill.findSourceMap;
      PerEngineModule.SourceMap = moduleSysPolyfill.SourceMap;
      PerEngineModule.wrap = moduleSysPolyfill.wrap;
      PerEngineModule.wrapper = moduleSysPolyfill.wrapper;
      PerEngineModule.Module = PerEngineModule;
      PerEngineModule.runMain = OrigModule.runMain;
      PerEngineModule._preloadModules = OrigModule._preloadModules;
      PerEngineModule._initPaths = OrigModule._initPaths;
      PerEngineModule.globalPaths = OrigModule.globalPaths;
      (PerEngineModule as any).default = PerEngineModule;
      return PerEngineModule;
    }
    // inject VFS-backed fs into WASI so any napi-rs .wasi.cjs loader gets filesystem access
    if (id === "wasi") {
      const origWASI = wasiPolyfill.WASI;
      return {
        ...wasiPolyfill,
        WASI: function WASIWithFs(this: any, options?: any) {
          const opts = { ...options };
          if (!opts.fs) opts.fs = fsBridge;
          return new (origWASI as any)(opts);
        },
      };
    }

    if (CORE_MODULES[id]) return CORE_MODULES[id];

    let resolved: string;
    try {
      resolved = resolveId(id, baseDir);
    } catch (resolveErr: any) {
      if (
        resolveErr?.code === "MODULE_NOT_FOUND" &&
        !id.startsWith("./") &&
        !id.startsWith("../")
      ) {
        // --- Determine WASM alternative package name(s) to try ---
        const wasmAlts: string[] = [];

        if (id.includes("wasm32-wasi")) {
          // Explicit wasm32-wasi package — auto-install as-is
          wasmAlts.push(id);
        } else {
          // Platform-specific native package pattern:
          //   {name}-{platform}-{arch}[-{abi}]
          // e.g. lightningcss-linux-x64-gnu, @pkg/core-darwin-arm64
          const platformRe =
            /^(.+)-(darwin|linux|win32|freebsd|android|sunos)-(x64|x86|arm64|arm|ia32|s390x|ppc64|mips64el|riscv64)(-[a-z]+)?$/;
          const m = id.match(platformRe);
          if (m) {
            const baseName = m[1]; // e.g. "lightningcss" or "@scope/pkg"
            wasmAlts.push(baseName + "-wasm32-wasi");
            wasmAlts.push(baseName + "-wasm");
          }
        }

        // Try resolving any of the WASM alternatives (already installed)
        for (const alt of wasmAlts) {
          resolveCache.delete(`${baseDir}|${alt}`);
          try {
            const altResolved = resolveId(alt, baseDir);
            const altRec = loadModule(altResolved, resolver._ownerRecord);
            return altRec.exports;
          } catch (altErr: any) {
            if (altErr instanceof AsyncModuleInitializationRequired) throw altErr;
            // not installed yet
          }
        }
      }
      throw resolveErr;
    }
    if (CORE_MODULES[resolved]) return CORE_MODULES[resolved];

    // package exports resolve rolldown/parseAst to a concrete file; still
    // short-circuit so we never hit the broken binding.parse → wrap(.errors) path
    if (
      /\/rolldown\/dist\/parse-ast-index\.(mjs|js|cjs)$/.test(resolved) ||
      resolved.endsWith("/rolldown/parseAst")
    ) {
      return CORE_MODULES["rolldown/parseAst"];
    }

    let rec: ModuleRecord;
    try {
      rec = loadModule(resolved, resolver._ownerRecord);
    } catch (loadErr: any) {
      // When a bare module fails to load (e.g. native binding not found inside
      // the module), try a WASM drop-in replacement: {name}-wasm or {name}-wasm32-wasi
      if (
        !id.startsWith("./") &&
        !id.startsWith("../") &&
        !id.startsWith("/") &&
        (loadErr?.code === "MODULE_NOT_FOUND" ||
          loadErr?.code === "ERR_DLOPEN_FAILED" ||
          (loadErr?.message &&
            /cannot\s+(find|load)\s+(module|native)/i.test(loadErr.message)))
      ) {
        const wasmAlts = [id + "-wasm32-wasi", id + "-wasm"];
        for (const alt of wasmAlts) {
          try {
            resolveCache.delete(`${baseDir}|${alt}`);
            const altResolved = resolveId(alt, baseDir);
            const altRec = loadModule(altResolved, resolver._ownerRecord);
            return altRec.exports;
          } catch (altErr: any) {
            if (altErr instanceof AsyncModuleInitializationRequired) throw altErr;
            // surface WASM alt errors so they don't silently vanish
            if (altErr?.code !== "MODULE_NOT_FOUND") {
              _nativeConsole.warn(`[wasm-fallback] ${alt}:`, altErr?.message?.slice(0, 200));
            }
          }
        }
        // last resort — built-in CDN polyfill (e.g. lightningcss)
        // if it has async init(), signal the async module runner to await it and retry
        const polyfillFallback = NATIVE_PACKAGE_POLYFILLS[id] as any;
        if (polyfillFallback) {
          if (typeof polyfillFallback.init === "function") {
            const ready = typeof polyfillFallback.isReady === "function"
              ? polyfillFallback.isReady()
              : false;
            if (!ready) {
              const initResult = polyfillFallback.init();
              if (typeof initResult?.then === "function") {
                const initPromise = Promise.resolve(initResult);
                // A synchronous caller cannot observe the eventual rejection;
                // keep it attached while async callers await the same promise.
                initPromise.catch(() => {});
                throw new AsyncModuleInitializationRequired(id, initPromise);
              }
            }
          }
          return polyfillFallback;
        }
      }
      throw loadErr;
    }
    // Proxy for async WASM — reads from rec.exports at access time so
    // reassigned module.exports is picked up after compilation finishes
    if ((rec as any).__wasmReady) {
      return new Proxy(Object.create(null), {
        get(_t, prop) {
          const ex = rec.exports as any;
          if (ex && prop in ex) return ex[prop];
          return undefined;
        },
        set(_t, prop, val) {
          (rec.exports as any)[prop] = val;
          return true;
        },
        has(_t, prop) {
          return rec.exports ? prop in (rec.exports as any) : false;
        },
        ownKeys() {
          return rec.exports ? Reflect.ownKeys(rec.exports as any) : [];
        },
        getOwnPropertyDescriptor(_t, prop) {
          if (!rec.exports) return undefined;
          return Object.getOwnPropertyDescriptor(rec.exports as any, prop);
        },
      });
    }
    return rec.exports;
  }) as ResolverFn;

  resolver.resolve = (id: string, options?: { paths?: string[] }): string => {
    // CORE_MODULES also contains non-builtin package shims (for example
    // rollup and esbuild). Keep those in the normal VFS resolver so
    // require.resolve("rollup") returns /.../node_modules/rollup/... rather
    // than the bare string "rollup".
    if (moduleSysPolyfill.isBuiltin(id)) return id;
    if (options?.paths && Array.isArray(options.paths)) {
      for (const p of options.paths) {
        try {
          return resolveId(id, p);
        } catch {
          /* try next */
        }
      }
    }
    return resolveId(id, baseDir);
  };

  resolver.cache = cache;
  resolver.extensions = {
    ".js": () => {},
    ".json": () => {},
    ".node": () => {},
    ".ts": () => {},
    ".tsx": () => {},
    ".mjs": () => {},
    ".cjs": () => {},
  };
  // Share the process entry module across child resolvers (require.main /
  // import.meta.main). Set via markResolverMain() from execute/runFileTLA.
  Object.defineProperty(resolver, "main", {
    configurable: true,
    enumerable: true,
    get: () => ((cache as any).__mainModule as ModuleRecord | null) ?? null,
    set: (mod: ModuleRecord | null) => {
      (cache as any).__mainModule = mod;
    },
  });
  return resolver;
}

function markResolverMain(resolver: ResolverFn, mod: ModuleRecord): void {
  if (resolver.main == null) resolver.main = mod;
}

// ── ScriptEngine class ──
export class ScriptEngine {
  private vol: MemoryVolume;
  private fsBridge: FsBridge;
  private proc: ProcessObject;
  private moduleRegistry: Record<string, ModuleRecord> = {};
  private opts: EngineOptions;
  private transformCache: Map<string, string>;

  constructor(vol: MemoryVolume, opts: EngineOptions = {}) {
    // Precedence: explicit injected cache > handler's LRU > plain Map
    if (opts.transformCache) {
      this.transformCache = opts.transformCache;
    } else if (opts.handler) {
      this.transformCache = opts.handler.transformCache as unknown as Map<
        string,
        string
      >;
    } else {
      this.transformCache = new Map();
    }
    // before any napi-rs / emnapi package loads: host MessagePort.ref must
    // keep the event loop alive (emnapi WaitingRequestCounter).
    threadPoolPolyfill.installHostMessagePortKeepAlive();
    this.vol = vol;
    this.proc = buildProcessEnv({
      cwd: opts.cwd || "/",
      env: opts.env,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
    });
    this.fsBridge = buildFileSystemBridge(vol, () => this.proc.cwd());
    this.opts = opts;

    // Don't call initShellExec here — Nodepod.boot() sets up the shell with correct cwd
    import("./polyfills/child_process")
      .then((mod) => {
        _shellExecPolyfill = mod;
        _initShellExec = mod.initShellExec;
      })
      .catch(() => {
        /* shell unavailable in this environment */
      });
    watcherPolyfill.setVolume(vol);
    scannerPolyfill.setVolume(vol);
    sqlitePolyfill.setVolume(vol);
    sqlitePolyfill.setSqliteCwd(opts.cwd ?? "/");
    esbuildPolyfill.setVolume(vol);
    rollupPolyfill.setVFSBridge(
      (path, opts) => vol.mkdirSync(path, opts),
      (path, data) => vol.writeFileSync(path, data),
    );

    (globalThis as any).__nodepodVolume = vol;

    // generic napi-rs WASI worker hook — overrides Worker constructor to detect wasi-worker.mjs scripts and spawn them as real Web Workers with bundled deps, everything else falls back to the fork-based worker
    // works for any napi-rs WASM package
    {
      const resolverForWorker = (id: string, fromDir: string): string => {
        const r = buildResolver(vol, this.fsBridge, this.proc, fromDir, this.moduleRegistry, this.opts, this.transformCache);
        return r.resolve(id);
      };
      const workerFactory = createNapiWorkerFactory(
        vol,
        resolverForWorker,
        this.proc.env as Record<string, string>,
        this.fsBridge,
        threadPoolPolyfill.getWorkerThreadForkCallback(),
        this.opts.enableSharedArrayBuffer ?? true,
      );
      threadPoolPolyfill.setWorkerConstructorOverride((self, script, opts) => {
        workerFactory.call(self, script, opts);
      });
      // prewarm now while the parent thread is free. chrome wont schedule
      // child workers spawned from a parent thats about to Atomics.wait
    }

    // Next.js createAsyncLocalStorage() prefers globalThis.AsyncLocalStorage over
    // require('async_hooks'). Install our propagation-aware polyfill so
    // workUnitAsyncStorage / workAsyncStorage survive await boundaries.
    asyncCtxPolyfill.installAsyncContext();
    if (!(globalThis as any).AsyncLocalStorage?.__nodepodAsyncCtx) {
      (globalThis as any).AsyncLocalStorage = asyncCtxPolyfill.AsyncLocalStorage;
      ((globalThis as any).AsyncLocalStorage as any).__nodepodAsyncCtx = true;
    }

    // Intercept fetch() for file:// URLs — serve from VFS instead of network.
    // napi-rs wasm32-wasi packages use fetch(new URL('file.wasm', import.meta.url))
    // which browsers block. This patches fetch to read from the in-memory filesystem.
    // every fetch also registers a FetchRequest Handle so the loop stays
    // alive until the request settles. matches node's undici.
    if (!(globalThis.fetch as any).__nodepodPatched) {
      const origFetch = globalThis.fetch.bind(globalThis);
      const patchedFetch = (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const handle = getRegistry().register("FetchRequest");
        const doFetch = (): Promise<Response> => {
          let url: string | undefined;
          if (typeof input === "string") url = input;
          else if (input instanceof URL) url = input.href;
          else if (input instanceof Request) url = input.url;

          if (url?.startsWith("file://")) {
            // Convert file:// URL to VFS path
            let vfsPath: string;
            try {
              vfsPath = decodeURIComponent(new URL(url).pathname);
            } catch {
              vfsPath = decodeURIComponent(url.slice(7));
            }
            const v = (globalThis as any).__nodepodVolume as
              | MemoryVolume
              | undefined;
            if (v) {
              const wasmPath =
                vfsPath.endsWith(".wasm") && vfsPath.includes("/node_modules/")
                  ? resolveWasmAssetPath(v, vfsPath)
                  : vfsPath;
              try {
                const data = v.readFileSync(wasmPath);
                const bytes =
                  data instanceof Uint8Array
                    ? data
                    : new TextEncoder().encode(String(data));
                const contentType = wasmPath.endsWith(".wasm")
                  ? "application/wasm"
                  : "application/octet-stream";
                return Promise.resolve(
                  new Response(
                    bytes.buffer.slice(
                      bytes.byteOffset,
                      bytes.byteOffset + bytes.byteLength,
                    ) as ArrayBuffer,
                    {
                      status: 200,
                      headers: { "Content-Type": contentType },
                    },
                  ),
                );
              } catch {
                // .wasm under node_modules that aren't in the VFS (big binaries that didn't extract), pull from CDN
                const cdnUrl = buildCdnWasmUrl(v, wasmPath);
                if (cdnUrl) {
                  return origFetch(cdnUrl).then((resp) => {
                    if (resp.ok) {
                      try {
                        // overlap compile with the caller's byte read, and
                        // persist to VFS so the next read skips the network
                        const forCompile =
                          typeof WebAssembly !== "undefined" &&
                          typeof WebAssembly.compileStreaming === "function"
                            ? resp.clone()
                            : null;
                        const forBytes = resp.clone();
                        (async () => {
                          const streaming = forCompile
                            ? WebAssembly.compileStreaming(forCompile)
                            : null;
                          streaming?.catch(() => {});
                          const bytes = new Uint8Array(await forBytes.arrayBuffer());
                          try {
                            const dir =
                              wasmPath.substring(0, wasmPath.lastIndexOf("/")) || "/";
                            v.mkdirSync(dir, { recursive: true });
                            v.writeFileSync(wasmPath, bytes);
                          } catch { /* best-effort */ }
                          if (streaming && bytes.byteLength >= PRECOMPILE_THRESHOLD) {
                            try {
                              registerCompiledModule(bytes, await streaming);
                            } catch {
                              precompileWasm(bytes);
                            }
                          } else {
                            precompileWasm(bytes);
                          }
                        })().catch(() => {});
                      } catch { /* clone unsupported — plain passthrough */ }
                    }
                    return resp;
                  });
                }
                return Promise.resolve(
                  new Response("Not found", { status: 404 }),
                );
              }
            }
          }
          // http://localhost:PORT/... from inside a pod: deliver to the
          // virtual server on that port (this worker's or a sibling's), the
          // way node's fetch reaches a local socket. falls through to the
          // network when nothing listens there.
          const local = url ? parseLoopbackHttpUrl(url) : null;
          if (local) {
            return fetchVirtualServer(input, init, local).then((resp) =>
              resp ?? origFetch(input, init),
            );
          }
          return origFetch(input, init);
        };
        return doFetch().then(
          (resp) => {
            handle.close();
            return trackFetchBodyConsumption(resp);
          },
          (err) => {
            handle.close();
            throw err;
          },
        );
      };
      (globalThis as any).fetch = Object.assign(patchedFetch, {
        __nodepodPatched: true,
      });
    }

    // bundlers (rolldown, rollup, Vite) prefix virtual module paths with null bytes (\0module, %00module), but Chrome's URL constructor rejects those — sanitize while keeping the virtual semantics
    if (!(globalThis.URL as any).__nodepodPatched) {
      const OrigURL = globalThis.URL;
      const PatchedURL = function URL(this: any, url: string, base?: string) {
        try {
          if (base !== undefined) return new OrigURL(url, base);
          return new OrigURL(url);
        } catch (e: any) {
          if (typeof url === "string" && (url.includes("%00") || url.includes("\0"))) {
            const sanitized = url
              .replace(/%00/g, "__v_nul__")
              .replace(/\0/g, "__v_nul__")
              // file:// absolute paths need three slashes
              .replace(/^file:\/\/([^/])/, "file:///$1");
            if (base !== undefined) return new OrigURL(sanitized, base);
            return new OrigURL(sanitized);
          }
          throw e;
        }
      } as any;
      PatchedURL.prototype = OrigURL.prototype;
      PatchedURL.createObjectURL = OrigURL.createObjectURL?.bind(OrigURL);
      PatchedURL.revokeObjectURL = OrigURL.revokeObjectURL?.bind(OrigURL);
      PatchedURL.canParse = (OrigURL as any).canParse?.bind(OrigURL);
      (PatchedURL as any).__nodepodPatched = true;
      (globalThis as any).URL = PatchedURL;
    }

    // Browsers disallow sync WebAssembly.Module() for >8MB buffers — serve from cache
    if (
      typeof WebAssembly !== "undefined" &&
      !(WebAssembly.Module as any).__nodepodPatched
    ) {
      const OrigModule = WebAssembly.Module;
      const PatchedModule = function WebAssemblyModule(
        this: any,
        bytes: BufferSource,
      ) {
        const cached = getCachedModule(bytes);
        if (cached) return cached;
        try {
          return new OrigModule(bytes);
        } catch (e: any) {
          if (
            e &&
            (e.message?.includes("disallowed on the main thread") ||
              e.message?.includes("buffer size is larger than"))
          ) {
            const cached2 = getCachedModule(bytes);
            if (cached2) return cached2;
            const compilePromise = compileWasmInWorker(
              bytes instanceof ArrayBuffer
                ? new Uint8Array(bytes)
                : (bytes as Uint8Array),
            );
            (globalThis as any).__wasmCompilePromise = compilePromise;
          }
          throw e;
        }
      } as any;
      PatchedModule.prototype = OrigModule.prototype;
      PatchedModule.__nodepodPatched = true;
      PatchedModule.imports = OrigModule.imports?.bind(OrigModule);
      PatchedModule.exports = OrigModule.exports?.bind(OrigModule);
      PatchedModule.customSections =
        OrigModule.customSections?.bind(OrigModule);
      (globalThis as any).WebAssembly.Module = PatchedModule;
    }

    // timers need .ref/.unref to match node's API and have to register
    // Handles so the loop knows about pending work. delegate to the
    // node:timers polyfill, it wires everything through getRegistry().
    // setImmediate uses the MessageChannel check-phase queue (not setTimeout(0)).
    if (!(globalThis.setTimeout as any).__nodepodPatched) {
      (globalThis as any).setTimeout = Object.assign(timersPolyfill.setTimeout, {
        __nodepodPatched: true,
      });
      (globalThis as any).setInterval = Object.assign(
        timersPolyfill.setInterval,
        { __nodepodPatched: true },
      );
      (globalThis as any).clearTimeout = timersPolyfill.clearTimeout;
      (globalThis as any).clearInterval = timersPolyfill.clearInterval;
      (globalThis as any).setImmediate = Object.assign(
        timersPolyfill.setImmediate,
        { __nodepodPatched: true },
      );
      (globalThis as any).clearImmediate = timersPolyfill.clearImmediate;
    } else if (!(globalThis.setImmediate as any)?.__nodepodPatched) {
      (globalThis as any).setImmediate = Object.assign(
        timersPolyfill.setImmediate,
        { __nodepodPatched: true },
      );
      (globalThis as any).clearImmediate = timersPolyfill.clearImmediate;
    }

    this.patchStackTraceApi();
    this.patchTextDecoder();
  }

  private patchTextDecoder(): void {
    const Original = globalThis.TextDecoder;

    class ExtendedDecoder {
      private enc: string;
      private inner: TextDecoder | null = null;

      constructor(encoding: string = "utf-8", options?: TextDecoderOptions) {
        this.enc = encoding.toLowerCase();
        const textEncodings = [
          "utf-8",
          "utf8",
          "utf-16le",
          "utf-16be",
          "utf-16",
          "ascii",
          "iso-8859-1",
          "latin1",
          "windows-1252",
        ];
        if (textEncodings.includes(this.enc)) {
          try {
            this.inner = new Original(encoding, options);
          } catch {
            this.inner = new Original("utf-8", options);
          }
        }
      }

      // make a BufferSource safe for native TextDecoder — it throws on SharedArrayBuffer-backed views, which threaded WASM modules (wasm32-wasip1-threads, emnapi, rayon, tokio) emit all the time
      // copies into a regular ArrayBuffer when needed, transparent to callers
      private static normalizeInput(input: BufferSource): BufferSource {
        if (typeof SharedArrayBuffer === "undefined") return input;
        if (input instanceof ArrayBuffer) return input;
        if (input instanceof SharedArrayBuffer) {
          const copy = new Uint8Array(input.byteLength);
          copy.set(new Uint8Array(input));
          return copy;
        }
        const view = input as ArrayBufferView;
        if (view.buffer instanceof SharedArrayBuffer) {
          const src = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
          const copy = new Uint8Array(view.byteLength);
          copy.set(src);
          return copy;
        }
        return input;
      }

      decode(input?: BufferSource, options?: TextDecodeOptions): string {
        if (!input) {
          if (this.inner) return this.inner.decode(undefined, options);
          return "";
        }
        const safe = ExtendedDecoder.normalizeInput(input);
        if (this.inner) return this.inner.decode(safe, options);
        const safeView = safe as ArrayBufferView | ArrayBuffer;
        const bytes =
          safeView instanceof ArrayBuffer
            ? new Uint8Array(safeView)
            : new Uint8Array(
                (safeView as ArrayBufferView).buffer,
                (safeView as ArrayBufferView).byteOffset,
                (safeView as ArrayBufferView).byteLength,
              );

        if (this.enc === "base64") return bytesToBase64(bytes);
        if (this.enc === "base64url")
          return bytesToBase64(bytes)
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=/g, "");
        if (this.enc === "hex") return bytesToHex(bytes);
        return new Original("utf-8").decode(safe, options);
      }

      get fatal(): boolean {
        return this.inner?.fatal ?? false;
      }
      get ignoreBOM(): boolean {
        return this.inner?.ignoreBOM ?? false;
      }
    }

    globalThis.TextDecoder = ExtendedDecoder as unknown as typeof TextDecoder;
  }

  // Override even in Chrome — eval produces stack frames the native V8 API can't map to VFS paths
  private patchStackTraceApi(): void {
    if ((Error as any).stackTraceLimit === undefined)
      (Error as any).stackTraceLimit = 10;

    function parseFrames(stack: string) {
      if (!stack) return [];
      const frames: Array<{
        fn: string;
        file: string;
        line: number;
        col: number;
      }> = [];
      for (const raw of stack.split("\n")) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        if (/^\w*Error\b/.test(trimmed) && !trimmed.startsWith("at ")) continue;

        const safari = trimmed.match(/^(.*)@(.*?):(\d+):(\d+)$/);
        if (safari) {
          frames.push({
            fn: safari[1] || "",
            file: safari[2],
            line: +safari[3],
            col: +safari[4],
          });
          continue;
        }

        const chrome = trimmed.match(
          /^at\s+(?:(.+?)\s+\()?(.*?):(\d+):(\d+)\)?$/,
        );
        if (chrome) {
          frames.push({
            fn: chrome[1] || "",
            file: chrome[2],
            line: +chrome[3],
            col: +chrome[4],
          });
          continue;
        }

        const chromePlain = trimmed.match(/^at\s+(?:(.+?)\s+\()?(.*?)\)?$/);
        if (chromePlain) {
          frames.push({
            fn: chromePlain[1] || "",
            file: chromePlain[2] || "<anonymous>",
            line: 0,
            col: 0,
          });
        }
      }
      return frames;
    }

    function makeCallSite(f: {
      fn: string;
      file: string;
      line: number;
      col: number;
    }) {
      return {
        getFileName: () => f.file || null,
        getLineNumber: () => f.line || null,
        getColumnNumber: () => f.col || null,
        getFunctionName: () => f.fn || null,
        getMethodName: () => f.fn || null,
        getTypeName: () => null,
        getThis: () => undefined,
        getFunction: () => undefined,
        getEvalOrigin: () => undefined,
        isNative: () => false,
        isConstructor: () => false,
        isToplevel: () => !f.fn,
        isEval: () => false,
        toString: () =>
          f.fn
            ? `${f.fn} (${f.file}:${f.line}:${f.col})`
            : `${f.file}:${f.line}:${f.col}`,
      };
    }

    function buildSites(stack: string, ctorOpt?: Function) {
      const frames = parseFrames(stack);
      let start = 0;
      if (ctorOpt?.name) {
        for (let i = 0; i < frames.length; i++) {
          if (frames[i].fn === ctorOpt.name) {
            start = i + 1;
            break;
          }
        }
      }
      return frames.slice(start).map(makeCallSite);
    }

    const sym = Symbol("rawStack");
    const symProcessed = Symbol("stackProcessed");

    const nativeCapture = (Error as any).captureStackTrace;

    Object.defineProperty(Error.prototype, "stack", {
      get() {
        if ((this as any)[symProcessed]) return (this as any)[sym];
        const raw = (this as any)[sym];
        if (
          typeof raw === "string" &&
          typeof (Error as any).prepareStackTrace === "function"
        ) {
          try {
            const sites = buildSites(raw);
            if (sites.length > 0) {
              return (Error as any).prepareStackTrace(this, sites);
            }
          } catch {
            return raw;
          }
        }
        return raw;
      },
      set(val: any) {
        (this as any)[sym] = val;
      },
      configurable: true,
      enumerable: false,
    });

    (Error as any).captureStackTrace = function (
      target: any,
      ctorOpt?: Function,
    ) {
      const saved = (Error as any).prepareStackTrace;
      (Error as any).prepareStackTrace = undefined;

      let raw: string;
      if (nativeCapture) {
        const tmp = {} as any;
        nativeCapture(tmp);
        raw = tmp.stack || "";
      } else {
        raw = new Error().stack || "";
      }
      (Error as any).prepareStackTrace = saved;

      if (typeof saved === "function") {
        try {
          const result = saved(target, buildSites(raw, ctorOpt));
          (target as any)[symProcessed] = true;
          target.stack = result;
        } catch {
          target.stack = raw;
        }
      } else {
        target.stack = raw;
      }
    };
  }

  execute(
    code: string,
    filename: string = "/index.js",
  ): { exports: unknown; module: ModuleRecord } {
    const dir = pathPolyfill.dirname(filename);
    // Only write when the content differs to avoid triggering file watchers
    // (e.g. nodemon/chokidar) with a no-op write that causes restart loops.
    try {
      const existing = this.vol.readFileSync(filename, "utf8");
      if (existing !== code) this.vol.writeFileSync(filename, code);
    } catch {
      this.vol.writeFileSync(filename, code);
    }

    const mod: ModuleRecord = {
      id: filename,
      filename,
      exports: {},
      loaded: false,
      children: [],
      paths: [],
      parent: null,
    };
    this.moduleRegistry[filename] = mod;

    const consoleProxy = wrapConsole(this.opts.onConsole);

    let processed = code;
    if (processed.startsWith("#!"))
      processed = processed.slice(processed.indexOf("\n") + 1);
    if (isTypeScriptFile(filename)) {
      processed = stripTypeScript(processed, filename);
    }
    const moduleExportName = pickModuleExportName(processed);
    let fileHasTLA = false;
    if (filename.endsWith(".cjs")) {
      try {
        const cjsAst = acorn.parse(processed, {
          ecmaVersion: "latest",
          sourceType: "script",
          allowImportExportEverywhere: true,
        });
        const cjsPatches: Array<[number, number, string]> = [];
        const walkCjs = (node: any) => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) {
            for (const c of node) walkCjs(c);
            return;
          }
          if (typeof node.type !== "string") return;
          if (node.type === "ImportExpression") {
            cjsPatches.push([node.start, node.start + 6, "__asyncLoad"]);
          }
          if (
            node.type === "MetaProperty" &&
            node.meta?.name === "import" &&
            node.property?.name === "meta"
          ) {
            cjsPatches.push([node.start, node.end, "import_meta"]);
          }
          for (const key of Object.keys(node)) {
            if (key === "type" || key === "start" || key === "end") continue;
            const val = node[key];
            if (val && typeof val === "object") walkCjs(val);
          }
        };
        walkCjs(cjsAst);
        if (cjsPatches.length > 0) {
          cjsPatches.sort((a, b) => b[0] - a[0]);
          for (const [start, end, replacement] of cjsPatches) {
            processed =
              processed.slice(0, start) + replacement + processed.slice(end);
          }
        }
      } catch {
        /* can't parse */
      }
    } else {
      const converted = convertModuleSyntaxDetailed(
        processed,
        filename,
        moduleExportName,
      );
      processed = converted.code;
      fileHasTLA = converted.hasTLA;
    }

    const isCjs = filename.endsWith(".cjs");
    if (!isCjs) processed = stripTopLevelAwait(processed);

    const resolver = buildResolver(
      this.vol,
      this.fsBridge,
      this.proc,
      dir,
      this.moduleRegistry,
      this.opts,
      this.transformCache,
      fileHasTLA,
    );
    resolver._ownerRecord = mod;
    markResolverMain(resolver, mod);

    try {
      const wrapper = buildModuleWrapper(processed, { moduleExportName });

      const asyncLoader = makeDynamicLoader(resolver);
      let fn;
      try {
        fn = (0, eval)(wrapper);
      } catch (syntaxErr) {
        throw syntaxErr;
      }

      fn(
        mod.exports,
        resolver,
        mod,
        filename,
        dir,
        this.proc,
        consoleProxy,
        importMetaForModule(resolver, filename, dir),
        asyncLoader,
        syncAwait,
        syncAwaitFn,
        SyncPromiseClass,
      );

      mod.loaded = true;
    } catch (err) {
      delete this.moduleRegistry[filename];
      throw err;
    }

    return { exports: mod.exports, module: mod };
  }

  executeSync = this.execute;

  async executeAsync(
    code: string,
    filename: string = "/index.js",
  ): Promise<ExecutionOutcome> {
    return Promise.resolve(this.execute(code, filename));
  }

  runFile(filename: string): { exports: unknown; module: ModuleRecord } {
    const source = this.vol.readFileSync(filename, "utf8");
    return this.execute(source, filename);
  }

  runFileSync = this.runFile;

  // Wraps in async IIFE when TLA is detected, falls back to sync otherwise
  //
  // `resolveDir` overrides the directory used for relative require/import
  // resolution, __dirname and import.meta (default: the file's directory).
  async runFileTLA(
    filename: string,
    opts?: RunFileOptions,
  ): Promise<{ exports: unknown; module: ModuleRecord }> {
    let retries = 0;
    while (true) {
      try {
        return await this.runFileTLAOnce(filename, opts);
      } catch (err) {
        if (!(err instanceof AsyncModuleInitializationRequired) || retries++ >= 1) {
          throw err;
        }
        // Await the actual initialization failure instead of returning an
        // unready polyfill or hiding the original CDN/import error.
        await err.ready;
        this.clearCache();
      }
    }
  }

  private async runFileTLAOnce(
    filename: string,
    opts?: RunFileOptions,
  ): Promise<{ exports: unknown; module: ModuleRecord }> {
    const source = this.vol.readFileSync(filename, "utf8");
    // `node -e` scripts live outside the project tree but must resolve
    // relative specifiers from the cwd, exactly like node's [eval] module.
    const dir = opts?.resolveDir ?? pathPolyfill.dirname(filename);
    // No need to write — source was just read from the same volume.
    // Writing it back triggers file watchers (nodemon restart loops).

    const mod: ModuleRecord = {
      id: filename,
      filename,
      exports: {},
      loaded: false,
      children: [],
      paths: [],
      parent: null,
    };
    this.moduleRegistry[filename] = mod;

    const consoleProxy = wrapConsole(this.opts.onConsole);

    let processed = source as string;
    if (processed.startsWith("#!"))
      processed = processed.slice(processed.indexOf("\n") + 1);
    if (isTypeScriptFile(filename)) {
      processed = stripTypeScript(processed, filename);
    }
    const moduleExportName = pickModuleExportName(processed);
    let tla = false;
    if (filename.endsWith(".cjs")) {
      processed = rewriteDynamicImportsRegex(processed);
      processed = replaceImportMetaOutsideLiterals(processed, () => "import_meta");
    } else {
      const converted = convertModuleSyntaxDetailed(
        processed,
        filename,
        moduleExportName,
      );
      processed = converted.code;
      tla = converted.hasTLA;
    }
    const tlaStripped = stripTopLevelAwait(processed);

    // Don't propagate deAsyncImports from entry — it uses native await (async IIFE),
    // so deps don't need de-async. loadModule handles individual TLA modules.
    const resolver = buildResolver(
      this.vol,
      this.fsBridge,
      this.proc,
      dir,
      this.moduleRegistry,
      this.opts,
      this.transformCache,
      false,
    );
    resolver._ownerRecord = mod;
    markResolverMain(resolver, mod);

    if (!tla) {
      try {
        processed = tlaStripped;
        const wrapper = buildModuleWrapper(processed, { moduleExportName });
        const asyncLoader = makeDynamicLoader(resolver);
        const fn = (0, eval)(wrapper);

        fn(
          mod.exports,
          resolver,
          mod,
          filename,
          dir,
          this.proc,
          consoleProxy,
          importMetaForModule(resolver, filename, dir),
          asyncLoader,
          syncAwait,
          syncAwaitFn,
          SyncPromiseClass,
        );
        mod.loaded = true;
      } catch (err) {
        delete this.moduleRegistry[filename];
        throw err;
      }
      return { exports: mod.exports, module: mod };
    }

    try {
      const wrapper = buildModuleWrapper(processed, {
        async: true,
        moduleExportName,
      });
      const asyncLoader = makeDynamicLoader(resolver);
      const fn = (0, eval)(wrapper);
      await fn(
        mod.exports,
        resolver,
        mod,
        filename,
        dir,
        this.proc,
        consoleProxy,
        importMetaForModule(resolver, filename, dir),
        asyncLoader,
        syncAwait,
        syncAwaitFn,
        SyncPromiseClass,
      );
      mod.loaded = true;
    } catch (err) {
      delete this.moduleRegistry[filename];
      throw err;
    }
    return { exports: mod.exports, module: mod };
  }

  async runFileAsync(filename: string): Promise<ExecutionOutcome> {
    return Promise.resolve(this.runFile(filename));
  }

  clearCache(): void {
    for (const k of Object.keys(this.moduleRegistry))
      delete this.moduleRegistry[k];
    // Also clear shared resolver/manifest caches
    (this.moduleRegistry as any).__resolveCache?.clear();
    (this.moduleRegistry as any).__manifestCache?.clear();
    delete (this.moduleRegistry as any).__pkgIdentityMap;
    delete (this.moduleRegistry as any).__mainModule;
    this.transformCache.clear();
  }

  /** Evict one node_modules entry when module cache exceeds soft limit. */
  private _trimModuleCache(): void {
    const limit = this.opts.handler?.options.moduleSoftCacheSize ?? 512;
    const keys = Object.keys(this.moduleRegistry);
    if (keys.length < limit) return;
    for (const k of keys) {
      if (k.includes("/node_modules/")) {
        delete this.moduleRegistry[k];
        return; // One eviction per call — amortized O(1)
      }
    }
  }

  getVolume(): MemoryVolume {
    return this.vol;
  }
  getProcess(): ProcessObject {
    return this.proc;
  }

  createREPL(): { eval: (code: string) => unknown } {
    const resolver = buildResolver(
      this.vol,
      this.fsBridge,
      this.proc,
      "/",
      this.moduleRegistry,
      this.opts,
      this.transformCache,
    );
    const consoleProxy = wrapConsole(this.opts.onConsole);
    const proc = this.proc;
    const buf = bufferPolyfill.Buffer;

    const GenFn = Object.getPrototypeOf(function* () {}).constructor;
    const gen = new GenFn(
      "require",
      "console",
      "process",
      "Buffer",
      `var __code, __result;
while (true) {
  __code = yield;
  try {
    __result = eval(__code);
    yield { value: __result, error: null };
  } catch (e) {
    yield { value: undefined, error: e };
  }
}`,
    )(resolver, consoleProxy, proc, buf);
    gen.next();

    return {
      eval(code: string): unknown {
        const normalized = code.replace(/^\s*(const|let)\s+/gm, "var ");
        const exprResult = gen.next("(" + normalized + ")").value as {
          value: unknown;
          error: unknown;
        };
        if (!exprResult.error) {
          gen.next();
          return exprResult.value;
        }
        gen.next();
        const stmtResult = gen.next(normalized).value as {
          value: unknown;
          error: unknown;
        };
        if (stmtResult.error) {
          gen.next();
          throw stmtResult.error;
        }
        gen.next();
        return stmtResult.value;
      },
    };
  }
}

export function executeCode(
  code: string,
  vol: MemoryVolume,
  opts?: EngineOptions,
): { exports: unknown; module: ModuleRecord } {
  const engine = new ScriptEngine(vol, opts);
  return engine.execute(code);
}

export type {
  IScriptEngine,
  ExecutionOutcome,
  EngineConfig,
} from "./engine-types";
export default ScriptEngine;
