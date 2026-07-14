import { defineConfig } from "vitest/config";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    {
      name: "test-process-worker-bundle",
      resolveId(id) {
        return id === "virtual:process-worker-bundle" ? "\0virtual:process-worker-bundle" : null;
      },
      load(id) {
        return id === "\0virtual:process-worker-bundle"
          ? 'export const PROCESS_WORKER_BUNDLE_GZIP_BASE64 = "";'
          : null;
      },
    },
  ],
  test: {
    include: ["src/**/*.test.ts"],
    benchmark: {
      include: ["src/**/*.bench.ts"],
    },
  },
});
