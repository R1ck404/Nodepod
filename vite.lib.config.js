import { defineConfig } from "vite";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";
import { resolve } from "path";
import { readFileSync } from "fs";
import { build as esbuild } from "esbuild";
import { gzipSync } from "node:zlib";

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8"),
);
// Only peer deps and Node.js builtins are external.
// Runtime deps (pako, acorn, etc.) are inlined so the bundle is self-contained
// and works in any environment (bundler, browser, etc.) without extra config.
const peerDeps = Object.keys(pkg.peerDependencies || {});
const allExternal = [
  ...peerDeps,
  /^node:/,
  // Framework integrations: keep these external so users' own copies are
  // used and rollup doesn't choke on `next/server` when `next` isn't
  // installed locally.
  "vite",
  "next",
  "next/server",
];

/**
 * Vite plugin that pre-bundles process-worker-entry.ts into a self-contained
 * JS string. This is necessary because consumers of nodepod (Next.js, Webpack,
 * etc.) can't resolve Vite-specific worker chunk URLs. Instead, we embed the
 * entire worker bundle as a string and create Blob URL workers at runtime.
 * The same bundle is also emitted as dist/__worker__.js so runtimes that can
 * reach it as a same-origin asset skip parsing the embedded copy entirely.
 */
function inlineProcessWorkerPlugin() {
  const VIRTUAL_ID = "virtual:process-worker-bundle";
  const RESOLVED_ID = "\0" + VIRTUAL_ID;
  let workerBundle = "";

  return {
    name: "inline-process-worker",
    async buildStart() {
      const result = await esbuild({
        entryPoints: [resolve(__dirname, "src/threading/process-worker-entry.ts")],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "esnext",
        write: false,
        minify: true,
        legalComments: "none",
        sourcemap: false,
        // Don't externalize anything — the worker must be fully self-contained
      });
      workerBundle = result.outputFiles[0].text;
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
    },
    load(id) {
      if (id === RESOLVED_ID) {
        const compressed = gzipSync(Buffer.from(workerBundle)).toString("base64");
        return `export const PROCESS_WORKER_BUNDLE_GZIP_BASE64 = ${JSON.stringify(compressed)};`;
      }
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "__worker__.js",
        source: workerBundle,
      });
    },
  };
}

export default defineConfig({
  plugins: [wasm(), topLevelAwait(), inlineProcessWorkerPlugin()],
  worker: {
    format: "es",
    rollupOptions: {
      external: allExternal,
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        // Each framework integration is its own subpath export (see
        // package.json `exports`). Slashes in the key push the output
        // under dist/integrations/*.
        "integrations/server": resolve(
          __dirname,
          "src/integrations/server.ts",
        ),
        "integrations/vite": resolve(__dirname, "src/integrations/vite.ts"),
        "integrations/next": resolve(__dirname, "src/integrations/next.ts"),
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) => {
        const ext = format === "es" ? "mjs" : "cjs";
        return `${entryName}.${ext}`;
      },
    },
    rollupOptions: {
      external: allExternal,
    },
    sourcemap: true,
    minify: false,
  },
});
