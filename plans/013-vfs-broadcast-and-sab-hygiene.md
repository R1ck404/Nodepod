# Plan 013: VFS broadcast hygiene — stop per-recipient clones, drop dead fields

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
- **Effort**: S
- **Risk**: LOW-MED
- **Depends on**: none (coordinate with 011 — both touch process-manager)
- **Category**: memory / runtime churn
- **Planned at**: 2026-07-02, from the memory & VFS perf audit

## Why this matters

When any file changes, the main thread clones the file's full contents once
**per live worker** and posts each copy separately. Under a dev server with
HMR (Vite writing `.vite/deps`, rebuilds touching many files) this is an
N×file-size allocation storm that churns GC and stalls the main thread.
Separately, every spawn sends a `sharedBuffer` field the worker never reads,
and `vfs-read` handler code on main has no worker-side sender — dead weight
that confuses profiling. After this plan, broadcast payloads are allocated
once and shared, and dead protocol surface is removed.

## Current state

- `src/threading/process-manager.ts:~1007-1018` — `broadcastVFSChange` loop:
  for each worker (excluding the writer's pid), it copies the content
  `ArrayBuffer` (`content.slice(0)` or equivalent explicit clone) and
  `postMessage`s it. Read the exact loop before editing.
- `src/threading/process-manager.ts:102,142` — `sharedBuffer` placed into
  `SpawnConfig` and `MainToWorker_Init`.
- `src/threading/process-worker-entry.ts` — grep `sharedBuffer`: the init
  handler never reads it (confirm).
- `src/threading/process-manager.ts:~413-454` — `vfs-read` message handler;
  grep the repo for senders: none (confirm with
  `rg '"vfs-read"' src` — only the handler should match).
- Worker applies incoming sync at `process-worker-entry.ts:~433`
  (`vfs-sync` handling).

## Design

1. **Single-allocation broadcast**: `postMessage` structured-clones
   `ArrayBuffer`s (it does not share them), so N messages from one buffer
   still produce N copies — but the *explicit* per-recipient `.slice(0)` on
   main is pure waste. Allocate the payload **once** (the `Uint8Array` from
   the volume is already a live reference — clone it exactly once to detach
   from VFS storage) and pass the same buffer to every `postMessage` call,
   letting structured clone do the per-recipient copy off the main-thread
   allocation path. Additionally, add a **size gate**: for content larger
   than 4MB, send a `vfs-invalidate` message (path only) instead of bytes;
   workers already have the file from their snapshot or can re-request it
   (with Plan 011's lazy read path, this becomes a clean pull model).
2. **Remove dead surface**: delete `sharedBuffer` from `SpawnConfig` /
   `MainToWorker_Init` / spawn wiring (it is unused by the worker; the
   SharedVFS SAB is delivered via its own path if/when used); delete the
   orphan `vfs-read` handler. If either turns out to be used somewhere,
   STOP (see below).

## Commands you will need

| Purpose   | Command                | Expected on success |
|-----------|------------------------|---------------------|
| Typecheck | `pnpm run type-check`  | exit 0   |
| Tests     | `pnpm test`            | all pass |
| Grep      | `rg '"vfs-read"' src`  | no matches after removal |
| Manual    | `node examples/serve.js` → `/examples/vite-hmr-test/` | HMR still works |

## Scope

**In scope**:
- `src/threading/process-manager.ts` (broadcast loop, spawn config, dead handler)
- `src/threading/worker-protocol.ts` (remove `sharedBuffer` from init; add `vfs-invalidate`)
- `src/threading/process-worker-entry.ts` (handle `vfs-invalidate`: drop/refresh local copy)
- `src/threading/process-handle.ts` (only if it references `sharedBuffer`)

**Out of scope**:
- SharedVFS itself (Plan 014).
- The snapshot path (Plan 011).

## Git workflow

- Branch: `advisor/013-vfs-broadcast-hygiene`
- Conventional commit: `perf(threading): single-allocation VFS broadcasts, remove dead protocol fields`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Confirm dead surface

`rg 'sharedBuffer' src --line-number` and `rg '"vfs-read"' src --line-number`.
Expected: `sharedBuffer` appears in process-manager (set), worker-protocol
(type), possibly process-handle (pass-through), and **nowhere in
process-worker-entry reads**; `vfs-read` appears only in the main-side
handler. If a real reader/sender exists, STOP and report.

### Step 2: Broadcast loop

Rewrite `broadcastVFSChange` to build the outgoing payload once before the
recipient loop. Add the >4MB `vfs-invalidate` path (new message type in
`worker-protocol.ts`; worker handler deletes its local copy under
`_suppressWatch`-equivalent so no echo, and relies on snapshot/lazy-read for
next access). Keep the `excludePid` semantics identical.

**Verify**: `pnpm run type-check` → exit 0; `pnpm test` → all pass.

### Step 3: Remove dead fields/handlers

Delete `sharedBuffer` from `SpawnConfig`, `MainToWorker_Init`, and the spawn
wiring; delete the `vfs-read` handler block. Fix resulting type errors.

**Verify**: `pnpm run type-check` → exit 0; `rg 'sharedBuffer|"vfs-read"' src`
→ no matches (except SharedVFS's own internals if named similarly — only the
spawn-protocol field must be gone).

### Step 4: Manual HMR soak

`pnpm run build:lib`; `node examples/serve.js`; run
`/examples/vite-hmr-test/` and `/examples/child-process-test/`. Edits must
propagate to running processes as before.

## Test plan

- Existing threading/integration suites (multi-instance-proxy, vite, exit
  semantics) must stay green.
- No worker-side automated harness exists for broadcast fan-out; the manual
  HMR example is the regression test. Note this in the report.

## Done criteria

- [ ] `pnpm run type-check` exits 0; `pnpm test` exits 0
- [ ] One allocation per broadcast on main (no per-recipient `.slice`)
- [ ] Files >4MB broadcast as invalidation, not bytes
- [ ] `sharedBuffer` spawn field and `vfs-read` handler removed
- [ ] Manual HMR example verified working
- [ ] `plans/README.md` status row updated

## STOP conditions

- Step 1 finds a live consumer of `sharedBuffer` or a `vfs-read` sender.
- HMR example breaks in a way traceable to the invalidation path — report
  (likely means workers need the bytes eagerly; keep bytes-path and gate size
  higher rather than hacking).

## Maintenance notes

- Once Plan 011's lazy read path is default, the invalidation path can become
  the norm for all sizes (pull model), eliminating broadcast byte traffic
  entirely — leave a TODO referencing this plan.
