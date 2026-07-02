# Plan 015: Persistent install caches — tarballs + snapshots for every entry point

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
- **Risk**: LOW-MED
- **Depends on**: none
- **Category**: install speed / network / memory (base64 inflation)
- **Planned at**: 2026-07-02, from the install-pipeline perf audit

## Why this matters

Today, only `installFromManifest` via the SDK benefits from the IndexedDB
snapshot cache; shell `npm install express` and programmatic
`packages.install()` re-download and re-extract every tarball on every page
reload. On top of that, the snapshot cache stores every file **base64-encoded**
(~33% size inflation plus encode/decode CPU) and restores files one
`writeFileSync` at a time. After this plan: (1) tarball bytes are cached in
IndexedDB keyed by URL+integrity so any install path skips the network on
warm runs; (2) the shell's installer gets the same snapshot cache the SDK
uses; (3) snapshots store raw bytes (no base64) and restore via the existing
bulk binary-snapshot path.

## Current state

- `src/persistence/idb-cache.ts` — IDB store of `VolumeSnapshot` keyed by a
  DJB2 hash of `package.json`, 7-day TTL (lines ~9, 86-88). No tarball store.
- `src/packages/installer.ts:~180-236` — cache check/restore only in
  `installFromManifest`; `install()` (~119-163) has no cache path. Restore
  loops `writeFileSync` per file (~189-201).
- `src/polyfills/child_process.ts:~637-638` — shell `npm install` constructs
  `DependencyInstaller` **without** `snapshotCache`.
- `src/memory-volume.ts:~351-356` — `toSnapshot()` base64-encodes contents;
  `fromBinarySnapshot` (~372-398) already supports a flat binary format.
- Tarball fetch: worker `src/threading/inline-worker.ts:~239-244`
  (`fetch(url).arrayBuffer()`), fallback `src/threading/offload.ts:~86-93`
  and `src/packages/archive-extractor.ts:~254-261`.
- Registry metadata: `src/packages/registry-client.ts:~48-81` (in-memory only).

## Design

1. **Tarball cache** (`src/persistence/tarball-cache.ts`, new): IDB object
   store `tarballs`, key = tarball URL, value = `{ bytes: ArrayBuffer,
   integrity: string, storedAt: number }`. API: `get(url)`, `put(url, bytes,
   integrity)`, `prune(maxBytes = 256MB, maxAgeDays = 14)` (LRU by
   `storedAt`, evict until under budget; run prune after each install batch).
   The **main thread** consults the cache before dispatching an extract task
   and passes cached bytes into the task (extend the offload task type with
   optional `tarballBytes`); the worker skips its `fetch` when bytes are
   provided. On worker fetch success, bytes are already posted back? — NO:
   the inline worker currently discards raw tarball bytes after extraction.
   Extend the extract result with the raw compressed bytes (transferable)
   ONLY when the main thread asked for them (`wantTarball: true`), so the
   main thread can `put()` them. Gate `wantTarball` on tarball size unknown
   or < 20MB to avoid shipping huge buffers back.
2. **Shell cache parity**: `child_process.ts` accepts/receives the
   `snapshotCache` (and tarball cache) — plumb from `Nodepod.boot()` the same
   way the SDK installer gets it. The shell runs inside a worker; IDB is
   available in workers, but the *installer* in the shell path runs on main
   (verify — read `initShellExec` / npm command wiring; if install executes
   worker-side, open IDB directly there: `openSnapshotCache()` works in any
   realm).
3. **Binary snapshots**: replace base64 `VolumeSnapshot` for the IDB cache
   with the flat binary format (`manifest + one ArrayBuffer`), stored as-is
   (IDB handles ArrayBuffers natively). Restore via
   `MemoryVolume.fromBinarySnapshot()` merged into the live volume (need a
   merge-at-prefix variant — write into `/node_modules` without clobbering
   the rest; check `fromBinarySnapshot` semantics first, it may rebuild the
   whole tree — if so add `writeBinarySnapshotAt(vol, prefix, snapshot)`
   helper instead of changing `fromBinarySnapshot`).
   Bump the IDB schema version; old-format entries are simply ignored
   (cache miss) and age out.

## Commands you will need

| Purpose   | Command                | Expected on success |
|-----------|------------------------|---------------------|
| Typecheck | `pnpm run type-check`  | exit 0   |
| Tests     | `pnpm test`            | all pass |
| Manual    | `node examples/serve.js` → `/examples/basic/` twice | 2nd `npm install` is near-instant, Network tab shows no tarball fetches |

## Scope

**In scope**:
- `src/persistence/tarball-cache.ts` (create)
- `src/persistence/idb-cache.ts` (binary snapshot format, schema bump)
- `src/packages/installer.ts` (cache in `install()` too; bulk restore; tarball cache consult)
- `src/threading/offload-types.ts`, `src/threading/inline-worker.ts` (optional `tarballBytes` in, raw bytes out)
- `src/packages/archive-extractor.ts` (fallback path consults cache)
- `src/polyfills/child_process.ts` + plumbing from `src/sdk/nodepod.ts` (shell parity)
- Tests: `src/__tests__/tarball-cache.test.ts` (create; use `fake-indexeddb` if
  already a devDep — check `package.json`; if not, test the pure logic with an
  in-memory stub interface instead of adding a dependency)

**Out of scope**:
- Lazy/deferred transforms (Plan 016).
- Registry metadata persistence (nice-to-have; note as follow-up).
- Service-worker-level HTTP caching.

## Git workflow

- Branch: `advisor/015-persistent-install-caches`
- Conventional commit: `perf(packages): persistent tarball + binary snapshot caches for all install paths`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Tarball cache module + wire into extract dispatch

Create `tarball-cache.ts` per the design. In `installer.ts`'s materialization
loop (~328-366), before dispatching each extract: `await cache.get(url)`; on
hit pass `tarballBytes` in the task; on miss set `wantTarball` and `put()`
from the result. Handle cache API errors by proceeding uncached (never fail
an install because IDB failed).

**Verify**: `pnpm run type-check` → exit 0; `pnpm test` → all pass.

### Step 2: Worker support for provided/returned bytes

`inline-worker.ts`: if `tarballBytes` present, skip fetch; if `wantTarball`,
include the compressed bytes in the result with a transfer list. Keep the
shasum check from Plan 003/audit follow-ups intact if present.

**Verify**: `pnpm run type-check` → exit 0; `pnpm test` → all pass.

### Step 3: Binary snapshot format in IDB + bulk restore

Implement per design point 3 (schema bump, `writeBinarySnapshotAt` helper if
needed). Apply to BOTH save and restore paths in `installer.ts`, and extend
the cache usage to `install()` (key: sorted `name@version` list digest —
reuse `quickDigest` for now, note SHA-256 upgrade as follow-up).

**Verify**: `pnpm test` → all pass; add a unit test for
`writeBinarySnapshotAt` (merge into existing tree without clobbering).

### Step 4: Shell parity

Trace how the shell's npm command constructs its installer
(`child_process.ts:~632-697`) and give it the same caches. Confirm realm (main
vs worker) and open IDB in the correct one.

**Verify**: `pnpm run type-check` → exit 0; `pnpm test` → all pass.

### Step 5: Manual warm-run check

`pnpm run build:lib`; `node examples/serve.js`; in `/examples/basic/` run an
install (add a terminal example command or use the SDK page), reload, rerun:
Network tab shows no `registry.npmjs.org` tarball fetches; wall time drops to
extraction-only.

## Test plan

- Unit: tarball cache put/get/prune (stub or fake-indexeddb).
- Unit: binary snapshot round-trip + merge-at-prefix.
- Existing installer/version-resolver suites green.
- Manual warm-reload verification (no automated browser harness exists).

## Done criteria

- [ ] `pnpm run type-check` exits 0; `pnpm test` exits 0
- [ ] Warm reload of the same install hits zero tarball network requests (manual)
- [ ] Shell `npm install` benefits from the snapshot cache (same key logic as SDK)
- [ ] IDB snapshots store raw bytes (no base64) with a bumped schema version
- [ ] Cache failures degrade to uncached installs, never errors
- [ ] `plans/README.md` status row updated

## STOP conditions

- The shell install path turns out to run in a realm where the offload
  worker pool is unavailable (would change where the cache consult goes) —
  report.
- `fromBinarySnapshot` cannot be safely adapted to merge-at-prefix without
  changing its spawn-path semantics — report (add the helper, don't mutate
  the spawn path).
- IDB quota errors during testing — implement the prune path first, then
  report if still failing.

## Maintenance notes

- Follow-ups noted for the README deferred list: persist registry metadata
  with ETag revalidation; upgrade snapshot cache key from DJB2 to SHA-256
  (sync-digest.ts now exists); pipeline extract→transform overlap.
