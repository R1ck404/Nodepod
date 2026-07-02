# Plan 009: Bound `ProcessHandle` stdout/stderr accumulation so verbose processes can't OOM the main thread

> **Executor instructions**: Follow step by step. Run every verification
> command before moving on. If a "STOP condition" occurs, stop and report.
> When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 78bec2c..HEAD -- src/threading/process-handle.ts`
> If changed, compare "Current state" excerpts against live code; on mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `78bec2c`, 2026-07-02

## Why this matters

`ProcessHandle` accumulates a worker's entire stdout/stderr into two ever-growing strings (`this._stdout += msg.data`). A long-running dev server or a chatty build prints megabytes; nothing caps it, so the main-thread heap grows unbounded until the tab OOMs. The SDK-facing `NodepodProcess` already solved this exact problem (`_pushStdout`/`_pushStderr` trim to a max), but `ProcessHandle` — which is where the raw worker output first lands, and which feeds `spawn-sync` — has no cap. After this plan, `ProcessHandle` trims retained output the same way `NodepodProcess` does, while still emitting every chunk to listeners (so live consumers see everything; only the *retained history buffer* is bounded).

## Current state

- `src/sdk/nodepod-process.ts` — the pattern to mirror (already correct):

```43:57:src/sdk/nodepod-process.ts
  _pushStdout(chunk: string): void {
    this._stdout += chunk;
    if (this._stdout.length > this._maxOutputBytes) {
      this._stdout = this._stdout.slice(-Math.floor(this._maxOutputBytes * 0.75));
    }
    this.emit("output", chunk);
  }

  _pushStderr(chunk: string): void {
    this._stderr += chunk;
    if (this._stderr.length > this._maxOutputBytes) {
      this._stderr = this._stderr.slice(-Math.floor(this._maxOutputBytes * 0.75));
    }
    this.emit("error", chunk);
  }
```

- `src/threading/process-handle.ts` — unbounded accumulation:

```28:29:src/threading/process-handle.ts
  private _stdout = "";
  private _stderr = "";
```

```161:169:src/threading/process-handle.ts
        case "stdout":
          this._stdout += msg.data;
          this.emit("stdout", msg.data);
          break;

        case "stderr":
          this._stderr += msg.data;
          this.emit("stderr", msg.data);
          break;
```

```171:175:src/threading/process-handle.ts
        case "exit": {
          const stdout = msg.stdout || this._stdout;
          const stderr = msg.stderr || this._stderr;
          this._stdout = stdout;
          this._stderr = stderr;
```

- Conventions: TS, private fields prefixed `_`. `emit(...)` must still fire for every chunk (live consumers rely on it). The cap applies only to the retained `_stdout`/`_stderr` strings exposed via the `stdout`/`stderr` getters (lines 48–49).

## Commands you will need

| Purpose   | Command              | Expected |
|-----------|----------------------|----------|
| Typecheck | `npm run type-check` | exit 0   |
| Tests     | `npm test`           | all pass |

## Scope

**In scope**:
- `src/threading/process-handle.ts`

**Out of scope**:
- `src/sdk/nodepod-process.ts` — already capped; do not touch.
- The worker side and the sync-spawn encoding — not changed here.
- Making the cap configurable via `MemoryHandler.options.maxProcessOutputBytes` — a nice-to-have, but keep this change to a hardcoded constant to stay low-risk (note it in Maintenance).

## Git workflow

- Branch: `advisor/009-cap-processhandle-output`
- Conventional commit: `fix(threading): bound retained stdout/stderr in ProcessHandle`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Add a cap constant and a trim helper

At module scope in `src/threading/process-handle.ts` (near the top, after imports), add:

```ts
const MAX_HANDLE_OUTPUT_BYTES = 5_000_000; // ~5MB retained per stream; matches NodepodProcess default intent
```

Add a private method on the class:

```ts
private _trim(s: string): string {
  return s.length > MAX_HANDLE_OUTPUT_BYTES
    ? s.slice(-Math.floor(MAX_HANDLE_OUTPUT_BYTES * 0.75))
    : s;
}
```

**Verify**: `npm run type-check` → exit 0.

### Step 2: Trim in the stdout/stderr cases (keep emitting every chunk)

```ts
case "stdout":
  this._stdout = this._trim(this._stdout + msg.data);
  this.emit("stdout", msg.data);
  break;

case "stderr":
  this._stderr = this._trim(this._stderr + msg.data);
  this.emit("stderr", msg.data);
  break;
```

(The `emit` still passes the full `msg.data` chunk — only the retained buffer is bounded.)

**Verify**: `npm run type-check` → exit 0.

### Step 3: Trim the final assignment in the `exit` case

```ts
this._stdout = this._trim(stdout);
this._stderr = this._trim(stderr);
```

(A worker that sends a huge final `msg.stdout` shouldn't bypass the cap.)

**Verify**: `npm run type-check` → exit 0; `npm test` → all pass.

## Test plan

- `ProcessHandle` construction requires a `Worker`, which isn't available in the vitest node environment without the worker-bundle mock harness (see the separate testing plan) — a full spawn test is out of scope here.
- If `_trim` is extracted as shown, add a minimal test that exercises it in isolation if the class can be constructed with a stubbed worker; otherwise rely on `type-check` + existing suite. Prefer: verify by inspection that `emit` still receives the full chunk and only the retained string is trimmed.
- Reviewer-facing note: once the worker-mock harness lands, add a test that pushes >5MB of stdout and asserts `handle.stdout.length <= MAX_HANDLE_OUTPUT_BYTES` while a listener counted all bytes emitted.

## Done criteria

- [ ] `MAX_HANDLE_OUTPUT_BYTES` constant and `_trim` helper exist
- [ ] stdout/stderr cases and the exit case route retained output through `_trim`
- [ ] `emit("stdout"/"stderr", msg.data)` still passes the untrimmed chunk
- [ ] `npm run type-check` exits 0; `npm test` exits 0
- [ ] No files outside `src/threading/process-handle.ts` modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- "Current state" excerpts don't match live code (drift).
- A test or caller depends on `handle.stdout` containing the *complete* history of a large process (would break under trimming) — report it; the fix may need to be opt-in for that caller.

## Maintenance notes

- The cap is currently a hardcoded constant. `MemoryHandler` already defines a `maxProcessOutputBytes` option that nothing reads; a follow-up could thread it through `ProcessManager` → `ProcessHandle` to make this configurable. Deferred to keep this change low-risk.
- Trimming keeps the *most recent* 75% when over cap (matches `NodepodProcess`); if a consumer needs head-retention instead, that's a different policy — call it out in review.
