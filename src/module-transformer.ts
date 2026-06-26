// ESM-to-CJS bulk transformer (esbuild-wasm). Used at install time to
// pre-convert packages so synchronous require() works at runtime.
// Transforms are offloaded to Web Workers when available.

import type { IVolume } from "./types/volume";
import { CDN_ESBUILD_ESM, CDN_ESBUILD_BINARY, cdnImport } from "./constants/cdn-urls";
import { offload, taskId, TaskPriority } from "./threading/offload";
import type { TransformResult } from "./threading/offload-types";

const inBrowser = typeof window !== "undefined";

// load and init esbuild-wasm from CDN (reuses existing instance)
export async function prepareTransformer(): Promise<void> {
  if (!inBrowser) {
    return;
  }

  if (window.__esbuildEngine) {
    return;
  }

  if (window.__esbuildReady) {
    return window.__esbuildReady;
  }

  window.__esbuildReady = (async () => {
    try {
      const loaded = await cdnImport(CDN_ESBUILD_ESM);
      const engine = loaded.default || loaded;

      try {
        await engine.initialize({ wasmURL: CDN_ESBUILD_BINARY });
      } catch (initErr) {
        if (
          initErr instanceof Error &&
          initErr.message.includes('Cannot call "initialize" more than once')
        ) {
          /* already initialized, ignore */
        } else {
          throw initErr;
        }
      }

      window.__esbuildEngine = engine;
    } catch (err) {
      window.__esbuildReady = undefined;
      throw err;
    }
  })();

  return window.__esbuildReady;
}

export function isTransformerLoaded(): boolean {
  if (!inBrowser) return true;
  return window.__esbuildEngine !== undefined;
}

function containsJsx(source: string): boolean {
  if (/<[A-Z][a-zA-Z0-9.]*[\s/>]/.test(source)) return true;
  if (/<\/[a-zA-Z]/.test(source)) return true;
  if (/\/>/.test(source)) return true;
  if (/<>|<\/>/.test(source)) return true;
  if (/React\.createElement\b/.test(source)) return true;
  if (/jsx\(|jsxs\(|jsxDEV\(/.test(source)) return true;
  return false;
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
): Promise<string> {
  if (!inBrowser) return source;

  const result: TransformResult = await offload({
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
  });

  // patch dynamic imports of node builtins to synchronous require()
  let code = result.code;
  code = code.replace(
    /\bimport\s*\(\s*["']node:([^"']+)["']\s*\)/g,
    'Promise.resolve(require("node:$1"))',
  );

  const coreModules = [
    "assert", "buffer", "child_process", "cluster", "crypto",
    "dgram", "dns", "events", "fs", "http", "http2", "https",
    "net", "os", "path", "perf_hooks", "querystring", "readline",
    "stream", "string_decoder", "timers", "tls", "url", "util",
    "v8", "vm", "worker_threads", "zlib", "async_hooks",
    "inspector", "module",
  ];
  for (const mod of coreModules) {
    const re = new RegExp(`\\bimport\\s*\\(\\s*["']${mod}["']\\s*\\)`, "g");
    code = code.replace(re, `Promise.resolve(require("${mod}"))`);
  }

  return code;
}

// direct main-thread esbuild transform (no worker offloading).
// used as the fallback path to avoid circular offload -> convertFile -> offload.
export async function convertFileDirect(
  source: string,
  filePath: string,
): Promise<string> {
  if (!inBrowser) return source;

  if (!window.__esbuildEngine) await prepareTransformer();
  const engine = window.__esbuildEngine;
  if (!engine) throw new Error("esbuild engine not available");

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
    return output.code;
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
          return output.code;
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
        return output.code;
      } catch {
        return source;
      }
    }
    return source;
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
  return (
    /\bimport\s*\(\s*["']node:/.test(source) ||
    /\bimport\s*\(\s*["'](fs|path|http|https|net|url|util|events|stream|os|crypto)["']/.test(
      source,
    )
  );
}

function patchBuiltinImports(source: string): string {
  let patched = source;
  patched = patched.replace(
    /\bimport\s*\(\s*["']node:([^"']+)["']\s*\)/g,
    'Promise.resolve(require("node:$1"))',
  );
  const builtins = [
    "assert",
    "buffer",
    "child_process",
    "cluster",
    "crypto",
    "dgram",
    "dns",
    "events",
    "fs",
    "http",
    "http2",
    "https",
    "net",
    "os",
    "path",
    "perf_hooks",
    "querystring",
    "readline",
    "stream",
    "string_decoder",
    "timers",
    "tls",
    "url",
    "util",
    "v8",
    "vm",
    "worker_threads",
    "zlib",
    "async_hooks",
    "inspector",
    "module",
  ];
  for (const b of builtins) {
    patched = patched.replace(
      new RegExp(`\\bimport\\s*\\(\\s*["']${b}["']\\s*\\)`, "g"),
      `Promise.resolve(require("${b}"))`,
    );
  }
  return patched;
}

function listJsFiles(vol: IVolume, dir: string): string[] {
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

function isEsmPackage(vol: IVolume, packageDir: string): boolean {
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
  vol: IVolume,
  packageDir: string,
  onProgress?: (msg: string) => void,
): Promise<number> {
  let converted = 0;
  const files = listJsFiles(vol, packageDir);
  onProgress?.(`  Converting ${files.length} files in ${packageDir}...`);

  // "type":"module" packages stay as ESM in VFS -- tools like Vite read them
  // directly and expect ESM syntax. require() handles conversion at runtime.
  const esmPackage = isEsmPackage(vol, packageDir);

  const BATCH = 50;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (fp) => {
        try {
          const src = vol.readFileSync(fp, "utf8");

          if (esmPackage) {
            if (needsBuiltinPatching(src)) {
              vol.writeFileSync(fp, patchBuiltinImports(src));
              converted++;
            }
            return;
          }

          // .mjs stays ESM even in non-ESM packages
          if (fp.endsWith(".mjs")) {
            if (needsBuiltinPatching(src)) {
              vol.writeFileSync(fp, patchBuiltinImports(src));
              converted++;
            }
            return;
          }

          if (requiresConversion(fp, src)) {
            const out = await convertFile(src, fp);
            vol.writeFileSync(fp, out);
            converted++;
          } else if (needsBuiltinPatching(src)) {
            vol.writeFileSync(fp, patchBuiltinImports(src));
            converted++;
          }
        } catch {
        }
      }),
    );
  }

  return converted;
}
