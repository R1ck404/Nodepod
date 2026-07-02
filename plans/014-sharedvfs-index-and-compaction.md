# Plan 014: SharedVFS — hash index, compaction, and failure visibility

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
- **Risk**: MED (shared-memory layout change, cross-thread)
- **Depends on**: none
- **Category**: memory / lookup performance
- **Planned at**: 2026-07-02, from the memory & VFS perf audit

## Why this matters

The SharedArrayBuffer-backed VFS mirror has three compounding problems:
(1) every lookup linearly scans up to 16,384 entries byte-comparing paths;
(2) the data region is append-only — every overwrite appends a new copy and
orphans the old bytes, deletes only clear a flag — so long dev sessions
(HMR rewriting the same files) bloat the 64MB region until writes silently
return `false`; (3) those silent failures mean workers just stop seeing
updates with no signal. After this plan, lookups go through an FNV-1a hash
stored per entry (fast reject), the controller compacts the data region when
waste crosses a threshold, and write failures are surfaced.

## Current state

- `src/threading/shared-vfs.ts:28-49` — layout: 16-byte header, 16,384 × 264B
  entry table, 64MB default data region. Entry: flags, offset, length, mtime,
  248-byte path. **No hash field.**
- `shared-vfs.ts:63-70` — `fnv1a()` exists but is never called.
- `shared-vfs.ts:105-134` (`writeFile`) — appends content at `dataUsed`;
  `_updateEntry` (read it) also appends; returns `false` on table/data
  exhaustion. Callers (`vfs-bridge.ts:122-124`) **ignore the return value**.
- `shared-vfs.ts:~173-185` (`deleteFile`) — clears `FLAG_ACTIVE` only.
- `shared-vfs.ts:~219-239` and reader-side `~383-403` (`_findEntry`) — linear
  scan with per-entry byte compare.
- Header int32 slots: `[0]` version, `[1]` entry count, `[2]` data used,
  `[3]` lock (writer lock via `Atomics`).
- Readers (`SharedVFSReader`) live in workers; they take no lock for reads
  but check the version counter (read the class before editing).

## Design

Keep the single-SAB layout (readers depend on it) but:

1. **Per-entry hash**: entry bytes 12–15 currently store mtime; do NOT reuse —
   instead take 4 bytes out of the path field (`ENTRY_PATH_MAX` 248 → 244) or
   grow `ENTRY_SIZE` 264 → 268... **Decision**: grow `ENTRY_SIZE` to 272
   (keep 8-byte alignment), adding `[16..19] pathHash`, path moves to
   `[20..267]`. Bump the layout `version` header value and update BOTH
   controller and reader constants in the same commit (they share the file).
   `_findEntry` compares `fnv1a(path)` against the stored hash first, only
   byte-comparing on hash match. This keeps the scan O(n) but drops the per-
   entry cost to one int compare in the common miss case (~50× faster scans);
   a full open-addressing table in SAB is deliberately out of scope (risk).
2. **Compaction**: controller tracks `wasteBytes` (accumulated on update/
   delete: old content length). When `wasteBytes > 16MB` or a write fails for
   space, `compact()`: take the writer lock, rebuild the data region by
   copying live entries' bytes into a scratch `ArrayBuffer`, write back
   contiguously, update offsets, bump version, release lock. Readers already
   re-resolve entries per operation and check version; verify the reader does
   not cache offsets across calls (read `SharedVFSReader` first — if it does,
   STOP).
3. **Failure visibility**: `writeFile` returning `false` gets logged (once
   per session per reason, not per file) by `VFSBridge`, and a counter is
   exposed via `getStats()` for the SDK to surface.

## Commands you will need

| Purpose   | Command                | Expected on success |
|-----------|------------------------|---------------------|
| Typecheck | `pnpm run type-check`  | exit 0   |
| Tests     | `pnpm test`            | all pass (incl. `shared-vfs.test.ts`, 40 tests) |
| Test one  | `pnpm exec vitest run src/__tests__/shared-vfs.test.ts` | pass |

## Scope

**In scope**:
- `src/threading/shared-vfs.ts` (layout vNext, hash-assisted scan, compaction, stats)
- `src/threading/vfs-bridge.ts` (log dropped writes)
- `src/__tests__/shared-vfs.test.ts` (extend: hash lookup, compaction, waste accounting)

**Out of scope**:
- Making SharedVFS the primary store for worker fs (that's the Plan 020 spike).
- Seeding SharedVFS from the volume at boot (worthwhile, but separate — note it).
- Open-addressing hash table layout.

## Git workflow

- Branch: `advisor/014-sharedvfs-index-compaction`
- Conventional commit: `perf(threading): SharedVFS hash-assisted lookup + data compaction`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Layout vNext with pathHash

Grow `ENTRY_SIZE` to 272; add `ENTRY_HASH_OFFSET = 16`; shift path to 20 with
`ENTRY_PATH_MAX = 248` intact (272 − 20 − 4 spare). Recompute `TABLE_SIZE` /
`DATA_OFFSET`. Write the hash in `writeFile`/`_updateEntry` entry-creation;
compare hash-first in both `_findEntry` implementations (controller + reader).
Since controller and reader are compiled from the same constants, no
cross-version negotiation is needed — but bump the header version constant so
a stale reader (shouldn't exist) fails loudly rather than misreading.

**Verify**: `pnpm exec vitest run src/__tests__/shared-vfs.test.ts` → all 40
existing tests pass unmodified (they exercise the public API, not offsets).

### Step 2: Waste accounting + compaction

Track `wasteBytes` in the controller (add to header as int32 slot 4 if a slot
is free within `HEADER_SIZE` 16 — slots 0-3 are used; grow `HEADER_SIZE` to 32
instead, folding into the same layout bump as Step 1). Increment on update
(old length) and delete (length). Implement `compact()` as designed; call it
opportunistically at the top of `writeFile` when `wasteBytes > 16MB`, and as
a rescue retry when a write fails for data-region space.

**Verify**: new tests — (a) overwrite the same path 1000× with 64KB payloads
in a small (4MB) test buffer: without compaction this would exhaust the
region; assert writes keep succeeding and `getStats().wasteBytes` stays
bounded; (b) delete files then write new ones into reclaimed space; (c) a
reader sees correct content immediately after a compaction (create reader on
the same SAB in-process for the test).

### Step 3: Failure visibility

`getStats()` gains `droppedWrites`. `VFSBridge.handleWorkerWrite` (and the
watcher mirror path) checks `writeFile`'s return; on `false`, increments and
`console.warn`s once per session.

**Verify**: `pnpm run type-check` → exit 0; `pnpm test` → all pass.

## Test plan

- Existing 40-test suite green, unmodified.
- New: hash-collision correctness (two paths with equal `fnv1a` — construct
  by brute force in the test or mock the hash fn — must still byte-compare
  and resolve correctly), compaction under churn, reader-after-compaction,
  dropped-write stats.

## Done criteria

- [ ] `pnpm run type-check` exits 0; `pnpm test` exits 0
- [ ] Lookup does hash compare before byte compare in controller AND reader
- [ ] Churn test proves the data region no longer grows unboundedly
- [ ] Dropped writes are counted and warned once
- [ ] `plans/README.md` status row updated

## STOP conditions

- `SharedVFSReader` caches entry offsets across calls (compaction would race
  it) — report; the fix needs a read-side retry-on-version-change loop, which
  changes the risk profile.
- Any existing shared-vfs test needs modification to pass (public behavior
  must not change).
- Compaction hold time on a full 64MB region proves >50ms in a quick
  measurement — report; may need incremental compaction instead.

## Maintenance notes

- Boot-time seeding of SharedVFS from the canonical volume (audit finding
  2.6) becomes more attractive after this plan since the region stops
  bloating; leave a TODO.
- If Plan 020 promotes SharedVFS to primary worker storage, the compaction
  lock becomes hotter — revisit locking granularity then.
