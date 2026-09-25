// esbuild polyfill -- loads esbuild-wasm from CDN, routes file I/O through MemoryVolume

import type { MemoryVolume } from "../memory-volume";
import { CDN_ESBUILD_BINARY, PINNED_ESBUILD_WASM } from "../constants/cdn-urls";
import {
  getEsbuild,
  getEsbuildIfReady,
  acquireEsbuild,
  acquireDedicatedEsbuild,
  type EsbuildLease,
  runEsbuildTransform,
} from "../helpers/esbuild-engine";
import { stripTopLevelAwait } from "../syntax-transforms";
import { ESBUILD_LOADER_MAP, RESOLVE_EXTENSIONS } from "../constants/config";
import { getRegistry } from "../helpers/event-loop";

const BUILTIN_MODULES = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);

type ExportValue = string | ExportMap;
interface ExportMap {
  [key: string]: ExportValue;
}

interface PackageJson {
  exports?: ExportMap | ExportValue;
  imports?: ExportMap;
  module?: string;
  main?: string;
}

interface ModuleHit {
  resolvedPath: string;
  fromVolume: boolean;
}

export interface TransformConfig {
  loader?: "js" | "jsx" | "ts" | "tsx" | "json" | "css";
  format?: "iife" | "cjs" | "esm";
  target?: string | string[];
  supported?: Record<string, boolean>;
  minify?: boolean;
  sourcemap?: boolean | "inline" | "external";
  jsx?: "transform" | "preserve";
  jsxFactory?: string;
  jsxFragment?: string;
}

export interface TransformOutput {
  code: string;
  map: string;
  warnings: unknown[];
}

export interface BundleConfig {
  entryPoints?: string[];
  stdin?: {
    contents: string;
    resolveDir?: string;
    loader?: "js" | "jsx" | "ts" | "tsx" | "json" | "css";
  };
  bundle?: boolean;
  outdir?: string;
  outfile?: string;
  format?: "iife" | "cjs" | "esm";
  platform?: "browser" | "node" | "neutral";
  target?: string | string[];
  supported?: Record<string, boolean>;
  minify?: boolean;
  sourcemap?: boolean | "inline" | "external";
  external?: string[];
  write?: boolean;
  plugins?: unknown[];
  absWorkingDir?: string;
  conditions?: string[];
  mainFields?: string[];
}

export interface BundleOutput {
  errors: unknown[];
  warnings: unknown[];
  outputFiles?: Array<{ path: string; contents: Uint8Array; text: string }>;
  metafile?: {
    inputs?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
  };
}

let wasmBinaryUrl: string = CDN_ESBUILD_BINARY;
let volumeRef: MemoryVolume | null = null;

export function setVolume(vol: MemoryVolume): void {
  volumeRef = vol;
}

export function setWasmUrl(url: string): void {
  wasmBinaryUrl = url;
}

// delegates to the realm-wide singleton (shared with module-transformer)
export async function initialize(opts?: { wasmURL?: string }): Promise<void> {
  await getEsbuild({ wasmURL: opts?.wasmURL || wasmBinaryUrl });
}

// The current instance. Not cached here: the engine retires instances that
// grew large (see esbuild-engine.ts), so each call asks for the live one.
async function currentEngine(): Promise<typeof import("esbuild-wasm")> {
  const ready = getEsbuildIfReady();
  if (ready) return ready;
  return getEsbuild({ wasmURL: wasmBinaryUrl });
}

// esbuild 0.27 moved Safari and iOS destructuring support from 10 to
// 14.1 / 14.5, and destructuring can't be lowered: every destructuring
// pattern became an error for targets in that gap. Vite 5-7 were built on
// earlier releases and target safari14 by default (dep optimizer and build),
// so for such targets destructuring counts as supported, as it did in the
// esbuild those tools depend on. An explicit `supported.destructuring` wins.
const DESTRUCTURING_GAP = /^(safari|ios)(\d+)(?:\.(\d+))?/i;
export function withEsbuildCompat<T extends { target?: string | string[]; supported?: Record<string, boolean> }>(
  cfg: T,
): T;
export function withEsbuildCompat<T extends { target?: string | string[]; supported?: Record<string, boolean> }>(
  cfg: T | undefined,
): T | undefined;
export function withEsbuildCompat<T extends { target?: string | string[]; supported?: Record<string, boolean> }>(
  cfg: T | undefined,
): T | undefined {
  if (!cfg?.target || (cfg.supported && "destructuring" in cfg.supported)) return cfg;
  const targets = Array.isArray(cfg.target) ? cfg.target : String(cfg.target).split(",");
  const inGap = targets.some((t) => {
    const m = DESTRUCTURING_GAP.exec(String(t).trim());
    if (!m) return false;
    const version = Number(m[2]) + Number(m[3] ?? 0) / 100;
    return version >= 10 && version < (m[1].toLowerCase() === "ios" ? 14.05 : 14.01);
  });
  return inGap ? { ...cfg, supported: { ...cfg.supported, destructuring: true } } : cfg;
}

export async function transform(
  source: string,
  cfg?: TransformConfig,
): Promise<TransformOutput> {
  const h = getRegistry().register("EsbuildOp");
  cfg = withEsbuildCompat(cfg);
  try {
    await currentEngine();
    return await runEsbuildTransform(
      (engine) => engine.transform(source, cfg),
      typeof source === "string" ? source.length : 0,
    );
  } finally {
    h.close();
  }
}

// Wrap plugins so the source of every module the build loads is counted
// (esbuild-wasm has no filesystem: all of it comes back from onLoad). The
// total sizes the instance's memory high-water mark (see esbuild-engine.ts).
function countingLoads(plugins: unknown[], count: (bytes: number) => void): unknown[] {
  const measure = (result: unknown): unknown => {
    const contents = (result as { contents?: string | Uint8Array } | null | undefined)?.contents;
    if (contents) count(contents.length);
    return result;
  };
  return plugins.map((plugin) => {
    const p = plugin as { setup?: (build: Record<string, unknown>) => unknown } | null;
    if (!p || typeof p.setup !== "function") return plugin;
    const setup = p.setup;
    // inherits everything else (a class instance's name getter included)
    const wrapped = Object.create(p) as Record<string, unknown>;
    Object.defineProperty(wrapped, "setup", {
      enumerable: true,
      configurable: true,
      writable: true,
      value(build: Record<string, unknown>) {
        const onLoad = build.onLoad as (options: unknown, callback: (args: unknown) => unknown) => void;
        return setup.call(p, {
          ...build,
          onLoad(options: unknown, callback: (args: unknown) => unknown) {
            onLoad(options, (args) => {
              const result = callback(args);
              return result && typeof (result as PromiseLike<unknown>).then === "function"
                ? Promise.resolve(result).then(measure)
                : measure(result);
            });
          },
        });
      },
    });
    return wrapped;
  });
}

export async function build(cfg: BundleConfig): Promise<BundleOutput> {
  // register before initialize() - the cdn import inside isn't tracked
  // so the loop can drain mid-await if we do it the other way round
  const h = getRegistry().register("EsbuildOp");
  cfg = withEsbuildCompat(cfg);
  try {
    await currentEngine();
    const split = await buildDependencyGroups(cfg);
    if (split) return split;
    return await buildOn(await acquireEsbuild({ build: true }), cfg, true);
  } finally {
    h.close();
  }
}

// One build on a leased instance (released when it ends). Outputs are
// written to the volume when `write` and the config asks for it.
async function buildOn(leased: EsbuildLease, cfg: BundleConfig, write: boolean): Promise<BundleOutput> {
  let inputBytes = cfg.stdin?.contents?.length ?? 0;
  try {
    const engine = leased.engine;

    const volumePlugin = createVolumePlugin(cfg.external, cfg.platform, cfg.conditions);
    const userPlugins = [...(cfg.plugins || [])];
    // volume plugin goes last so other plugins' onLoad handlers run first
    if (volumePlugin) userPlugins.push(volumePlugin);
    const allPlugins = countingLoads(userPlugins, (bytes) => {
      inputBytes += bytes;
    });

    let entries = cfg.entryPoints;
    if (entries && volumeRef) {
      const base = cfg.absWorkingDir || resolveWorkingDir();
      entries = entries.map((ep) => toAbsolute(ep, base));
    }

    const workDir = cfg.absWorkingDir || resolveWorkingDir();

    // always get outputFiles in memory, then write to VFS if requested
    const shouldWrite = cfg.write !== false;

    const raw = (await engine.build({
      ...cfg,
      entryPoints: entries,
      plugins: allPlugins,
      write: false,
      absWorkingDir: workDir,
    })) as BundleOutput;

    stripNamespacePrefixes(raw);

    if (write && shouldWrite) writeOutputs(raw, workDir);

    return raw;
  } finally {
    leased.release(inputBytes);
  }
}

function writeOutputs(raw: BundleOutput, workDir: string): void {
  if (!raw.outputFiles || !volumeRef) return;
  for (const f of raw.outputFiles) {
    const outPath = f.path.startsWith("/") ? f.path : workDir + "/" + f.path;
    const dir = outPath.substring(0, outPath.lastIndexOf("/"));
    if (dir && !volumeRef.existsSync(dir)) {
      volumeRef.mkdirSync(dir, { recursive: true });
    }
    // the bytes as esbuild made them: `text` decodes them only for the
    // volume to encode them again (megabytes, for a dependency pre-bundle)
    volumeRef.writeFileSync(outPath, f.contents ?? f.text);
  }
}

// ── Parallel dependency pre-bundle ──
// Vite pre-bundles all of an app's dependencies in one build, and a build
// runs on one esbuild-wasm instance: Go compiled to wasm, one thread. Entries
// whose dependency closures share no package (a UI kit and the React it
// uses, next to three.js, date-fns, rxjs...) are bundled as separate builds
// on instances of their own, at the same time. The split result is only
// used if the builds' module sets turn out disjoint: then it is the output
// the single build gives, with chunks and helpers per group. Anything else
// (an overlap the package manifests didn't show, an error) runs the single
// build as before.
const SPLIT_MAX_BUILDS = 4;

function isDependencyPrebundle(cfg: BundleConfig): boolean {
  const c = cfg as BundleConfig & { splitting?: boolean; metafile?: boolean };
  return (
    Array.isArray(cfg.entryPoints) &&
    cfg.entryPoints.length >= 2 &&
    cfg.bundle === true &&
    c.splitting === true &&
    c.metafile === true &&
    cfg.format === "esm" &&
    !!cfg.outdir &&
    !cfg.stdin &&
    (cfg.plugins ?? []).some((p) => (p as { name?: string } | null)?.name === "vite:dep-pre-bundle")
  );
}

// Vite's flattenId (optimizer entry names)
function flattenId(id: string): string {
  return id.replace(/[/:]/g, "_").replace(/\./g, "__").replace(/(\s*>\s*)/g, "___");
}

function packageNamesIn(vol: MemoryVolume, nodeModules: string): string[] {
  const names: string[] = [];
  let entries: string[];
  try {
    entries = vol.readdirSync(nodeModules) as string[];
  } catch {
    return names;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      try {
        for (const sub of vol.readdirSync(`${nodeModules}/${name}`) as string[]) names.push(`${name}/${sub}`);
      } catch {
        /* unreadable scope */
      }
    } else {
      names.push(name);
    }
  }
  return names;
}

// node's lookup of a package from inside `fromDir`
function packageDirFrom(vol: MemoryVolume, name: string, fromDir: string, root: string): string | null {
  for (let dir = fromDir; ; ) {
    const candidate = `${dir === "/" ? "" : dir}/node_modules/${name}`;
    if (vol.existsSync(`${candidate}/package.json`)) return candidate;
    if (dir === "/" || dir.length <= root.length) break;
    const up = dir.substring(0, dir.lastIndexOf("/")) || "/";
    // a package's own node_modules dir holds its children, not itself
    dir = up.endsWith("/node_modules") ? up.substring(0, up.lastIndexOf("/")) || "/" : up;
  }
  return null;
}

// Groups of entries whose package closures don't overlap, largest first;
// null when the entries can't be mapped to installed packages
export function planDependencyGroups(vol: MemoryVolume, cfg: BundleConfig): Array<{ entries: string[]; packages: number }> | null {
  const root = (cfg.absWorkingDir || resolveWorkingDir()).replace(/\/+$/, "") || "/";
  const entries = cfg.entryPoints as string[];
  const byFlat = new Map<string, string>();
  for (const name of packageNamesIn(vol, `${root === "/" ? "" : root}/node_modules`)) byFlat.set(flattenId(name), name);

  const closures: Array<Set<string>> = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.includes("___")) return null;
    // the longest installed package whose flattened name starts the entry
    let pkg: string | null = null;
    for (let end = entry.length; end > 0; end = entry.lastIndexOf("_", end - 1)) {
      const hit = byFlat.get(entry.slice(0, end));
      if (hit) {
        pkg = hit;
        break;
      }
      if (end <= 0) break;
    }
    if (!pkg) return null;
    const start = packageDirFrom(vol, pkg, root, root);
    if (!start) return null;
    const closure = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const dir = queue.pop()!;
      let manifest: Record<string, Record<string, string> | undefined>;
      try {
        manifest = JSON.parse(vol.readFileSync(`${dir}/package.json`, "utf8") as string);
      } catch {
        continue;
      }
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        for (const dep of Object.keys(manifest[field] ?? {})) {
          const depDir = packageDirFrom(vol, dep, dir, root);
          if (depDir && !closure.has(depDir)) {
            closure.add(depDir);
            queue.push(depDir);
          }
        }
      }
    }
    closures.push(closure);
  }

  // union entries that share any package
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map<string, number>();
  closures.forEach((closure, i) => {
    for (const dir of closure) {
      const j = owner.get(dir);
      if (j === undefined) owner.set(dir, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, { entries: string[]; packages: Set<string> }>();
  entries.forEach((entry, i) => {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { entries: [], packages: new Set() }));
    g.entries.push(entry);
    for (const dir of closures[i]) g.packages.add(dir);
  });
  return [...groups.values()]
    .map((g) => ({ entries: g.entries, packages: g.packages.size }))
    .sort((a, b) => b.packages - a.packages);
}

async function buildDependencyGroups(cfg: BundleConfig): Promise<BundleOutput | null> {
  if (!volumeRef || !isDependencyPrebundle(cfg)) return null;
  const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 2;
  const maxBuilds = Math.min(SPLIT_MAX_BUILDS, Math.max(1, cores - 2));
  if (maxBuilds < 2) return null;
  let groups: Array<{ entries: string[]; packages: number }> | null;
  try {
    groups = planDependencyGroups(volumeRef, cfg);
  } catch {
    return null;
  }
  if (!groups || groups.length < 2) return null;

  // the biggest group on its own; the rest spread over the other builds,
  // each onto the least loaded (by package count)
  const slots: string[][] = [groups[0].entries.slice()];
  const rest = groups.slice(1);
  const others = Math.min(maxBuilds - 1, rest.length);
  const load: number[] = [];
  for (let i = 0; i < others; i++) {
    slots.push([]);
    load.push(0);
  }
  for (const g of rest) {
    const i = load.indexOf(Math.min(...load));
    slots[1 + i].push(...g.entries);
    load[i] += g.packages;
  }

  const acquired = await Promise.allSettled(
    slots.map((_, i) => (i === 0 ? acquireEsbuild({ build: true }) : acquireDedicatedEsbuild())),
  );
  const leases = acquired.map((a) => (a.status === "fulfilled" ? a.value : null));
  if (leases.some((l) => !l)) {
    for (const l of leases) l?.release();
    return null;
  }
  // every group finishes before a failure falls back, so the single build
  // doesn't run alongside the rest of them
  const built = await Promise.allSettled(
    slots.map((entryPoints, i) => buildOn(leases[i]!, { ...cfg, entryPoints }, false)),
  );
  // the single build reports the error as it always has
  if (built.some((b) => b.status === "rejected")) return null;
  const results = built.map((b) => (b as PromiseFulfilledResult<BundleOutput>).value);

  const merged = mergeGroupResults(results);
  if (!merged) return null;
  if (cfg.write !== false) writeOutputs(merged, cfg.absWorkingDir || resolveWorkingDir());
  return merged;
}

// one result from disjoint group builds, or null if they weren't disjoint
export function mergeGroupResults(results: BundleOutput[]): BundleOutput | null {
  const inputs: Record<string, unknown> = {};
  const outputs: Record<string, unknown> = {};
  const files = new Map<string, { path: string; contents: Uint8Array; text: string }>();
  const warnings: unknown[] = [];
  for (const r of results) {
    if (!r.metafile?.inputs || !r.metafile.outputs || !r.outputFiles) return null;
    for (const [path, info] of Object.entries(r.metafile.inputs)) {
      if (path in inputs) return null;
      inputs[path] = info;
    }
    for (const [path, info] of Object.entries(r.metafile.outputs)) {
      // shared runtime-helper chunks come out byte-identical, same name
      if (path in outputs && JSON.stringify(outputs[path]) !== JSON.stringify(info)) return null;
      outputs[path] = info;
    }
    for (const f of r.outputFiles) {
      const known = files.get(f.path);
      if (known && known.text !== f.text) return null;
      files.set(f.path, f);
    }
    warnings.push(...(r.warnings ?? []));
  }
  return {
    ...results[0],
    errors: [],
    warnings,
    outputFiles: [...files.values()],
    metafile: { ...results[0].metafile, inputs, outputs },
  };
}

export async function formatMessages(
  messages: unknown[],
  opts?: { kind?: "error" | "warning"; color?: boolean },
): Promise<string[]> {
  // leased like any call: right after a large build the instance that ran
  // it is being replaced, which is exactly when a tool formats its errors
  const h = getRegistry().register("EsbuildOp");
  try {
    const leased = await acquireEsbuild({ wasmURL: wasmBinaryUrl });
    try {
      return await (
        leased.engine as unknown as {
          formatMessages: (m: unknown[], o?: unknown) => Promise<string[]>;
        }
      ).formatMessages(messages, opts);
    } finally {
      leased.release();
    }
  } finally {
    h.close();
  }
}

// single source of truth: the pinned CDN version we actually load
export const version = PINNED_ESBUILD_WASM;

// build context for incremental builds (used by Vite)
export async function context(cfg: BundleConfig): Promise<{
  rebuild: () => Promise<BundleOutput>;
  watch: (opts?: unknown) => Promise<void>;
  serve: (opts?: unknown) => Promise<{ host: string; port: number }>;
  cancel: () => Promise<void>;
  dispose: () => Promise<void>;
}> {
  const initHandle = getRegistry().register("EsbuildOp");
  try {
    await currentEngine();
  } finally {
    initHandle.close();
  }

  let disposed = false;
  const ctx = {
    async rebuild(): Promise<BundleOutput> {
      if (disposed) throw new Error("Build context already disposed");
      return build(cfg);
    },
    async watch(_opts?: unknown): Promise<void> {},
    async serve(_opts?: unknown): Promise<{ host: string; port: number }> {
      return { host: "localhost", port: 0 };
    },
    async cancel(): Promise<void> {},
    async dispose(): Promise<void> {
      disposed = true;
    },
  };
  return ctx;
}

export function stop(): void {}

export async function analyzeMetafile(
  metafile:
    | string
    | { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> },
  _opts?: { verbose?: boolean; color?: boolean },
): Promise<string> {
  const meta = typeof metafile === "string" ? JSON.parse(metafile) : metafile;
  const outputs = meta?.outputs ?? {};
  const lines: string[] = [];
  for (const [name, info] of Object.entries(outputs)) {
    const bytes = (info as any)?.bytes ?? 0;
    lines.push(`  ${name}  ${(bytes / 1024).toFixed(1)}kb`);
  }
  return lines.join("\n");
}

export function analyzeMetafileSync(
  metafile:
    | string
    | { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> },
  _opts?: { verbose?: boolean; color?: boolean },
): string {
  const meta = typeof metafile === "string" ? JSON.parse(metafile) : metafile;
  const outputs = meta?.outputs ?? {};
  const lines: string[] = [];
  for (const [name, info] of Object.entries(outputs)) {
    const bytes = (info as any)?.bytes ?? 0;
    lines.push(`  ${name}  ${(bytes / 1024).toFixed(1)}kb`);
  }
  return lines.join("\n");
}

// can't truly block for WASM in browser, so just return source unchanged
export function transformSync(
  source: string,
  cfg?: TransformConfig,
): TransformOutput {
  return { code: source, map: "", warnings: [] };
}

export function buildSync(cfg: BundleConfig): BundleOutput {
  return { errors: [], warnings: [], outputFiles: [] };
}

export default {
  initialize,
  transform,
  transformSync,
  build,
  buildSync,
  context,
  stop,
  formatMessages,
  analyzeMetafile,
  analyzeMetafileSync,
  version,
  setVolume,
  setWasmUrl,
};

// Internal helpers

const NODE_CONDITION_ORDER = [
  "node",
  "browser",
  "require",
  "module",
  "import",
  "default",
] as const;

const BROWSER_CONDITION_ORDER = [
  "browser",
  "module",
  "import",
  "node",
  "require",
  "default",
] as const;

function pickCondition(entry: ExportValue, platform?: string, conditions?: string[]): string | undefined {
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && entry !== null) {
    if (conditions) {
      for (const cond of conditions) {
        const nested = (entry as ExportMap)[cond];
        if (nested !== undefined) {
          const resolved = pickCondition(nested, platform, conditions);
          if (resolved) return resolved;
        }
      }
    }
    const order = platform === "browser" ? BROWSER_CONDITION_ORDER : NODE_CONDITION_ORDER;
    for (const cond of order) {
      const nested = (entry as ExportMap)[cond];
      if (nested !== undefined) {
        const resolved = pickCondition(nested, platform, conditions);
        if (resolved) return resolved;
      }
    }
  }
  return undefined;
}

function locateModule(
  vol: MemoryVolume,
  specifier: string,
  exts: string[],
  fromDir?: string,
  platform?: string,
  conditions?: string[],
): ModuleHit | null {
  const parts = specifier.split("/");
  const scoped = parts[0].startsWith("@");
  const pkgName = scoped ? parts.slice(0, 2).join("/") : parts[0];
  const subPath = scoped ? parts.slice(2).join("/") : parts.slice(1).join("/");

  const searchRoots: string[] = [];
  if (fromDir) {
    let dir = fromDir;
    while (dir !== "/" && dir) {
      searchRoots.push(dir + "/node_modules/" + pkgName);
      const parent = dir.substring(0, dir.lastIndexOf("/")) || "/";
      if (parent === dir) break;
      dir = parent;
    }
  }
  searchRoots.push("/node_modules/" + pkgName);
  // also walk from cwd, handles projects outside /project/ (e.g. /home/test/)
  const cwd = typeof process !== 'undefined' && process.cwd ? process.cwd() : '/';
  if (cwd !== '/' && cwd !== fromDir) {
    let d = cwd;
    while (d !== '/' && d) {
      const c = d + '/node_modules/' + pkgName;
      if (!searchRoots.includes(c)) searchRoots.push(c);
      const p = d.substring(0, d.lastIndexOf('/')) || '/';
      if (p === d) break;
      d = p;
    }
  }

  let base: string | null = null;
  for (const candidate of searchRoots) {
    if (vol.existsSync(candidate)) {
      base = candidate;
      break;
    }
  }
  if (!base) return null;

  const pkgJsonPath = base + "/package.json";
  if (!vol.existsSync(pkgJsonPath)) return null;

  try {
    const raw = vol.readFileSync(pkgJsonPath, "utf8");
    const pkg: PackageJson = JSON.parse(raw);

    let found: string | null = null;

    if (subPath) {
      found = resolveSubpath(vol, pkg, base, subPath, exts, platform, conditions);
    } else {
      found = resolveRoot(vol, pkg, base, exts, platform, conditions);
    }

    if (found) return { resolvedPath: found, fromVolume: true };
  } catch {
    /* parse failure */
  }

  return null;
}

function resolveSubpath(
  vol: MemoryVolume,
  pkg: PackageJson,
  base: string,
  sub: string,
  exts: string[],
  platform?: string,
  conditions?: string[],
): string | null {
  if (pkg.exports && typeof pkg.exports === "object") {
    const key = "./" + sub;
    const mapEntry = (pkg.exports as ExportMap)[key];
    if (mapEntry) {
      const target = pickCondition(mapEntry, platform, conditions);
      if (target) {
        const full = base + "/" + target.replace(/^\.\//, "");
        const hit = probeFile(vol, full, ["", ".js", ".ts", ".mjs"]);
        if (hit) return hit;
      }
    }
  }
  return probeFile(vol, base + "/" + sub, exts);
}

function resolveRoot(
  vol: MemoryVolume,
  pkg: PackageJson,
  base: string,
  exts: string[],
  platform?: string,
  conditions?: string[],
): string | null {
  if (pkg.exports) {
    const top =
      typeof pkg.exports === "object" && !Array.isArray(pkg.exports)
        ? (pkg.exports as ExportMap)["."] || pkg.exports
        : pkg.exports;
    const target = pickCondition(top as ExportValue, platform, conditions);
    if (target) {
      const full = base + "/" + target.replace(/^\.\//, "");
      const hit = probeFile(vol, full, ["", ".js", ".ts", ".mjs"]);
      if (hit) return hit;
    }
  }
  const fallback = pkg.module || pkg.main || "index.js";
  return probeFile(vol, base + "/" + fallback.replace(/^\.\//, ""), exts);
}

// resolve #-prefixed subpath imports via package.json "imports" field
function resolvePackageImport(
  vol: MemoryVolume,
  specifier: string,
  exts: string[],
  fromDir: string,
  platform?: string,
  conditions?: string[],
): string | null {
  let dir = fromDir;
  while (dir && dir !== "/") {
    const pkgPath = dir + "/package.json";
    if (vol.existsSync(pkgPath)) {
      try {
        const pkg: PackageJson = JSON.parse(vol.readFileSync(pkgPath, "utf8"));
        if (pkg.imports) {
          const entry = pkg.imports[specifier];
          if (entry !== undefined) {
            const target = pickCondition(entry, platform, conditions);
            if (target) {
              const full = dir + "/" + target.replace(/^\.\//, "");
              const hit = probeFile(vol, full, ["", ...exts]);
              if (hit) return hit;
            }
          }

          for (const key of Object.keys(pkg.imports)) {
            const starIdx = key.indexOf("*");
            if (starIdx === -1) continue;
            const prefix = key.slice(0, starIdx);
            const suffix = key.slice(starIdx + 1);
            if (
              specifier.startsWith(prefix) &&
              specifier.endsWith(suffix) &&
              specifier.length >= prefix.length + suffix.length
            ) {
              const matched = suffix.length
                ? specifier.slice(prefix.length, -suffix.length)
                : specifier.slice(prefix.length);
              const target = pickCondition(pkg.imports[key], platform, conditions);
              if (target) {
                const resolved = target.replace(/\*/g, matched);
                const full = dir + "/" + resolved.replace(/^\.\//, "");
                const hit = probeFile(vol, full, ["", ...exts]);
                if (hit) return hit;
              }
            }
          }
        }
      } catch {
        /* parse failure — skip */
      }
    }
    const parent = dir.substring(0, dir.lastIndexOf("/")) || "/";
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function probeFile(
  vol: MemoryVolume,
  candidate: string,
  exts: string[],
): string | null {
  for (const ext of exts) {
    const p = candidate + ext;
    if (vol.existsSync(p)) {
      try {
        if (!vol.statSync(p).isDirectory()) return p;
      } catch {
        return p;
      }
    }
  }
  return null;
}

function resolveWorkingDir(): string {
  if (
    typeof globalThis !== "undefined" &&
    globalThis.process &&
    typeof globalThis.process.cwd === "function"
  ) {
    return globalThis.process.cwd();
  }
  return "/";
}

function toAbsolute(entry: string, base: string): string {
  if (entry.includes("vfs:")) {
    entry = entry.substring(entry.indexOf("vfs:") + 4);
  }
  if (entry.startsWith("/")) return entry;
  if (entry.startsWith("./")) {
    const b = base.endsWith("/") ? base.slice(0, -1) : base;
    return b + "/" + entry.slice(2);
  }
  if (entry.startsWith("../")) {
    const segments = (base.endsWith("/") ? base.slice(0, -1) : base)
      .split("/")
      .filter(Boolean);
    segments.pop();
    return "/" + segments.join("/") + "/" + entry.slice(3);
  }
  return entry;
}

function normalizeParts(raw: string): string {
  const pieces = raw.split("/").filter(Boolean);
  const stack: string[] = [];
  for (const piece of pieces) {
    if (piece === "..") stack.pop();
    else if (piece !== ".") stack.push(piece);
  }
  return "/" + stack.join("/");
}

function stripNamespacePrefixes(output: BundleOutput): void {
  if (output.outputFiles) {
    for (const f of output.outputFiles) {
      if (f.path.includes("vfs:")) f.path = f.path.replace(/vfs:/g, "");
    }
  }
  if (output.metafile) {
    const m = output.metafile as {
      inputs?: Record<string, unknown>;
      outputs?: Record<string, unknown>;
    };
    for (const bucket of ["inputs", "outputs"] as const) {
      const obj = m[bucket];
      if (!obj) continue;
      for (const key of Object.keys(obj)) {
        if (key.includes("vfs:")) {
          obj[key.replace(/vfs:/g, "")] = obj[key];
          delete obj[key];
        }
      }
    }
  }
}

function createVolumePlugin(externals?: string[], platform?: string, conditions?: string[]): unknown {
  if (!volumeRef) return null;
  const vol = volumeRef;

  return {
    name: "volume-loader",
    setup(api: unknown) {
      const b = api as {
        onResolve: (
          o: { filter: RegExp; namespace?: string },
          cb: (a: { path: string; importer: string; kind: string }) => unknown,
        ) => void;
        onLoad: (
          o: { filter: RegExp; namespace?: string },
          cb: (a: {
            path: string;
            namespace?: string;
            pluginData?: Record<string, unknown>;
          }) => unknown,
        ) => void;
      };

      const tryExts = ["", ...RESOLVE_EXTENSIONS];

      const nativeAddonCache = new Map<string, boolean>();

      function volumeHit(filePath: string) {
        return { path: filePath, pluginData: { fromVolume: true } };
      }

      b.onResolve({ filter: /.*/ }, (args) => {
        const { path: raw, importer } = args;

        if (raw.endsWith(".node")) {
          return { external: true };
        }

        // externalize packages with native bindings (napi/binary/gypfile in package.json)
        if (!raw.startsWith(".") && !raw.startsWith("/") && !raw.startsWith("#")) {
          const parts = raw.split("/");
          const scoped = parts[0].startsWith("@");
          const pkgName = scoped ? parts.slice(0, 2).join("/") : parts[0];

          const cached = nativeAddonCache.get(pkgName);
          if (cached === true) return { external: true };
          if (cached === undefined) {
            const candidates: string[] = [];
            if (importer) {
              let dir = importer.substring(0, importer.lastIndexOf("/"));
              while (dir && dir !== "/") {
                candidates.push(dir + "/node_modules/" + pkgName);
                dir = dir.substring(0, dir.lastIndexOf("/")) || "/";
              }
            }
            candidates.push("/node_modules/" + pkgName);
            // also walk from cwd, for projects outside /project/
            const cwd2 = typeof process !== 'undefined' && process.cwd ? process.cwd() : '/';
            if (cwd2 !== '/') {
              let d2 = cwd2;
              while (d2 !== '/' && d2) {
                const c2 = d2 + '/node_modules/' + pkgName;
                if (!candidates.includes(c2)) candidates.push(c2);
                const p2 = d2.substring(0, d2.lastIndexOf('/')) || '/';
                if (p2 === d2) break;
                d2 = p2;
              }
            }
            let isNative = false;
            for (const candidate of candidates) {
              if (!vol.existsSync(candidate)) continue;
              try {
                const pkgJson = JSON.parse(vol.readFileSync(candidate + "/package.json", "utf8"));
                if (pkgJson.napi || pkgJson.binary || pkgJson.gypfile) {
                  isNative = true;
                }
              } catch { /* no package.json — proceed */ }
              break;
            }
            nativeAddonCache.set(pkgName, isNative);
            if (isNative) return { external: true };
          }
        }

        if (raw.startsWith("node_modules/")) {
          const absPath = "/" + raw;
          const found = probeFile(vol, absPath, tryExts);
          if (found) return volumeHit(found);
          return { external: true };
        }

        if (raw.startsWith("/")) {
          const found = probeFile(vol, raw, tryExts);
          return found ? volumeHit(found) : { external: true };
        }

        if (raw.startsWith(".")) {
          let combined = raw;
          if (importer) {
            const dir = importer.substring(0, importer.lastIndexOf("/"));
            combined = dir + "/" + raw;
          }
          const normed = normalizeParts(combined);

          const found = probeFile(vol, normed, tryExts);
          if (found) return volumeHit(found);

          for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
            const idx = probeFile(vol, normed + "/index" + ext, [""]);
            if (idx) return volumeHit(idx);
          }
        }

        if (raw.startsWith("#")) {
          const importerDir = importer
            ? importer.substring(0, importer.lastIndexOf("/"))
            : resolveWorkingDir();
          const resolved = resolvePackageImport(vol, raw, tryExts, importerDir, platform, conditions);
          if (resolved) return volumeHit(resolved);
          return { external: true };
        }

        if (
          externals &&
          externals.some((e) => raw === e || raw.startsWith(e + "/"))
        ) {
          return { external: true };
        }

        const importerDir = importer
          ? importer.substring(0, importer.lastIndexOf("/"))
          : resolveWorkingDir();
        const hit = locateModule(vol, raw, tryExts, importerDir, platform, conditions);
        if (hit) {
          return { path: hit.resolvedPath, pluginData: { fromVolume: true } };
        }

        // builtins resolve at runtime via our module resolver
        const bare = raw.replace(/^node:/, "");
        if (BUILTIN_MODULES.has(bare)) {
          return { external: true };
        }

        // let other plugins handle virtual module IDs (e.g. Vite dep optimizer)
        if (args.kind === "entry-point") {
          return undefined;
        }

        return { external: true };
      });

      b.onLoad({ filter: /.*/, namespace: "builtin-stub" }, () => {
        return { contents: "module.exports = {};", loader: "js" as const };
      });

      // read from VFS -- matches ALL paths since other plugins may resolve to relative paths
      b.onLoad({ filter: /.*/ }, (args) => {
        if (
          args.namespace &&
          args.namespace !== "file" &&
          args.namespace !== ""
        )
          return null;

        const fromVolume = args.pluginData?.fromVolume;

        if (!fromVolume) {
          let tryPath = args.path;
          if (!tryPath.startsWith("/")) {
            tryPath = "/" + tryPath;
          }
          if (!vol.existsSync(tryPath)) return null;
          args = {
            ...args,
            path: tryPath,
            pluginData: { fromVolume: true, actualPath: tryPath },
          };
        }
        try {
          const diskPath =
            (args.pluginData?.actualPath as string | undefined) || args.path;
          let source: string;
          if (vol.existsSync(diskPath)) {
            source = vol.readFileSync(diskPath, "utf8");
          } else {
            throw new Error(`Not found: ${diskPath}`);
          }

          // stub out files that require .node native addons
          if (diskPath.includes("node_modules") &&
              /require\(.+\.node['"`)]/m.test(source.slice(0, 4096))) {
            return { contents: "module.exports = {};", loader: "js" as const };
          }

          // strip top-level await so esbuild doesn't reject CJS require() calls
          if (/\bawait\b/.test(source) && !args.path.endsWith(".mjs")) {
            source = stripTopLevelAwait(source, "topLevelOnly");
          }

          const dot = diskPath.lastIndexOf(".");
          const ext = dot >= 0 ? diskPath.substring(dot) : "";
          const loaderMap = ESBUILD_LOADER_MAP;
          let loader = loaderMap[ext] as
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "json"
            | "css"
            | "text"
            | "file"
            | undefined;

          // unknown extensions: let other plugins handle (e.g. .html, .svelte, .vue)
          if (!loader) return null;

          return { contents: source, loader };
        } catch (err) {
          if (args.path.endsWith(".map")) {
            return {
              contents: '{"version":3,"sources":[],"mappings":""}',
              loader: "json" as const,
            };
          }
          return {
            errors: [{ text: `volume-loader: ${args.path} -- ${err}` }],
          };
        }
      });
    },
  };
}
