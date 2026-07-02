# Plan 012: Bound worker-side caches (transform cache + module registry)

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
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: memory (leak fix)
- **Planned at**: 2026-07-02, from the memory & VFS perf audit

## Why this matters

Inside process workers, every `node script.js` builds a `ScriptEngine`
**without** a `MemoryHandler`, so the transform cache falls back to a plain
unbounded `Map`. Long-running worker processes (dev servers, watchers) that
require many modules — or repeatedly re-run scripts — accumulate transformed
source strings forever. On main, the `MemoryHandler` LRU caps this at 512
entries; in workers there is no cap at all. Combined with the 2000-entry
module registry this is one of the top three memory sinks. After this plan,
worker transform caches are LRU-bounded and shared across `ScriptEngine`
instances within the same worker, which also makes repeat `node` runs faster
(cache hits instead of full re-transforms).

## Current state

- `src/script-engine.ts:~2082-2089` — `ScriptEngine` constructor: when
  `options.handler` is absent, `codeCache` becomes a plain `Map` (unbounded).
- `src/polyfills/child_process.ts:~1113-1135` — `executeNodeBinary()` creates
  `new ScriptEngine({...})` per invocation with **no** `handler` and no shared
  cache; each run starts cold and the old Map is only freed when the engine is
  GC'd (retained if anything holds the engine).
- `src/memory-handler.ts:~89` — main-thread LRU cap is 512 entries.
- `src/constants/config.ts:203` — module registry cap 2000 (FIFO eviction in
  `script-engine.ts:~1559-1560`); this one is bounded, leave as is.
- Conventions: TS, named exports, kebab-case, Vitest.

## Design

Create a small `LruCache<string, string>` (or reuse the LRU logic in
`memory-handler.ts` if it's extractable) and a **worker-global** singleton:
`getWorkerTransformCache(): LruCache` in a new module
`src/threading/worker-transform-cache.ts` with a cap of 512 entries /
~32MB estimated bytes (track summed value lengths, evict LRU until under
both caps). `executeNodeBinary` passes it into every `ScriptEngine` it
creates. The cache key already includes a content hash
(`path|quickDigest(source)` at `script-engine.ts:~1516`), so staleness is
handled — the LRU just bounds growth.

## Commands you will need

| Purpose   | Command                | Expected on success |
|-----------|------------------------|---------------------|
| Typecheck | `pnpm run type-check`  | exit 0   |
| Tests     | `pnpm test`            | all pass |
| Test one  | `pnpm exec vitest run src/__tests__/worker-transform-cache.test.ts` | new tests pass |

## Scope

**In scope**:
- `src/threading/worker-transform-cache.ts` (create)
- `src/script-engine.ts` (accept an injected cache; do not change key format)
- `src/polyfills/child_process.ts` (`executeNodeBinary` passes the singleton)
- `src/__tests__/worker-transform-cache.test.ts` (create)

**Out of scope**:
- Main-thread `MemoryHandler` (already bounded).
- Module instance registry cap (already bounded at 2000).
- Persisting transforms across reloads (Plan 016 territory).

## Git workflow

- Branch: `advisor/012-bound-worker-caches`
- Conventional commit: `perf(threading): bound and share worker transform cache`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: LRU cache module

Create `src/threading/worker-transform-cache.ts`: an LRU keyed
`Map<string, string>` with `maxEntries = 512` and `maxBytes = 32 * 1024 * 1024`
(sum of `value.length * 2` as a UTF-16 estimate). `get()` refreshes recency
(delete+set). Export `getWorkerTransformCache()` returning a module-level
singleton. Include a `stats()` helper (entries, approxBytes) for tests.

**Verify**: `pnpm exec vitest run src/__tests__/worker-transform-cache.test.ts`
(write the test first if you prefer): inserting 513 entries evicts the least
recently used; a `get()` protects an entry from eviction; byte cap triggers
eviction independently of entry count.

### Step 2: Inject into ScriptEngine

`ScriptEngine` options: add `transformCache?: { get(k): string | undefined; set(k, v): void }`.
In the constructor, precedence: explicit `transformCache` > `handler`'s cache >
plain `Map` (unchanged fallback). Do not change the cache key format.

**Verify**: `pnpm run type-check` → exit 0; `pnpm test` → all pass.

### Step 3: Wire `executeNodeBinary`

In `child_process.ts`, `executeNodeBinary` passes
`transformCache: getWorkerTransformCache()`. This code runs both on main (SDK
spawn fallback paths) and inside workers; the singleton is per-realm which is
exactly the desired scope.

**Verify**: `pnpm run type-check` → exit 0; `pnpm test` → all pass (notably
`exit-semantics.test.ts` and `script-engine.test.ts`, which exercise repeated
executions — behavior must be identical, only faster).

## Test plan

- New unit suite for the LRU (evictions, recency, byte cap).
- Existing `script-engine` / `exit-semantics` / integration suites green — they
  implicitly verify cross-run cache reuse doesn't change semantics (keys are
  content-hashed so edits to a file still retransform).

## Done criteria

- [ ] `pnpm run type-check` exits 0; `pnpm test` exits 0
- [ ] No unbounded `Map` used as `codeCache` when engines are created via `executeNodeBinary`
- [ ] Two sequential `node` runs of the same script in one worker reuse transforms (verifiable via `stats()` in a unit test with two engines sharing the singleton)
- [ ] `plans/README.md` status row updated

## STOP conditions

- "Current state" excerpts don't match live code (drift).
- `ScriptEngine` turns out to mutate cached values in place (would make
  sharing unsafe) — report.
- Any existing test regresses.

## Maintenance notes

- If Plan 016 (lazy install transforms) lands, runtime transform volume goes
  up; the byte cap here becomes the guard rail — revisit the 32MB number then.
- TLA-processed output is currently NOT cached (post-cache processing in
  `loadModule`); caching final post-TLA code is a separate optimization noted
  in the module-loading audit.
