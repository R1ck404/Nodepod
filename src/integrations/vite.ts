// Vite plugin that serves /__sw__.js in dev and emits it as an asset at
// build time, so the user never has to copy the file into public/.
//
//   // vite.config.ts
//   import nodepod from '@scelar/nodepod/vite';
//   export default defineConfig({ plugins: [nodepod()] });
//
// Vite's types are imported as `type` only so `vite` stays an optional
// peer dep at runtime.

import type { Plugin } from "vite";
import { readServiceWorkerSource } from "./shared/read-sw";
import { readWorkerBundleSource } from "./shared/read-worker";
import { swResponseHeaders, DEFAULT_SW_PATH } from "./shared/headers";

const WORKER_ASSET_PATH = "/__worker__.js";

export interface NodepodVitePluginOptions {
  /** Path to serve the SW from. Same origin as the page, must end in .js. Defaults to /__sw__.js. */
  path?: string;
}

export default function nodepod(
  opts: NodepodVitePluginOptions = {},
): Plugin {
  const swPath = opts.path ?? DEFAULT_SW_PATH;
  // Rollup asset names are relative to outDir, so drop the leading slash.
  const assetFileName = swPath.replace(/^\/+/, "");

  return {
    name: "nodepod",
    configureServer(server) {
      // Match on the path alone so the SDK's `?v=${Date.now()}` cache-buster
      // still hits this handler.
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split("?")[0];
        if (url === WORKER_ASSET_PATH) {
          // process-worker bundle: only exists in built packages; fall
          // through (404) so the runtime uses its embedded copy
          const source = await readWorkerBundleSource(import.meta.url).catch(() => null);
          if (source === null) return next();
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.statusCode = 200;
          res.end(source);
          return;
        }
        if (url !== swPath) return next();
        try {
          const source = await readServiceWorkerSource(import.meta.url);
          const headers = swResponseHeaders();
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
          res.statusCode = 200;
          res.end(source);
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain");
          const msg = err instanceof Error ? err.message : String(err);
          res.end(`[nodepod/vite] failed to read __sw__.js: ${msg}`);
        }
      });
    },
    async generateBundle() {
      const source = await readServiceWorkerSource(import.meta.url);
      this.emitFile({
        type: "asset",
        fileName: assetFileName,
        source,
      });
      const workerSource = await readWorkerBundleSource(import.meta.url).catch(() => null);
      if (workerSource !== null) {
        this.emitFile({
          type: "asset",
          fileName: WORKER_ASSET_PATH.replace(/^\/+/, ""),
          source: workerSource,
        });
      }
    },
  };
}

// Also expose as named for `import { nodepod } from '@scelar/nodepod/vite'`.
export { nodepod };
