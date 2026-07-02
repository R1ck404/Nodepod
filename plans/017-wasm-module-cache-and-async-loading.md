# Plan 017: WASM module cache, streaming instantiation, and removal of the sync XHR fallback

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: Written against commit `78bec2c` plus the
> uncommitted working tree of 2026-07-02 (plans 001–010 applied). Compare
> "Current state" excerpts against live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: latency (TTI, per-op) / memory / main-thread jank
- **Planned at**: 2026-07-02, from the WASM/WASI perf audit

## Why this matters

Three compounding problems: (1) compiled `WebAssembly.Module`s are cached
in-memory only, **keyed by byte length**, per-realm — so 10–16MB binaries
(esbuild, lightningcss) are recompiled on every reload and in every worker;
(2) nothing uses `instantiateStreaming`, so compile can't overlap download;
(3) a **synchronous XHR** fallback in `fs.readFileSync` can block a thread
for the entire download of a 15MB `.wasm` from CDN. After this plan, compiled
modules persist in IndexedDB keyed by content hash (structured-clone of
`WebAssembly.Module` — supported in Chromium/Firefox), CDN loads stream, and
the sync XHR path is gone.

## Current state

- `src/helpers/wasm-cache.ts:12-13` — `sizeCache` keyed by `byteLength`;
  `44-60` `precompileWasm()` (≥4MB); `63-67` `getCachedModule()`;
  `91-120` throwaway compile worker per call.
- `src/script-engine.ts:~2271-2309` — patches `WebAssembly.Module`
  constructor to consult the cache / offload compile.
- No `instantiateStreaming` anywhere (`rg instantiateStreaming src` → empty).
- `src/polyfills/fs.ts:~1374-1418` — sync XHR: `readFileSync` of a missing
  `/node_modules/**.wasm` builds a jsdelivr URL and does
  `xhr.open("GET", url, false)`, writes result to VFS, returns.
- Async equivalent exists: `src/script-engine.ts:~2195-2218` (patched
  `fetch()` falls back to CDN for missing VFS `.wasm`).
- `src/persistence/idb-cache.ts` — existing IDB helper (snapshots only).
- Large binaries: esbuild via `src/polyfills/esbuild.ts:130-167` (lazy, CDN),
  lightningcss `src/polyfills/lightningcss.ts:60-63` (eager at import),
  brotli `src/polyfills/zlib.ts:84-87` (eager at import).

## Design

1. **Content-hash keyed persistent module cache**
   (`src/persistence/wasm-module-cache.ts`, new): IDB store `wasmModules`,
   key = SHA-256 hex of bytes (use `crypto.subtle.digest` — async is fine
   here), value = `{ module: WebAssembly.Module, storedAt }`. Feature-detect
   structured-clone support for `WebAssembly.Module` at first use (try/catch
   a put of a trivial module); if unsupported (Safari historically), fall
   back to storing nothing (compile as today). Wrap ALL of
   `wasm-cache.ts`'s consumers: `precompileWasm` checks IDB before
   compiling; after compile, `put()`. Keep the in-memory map as L1 but
   change its key from byte length to the content hash (compute hash once,
   pass alongside).
2. **Streaming for CDN fetches**: in the patched `fetch()` CDN fallback and
   any polyfill that fetches `.wasm` itself, prefer
   `WebAssembly.instantiateStreaming`/`compileStreaming` when the response
   is a real network response with `application/wasm`. VFS-sourced bytes
   keep the bytes path. (esbuild/lightningcss `init()` internals fetch their
   own wasm — out of reach without forking; the win here applies to the
   napi-rs/VFS-fallback path. Note this limit in the report.)
3. **Kill the sync XHR**: delete the block at `fs.ts:~1374-1418`. In its
   place, throw `ENOENT` as normal — but first, make the miss unlikely:
   at install time, `archive-extractor.ts` already precompiles `.wasm` it
   writes; ADD an install-time step that, for packages whose tarball
   skipped large `.wasm` files, fires an **async** prefetch via the existing
   patched-fetch CDN path and writes to VFS (best-effort, non-blocking).
   Also verify the async retry path in `script-engine.ts:~1720-1761` (large
   sync-compile failure fallback) still covers the napi-rs loaders that
   previously depended on the sync XHR; run the native-WASI example to
   confirm.

## Commands you will need

| Purpose   | Command                | Expected on success |
|-----------|------------------------|---------------------|
| Typecheck | `pnpm run type-check`  | exit 0   |
| Tests     | `pnpm test`            | all pass |
| Manual    | `node examples/serve.js` → `/examples/native-wasi-test/`, `/examples/issue-54-tailwind-v4/` | native packages still work; 2nd reload visibly faster |

## Scope

**In scope**:
- `src/persistence/wasm-module-cache.ts` (create)
- `src/helpers/wasm-cache.ts` (hash keys, IDB integration, persistent compile worker)
- `src/polyfills/fs.ts` (remove sync XHR block)
- `src/script-engine.ts` (streaming in CDN fallback; verify async retry path)
- `src/packages/archive-extractor.ts` (best-effort large-wasm prefetch hook)
- `src/__tests__/wasm-module-cache.test.ts` (create — logic-level with stubbed IDB/WebAssembly where needed)

**Out of scope**:
- esbuild/lightningcss internal init flows (their own packages fetch wasm).
- Preloading esbuild at boot (Plan 018).
- Cross-worker module *sharing* at runtime (each realm still instantiates;
  they just skip compile via IDB).

## Git workflow

- Branch: `advisor/017-wasm-module-cache`
- Conventional commit: `perf(wasm): persistent content-hash module cache, streaming compile, remove sync XHR`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Cache module + feature detection

Create `wasm-module-cache.ts` per design. Unit-test the hashing and the
graceful-degrade path (stub `indexedDB` absent → all ops no-op).

**Verify**: `pnpm exec vitest run src/__tests__/wasm-module-cache.test.ts` → pass.

### Step 2: Rekey `wasm-cache.ts` + persistent compile worker

Compute SHA-256 alongside compile; L1 map keyed by hash; consult IDB before
compiling; `put()` after. Replace the per-call throwaway worker
(`91-120`) with a lazily-created persistent worker reused across compiles.

**Verify**: `pnpm run type-check` → exit 0; `pnpm test` → all pass
(`src/__tests__/digest.test.ts` and any wasm-adjacent suites).

### Step 3: Streaming CDN fallback

In `script-engine.ts`'s patched fetch CDN fallback for `.wasm`, when the
caller ultimately wants a module (the napi loader path), use
`compileStreaming(response.clone())` while also writing bytes to VFS from
the original response. Keep byte semantics for callers that want bytes.

**Verify**: `pnpm run type-check` → exit 0; `pnpm test` → all pass.

### Step 4: Remove sync XHR + install-time prefetch

Delete `fs.ts:~1374-1418`. Add the best-effort async prefetch at extraction
time for packages known to reference large `.wasm` (heuristic: any package
whose manifest lists a `.wasm` file that extraction skipped — check what
signal exists in the extract result; if none exists, prefetch on first
ENOENT via the async patched-fetch path and log). Then run the native-WASI
and tailwind-v4 examples manually.

**Verify**: `rg 'open\("GET".*false' src` → no matches;
`pnpm run build:lib` → exit 0; manual examples work.

## Test plan

- Unit: cache module (hash keying, degrade paths).
- Existing suites green.
- Manual: `/examples/native-wasi-test/` cold + warm reload — warm reload
  should show markedly faster native-package startup (record before/after in
  the report); tailwind-v4 example exercises the large-wasm path that
  previously used sync XHR.

## Done criteria

- [ ] `pnpm run type-check` exits 0; `pnpm test` exits 0
- [ ] No sync XHR remains in `src/`
- [ ] Warm reload skips recompiling previously-seen wasm (observable via manual timing or a debug counter)
- [ ] Cache keyed by content hash, not byte length
- [ ] Browsers without Module structured-clone degrade to current behavior
- [ ] `plans/README.md` status row updated

## STOP conditions

- Native-WASI or tailwind example breaks after removing the sync XHR and the
  async retry path does NOT cover it — report with the failing load sequence;
  do not reintroduce sync XHR.
- `WebAssembly.Module` structured clone fails in the primary test browser —
  report (plan assumed Chromium support).
- IDB `put` of large modules (>50MB store growth) hits quota during testing —
  add pruning before proceeding.

## Maintenance notes

- Cross-realm sharing (compile once on main, postMessage the Module to
  workers) is a further win the IDB cache makes mostly redundant; revisit
  only if profiling shows instantiate-from-cached-module is still hot.
- Safari support for IDB-persisted WebAssembly.Module should be re-checked
  periodically; the feature-detect makes this safe either way.
