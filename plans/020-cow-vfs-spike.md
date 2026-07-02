# Plan 020: SPIKE — copy-on-write shared VFS for process spawns

> **Executor instructions**: This is a **design spike**, not an implementation
> plan. The deliverable is a written design + a throwaway prototype branch +
> measurements — NOT merged production code. Follow the questions below; if a
> question can't be answered with evidence, say so explicitly in the
> deliverable. When done, update this plan's row in `plans/README.md` and
> file the resulting implementation plan(s) as 021+.
>
> **Drift check (run first)**: Written against commit `78bec2c` plus the
> uncommitted working tree of 2026-07-02. Plans 011–014 change the ground this
> spike stands on — read their status rows first and account for whatever has
> landed.

## Status

- **Priority**: P1 (the end-state for the memory problem)
- **Effort**: L (spike itself: M)
- **Risk**: HIGH (worker isolation semantics)
- **Depends on**: ideally after 011 (lean snapshots) and 014 (SharedVFS
  compaction) land, since both change the baseline
- **Category**: memory / architecture
- **Planned at**: 2026-07-02, from the memory & VFS perf audit

## Why this matters

Even with Plan 011 (excluding `node_modules` from snapshots + lazy reads),
every worker still materializes private copies of whatever it touches, the
main thread keeps the canonical tree, and SharedVFS keeps a third mirror.
The end-state that eliminates the multiplier is: **one shared, read-mostly
byte store** (SAB) that all workers read directly, with **per-process
copy-on-write overlays** for writes. That's an architecture change with real
risk: POSIX-ish semantics (a child's writes must NOT leak to the parent or
siblings until synced), Atomics coordination, and the 64MB/16K-entry
SharedVFS limits. Hence a spike: prove or kill the approach with a prototype
and numbers before committing.

## Questions the spike must answer

1. **Capacity**: Can SharedVFS (post-Plan-014) hold a realistic
   `node_modules` (measure: file count + bytes for a `create vite` React
   project)? The 16,384-entry cap is likely the binding constraint — what
   layout change lifts it (grow table? two-level index?) and what does the
   SAB budget become?
2. **Read path**: With workers reading file bytes directly from the SAB
   (zero-copy into `WebAssembly`/decoders where possible), what breaks?
   Known hazard: `TextDecoder`/some APIs reject SAB-backed views —
   `memory-volume.ts:202-218` and `buffer.ts:147-150` already copy for this;
   quantify how much copying remains and whether it negates the win.
3. **COW overlay semantics**: Overlay = per-worker in-memory `MemoryVolume`
   consulted before the shared base. Define precedence for: write, delete
   (needs whiteout markers), rename, readdir merge (base ∪ overlay −
   whiteouts), stat. Where does the existing `vfs-write` sync-back fit —
   does the parent still get child writes, and when?
4. **Consistency model**: Main thread mutates the base (installs, HMR
   writes) while workers read it. Is per-entry versioning + retry
   (seqlock-style) enough? Prototype the race: main compacts/overwrites
   while a worker reads the same entry in a tight loop — detect torn reads.
5. **Fallback story**: No SAB (not cross-origin isolated) → today's snapshot
   path must remain. How much dual-path complexity does that impose on `fs`?
   Is the maintenance cost acceptable?
6. **Numbers**: On the prototype, for a project with real `node_modules`
   (~100MB+): per-spawn wall time and per-worker retained heap, versus (a)
   current full snapshot, (b) Plan-011 lean snapshot. The decision threshold:
   COW must beat lean snapshots by a wide margin (>2× memory or >3× spawn
   latency) to justify its complexity — otherwise recommend stopping at 011.

## Prototype scope (throwaway)

- Branch `spike/020-cow-vfs`, no tests required, hacks allowed, clearly
  marked DO-NOT-MERGE.
- Minimum: SharedVFS-as-base + overlay `MemoryVolume` wired into ONE code
  path (worker `fs.readFileSync`/`writeFileSync`/`readdirSync`), enough to
  run `/examples/child-process-test/` and a `require('express')` from a
  pre-seeded base.
- Measure with `performance.now()` + `performance.memory` (Chromium) —
  crude is fine, relative numbers are what matter.

## Deliverable

`plans/020-cow-vfs-spike.RESULTS.md` containing:
- Answers to the six questions with evidence (code refs, measurements table).
- A go/no-go recommendation with the measured deltas.
- If GO: a sketch of implementation plans (021+: layout change, overlay fs,
  migration/fallback, test harness needs) with effort/risk estimates.
- If NO-GO: what to do instead (likely: ship 011 default-lean + 013 pull
  model and stop).

## STOP conditions

- SAB unavailability in the primary dev environment (no COOP/COEP) — the
  spike needs `node examples/serve.js` which sets the headers; if isolation
  still fails, report.
- The 16K-entry cap can't be lifted without breaking `SharedVFSReader`
  compatibility mid-spike — note it as a cost in the results, don't solve it.

## Maintenance notes

- The audit also flagged the WASI fs-proxy SAB copies
  (`napi-wasm-worker.ts:1006-1046` — full file bytes copied per read with a
  fresh SAB per call). A COW shared base would let WASI workers read the
  same SAB directly; include that in the GO sketch if applicable.
