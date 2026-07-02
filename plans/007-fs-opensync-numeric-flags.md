# Plan 007: Decode numeric `flags` in `fs.openSync` instead of collapsing them to read-only

> **Executor instructions**: Follow step by step. Run every verification
> command before moving on. If a "STOP condition" occurs, stop and report.
> When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 78bec2c..HEAD -- src/polyfills/fs.ts`
> If changed, compare "Current state" excerpts against live code; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `78bec2c`, 2026-07-02

## Why this matters

`fs.openSync` accepts flags either as a string (`"r"`, `"w"`, `"a+"`) or as a numeric bitmask built from `fs.constants` (`O_WRONLY | O_CREAT | O_TRUNC`). Low-level file code and some native-addon shims use the numeric form. This polyfill throws the numeric value away — `typeof flags === "number" ? "r" : flags` — so every numeric-flag open becomes **read-only**. Code that opens a file for writing with numeric flags then silently fails to write (or hits a wrong-FD-state error), and `O_CREAT` never creates the file. After this plan, numeric flags are decoded to the equivalent string semantics using the constants the polyfill already defines.

## Current state

- `src/polyfills/fs.ts`. The bug:

```1566:1604:src/polyfills/fs.ts
    openSync(target: unknown, flags: string | number, _mode?: number): number {
      const p = abs(target);
      const flagStr = typeof flags === "number" ? "r" : flags;
      const exists = volume.existsSync(p);
      const isWrite = flagStr.includes("w") || flagStr.includes("a");
      const isReadOnly = flagStr.includes("r") && !flagStr.includes("+");

      if (!exists && isReadOnly) {
        const err = new Error(
          `ENOENT: no such file or directory, open '${p}'`,
        ) as Error & { code: string; errno: number; path: string };
        err.code = "ENOENT";
        err.errno = -2;
        err.path = p;
        throw err;
      }

      let content: Uint8Array;
      if (exists && !flagStr.includes("w")) {
        content = volume.readFileSync(p);
      } else {
        content = new Uint8Array(0);
        if (isWrite) {
          const parent = p.substring(0, p.lastIndexOf("/")) || "/";
          if (!volume.existsSync(parent)) {
            volume.mkdirSync(parent, { recursive: true });
          }
        }
      }

      const fd = fdCounter++;
      openFiles.set(fd, {
        filePath: p,
        cursor: flagStr.includes("a") ? content.length : 0,
        mode: flagStr,
        data: new Uint8Array(content),
      });
      return fd;
    },
```

- The rest of `openSync` reasons purely from `flagStr` string membership (`.includes("w")`, `.includes("a")`, `.includes("+")`, `.includes("r")`). So the minimal, low-risk fix is to convert a numeric bitmask into the equivalent flag string up front, leaving all downstream logic untouched.
- The O_* constant values are defined in this same file (lines 545–557): `O_RDONLY:0, O_WRONLY:1, O_RDWR:2, O_CREAT:64, O_EXCL:128, O_TRUNC:512, O_APPEND:1024`.
- Node's numeric→string mapping (the semantics to reproduce):
  - `O_RDONLY` → `"r"`
  - `O_WRONLY|O_CREAT|O_TRUNC` → `"w"`
  - `O_WRONLY|O_CREAT|O_APPEND` → `"a"`
  - `O_RDWR` → `"r+"`
  - `O_RDWR|O_CREAT|O_TRUNC` → `"w+"`
  - `O_RDWR|O_CREAT|O_APPEND` → `"a+"`
- Conventions: TS, the fs polyfill is a big object of sync methods. Tests are Vitest; there is a `src/__tests__/path.test.ts` and `buffer.test.ts` to model on. There may be an existing fs test — check `src/__tests__/` for an `fs`-related file and extend it if present; otherwise create `src/__tests__/fs-opensync.test.ts`.

## Commands you will need

| Purpose   | Command              | Expected |
|-----------|----------------------|----------|
| Typecheck | `npm run type-check` | exit 0   |
| Tests     | `npm test`           | all pass |

## Scope

**In scope**:
- `src/polyfills/fs.ts` (the `openSync` method only)
- A test file (extend an existing fs test if one exists, else create `src/__tests__/fs-opensync.test.ts`)

**Out of scope**:
- `accessSync` mode handling, `copyFileSync` `COPYFILE_EXCL`, `closeSync` EBADF — related fs-fidelity findings, but each is its own change; do NOT bundle them here.
- The `promises.open` / async `open` paths — not this plan.
- Changing the `openFiles` FD record shape.

## Git workflow

- Branch: `advisor/007-fs-opensync-numeric-flags`
- Conventional commit: `fix(fs): decode numeric open flags instead of forcing read-only`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Add a numeric→string flag decoder inside `openSync`

Replace the single line `const flagStr = typeof flags === "number" ? "r" : flags;` with a decode that maps the bitmask to the equivalent string. Read the O_* values from the same constants object the file exports (or reference the literal values 1/2/64/512/1024, which match lines 545–551). Target:

```ts
const flagStr =
  typeof flags === "number" ? numericFlagsToString(flags) : flags;
```

And add `numericFlagsToString` as a local helper (module scope, near the top of the file or just above the fs object) implementing:

```ts
function numericFlagsToString(f: number): string {
  const O_WRONLY = 1, O_RDWR = 2, O_CREAT = 64, O_TRUNC = 512, O_APPEND = 1024;
  const readWrite = (f & O_RDWR) === O_RDWR;
  const writeOnly = (f & O_WRONLY) === O_WRONLY;
  const append = (f & O_APPEND) === O_APPEND;
  // Not strictly needed downstream, but mirrors Node's create/truncate intent:
  // downstream logic keys off "w"/"a"/"+"/"r" only.
  if (append) return readWrite ? "a+" : "a";
  if (writeOnly) return "w";
  if (readWrite) return (f & O_CREAT) || (f & O_TRUNC) ? "w+" : "r+";
  return "r";
}
```

Note: the downstream logic only inspects the presence of `w`/`a`/`+`/`r` in `flagStr`, so returning the closest string equivalent is sufficient and keeps this change minimal.

**Verify**: `npm run type-check` → exit 0.

### Step 2: Tests

Extend an existing fs test file if one imports the fs polyfill; otherwise create `src/__tests__/fs-opensync.test.ts`. Build an fs instance the way the existing tests do (inspect how another test constructs `MemoryVolume` + the fs polyfill — follow that exact setup). Cases:
- Open a non-existent path with numeric `O_WRONLY | O_CREAT | O_TRUNC` (`1 | 64 | 512 = 577`) → does not throw ENOENT; a subsequent `writeSync` + `closeSync` persists content (readable via `readFileSync`).
- Open with numeric `O_RDONLY` (`0`) on a non-existent path → throws `ENOENT` with `.code === "ENOENT"`.
- Open existing file with numeric `O_APPEND | O_WRONLY` (`1024 | 1 = 1025`) → cursor starts at end (append semantics); writing appends rather than truncating.
- Regression: string flag `"w"` still works as before.

**Verify**: `npx vitest run <the fs test file>` → all pass.

## Test plan

- Cover: numeric write-create (the bug), numeric read-only ENOENT, numeric append, and a string-flag regression.
- Model the fs/volume setup on whichever existing test constructs the fs polyfill (search `src/__tests__/` for `openSync` or the fs import). If none exists, model MemoryVolume construction on how `src/memory-volume.ts` is used in `src/__tests__/memory-volume.test.ts`.
- Verification: `npm test` → all pass including new cases.

## Done criteria

- [ ] `openSync` decodes numeric flags (no more `? "r" :`)
- [ ] `grep -n 'typeof flags === "number" ? "r"' src/polyfills/fs.ts` returns no matches
- [ ] `npm run type-check` exits 0; `npm test` exits 0; new numeric-flag tests pass
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- "Current state" excerpt doesn't match live code (drift).
- You cannot determine from an existing test how to instantiate the fs polyfill with a `MemoryVolume` — report rather than guessing the constructor wiring.
- Decoding numeric flags surfaces a downstream assumption that breaks other fs tests (e.g. a test that relied on numeric flags being read-only) — report it; that test encodes the bug.

## Maintenance notes

- If numeric `O_EXCL` (128) support is later required (fail if file exists), it must be added to both `numericFlagsToString`'s intent and the create branch — currently EXCL is not enforced for string or numeric flags.
- Reviewer should confirm the append case sets `cursor` to `content.length` (existing logic already does this when `flagStr.includes("a")`).
