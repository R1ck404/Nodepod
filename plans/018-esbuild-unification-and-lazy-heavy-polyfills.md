# Plan 018: One esbuild to rule them all — unified singleton, boot preload, lazy heavy polyfills

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
- **Depends on**: none (synergizes with 016/017)
- **Category**: TTI / bandwidth / memory
- **Planned at**: 2026-07-02, from the WASM/WASI perf audit

## Why this matters

esbuild-wasm (~10MB) is initialized independently in up to three places —
the runtime polyfill singleton, the module-transformer's `window.__esbuildEngine`,
and **each of the 6 offload pool workers** (every worker cold-downloads
esbuild + pako from CDN at warm-up). Meanwhile lightningcss (~16MB) and
brotli-wasm initialize **eagerly at module import** whether or not the app
ever touches CSS or brotli. Net effect: tens of MB of duplicate downloads
and duplicate WASM instances resident in memory, and boot-time work for
features that may never run. After this plan: one shared init promise on
each realm, worker warm-up stops pre-fetching esbuild until a transform task
actually arrives, lightningcss/brotli become lazy, and esbuild is preloaded
in parallel with boot (it's the one big binary that's almost always needed).

## Current state

- `src/polyfills/esbuild.ts:117-118,130-167` — module-level `engine` +
  `bootPromise`; reads `window.__esbuild` / `window.__esbuildInitPromise`
  (the latter is never written anywhere — dead path).
- `src/module-transformer.ts:18-44` — separate singleton on
  `window.__esbuildEngine` + `window.__esbuildReady`.
- `src/threading/worker-pool.ts:177-184` — each new pool worker is
  "pre-warmed", triggering `inline-worker.ts:175-187` to `cdnImport`
  esbuild's ESM + `initialize({ wasmURL })` + import pako, per worker.
- `src/polyfills/lightningcss.ts:60-63` — top-level `ensureInit()` at import.
- `src/polyfills/zlib.ts:84-87` — top-level `ensureBrotli()` at import.
- `src/polyfills/esbuild.ts:249-279` — `context()` is fake: `rebuild()`
  re-runs a full `build()`; separate concern, see Maintenance notes.
- Version skew: `cdn-urls.ts:3` pins esbuild `0.20.0`; `esbuild.ts:247`
  reports version `0.21.5`.
- `src/sdk/nodepod.ts:~208-345` — `boot()`; no wasm preloads today.

## Design

1. **Unified main-thread singleton**: one module,
   `src/helpers/esbuild-engine.ts` (new), owning
   `getEsbuild(): Promise<EsbuildEngine>` behind a single
   `globalThis.__nodepodEsbuild` promise. Both `polyfills/esbuild.ts` and
   `module-transformer.ts` delegate to it. Delete the dead
   `__esbuildInitPromise` read and the duplicate `__esbuildEngine` init.
2. **Worker warm-up diet**: pool warm-up imports pako only (needed by every
   extract task); esbuild init in a pool worker happens lazily on the first
   transform task that worker receives. With Plan 016 (lazy transforms) the
   common install path dispatches zero transform tasks, so most workers
   never pay the 10MB. (Workers can't share the main thread's instance —
   esbuild-wasm has no cross-realm mode; the diet + lazy transforms is the
   practical win. Note this in the report.)
3. **Lazy lightningcss/brotli**: move `ensureInit()`/`ensureBrotli()` calls
   from module top-level into the first API call that needs them (each file
   already has an internal ready-promise pattern to build on). Audit each
   exported function to ensure it awaits/init-guards.
4. **Boot preload for esbuild**: `Nodepod.boot()` fires
   `void getEsbuild()` (not awaited) after core setup, so the download
   overlaps SW registration and installs. Gate behind
   `NodepodOptions.preloadEsbuild?: boolean` default **true**.
5. **Fix the version pin skew**: align `cdn-urls.ts` and the reported
   version string (pick the pinned CDN version as truth).

## Commands you will need

| Purpose   | Command                | Expected on success |
|-----------|------------------------|---------------------|
| Typecheck | `pnpm run type-check`  | exit 0   |
| Tests     | `pnpm test`            | all pass |
| Manual    | `node examples/serve.js` → basic, vite-build, brotli, tailwind examples | all work; Network tab shows ONE esbuild wasm fetch |

## Scope

**In scope**:
- `src/helpers/esbuild-engine.ts` (create)
- `src/polyfills/esbuild.ts`, `src/module-transformer.ts` (delegate)
- `src/threading/worker-pool.ts`, `src/threading/inline-worker.ts` (lazy esbuild in workers)
- `src/polyfills/lightningcss.ts`, `src/polyfills/zlib.ts` (lazy init)
- `src/sdk/nodepod.ts`, `src/sdk/types.ts` (preload option)
- `src/constants/cdn-urls.ts` (version alignment)

**Out of scope**:
- Real incremental `context()` implementation (own plan; see notes).
- SharedWorker-based single esbuild instance (architecture change; revisit
  if worker esbuild use stays hot after Plan 016).

## Git workflow

- Branch: `advisor/018-esbuild-unification`
- Conventional commit: `perf(polyfills): unify esbuild init, lazy heavy wasm polyfills, boot preload`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: `esbuild-engine.ts` + delegation

Create the shared module; port the init logic from `polyfills/esbuild.ts`
(it's the most complete). Both consumers delegate; remove
`window.__esbuildEngine` writes and the dead `__esbuildInitPromise` read.
Keep the public API of `polyfills/esbuild.ts` byte-compatible (packages
`require('esbuild')` against it).

**Verify**: `pnpm run type-check` → exit 0; `pnpm test` → all pass;
`rg '__esbuildEngine|__esbuildInitPromise' src` → no matches.

### Step 2: Worker warm-up diet

In `inline-worker.ts`, split init: pako at warm-up; esbuild behind a
worker-local `ensureEsbuild()` called only by transform task handlers.
Confirm extract-only workloads never touch it (add a unit-visible counter or
verify via the task handler code path).

**Verify**: `pnpm run type-check` → exit 0; `pnpm test` → all pass.

### Step 3: Lazy lightningcss + brotli

Move top-level init calls into first-use guards. Check every export
(including default-export shapes packages consume) awaits readiness. The
zlib polyfill has sync APIs (`brotliDecompressSync`) — read how the current
eager init supports them; if sync APIs depend on the eager init having
finished, keep a fast path: initialize on polyfill first *require* by user
code rather than at bundle import (the CORE_MODULES factory boundary — find
where zlib is registered in `script-engine.ts` CORE_MODULES and hook there).
If that boundary doesn't exist cleanly, STOP and report rather than breaking
sync brotli.

**Verify**: `pnpm test` → all pass, especially
`src/__tests__/zlib-brotli.test.ts` (8 tests); manual
`/examples/brotli-test/` works.

### Step 4: Boot preload + version alignment

Add the `preloadEsbuild` option (default true) firing `void getEsbuild()` in
`boot()`. Align the CDN pin and reported version in one place.

**Verify**: `pnpm run type-check` → exit 0; `pnpm run build:lib` → exit 0.

### Step 5: Manual network audit

`node examples/serve.js`; open the vite-build example with DevTools Network:
exactly one esbuild wasm download; lightningcss/brotli fetched only when the
example actually uses them; basic example TTI not regressed.

## Test plan

- Existing suites green (zlib-brotli, syntax-transforms, script-engine,
  integrations/vite are the sensitive ones).
- Manual network-tab audit as the fan-out check (no automated browser
  harness exists).

## Done criteria

- [ ] `pnpm run type-check` exits 0; `pnpm test` exits 0
- [ ] One esbuild init promise per realm; zero duplicate singletons in `src/`
- [ ] Pool workers no longer fetch esbuild at warm-up
- [ ] lightningcss + brotli initialize only on first use; sync brotli APIs still work
- [ ] esbuild preloads during boot (option default on)
- [ ] CDN pin and version string agree
- [ ] `plans/README.md` status row updated

## STOP conditions

- Sync brotli APIs cannot survive lazy init without a CORE_MODULES require
  hook (Step 3) — report the exact dependency chain.
- Any package in the vite/tailwind examples requires esbuild inside a pool
  worker before a transform task arrives (would mean warm-up diet breaks a
  hidden dependency) — report.

## Maintenance notes

- The fake `context()` (`esbuild.ts:249-279`) makes every Vite rebuild a
  full re-build — high-impact dev-loop fix but needs esbuild-wasm's real
  `context()` API and lifecycle management; write as its own plan when
  tackled.
- If Plan 016 ships first, measure worker esbuild usage before considering a
  SharedWorker esbuild service; it may simply not be hot anymore.
