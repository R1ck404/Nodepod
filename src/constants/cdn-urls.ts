// Pinned CDN versions and URLs

export const PINNED_ESBUILD_WASM = '0.28.2';
export const PINNED_ROLLUP_BROWSER = '4.44.0';
export const PINNED_BROTLI_WASM = '3.0.1';
export const PINNED_LIGHTNINGCSS_WASM = '1.31.1';
export const PINNED_WA_SQLITE = '1.0.0';

// Faster drop-ins with identical output (github.com/R1ck404/fast-packages).
// fast-esbuild-wasm is all JavaScript: it ships no esbuild.wasm. jsdelivr
// serves the package's files as published (esm.sh rebundles them, and answers
// 404 for a few minutes after a release).
const PINNED_FAST_ESBUILD = '0.28.5'; // (initialize({ serviceInWorker, smallInput }) since 0.28.4)
const PINNED_FAST_BROTLI = '3.0.3';
const FAST_ESBUILD_BASE = `https://cdn.jsdelivr.net/npm/@r1ck404/fast-esbuild-wasm@${PINNED_FAST_ESBUILD}`;
export const ESBUILD_HAS_BINARY = false;

export const CDN_ESBUILD_ESM = `${FAST_ESBUILD_BASE}/esm/browser.min.js`;
// Never fetched: initialize() only checks that it is a URL, there is no binary.
export const CDN_ESBUILD_BINARY = `${FAST_ESBUILD_BASE}/esbuild.wasm`;
// The module CDN_ESBUILD_ESM re-exports. Importing it under a distinct query
// yields a separate module instance, i.e. a separate esbuild service (see
// esbuild-engine.ts recycling).
export const CDN_ESBUILD_BUNDLE = `${FAST_ESBUILD_BASE}/esm/browser.min.js`;
// esbuild's browser build as a classic script, evaluated once per instance
// (see esbuild-engine.ts)
export const CDN_ESBUILD_BROWSER_SCRIPT = `${FAST_ESBUILD_BASE}/lib/browser.min.js`;
export const CDN_ROLLUP_BROWSER = `https://esm.sh/@rollup/browser@${PINNED_ROLLUP_BROWSER}`;
// jsdelivr serves raw files without rebundling. esm.sh rebundles everything
// which breaks brotli-wasm's circular WASM/JS-glue dependencies, causing
// `(void 0) is not a function` at runtime. The pkg.web variant has a proper
// init() that fetches the co-located .wasm binary via import.meta.url.
export const CDN_BROTLI_WASM = `https://cdn.jsdelivr.net/npm/@r1ck404/fast-brotli-wasm@${PINNED_FAST_BROTLI}/pkg.web.mjs`;
export const CDN_LIGHTNINGCSS_WASM = `https://esm.sh/lightningcss-wasm@${PINNED_LIGHTNINGCSS_WASM}`;
export const CDN_WA_SQLITE = `https://cdn.jsdelivr.net/npm/wa-sqlite@${PINNED_WA_SQLITE}/dist/wa-sqlite.mjs`;
export const CDN_WA_SQLITE_WASM = `https://cdn.jsdelivr.net/npm/wa-sqlite@${PINNED_WA_SQLITE}/dist/wa-sqlite.wasm`;

// new Function hides import() from bundler static analysis so CDN URLs work at runtime
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const _dynamicImport = new Function("url", "return import(url)") as (url: string) => Promise<any>;
export { _dynamicImport as cdnImport };
