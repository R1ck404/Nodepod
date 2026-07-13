// Single esbuild-wasm instance per realm. Both the `esbuild` polyfill and
// the install-time module transformer used to boot their own copy of the
// ~10MB binary; this module owns the one shared init promise, stored on
// globalThis so duplicate bundle copies of this file still converge.

import { CDN_ESBUILD_ESM, CDN_ESBUILD_BINARY, cdnImport } from "../constants/cdn-urls";

export type EsbuildEngine = typeof import("esbuild-wasm");

interface EsbuildGlobal {
  __nodepodEsbuild?: Promise<EsbuildEngine>;
  __nodepodEsbuildReady?: EsbuildEngine;
  __esbuild?: EsbuildEngine;
}

/**
 * Get (initializing on first call) the realm-wide esbuild-wasm instance.
 * A host page may pre-provide its own instance on `globalThis.__esbuild`.
 * Failed initialization clears the shared promise so callers can retry.
 */
export function getEsbuild(opts?: { wasmURL?: string }): Promise<EsbuildEngine> {
  const g = globalThis as EsbuildGlobal;

  if (g.__nodepodEsbuild) return g.__nodepodEsbuild;

  if (g.__esbuild) {
    g.__nodepodEsbuildReady = g.__esbuild;
    g.__nodepodEsbuild = Promise.resolve(g.__esbuild);
    return g.__nodepodEsbuild;
  }

  g.__nodepodEsbuild = (async () => {
    try {
      const loaded = await cdnImport(CDN_ESBUILD_ESM);
      const engine: EsbuildEngine = loaded.default || loaded;
      try {
        await engine.initialize({ wasmURL: opts?.wasmURL || CDN_ESBUILD_BINARY });
      } catch (initErr) {
        if (
          !(
            initErr instanceof Error &&
            initErr.message.includes('Cannot call "initialize" more than once')
          )
        ) {
          throw initErr;
        }
      }
      g.__nodepodEsbuildReady = engine;
      return engine;
    } catch (err) {
      g.__nodepodEsbuild = undefined;
      throw new Error(`esbuild: initialization failed -- ${err}`);
    }
  })();

  return g.__nodepodEsbuild;
}

/** The initialized instance, or null if init hasn't completed yet. */
export function getEsbuildIfReady(): EsbuildEngine | null {
  return (globalThis as EsbuildGlobal).__nodepodEsbuildReady ?? null;
}

export function disposeEsbuild(): void {
  const g = globalThis as EsbuildGlobal;
  try { (g.__nodepodEsbuildReady as any)?.stop?.(); } catch { /* ignore */ }
  g.__nodepodEsbuildReady = undefined;
  g.__nodepodEsbuild = undefined;
}
