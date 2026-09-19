// Rollup polyfill that lazy-loads @rollup/browser from CDN

import * as acorn from "acorn";
import acornJsx from "acorn-jsx";
import {
  CDN_ROLLUP_BROWSER,
  PINNED_ROLLUP_BROWSER,
  cdnImport,
} from "../constants/cdn-urls";
import { withHandle } from "../helpers/event-loop";

// acorn parser extended with JSX support
const acornJsxParser = (acorn.Parser as any).extend(acornJsx());

let cachedRollup: unknown = null;
let loadingPromise: Promise<unknown> | null = null;

// injected by the script engine so bundle.write() can write to the VFS
let _vfsMkdirSync: ((path: string, opts?: { recursive?: boolean }) => void) | null = null;
let _vfsWriteFileSync: ((path: string, data: string | Uint8Array) => void) | null = null;

export function setVFSBridge(
  mkdirSync: (path: string, opts?: { recursive?: boolean }) => void,
  writeFileSync: (path: string, data: string | Uint8Array) => void,
): void {
  _vfsMkdirSync = mkdirSync;
  _vfsWriteFileSync = writeFileSync;
}

async function ensureRollup(): Promise<unknown> {
  if (cachedRollup) return cachedRollup;
  if (loadingPromise) return loadingPromise;

  // the CDN import settles from the network, not from a tracked handle:
  // without a handle `vite build` exits 0 here before rollup ever runs
  loadingPromise = withHandle("DynamicImport", async () => {
    try {
      const mod = await cdnImport(CDN_ROLLUP_BROWSER);
      cachedRollup = mod;
      return mod;
    } catch (err) {
      loadingPromise = null;
      throw new Error(
        `rollup: failed to load @rollup/browser from CDN -- ${err}`,
      );
    }
  });

  return loadingPromise;
}

export const VERSION: string = PINNED_ROLLUP_BROWSER;

// @rollup/browser blocks fs access in bundle.write() so we intercept it,
// call generate() instead, and write the output to the VFS ourselves
export async function rollup(inputOptions: unknown): Promise<unknown> {
  const r = (await ensureRollup()) as {
    rollup: (o: unknown) => Promise<unknown>;
  };
  // @rollup/browser parses through WebAssembly; hold a handle across the
  // build and each generate() so those awaits cannot drain the loop
  const bundle = (await withHandle("WASMWork", () => r.rollup(inputOptions))) as any;
  const generate = bundle.generate.bind(bundle);
  bundle.generate = (outputOptions: any) =>
    withHandle("WASMWork", () => generate(outputOptions));

  bundle.write = async function (outputOptions: any) {
    const result = await bundle.generate(outputOptions);

    const dir = outputOptions?.dir || "dist";
    if (!_vfsMkdirSync || !_vfsWriteFileSync) {
      throw new Error("rollup: VFS bridge not set up");
    }
    const mkdirSync = _vfsMkdirSync;
    const writeFileSync = _vfsWriteFileSync;

    try {
      mkdirSync(dir, { recursive: true });
    } catch { /* already exists */ }

    for (const chunk of result.output) {
      const filePath = dir + "/" + chunk.fileName;
      const fileDir = filePath.substring(0, filePath.lastIndexOf("/"));
      if (fileDir && fileDir !== dir) {
        try {
          mkdirSync(fileDir, { recursive: true });
        } catch { /* already exists */ }
      }

      if (chunk.type === "chunk") {
        writeFileSync(filePath, chunk.code);
        if (chunk.map) {
          writeFileSync(filePath + ".map", chunk.map.toString());
        }
      } else if (chunk.type === "asset") {
        writeFileSync(filePath, chunk.source);
      }
    }

    return result;
  };

  return bundle;
}

export async function watch(watchOptions: unknown): Promise<unknown> {
  const r = (await ensureRollup()) as { watch: (o: unknown) => unknown };
  return r.watch(watchOptions);
}

export function defineConfig<T>(config: T): T {
  return config;
}

// Rollup/Rolldown PARSE_ERROR shape so Vite's ssrTransform can format it.
function toParseError(err: unknown, filename?: string): Error {
  const e = err as {
    message?: string;
    pos?: number;
    loc?: { line: number; column: number };
  };
  const out = new Error(e?.message || String(err)) as Error & {
    code: string;
    pos?: number;
    loc?: { line: number; column: number; file?: string };
  };
  out.code = "PARSE_ERROR";
  if (typeof e?.pos === "number") out.pos = e.pos;
  if (e?.loc) {
    out.loc = { ...e.loc, file: filename };
  }
  return out;
}

type ParseAstOpts = {
  allowReturnOutsideFunction?: boolean;
  jsx?: boolean;
  // rolldown ParserOptions — accepted and ignored (acorn has no lang switch)
  lang?: string;
  preserveParens?: boolean;
  signal?: AbortSignal;
} | null;

// falls back to acorn-jsx if plain acorn fails (e.g. JSX in source).
// signature matches both rollup/parseAst and rolldown/parseAst:
//   parseAst(source, options?, filename?)
export function parseAst(
  source: string,
  opts?: ParseAstOpts,
  filename?: string,
): unknown {
  const parseOpts = {
    ecmaVersion: "latest" as const,
    sourceType: "module" as const,
    allowReturnOutsideFunction: opts?.allowReturnOutsideFunction ?? false,
    locations: true,
  };

  try {
    if (opts?.jsx || opts?.lang === "jsx" || opts?.lang === "tsx") {
      return acornJsxParser.parse(source, parseOpts);
    }
    try {
      return acorn.parse(source, parseOpts);
    } catch {
      return acornJsxParser.parse(source, parseOpts);
    }
  } catch (err) {
    throw toParseError(err, filename);
  }
}

export async function parseAstAsync(
  source: string,
  opts?: ParseAstOpts,
  filename?: string,
): Promise<unknown> {
  return parseAst(source, opts, filename);
}

// prevents "unsupported platform" error when Rollup probes for native bindings
export function getPackageBase(): string {
  return "";
}

export { ensureRollup as loadRollup };

export interface Plugin {
  name: string;
  [key: string]: unknown;
}

export interface PluginContext {
  meta: { rollupVersion: string };
  parse: (code: string) => unknown;
  [key: string]: unknown;
}

export default {
  VERSION,
  rollup,
  watch,
  defineConfig,
  parseAst,
  parseAstAsync,
  loadRollup: ensureRollup,
};
