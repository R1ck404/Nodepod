# Plan 016: Lazy package transforms — extract at install, transform on first require

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: Written against commit `78bec2c` plus the
> uncommitted working tree of 2026-07-02 (plans 001–010 applied). Compare
> "Current state" excerpts against live code; on a mismatch, STOP.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED (changes what's on disk in the VFS after install)
- **Depends on**: 012 recommended first (bounds the runtime transform cache
  that will absorb the moved work)
- **Category**: install speed / CPU / memory
- **Planned at**: 2026-07-02, from the install-pipeline perf audit

## Why this matters

`npm install` currently runs esbuild over **every** `.js/.mjs/.jsx` file of
every installed package at install time (`convertPackage` after each
extract). For a Vite-scale dependency tree this is frequently the single
largest install phase — and much of that work is wasted: most files in most
packages are never required. The runtime module loader already has a full
transform path (acorn ESM→CJS + caching), so deferring conversion to first
`require()` removes 30–70% of install CPU, reduces peak memory during
install (no second read+write of every file), and — combined with Plan 012 —
spreads the cost over actual usage. Install-time transforms remain available
behind the existing option for embedders that prefer them.

## Current state

- `src/packages/installer.ts:~318` — `transformModules !== false` defaults
  eager transform ON; `~338-360` — per-package `downloadAndExtract` then
  `await convertPackage(...)` serially.
- `src/module-transformer.ts:~277-298,321` — `listJsFiles` lists ALL js
  recursively; `~324-342` skips `"type":"module"` packages (left as ESM for
  runtime); `~328-364` batches 50 transforms via the shared offload pool.
- Runtime path: `src/script-engine.ts:~1505-1654` (`loadModule`) — reads
  file, `convertModuleSyntax` (acorn) for ESM sources, caches by
  `path|quickDigest(source)`. **This already handles untransformed CJS/ESM
  packages** — the eager install transform is an optimization, not a
  correctness requirement (confirm by reading `convertModuleSyntax`'s
  coverage of `exports`/`module.exports` interop before proceeding).
- Runtime esbuild fallback for TS: install-time only today
  (`module-transformer.ts`); runtime TS uses regex stripping
  (`script-engine.ts:136-228`) — unchanged by this plan.
- `installOptions` flow: SDK `Nodepod.boot({ install })` →
  `DependencyInstaller` → materialization; shell npm install → same
  installer class.

## Design

Flip the default: `transformModules` default becomes `false` (lazy), with
value `"eager"` restoring today's behavior (keep `true` as alias for
`"eager"` for backward compat). Under lazy:

1. Install = download + extract + write only. No `convertPackage` calls.
2. Runtime `loadModule` keeps working as today for CJS and ESM sources.
   The one gap to close: packages whose `package.json` lacks `"type"` but
   whose entry files are ESM (`.js` with import/export) — `loadModule`
   already detects import/export via regex + acorn parse
   (`script-engine.ts:~304-366`), so no change expected; the test matrix
   below proves it.
3. Measure: add a lightweight timing log around install phases
   (`console.debug` gated on existing debug flag if one exists in
   `config.ts`; otherwise skip logging — do not invent a flag system).

## Commands you will need

| Purpose   | Command                | Expected on success |
|-----------|------------------------|---------------------|
| Typecheck | `pnpm run type-check`  | exit 0   |
| Tests     | `pnpm test`            | all pass |
| Manual    | `node examples/serve.js` → basic + vite examples | installs faster, apps still run |

## Scope

**In scope**:
- `src/packages/installer.ts` (default flip, option normalization)
- `src/sdk/types.ts` (option type: `boolean | "eager"`, docs comment)
- `src/module-transformer.ts` (only if option normalization lives there)
- `src/__tests__/` — extend an existing installer-adjacent suite or create
  `src/__tests__/lazy-transform.test.ts` exercising `loadModule` over
  representative untransformed fixtures (CJS package, dual-mode package, ESM
  `"type":"module"` package, ESM-without-type package)
- `README.md` — one line documenting the new default

**Out of scope**:
- Runtime TS handling via esbuild (audit follow-up, separate plan).
- Pipelining extract/transform for eager mode.
- Persistent transform-output cache (couples with Plan 015; note follow-up).

## Git workflow

- Branch: `advisor/016-lazy-install-transforms`
- Conventional commit: `perf(packages): default to lazy module transforms at require-time`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Prove runtime coverage (spike, no code change)

Write the fixture test FIRST (`lazy-transform.test.ts`): construct a
`MemoryVolume` with four mini-packages (CJS, ESM+type:module, ESM w/o type,
dual entry with `exports` map) exactly as extracted (NO conversion), then
`require()` each through a `ScriptEngine` and assert exports resolve. If any
fixture fails, STOP — the gap in `loadModule` must be cataloged and fixed (or
the plan re-scoped) before flipping any default.

**Verify**: `pnpm exec vitest run src/__tests__/lazy-transform.test.ts` → pass.

### Step 2: Option normalization + default flip

`transformModules?: boolean | "eager"` normalized once at installer entry:
`"eager" | true` → eager, `false | undefined` → lazy. Remove the
`convertPackage` call from the lazy path (keep for eager). Update the SDK
type + JSDoc.

**Verify**: `pnpm run type-check` → exit 0; `pnpm test` → all pass.

### Step 3: Manual end-to-end

`pnpm run build:lib`; `node examples/serve.js`; run the basic example and
`/examples/vite-build-test/` (heaviest consumer). Time an `npm install` of a
mid-size package before/after (DevTools console timestamps are fine). Record
numbers in your report.

## Test plan

- Step 1 fixture suite is the core regression net.
- Existing suites green — especially `script-engine.test.ts`,
  `issue-56-typebox-tdz-repro.test.ts` (TDZ/ESM edge cases), and the
  integration suites.
- Manual browser verification of a real framework install.

## Done criteria

- [ ] `pnpm run type-check` exits 0; `pnpm test` exits 0
- [ ] Default install performs zero esbuild transform tasks (assert via a spy/counter in a unit test or grep the offload task types dispatched)
- [ ] `transformModules: "eager"` restores previous behavior
- [ ] All four fixture package shapes load correctly untransformed
- [ ] Vite example still builds/runs in the browser
- [ ] `plans/README.md` status row updated

## STOP conditions

- Step 1 fixtures reveal `loadModule` cannot handle a common untransformed
  shape (e.g. `exports` map subpath, `__esModule` interop) — report with the
  failing fixture; do not flip the default.
- Vite example breaks under lazy mode in a way the fixtures didn't catch —
  report; consider keeping eager default and offering lazy opt-in instead
  (decision goes to maintainer).
- Any sign that install-time transforms are load-bearing for the SW preview
  path (transformed code served over HTTP) — report.

## Maintenance notes

- Follow-up (with Plan 015): persist runtime transform outputs in IDB keyed
  by content hash so even first-require cost survives reloads.
- Follow-up: route runtime TS through esbuild instead of regex stripping —
  bigger correctness win than perf.
