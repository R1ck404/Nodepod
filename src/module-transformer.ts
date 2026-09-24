// ESM-to-CJS bulk transformer (esbuild-wasm). Used at install time to
// pre-convert packages so synchronous require() works at runtime.
// Transforms are offloaded to Web Workers when available.

import type { MemoryVolume } from "./memory-volume";
import { offload, profiledOffload, taskId, TaskPriority } from "./threading/offload";
import type { TransformBatchResult, TransformBatchTask, TransformResult } from "./threading/offload-types";
import { getEsbuild, getEsbuildIfReady, acquireEsbuild, type EsbuildEngine } from "./helpers/esbuild-engine";
import type { NodepodProfilerImpl } from "./profiling/profiler";
import { chunkTransformFiles } from "./threading/transform-batching";
import { containsJsx } from "./threading/jsx-detection";

const inBrowser = typeof window !== "undefined";

const BUILTIN_MODULES = [
  "assert", "buffer", "child_process", "cluster", "crypto",
  "dgram", "dns", "events", "fs", "http", "http2", "https",
  "net", "os", "path", "perf_hooks", "querystring", "readline",
  "stream", "string_decoder", "timers", "tls", "url", "util",
  "v8", "vm", "worker_threads", "zlib", "async_hooks",
  "inspector", "module",
] as const;

const BUILTIN_MODULE_PATTERN = BUILTIN_MODULES.join("|");
const BUILTIN_IMPORT_RE = new RegExp(
  `\\bimport\\s*\\(\\s*["']((?:node:)?(?:${BUILTIN_MODULE_PATTERN}))["']\\s*\\)`,
  "g",
);
const BUILTIN_IMPORT_PROBE = new RegExp(
  `\\bimport\\s*\\(\\s*["'](?:node:)?(?:${BUILTIN_MODULE_PATTERN})["']`,
);

// load and init esbuild-wasm from CDN (realm-wide singleton, shared with the esbuild polyfill)
export async function prepareTransformer(): Promise<void> {
  if (!inBrowser) {
    return;
  }
  await getEsbuild();
}

export function isTransformerLoaded(): boolean {
  if (!inBrowser) return true;
  return getEsbuildIfReady() !== null;
}

function detectLoader(
  filePath: string,
  source: string,
): "js" | "jsx" | "ts" | "tsx" {
  if (filePath.endsWith(".jsx")) return "jsx";
  if (filePath.endsWith(".ts")) return "ts";
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".mjs")) return "js";
  if (containsJsx(source)) return "jsx";
  return "js";
}

// convert a single file ESM->CJS via offloaded esbuild.transform()
export async function convertFile(
  source: string,
  filePath: string,
  profiler?: NodepodProfilerImpl | null,
): Promise<string> {
  if (!inBrowser) return source;

  const task = {
    type: "transform",
    id: taskId(),
    source,
    filePath,
    options: {
      loader: detectLoader(filePath, source),
      format: "cjs",
      target: "esnext",
      platform: "neutral",
      define: {
        "import.meta.url": "import_meta.url",
        "import.meta.dirname": "import_meta.dirname",
        "import.meta.filename": "import_meta.filename",
        "import.meta": "import_meta",
      },
    },
    priority: TaskPriority.NORMAL,
  } as const;
  const result: TransformResult = await (profiler
    ? profiledOffload(task, profiler)
    : offload(task));

  return patchBuiltinImports(result.code);
}

// direct main-thread esbuild transform (no worker offloading).
// used as the fallback path to avoid circular offload -> convertFile -> offload.
export async function convertFileDirect(
  source: string,
  filePath: string,
): Promise<string> {
  if (!inBrowser) return source;
  // leased: the engine may retire an instance, never under a running call
  const leased = await acquireEsbuild();
  try {
    return await convertFileDirectWith(leased.engine, source, filePath);
  } finally {
    leased.release(source.length);
  }
}

async function convertFileDirectWith(
  engine: EsbuildEngine,
  source: string,
  filePath: string,
): Promise<string> {
  const loader = detectLoader(filePath, source);

  try {
    const output = await engine.transform(source, {
      loader,
      format: "cjs",
      target: "esnext",
      platform: "neutral",
      define: {
        "import.meta.url": "import_meta.url",
        "import.meta.dirname": "import_meta.dirname",
        "import.meta.filename": "import_meta.filename",
        "import.meta": "import_meta",
      },
    });
    return patchBuiltinImports(output.code);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    // retry with alternative loaders
    if (loader === "js" || loader === "jsx") {
      const fallbacks = loader === "js" ? ["jsx", "tsx", "ts"] : ["tsx"];
      for (const fallbackLoader of fallbacks) {
        try {
          const output = await engine.transform(source, {
            loader: fallbackLoader as "jsx" | "tsx" | "ts",
            format: "cjs",
            target: "esnext",
            platform: "neutral",
            define: {
              "import.meta.url": "import_meta.url",
              "import.meta.dirname": "import_meta.dirname",
              "import.meta.filename": "import_meta.filename",
              "import.meta": "import_meta",
            },
          });
          return patchBuiltinImports(output.code);
        } catch {
        }
      }
    }

    if (msg.includes("Top-level await")) {
      try {
        const output = await engine.transform(source, {
          loader,
          format: "esm",
          target: "esnext",
          platform: "neutral",
          define: {
            "import.meta.url": "import_meta.url",
            "import.meta.dirname": "import_meta.dirname",
            "import.meta.filename": "import_meta.filename",
            "import.meta": "import_meta",
          },
        });
        return patchBuiltinImports(output.code);
      } catch {
        return patchBuiltinImports(source);
      }
    }
    return patchBuiltinImports(source);
  }
}

function requiresConversion(filePath: string, source: string): boolean {
  // .mjs must stay ESM in the VFS -- tools read them directly. the runtime
  // handles ESM->CJS on-the-fly for require().
  if (filePath.endsWith(".mjs")) return false;
  if (filePath.endsWith(".cjs")) return false;
  return (
    /\bimport\s+[\w{*'"]/m.test(source) ||
    /\bexport\s+(?:default|const|let|var|function|class|{|\*)/m.test(source) ||
    /\bimport\.meta\b/.test(source)
  );
}

function needsBuiltinPatching(source: string): boolean {
  return BUILTIN_IMPORT_PROBE.test(source);
}

export function patchBuiltinImports(source: string): string {
  return source.replace(
    BUILTIN_IMPORT_RE,
    (_match, moduleName: string) => `Promise.resolve(require("${moduleName}"))`,
  );
}

function listJsFiles(vol: MemoryVolume, dir: string): string[] {
  const result: string[] = [];
  try {
    for (const name of vol.readdirSync(dir)) {
      const full = dir + "/" + name;
      try {
        const info = vol.statSync(full);
        if (info.isDirectory()) {
          if (name !== "node_modules") result.push(...listJsFiles(vol, full));
        } else if (
          name.endsWith(".js") ||
          name.endsWith(".mjs") ||
          name.endsWith(".jsx")
        ) {
          result.push(full);
        }
      } catch {
      }
    }
  } catch {
  }
  return result;
}

function isEsmPackage(vol: MemoryVolume, packageDir: string): boolean {
  try {
    const pkgPath = packageDir + "/package.json";
    if (vol.existsSync(pkgPath)) {
      const raw = vol.readFileSync(pkgPath, "utf8");
      const pkg = JSON.parse(raw);
      return pkg.type === "module";
    }
  } catch {
  }
  return false;
}

// convert all ESM files in a package directory to CJS
export async function convertPackage(
  vol: MemoryVolume,
  packageDir: string,
  onProgress?: (msg: string) => void,
  profiler?: NodepodProfilerImpl | null,
): Promise<number> {
  const profileSpan = profiler?.begin("modules.transform", {
    category: "modules",
    metadata: { path: packageDir },
  }) ?? null;
  let converted = 0;
  const files = listJsFiles(vol, packageDir);
  onProgress?.(`  Converting ${files.length} files in ${packageDir}...`);

  // "type":"module" packages stay as ESM in VFS -- tools like Vite read them
  // directly and expect ESM syntax. require() handles conversion at runtime.
  const esmPackage = isEsmPackage(vol, packageDir);

  const candidates: TransformBatchTask["files"] = [];
  for (const fp of files) {
    try {
      const src = vol.readFileSync(fp, "utf8");

      // "type":"module" packages and .mjs files stay ESM in the VFS.
      if (esmPackage || fp.endsWith(".mjs")) {
        if (needsBuiltinPatching(src)) {
          vol.writeFileSync(fp, patchBuiltinImports(src));
          converted++;
        }
        continue;
      }

      if (requiresConversion(fp, src)) {
        candidates.push({
          filePath: fp,
          source: src,
          loader: detectLoader(fp, src),
        });
      } else if (needsBuiltinPatching(src)) {
        vol.writeFileSync(fp, patchBuiltinImports(src));
        converted++;
      }
    } catch {
      // Keep the existing best-effort package conversion behavior.
    }
  }

  const batches: TransformBatchTask[] = chunkTransformFiles(candidates).map((files) => ({
    type: "transformBatch",
    id: taskId(),
    files,
    options: {
      format: "cjs",
      target: "esnext",
      platform: "neutral",
      define: {
        "import.meta.url": "import_meta.url",
        "import.meta.dirname": "import_meta.dirname",
        "import.meta.filename": "import_meta.filename",
        "import.meta": "import_meta",
      },
    },
    priority: TaskPriority.NORMAL,
  }));

  const results: TransformBatchResult[] = await Promise.all(
    batches.map((batch) => profiler
      ? profiledOffload(batch, profiler)
      : offload(batch)),
  );
  for (const batch of results) {
    for (const result of batch.results) {
      try {
        vol.writeFileSync(result.filePath, result.code);
        converted++;
      } catch {
      }
    }
  }

  profiler?.count("modules.transformedFiles", converted);
  profiler?.end(profileSpan);
  return converted;
}
