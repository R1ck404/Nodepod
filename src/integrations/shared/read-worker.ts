// Finds and reads the built process-worker bundle (dist/__worker__.js) from
// disk. Unlike __sw__.js (which is a static source file), the worker bundle
// only exists after `build:lib`, so callers must tolerate absence — the
// runtime falls back to the embedded bundle string in that case.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const WORKER_RELATIVE_PATHS = [
  "../__worker__.js",         // dist/integrations/*.mjs -> dist/__worker__.js
  "../../dist/__worker__.js", // src/integrations/*.ts  -> dist/__worker__.js (if built)
];

let cached: Promise<string | null> | null = null;

async function locateWorker(fromFileUrl: string): Promise<string | null> {
  const baseDir = dirname(fileURLToPath(fromFileUrl));
  for (const rel of WORKER_RELATIVE_PATHS) {
    const candidate = resolve(baseDir, rel);
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Read the worker bundle source, or null when the built asset isn't on disk.
 * Pass `import.meta.url` from the caller so paths resolve from src/ or dist/.
 */
export async function readWorkerBundleSource(
  fromFileUrl: string,
): Promise<string | null> {
  if (!cached) {
    cached = (async () => {
      const path = await locateWorker(fromFileUrl);
      if (!path) return null;
      return readFile(path, "utf8");
    })();
  }
  return cached;
}

/** Test-only: reset the module cache between cases. */
export function __resetWorkerBundleSourceCacheForTests(): void {
  cached = null;
}
