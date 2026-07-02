# Plan 011: Spawn snapshot diet — stop shipping `node_modules` to every worker

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: This plan was written against commit `78bec2c`
> plus the uncommitted working tree of 2026-07-02 (plans 001–010 applied).
> Compare the "Current state" excerpts against live code; on a mismatch, STOP.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: MED-HIGH
- **Depends on**: none (coordinate with 012/013 — all touch threading/)
- **Category**: memory / spawn latency
- **Planned at**: 2026-07-02, from the memory & VFS perf audit

## Why this matters

Every `spawn()`, `fork()`, and shell `node script.js` serializes the **entire**
VFS — including `node_modules` — into one ArrayBuffer, transfers it to a fresh
worker, and the worker rebuilds a private `MemoryVolume` copy. For a project
with ~150MB in `node_modules`, each spawn allocates ~150MB on main (transient)
plus ~150MB retained in the worker. A dev-server scenario (parent + child
processes) reaches 650MB–1GB+ total heap. This is the single largest memory
and spawn-latency cost in the codebase. After this plan, spawn snapshots
exclude heavy directories and workers fetch excluded files on demand via a
synchronous SAB-backed fs proxy (mechanism already exists for WASI workers),
cutting per-worker memory by roughly the size of `node_modules`.

## Current state

- `src/threading/process-manager.ts:92-94` — every spawn does
  `this._vfsBridge.createSnapshot()` (full tree, no exclusions). Fork and
  `spawn-request` route through the same `spawn()` (lines ~457-466, ~581-587).
- `src/threading/vfs-bridge.ts:30-63` — `createSnapshot()` walks the whole
  volume and packs all bytes into one buffer.
- `src/threading/process-handle.ts:81-87` — snapshot buffer is **transferred**
  (not cloned) to the worker.
- `src/threading/process-worker-entry.ts:154` — worker rebuilds via
  `MemoryVolume.fromBinarySnapshot(msg.snapshot)`; each file is `.slice()`d
  (second copy, worker heap).
- `src/memory-volume.ts:~363` — `SHALLOW_EXCLUDE_DIRS` already exists
  (`node_modules`, `.cache`, `.npm`) but is only used by SDK
  `Nodepod.snapshot({ shallow: true })`, never by spawn.
- **Sync read fallback mechanism already exists**: `process-manager.ts:118-134`
  creates 16 `MessageChannel`s per spawn wired to
  `handleFsProxy(data.__fs__, tabFsBridge)` where `tabFsBridge =
  buildFileSystemBridge(this._volume, ...)`. WASI workers use these ports with
  a SAB + `Atomics.wait` handshake to do synchronous reads against the main
  volume (see `src/helpers/napi-wasm-worker.ts` fs proxy, ~lines 960-1046).
  The process worker itself does NOT currently use these ports for its own fs.

## Design

1. `createSnapshot(opts?: { excludePrefixes?: string[] })` — walk skips
   subtrees whose path starts with an excluded prefix, but still records the
   directory entries themselves (so `existsSync('/project/node_modules')` is
   true in the worker) plus a marker list `lazyPrefixes: string[]` in the
   snapshot manifest.
2. Worker side: `MemoryVolume` gets an optional **miss handler**. On a read
   miss (`readFileSync` / `statSync` / `readdirSync`) for a path under a lazy
   prefix, the worker performs a synchronous proxy read to main over a
   dedicated fs MessagePort + SAB (same wire protocol as the WASI fs proxy),
   writes the result into its local volume (cache), and returns it. Writes
   under lazy prefixes go to the local volume as today (existing `vfs-write`
   sync-back continues to work).
3. Rollout is gated: new `NodepodOptions.spawnSnapshot?: "full" | "lean"`,
   **default `"full"`** in this plan. Flipping the default is a separate
   follow-up once examples/integration tests soak.

## Commands you will need

| Purpose   | Command                | Expected on success |
|-----------|------------------------|---------------------|
| Typecheck | `pnpm run type-check`  | exit 0   |
| Tests     | `pnpm test`            | all pass |
| Build     | `pnpm run build:lib`   | exit 0   |
| Manual    | `node examples/serve.js` → `/examples/basic/`, `/examples/child-process-test/` | boots, spawns work |

## Scope

**In scope**:
- `src/threading/vfs-bridge.ts` (exclude option)
- `src/threading/worker-protocol.ts` (snapshot manifest: `lazyPrefixes`)
- `src/threading/process-manager.ts` (pass option; dedicate one fs port to the process worker itself)
- `src/threading/process-worker-entry.ts` (miss handler wiring)
- `src/memory-volume.ts` (optional miss-handler hook, read paths only)
- `src/sdk/nodepod.ts` + `src/sdk/types.ts` (option plumb-through)
- `src/__tests__/vfs-bridge-lean.test.ts` (create)

**Out of scope**:
- Changing the default to `"lean"` (follow-up after soak).
- COW/shared-memory VFS redesign (Plan 020).
- SharedVFS (Plan 014).

## Git workflow

- Branch: `advisor/011-spawn-snapshot-diet`
- Conventional commit: `perf(threading): lean spawn snapshots with lazy fs fallback`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Exclude option in `createSnapshot`

Add `opts?: { excludePrefixes?: string[] }` to `VFSBridge.createSnapshot()`.
During `_walkVolume`, when a directory path matches an exclude prefix, push
its directory manifest entry but do not descend. Return `lazyPrefixes` in the
snapshot object (extend `VFSBinarySnapshot` in `worker-protocol.ts`, optional
field so existing messages stay valid).

**Verify**: `pnpm run type-check` → exit 0. Add a unit test: build a volume
with `/a.txt` + `/node_modules/x/i.js`, snapshot with
`excludePrefixes: ["/node_modules"]`, assert manifest contains `/a.txt` and
the `/node_modules` dir entry but not the file, and `lazyPrefixes` is set.

### Step 2: MemoryVolume miss handler (read-only hook)

Add `setMissHandler(fn: (path: string) => Uint8Array | null)` to
`MemoryVolume`. In `readFileSync`/`statSync`/`existsSync`/`readdirSync`
failure paths ONLY (do not touch write paths), if a handler is set and the
path is under a registered lazy prefix, call it; on non-null, write the bytes
into the local tree (silent, no watchers) and retry the original operation.
`readdirSync` needs a directory-listing variant — extend the handler contract
to `{ readFile(path), readdir(path), stat(path) }`.

**Verify**: unit test with a stub handler; `pnpm run type-check` → exit 0.

### Step 3: Sync proxy read from the process worker

In `process-manager.ts`, the 16-port pool built at lines 118-134 currently
serves only WASI workers. Reserve one additional dedicated `MessageChannel`
(same `handleFsProxy`/`buildFileSystemBridge` wiring) and pass its port in
`MainToWorker_Init` as `lazyFsPort`. In `process-worker-entry.ts`, if
`msg.snapshot.lazyPrefixes` is non-empty and `lazyFsPort` is present, build a
sync reader that mirrors the WASI fs proxy wire protocol (request via
`postMessage` on the port with a fresh SAB per call, `Atomics.wait` for
completion — copy the exact handshake from `napi-wasm-worker.ts`'s fs proxy
client) and install it as the volume's miss handler.

If SAB is unavailable (`!crossOriginIsolated`), do NOT install the handler and
force `spawnSnapshot: "full"` regardless of the option (log once).

**Verify**: `pnpm run type-check` → exit 0; `pnpm test` → all pass.

### Step 4: Option plumb-through, default "full"

Add `spawnSnapshot?: "full" | "lean"` to `NodepodOptions`; thread it
`Nodepod.boot()` → `ProcessManager` → `spawn()` so that `"lean"` passes
`{ excludePrefixes: SHALLOW_EXCLUDE_DIRS-derived list }` to `createSnapshot`.
Export the prefix list from one place (reuse/move the `SHALLOW_EXCLUDE_DIRS`
set in `memory-volume.ts` rather than duplicating).

**Verify**: `pnpm run type-check` → exit 0.

### Step 5: Integration test + manual soak

Create `src/__tests__/vfs-bridge-lean.test.ts` covering Step 1 and Step 2
units. Then build and manually verify both modes in the browser:
`pnpm run build:lib`, `node examples/serve.js`, run `/examples/basic/` and
`/examples/child-process-test/` (default full mode — must be unchanged). Then
temporarily flip the example to `spawnSnapshot: "lean"` after an
`npm install` of some package and confirm `require()` of an installed package
still works via the lazy path (watch DevTools memory: worker heap should be
dramatically smaller).

**Verify**: `pnpm test` → all pass; manual checks OK.

## Test plan

- Unit: snapshot exclusion manifest shape; miss-handler retry semantics.
- Existing threading/integration suites must stay green in default mode.
- Manual browser test for lean mode (no automated SW/worker harness exists —
  see plans/README deferred findings).

## Done criteria

- [ ] `pnpm run type-check` exits 0; `pnpm test` exits 0
- [ ] Default behavior (`"full"`) byte-identical to before (no test changes needed to pass)
- [ ] Lean mode: snapshot for a volume with `node_modules` excludes those file bytes; worker can still `require()` installed packages in the browser
- [ ] SAB-unavailable environments silently fall back to full snapshots
- [ ] `plans/README.md` status row updated

## STOP conditions

- The WASI fs proxy handshake in `napi-wasm-worker.ts` turns out not to be
  reusable from the process worker context (e.g. port delivery ordering) —
  report with details rather than inventing a new protocol.
- Miss-handler recursion (proxy read triggers another miss) — report.
- Any existing test fails in default `"full"` mode.

## Maintenance notes

- Flipping the default to `"lean"` should be its own change after soak, with
  release notes. `spawnSync`/`execSync` paths spawn children too — they get
  the same benefit automatically since everything routes through `spawn()`.
- Plan 020 (COW-VFS spike) supersedes parts of this eventually; the option
  boundary introduced here (`spawnSnapshot`) is the right seam for it.
