// One compiled esbuild-wasm module per page, shared with every process
// worker. Without it each process fetched and compiled the ~10MB binary and
// ran esbuild's Go runtime init on cold (baseline-tier) code before its
// first build. A WebAssembly.Module can be posted to workers, so the
// compile (and V8's optimized tier-up of it) happens once per session.

import { CDN_ESBUILD_BINARY } from "../constants/cdn-urls";

let modulePromise: Promise<WebAssembly.Module | null> | null = null;
let compiling = false;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
// Workers keep the module they were handed for as long as their esbuild
// instance lives; this thread only needs it to hand out. Drop the reference
// after a quiet period so an idle pod doesn't pin the compiled code; the next
// request recompiles, from V8's wasm code cache when the HTTP cache has it.
const RELEASE_AFTER_MS = 10_000;

function scheduleRelease(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    // still compiling (a slow network): wait for it rather than start a
    // second compile on the next request
    if (compiling) scheduleRelease();
    else modulePromise = null;
  }, RELEASE_AFTER_MS);
}

async function compile(url: string): Promise<WebAssembly.Module | null> {
  if (typeof WebAssembly === "undefined" || typeof fetch !== "function") return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    // Streaming compile of an HTTP-cacheable response is also what makes
    // V8 persist the optimized code in the HTTP cache across visits.
    if (
      typeof WebAssembly.compileStreaming === "function" &&
      /^application\/wasm($|;)/i.test(res.headers.get("content-type") || "")
    ) {
      return await WebAssembly.compileStreaming(res);
    }
    return await WebAssembly.compile(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** The shared module, compiling it on first call. Resolves null on failure. */
export function getSharedEsbuildModule(): Promise<WebAssembly.Module | null> {
  scheduleRelease();
  if (!modulePromise) {
    compiling = true;
    const started: Promise<WebAssembly.Module | null> = compile(CDN_ESBUILD_BINARY).then((mod) => {
      compiling = false;
      // let a later call retry after a transient failure
      if (!mod && modulePromise === started) modulePromise = null;
      return mod;
    });
    modulePromise = started;
  }
  return modulePromise;
}

/** Start compiling in the background (no-op if already started). */
export function prefetchSharedEsbuildModule(): void {
  void getSharedEsbuildModule();
}

/**
 * Get the shared module fetched and compiled ahead of first use from any
 * thread: a process worker asks the main thread (which owns the module),
 * the main thread starts it directly.
 */
export function requestEsbuildPrefetch(): void {
  const request = (globalThis as { __nodepodRequestEsbuildModule?: () => Promise<unknown> })
    .__nodepodRequestEsbuildModule;
  if (request) {
    void request().catch(() => {});
  } else if (typeof document !== "undefined") {
    prefetchSharedEsbuildModule();
  }
}

export function resetSharedEsbuildModule(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  modulePromise = null;
}
