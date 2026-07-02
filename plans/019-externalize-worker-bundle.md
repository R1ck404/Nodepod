# Plan 019: Externalize + minify the embedded process-worker bundle

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: Written against commit `78bec2c` plus the
> uncommitted working tree of 2026-07-02 (plans 001–010 applied). Compare
> "Current state" excerpts against live code; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (build/distribution change affects every consumer)
- **Depends on**: none
- **Category**: bundle size / initial-load memory
- **Planned at**: 2026-07-02, from the module-loading perf audit

## Why this matters

The process-worker entry (which imports `ScriptEngine` and its 40+ polyfills
— essentially the whole runtime) is esbuild-bundled **unminified**, then
`JSON.stringify`'d and embedded as a giant string constant inside the main
library chunk. The runtime tree is therefore shipped twice: once as real
code, once as an escaped string — a major contributor to the 3.5MB ESM chunk
(~780KB gzip) and to main-thread parse time and baseline heap (the string is
resident for the lifetime of the page). After this plan the worker bundle is
minified (immediate ~2× shrink of the embedded payload) and, where the
embedder's setup allows, served as a separate `dist/` asset fetched on first
spawn instead of being embedded at all.

## Current state

- `vite.lib.config.js:32-51` — build-time esbuild of
  `src/threading/process-worker-entry.ts` (`bundle: true, format: "iife",
  minify: false, write: false`), result exposed as `PROCESS_WORKER_BUNDLE`
  (JSON.stringify'd around line 58 — read the exact mechanism: likely a
  `define` or virtual module).
- `src/threading/process-manager.ts:337-346` — `_createWorker()`: one-time
  `Blob` from `PROCESS_WORKER_BUNDLE` → `URL.createObjectURL` → `new Worker`.
- `src/threading/process-worker-entry.ts:5` — imports ScriptEngine (whole
  polyfill tree).
- Integrations already ship a separate asset precedent: `__sw__.js` is
  copied to `dist/` by `build:lib` and emitted by the Vite plugin
  (`src/integrations/vite.ts` emits it via `generateBundle`; see
  `src/__tests__/integrations/vite.test.ts:22-31`).
- Consumers boot from `dist/index.mjs` (ESM) or `index.cjs`.

## Design

Two stages, both in this plan:

1. **Minify (safe, unconditional win)**: flip `minify: true` in the
   build-time esbuild call. No behavior change — the IIFE is opaque.
   Also add `legalComments: "none"`.
2. **External asset with embedded fallback**: emit the worker bundle as
   `dist/__worker__.js` (same copy step as `__sw__.js`; also emit from the
   Vite/Next integrations like the SW). At runtime, `_createWorker()`
   resolution order:
   1. explicit `NodepodOptions.workerUrl` if provided,
   2. `new URL('./__worker__.js', import.meta.url)` when `import.meta.url`
      is available and a HEAD/fetch probe succeeds (cache the probe result;
      fetch the text and build a Blob URL from it — building from same-origin
      text avoids cross-origin `new Worker(url)` restrictions and keeps COEP
      simple),
   3. fallback to the embedded `PROCESS_WORKER_BUNDLE` exactly as today.
   Keep the embedded copy in this plan (zero-config consumers keep working);
   dropping it is a follow-up once integrations prove the asset path.

## Commands you will need

| Purpose   | Command                | Expected on success |
|-----------|------------------------|---------------------|
| Typecheck | `pnpm run type-check`  | exit 0   |
| Build     | `pnpm run build:lib`   | exit 0; `dist/__worker__.js` exists |
| Tests     | `pnpm test`            | all pass |
| Size      | compare `dist/index.mjs` size before/after | meaningful shrink from minify |
| Manual    | `node examples/serve.js` → basic + child-process examples | spawns work via asset path |

## Scope

**In scope**:
- `vite.lib.config.js` (minify; emit `dist/__worker__.js`)
- `package.json` `build:lib` script (copy step, mirroring `__sw__.js`)
- `src/threading/process-manager.ts` (`_createWorker` resolution order)
- `src/sdk/types.ts` (`workerUrl` option)
- `src/integrations/vite.ts` (emit worker asset alongside SW; extend
  `src/__tests__/integrations/vite.test.ts`)
- `examples/serve.js` (serve `/__worker__.js` from `dist/` like the SW —
  check whether needed: examples serve the whole repo root already, so
  `dist/__worker__.js` is directly reachable; only add a mapping if a root
  path is required)

**Out of scope**:
- Removing the embedded fallback (follow-up after soak).
- Code-splitting rare polyfills out of the main chunk (separate effort,
  noted in the audit).
- Next.js integration asset emission (verify it serves `dist/` assets the
  same way; if not, note as follow-up rather than expanding scope).

## Git workflow

- Branch: `advisor/019-externalize-worker-bundle`
- Conventional commit: `perf(build): minify + externalize process worker bundle with embedded fallback`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Minify

Flip `minify: true` in the worker esbuild step. Build and record
`dist/index.mjs` size before/after in your report.

**Verify**: `pnpm run build:lib` → exit 0; `pnpm test` → all pass (integration
suites boot workers from the embedded bundle).

### Step 2: Emit the asset

Add the `dist/__worker__.js` emission: write the same bundled text to disk
during `build:lib` (extend the existing `copyFileSync` chain in the npm
script, or write from the Vite plugin — prefer whichever mechanism `__sw__.js`
already uses so there's one pattern). Update `src/integrations/vite.ts`
`generateBundle` to emit it like the SW; extend the vite integration test to
assert both assets are emitted.

**Verify**: `pnpm run build:lib` → `dist/__worker__.js` exists;
`pnpm exec vitest run src/__tests__/integrations/vite.test.ts` → pass.

### Step 3: Runtime resolution order

Implement the 3-step resolution in `_createWorker()` per the design. The
probe must be async — but `_createWorker` is sync today. Restructure: resolve
the worker source **once** at `ProcessManager` construction or first spawn
(async init already exists in boot flow — hook `Nodepod.boot()` to kick the
probe so first spawn doesn't wait; until the probe resolves, spawns use the
embedded fallback). Keep it simple: a module-level
`workerSourcePromise: Promise<string>` seeded at boot, `_createWorker` uses
the resolved value if ready, else embedded.

**Verify**: `pnpm run type-check` → exit 0; `pnpm test` → all pass.

### Step 4: Manual verification

`node examples/serve.js`; basic + child-process examples: confirm in the
Network tab that `__worker__.js` is fetched once and spawns succeed; then
temporarily block that URL (DevTools request blocking) and confirm the
embedded fallback still spawns.

## Test plan

- Vite integration test asserts worker asset emission.
- Existing threading/integration suites green under the embedded path (unit
  tests run in Node where the fetch probe fails → fallback exercised
  automatically).
- Manual browser test covers the asset path + deliberate fallback.

## Done criteria

- [ ] `pnpm run type-check` exits 0; `pnpm test` exits 0
- [ ] Worker bundle minified; `dist/index.mjs` size reduction recorded
- [ ] `dist/__worker__.js` emitted by build and by the Vite integration
- [ ] Runtime prefers the external asset, falls back to embedded seamlessly
- [ ] Manual checks pass (asset path + blocked-asset fallback)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Minification breaks the worker (e.g. relies on function names) — report
  the exact breakage; do not ship unminified.
- `import.meta.url` resolution proves unusable in a target packaging setup
  (CJS build) — restrict the asset path to the ESM build and note it.
- The Vite plugin cannot emit a second asset without breaking SW emission.

## Maintenance notes

- Follow-up: drop the embedded fallback (biggest remaining size win) once
  integrations and esm.sh-style consumers are confirmed to get the asset.
- Follow-up: code-split rare polyfills (cluster, sqlite, repl, inspector…)
  behind dynamic CORE_MODULES factories — the audit sized this as the next
  chunk-size lever after the worker string.
