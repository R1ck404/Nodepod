// Browser Bundler — bundles node_modules packages into single ESM files for the browser.
// Uses esbuild-wasm. React-family packages are kept external (shared via import map).

import {
  build,
  setVolume as setVFS,
  type BundleOutput as BuildResult,
} from "../polyfills/esbuild";
import type { IVolume } from "../types/volume";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const bundledModules = new Map<string, string>();
let activeVolume: IVolume | null = null;
let externalPackages: string[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function invalidateBundleCache(): void {
  bundledModules.clear();
}

// Must be called before bundleForBrowser
export function attachVolume(vol: IVolume): void {
  setVFS(vol);
  activeVolume = vol;
}

export function setExternalPackages(packages: string[]): void {
  externalPackages = [...packages];
}

// Bundle a bare specifier (e.g. "zod", "lodash/merge") into a self-contained ESM string
export async function bundleForBrowser(specifier: string): Promise<string> {
  const hit = bundledModules.get(specifier);
  if (hit) return hit;

  const entryFile = locateEntryPoint(specifier);

  let knownExports: string[] = [];
  if (entryFile && activeVolume) {
    try {
      const src = activeVolume.readFileSync(entryFile, "utf8");
      knownExports = detectCjsExports(src);
    } catch {
      // non-critical
    }
  }

  let outcome: BuildResult;

  if (entryFile) {
    outcome = await build({
      entryPoints: [entryFile],
      bundle: true,
      format: "esm",
      target: "esnext",
      external: externalPackages,
      write: false,
    });
  } else {
    // can't determine entry point — let esbuild resolve it via a re-export stub
    const stub = `export * from '${specifier}';\n`;
    outcome = await build({
      stdin: {
        contents: stub,
        resolveDir: "/node_modules",
        loader: "js",
      },
      bundle: true,
      format: "esm",
      target: "esnext",
      external: externalPackages,
      write: false,
    });
  }

  if (!outcome.outputFiles || outcome.outputFiles.length === 0) {
    throw new Error(`Bundling produced no output for "${specifier}"`);
  }

  const outputRecord = outcome.outputFiles[0];
  let esmCode = outputRecord.text;
  if (!esmCode && outputRecord.contents?.length > 0) {
    esmCode = new TextDecoder().decode(outputRecord.contents);
  }

  if (!esmCode) {
    throw new Error(
      `Bundling produced empty output for "${specifier}" (entry: ${entryFile || "stdin"})`,
    );
  }

  esmCode = rewriteExternalRequireCalls(esmCode);
  if (knownExports.length > 0) {
    esmCode = injectNamedExports(esmCode, knownExports);
  }

  bundledModules.set(specifier, esmCode);
  return esmCode;
}

// ---------------------------------------------------------------------------
// Entry-point resolution
// ---------------------------------------------------------------------------

// CJS first to avoid .mjs confusion
const CONDITION_ORDER = ["require", "import", "module", "default"] as const;

// Walk nested export conditions until we hit an actual file path string
function drillCondition(node: unknown): string | undefined {
  if (typeof node === "string") return node;
  if (typeof node === "object" && node !== null) {
    const obj = node as Record<string, unknown>;
    for (const key of CONDITION_ORDER) {
      if (key in obj) {
        const found = drillCondition(obj[key]);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function fileExists(filePath: string): boolean {
  if (!activeVolume) return false;
  if (!activeVolume.existsSync(filePath)) return false;
  try {
    return !activeVolume.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

// Resolve bare specifier to absolute path. Handles scoped packages, exports map, and fallbacks.
function locateEntryPoint(specifier: string): string | null {
  if (!activeVolume) return null;

  const segments = specifier.split("/");
  const isScoped = segments[0].startsWith("@");
  const pkgName = isScoped ? segments.slice(0, 2).join("/") : segments[0];
  const subPath = isScoped
    ? segments.slice(2).join("/")
    : segments.slice(1).join("/");

  const pkgRoot = `/node_modules/${pkgName}`;
  const manifestFile = `${pkgRoot}/package.json`;
  if (!activeVolume.existsSync(manifestFile)) return null;

  try {
    const manifest = JSON.parse(
      activeVolume.readFileSync(manifestFile, "utf8"),
    );

    if (manifest.exports && typeof manifest.exports === "object") {
      const conditionKey = subPath ? `./${subPath}` : ".";
      const mapEntry = (manifest.exports as Record<string, unknown>)[
        conditionKey
      ];
      if (mapEntry) {
        const resolved = drillCondition(mapEntry);
        if (resolved) {
          const abs = `${pkgRoot}/${resolved.replace(/^\.\//, "")}`;
          if (fileExists(abs)) return abs;
        }
      }
    }

    // fallback: main/module fields (root export only)
    if (!subPath) {
      const fallbackEntry = manifest.main || manifest.module;
      if (fallbackEntry) {
        const abs = `${pkgRoot}/${fallbackEntry.replace(/^\.\//, "")}`;
        if (fileExists(abs)) return abs;
      }
      const defaultIndex = `${pkgRoot}/index.js`;
      if (fileExists(defaultIndex)) return defaultIndex;
    } else {
      const basePath = `${pkgRoot}/${subPath}`;
      for (const ext of ["", ".js", ".cjs", ".mjs", ".json"]) {
        if (fileExists(basePath + ext)) return basePath + ext;
      }
    }
  } catch {
    // non-fatal
  }

  return null;
}

// ---------------------------------------------------------------------------
// CJS export detection
// ---------------------------------------------------------------------------

// Detect named exports from CJS — looks for esbuild's __export() helper or exports.X = patterns
function detectCjsExports(source: string): string[] {
  const helperMatch = source.match(/__export\(\w+,\s*\{([^}]+)\}/);
  if (helperMatch) {
    return [...helperMatch[1].matchAll(/(\w+)\s*:/g)]
      .map((m) => m[1])
      .filter((id) => id !== "default" && id !== "__esModule");
  }

  const propMatches = [...source.matchAll(/exports\.(\w+)\s*=/g)].map(
    (m) => m[1],
  );
  return [...new Set(propMatches)].filter(
    (id) => id !== "default" && id !== "__esModule",
  );
}

// ---------------------------------------------------------------------------
// Post-processing transforms
// ---------------------------------------------------------------------------

// esbuild emits __require("ext") for CJS externals in ESM — rewrite to proper import declarations
function rewriteExternalRequireCalls(code: string): string {
  const specifiers = new Set<string>();
  for (const m of code.matchAll(/__require\(["']([^"']+)["']\)/g)) {
    specifiers.add(m[1]);
  }
  if (specifiers.size === 0) return code;

  const uniqueSpecs = [...specifiers];
  const importBlock = uniqueSpecs
    .map((spec, idx) => `import * as __imported${idx} from "${spec}";`)
    .join("\n");

  let patched = code;
  for (let idx = 0; idx < uniqueSpecs.length; idx++) {
    const spec = uniqueSpecs[idx];
    patched = patched.split(`__require("${spec}")`).join(`__imported${idx}`);
    patched = patched.split(`__require('${spec}')`).join(`__imported${idx}`);
  }

  return importBlock + "\n" + patched;
}

// esbuild wraps CJS as `export default require_xxx()` with no named exports.
// When we know the names from static analysis, inject explicit re-exports.
function injectNamedExports(code: string, names: string[]): string {
  if (names.length === 0) return code;

  const wrapperPattern = /export\s+default\s+(require_\w+)\(\)\s*;?/;
  const m = code.match(wrapperPattern);
  if (!m) return code;

  const requireCall = m[1];

  const replacement =
    `var __mod = ${requireCall}();\nexport default __mod;\n` +
    names.map((n) => `export var ${n} = __mod.${n};`).join("\n") +
    "\n";

  return code.replace(m[0], replacement);
}

// ---------------------------------------------------------------------------
// Class facade
// ---------------------------------------------------------------------------

export class BrowserBundler {
  private vol: IVolume;

  constructor(vol: IVolume, options?: { external?: string[] }) {
    this.vol = vol;
    attachVolume(vol);
    if (options?.external) setExternalPackages(options.external);
  }

  bundle(specifier: string): Promise<string> {
    return bundleForBrowser(specifier);
  }

  clearCache(): void {
    invalidateBundleCache();
  }
}

export default BrowserBundler;
