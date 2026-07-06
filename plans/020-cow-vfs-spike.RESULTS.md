# Plan 020 spike RESULTS: copy-on-write shared VFS for process spawns

- **Date**: 2026-07-03
- **Baseline**: working tree with plans 011–019 applied (lean spawn snapshots,
  VFS broadcast hygiene, SharedVFS hash index + compaction all landed)
- **Recommendation**: **NO-GO** (for now) — ship 011 + 013 + 014 and stop.
  Details and the re-open trigger are at the bottom.
- **Prototype artifact**: `plans/spike-020-torn-read-experiment.ts`
  (worker_threads reader vs. main-thread writer/compactor; see Q4)

## Q1 — Capacity: can SharedVFS hold a realistic `node_modules`?

Measured three real installs (Windows, 2026-07-03):

| Project                              | Files      | Bytes    | Max path length | Fits 16,384 entries? | Fits 64MB SAB? |
|--------------------------------------|------------|----------|-----------------|----------------------|----------------|
| `npm install express` (flat)         | 595        | 2.1 MB   | 77              | yes                  | yes            |
| `pnpm create vite` react (vite 8)    | 433        | 60 MB    | 143             | yes                  | **marginal**   |
| This repo's dev tree (heavy end)     | 22,954     | 853 MB   | <248            | **no**               | **no**         |

Notes:

- The data region of a 64MB SAB is 64MB − 32B header − 16,384×272B table
  ≈ **59.5MB usable**. The vite-react install alone is 60MB of file bytes —
  it does not fit once project files and write churn are added. Modern
  Vite ships pre-bundled (few files, big bytes); older-generation stacks
  (webpack/CRA-era, Next) are the opposite (30–60k files) and blow the
  **entry cap** instead. Either axis fails first depending on the stack.
- Path lengths are not a constraint (max seen 143 < 248 cap).
- Lifting the caps means a growable or two-level index. SAB cannot be
  resized in place (Chrome's growable SAB requires `maxByteLength`
  reservation up front); the realistic design is **chunked**: a directory
  SAB pointing at N data SABs, allocated on demand. That's a full layout
  rewrite of `shared-vfs.ts` plus a reader-side re-attach protocol
  (workers must be handed new SAB references mid-life via postMessage —
  the current design assumes exactly one buffer for the worker lifetime).
  Estimated budget for a "safe default" reservation: 256MB+ virtual, which
  is real memory pressure on 32-bit-limited tabs and mobile.

## Q2 — Read path: what breaks with workers reading SAB bytes directly?

The premise of zero-copy reads is mostly defeated by API restrictions that
already force copies today. Evidence in the current tree:

- `TextDecoder.decode()` rejects SAB-backed views. Every **text** read must
  copy first — and module source (the dominant read at `require()` time) is
  text. Existing copy sites: `src/memory-volume.ts` `decodeText()` (~line
  220), `src/polyfills/buffer.ts` `toString()` (~line 156),
  `src/threading/inline-worker.ts` extract path, `readNullTerminated()` in
  `src/threading/offload-worker.ts` (~line 70).
- `WebAssembly.compile`/`Module` require non-shared buffers, so `.wasm`
  reads (the biggest single files) copy as well.
- `postMessage` cannot transfer SAB-backed bytes; both
  `src/threading/process-worker-entry.ts` (~lines 198, 536) carry
  load-bearing comments about copying SAB-backed results before transfer.
- What genuinely could be zero-copy: binary reads consumed by pure-JS code
  (hashing, gzip via pako, byte concatenation). That is a minority of read
  volume in profiled installs/spawns.

Conclusion: a COW shared base saves the **per-worker retained copy** (the
hydrated private cache), not the **transient decode copy** — every text/wasm
read still allocates once. Post-Plan-011 the retained copy is already
limited to files the worker actually touches, so the marginal win shrinks to
"shared cache of touched files across sibling workers".

## Q3 — COW overlay semantics

Design sketch (what an implementation would need — no blockers found, but
substantial surface):

- **Precedence**: overlay (per-worker `MemoryVolume`) → whiteout set →
  shared base. All 30+ sync methods on the fs bridge must consult in that
  order.
- **Write**: write to overlay only. Parent visibility unchanged from today:
  the existing `vfs-write` sync-back message keeps flowing (overlay write +
  async notify), so parent/sibling isolation until sync is actually the
  *same* model as today — good.
- **Delete**: needs explicit whiteout markers (path-set per worker);
  `readdirSync` = (base entries ∪ overlay entries) − whiteouts; `existsSync`
  and `statSync` must check whiteouts before the base.
- **Rename**: copy-up (materialize base file into overlay under new name)
  + whiteout the old path. Directory renames require recursive copy-up —
  the ugliest case (matches what plan 011's lazy hydration already does for
  `renameSync` on lazy paths).
- **stat**: base stats lack uid/mode fidelity (SAB entry stores only
  size/mtime/flags) — overlay stats win when present; base stats get
  synthesized defaults, same as `SharedVFSReader.statSync` today.

## Q4 — Consistency: is versioning + retry enough? (measured)

Prototyped the exact race the plan asked for:
`plans/spike-020-torn-read-experiment.ts` runs a `worker_threads` reader in
a tight loop against `/target.bin` (256KB, alternating uniform `A`/`B`
payloads) while the main thread rewrites the file, churns a 512KB filler,
and forces `compact()` every 5 writes.

Three 3-second runs (Node 22, Windows):

| Run | Writes | Compactions | Reads  | Torn reads |
|-----|--------|-------------|--------|------------|
| 1   | 83,348 | 16,669      | 16,668 | **1**      |
| 2   | 72,875 | 14,575      | 16,398 | **3**      |
| 3   | 87,496 | 17,499      | 17,441 | **1**      |

**Torn reads are real and reproducible** (~1 per 10k reads under forced
churn). Mechanism: `compact()` relocates data-region bytes under the writer
lock, but readers take no lock — a reader that has loaded `contentOffset`
and is mid-copy sees bytes move under it. Today this is survivable because
process workers read via their own hydrated `MemoryVolume` copy and the
SharedVFS read path is a fallback; in a COW world where **every read** hits
the SAB, this must be fixed with a per-entry seqlock (even/odd generation
counter checked before and after the byte copy, retry on mismatch) or an
epoch scheme for compaction. Doable, but it puts an Atomics handshake on
the hottest path in the system and is exactly the class of bug that escapes
tests and corrupts user builds.

(A side finding from writing the experiment: entry fields are written
big-endian via `DataView` while header slots use native-endian `Atomics` —
any reader written against "the obvious" layout reads garbage. Worth a
comment in `shared-vfs.ts` regardless of this spike's outcome.)

## Q5 — Fallback story

No-SAB environments (no COOP/COEP) must keep the snapshot path forever.
That means the fs bridge carries **three** read models simultaneously:
private volume (no SAB), lean snapshot + lazy miss handler (plan 011), and
COW overlay + shared base. Plans 011/013 already added the second model;
the third would touch the same ~30 fs entry points again plus spawn,
broadcast, and WASI proxy code. The dual-path tax is the largest hidden
cost here: every future fs bugfix lands three times.

## Q6 — Numbers: COW vs. full snapshot vs. lean snapshot

Direct browser measurements (per-spawn wall time, per-worker retained heap)
were **not obtainable in this environment** (no Chromium harness with
COOP/COEP + `performance.memory` available to the spike). Stated per the
spike instructions. What the landed plans already establish analytically:

- **Full snapshot (pre-011)**: per-worker copy ≈ full tree incl.
  `node_modules` (e.g. ~60MB+ for vite-react per spawn).
- **Lean snapshot (011, landed)**: per-worker copy ≈ project files + only
  the `node_modules` files the worker actually touches (hydrated on miss).
  For an express server spawn that's ~2MB ceiling (the whole express tree)
  and typically less.
- **COW (this spike)**: per-worker retained ≈ overlay writes only; touched
  files are read from the shared base but still incur a transient decode
  copy per read (Q2).

The delta COW offers over lean is therefore bounded by "bytes of
node_modules a worker touches", minus nothing on the transient side. For
the typical Nodepod workload (spawn node server, require a framework) that
is single-digit MB per worker — **well under the >2× memory / >3× latency
threshold** the plan set for GO, while carrying the Q4 correctness risk,
the Q1 layout rewrite, and the Q5 triple-path maintenance tax.

## Decision: NO-GO (revisit trigger defined)

Stop at the landed stack: 011 (lean snapshots, default still "full" —
consider flipping the default after browser soak), 013 (broadcast hygiene /
invalidation), 014 (hash index + compaction). Do not build the COW overlay
now.

**Revisit trigger**: profiling of a real multi-process workload (e.g. 4+
concurrent spawns under `spawnSnapshot: "lean"`) showing per-worker hydrated
`node_modules` copies exceeding ~50MB each, i.e. heavy overlapping touch
sets across siblings. That is the one scenario where a shared base pays for
its complexity. If it fires, the implementation plans sketched are:

1. **021 — chunked SAB layout**: directory SAB + N data chunks, growable by
   allocation; per-entry seqlock; lift the 16,384-entry cap (two-level
   index). Effort L, risk HIGH.
2. **022 — overlay fs**: per-worker overlay volume + whiteouts + copy-up
   rename, wired behind the existing miss-handler seam from plan 011.
   Effort M, risk MED (the 011 seam does most of the shaping).
3. **023 — WASI fs-proxy over shared base**: replace the per-read fresh-SAB
   copies in `napi-wasm-worker.ts` (~line 1006) with direct base reads.
   Effort S once 021 exists. This is also the item with the clearest
   standalone win if 021 ever lands.
