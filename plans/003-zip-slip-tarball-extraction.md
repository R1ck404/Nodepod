# Plan 003: Reject path-traversal (`..`) entries during npm tarball extraction

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 78bec2c..HEAD -- src/packages/archive-extractor.ts`
> If the file changed since this plan was written, compare "Current state"
> excerpts against live code first; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `78bec2c`, 2026-07-02

## Why this matters

npm packages are untrusted. When Nodepod extracts a downloaded `.tgz` into the virtual filesystem, it joins each tar member's path onto the destination directory with no check that the result stays inside that directory. A malicious (or compromised) package can include an entry like `../../package.json` or `../react/index.js`; because `path.join`/`normalize` collapse `..`, the write lands **outside** the package's own `node_modules/<pkg>/` folder — overwriting the project's `package.json`, another dependency's code, or bin stubs that later execute. That's a classic "zip-slip" sandbox escape. After this plan, any entry that would escape the destination directory is skipped and the extraction continues safely (matching how `tar`/npm behave).

## Current state

- `src/packages/archive-extractor.ts` — downloads, decompresses, parses, and writes tar members to a `MemoryVolume`. Imports `import * as path from "../polyfills/path";` (line 6). Two functions write files and both lack the guard:

`extractArchive` (main-thread parse path):

```161:177:src/packages/archive-extractor.ts
    if (filter && !filter(relative)) continue;

    const absolute = path.join(destDir, relative);

    if (entry.kind === "directory") {
      vol.mkdirSync(absolute, { recursive: true });
    } else if (entry.kind === "file" && entry.payload) {
      const parentDir = path.dirname(absolute);
      vol.mkdirSync(parentDir, { recursive: true });
      vol.writeFileSync(absolute, entry.payload);
      // pre-compile so it's ready by the time code needs it
      if (absolute.endsWith(".wasm")) {
        precompileWasm(entry.payload);
      }
      writtenPaths.push(absolute);
    }
```

`downloadAndExtract` (worker-offload path — worker returns `file.path` strings):

```206:228:src/packages/archive-extractor.ts
  for (const file of result.files) {
    if (opts.filter && !opts.filter(file.path)) continue;

    const absolute = path.join(destDir, file.path);
    const parentDir = path.dirname(absolute);
    vol.mkdirSync(parentDir, { recursive: true });

    if (file.isBinary) {
      ...
      vol.writeFileSync(absolute, bytes);
      ...
    } else {
      vol.writeFileSync(absolute, file.data as string);
    }
    writtenPaths.push(absolute);
  }
```

- `path.normalize` (see `src/polyfills/path.ts:8`) collapses `..`/`.` segments, so a normalized absolute path that does not start with `destDir + "/"` (and isn't `destDir` itself) has escaped.
- There is a third function `downloadAndExtractDirect` (starts ~line 235) that likely mirrors `downloadAndExtract` — inspect it; if it also joins `file.path`/`relative` onto `destDir` and writes, it needs the same guard.
- Conventions: TS, named exports, kebab-case. Tests are Vitest; model on `src/__tests__/buffer.test.ts`.

## Commands you will need

| Purpose   | Command                | Expected on success |
|-----------|------------------------|---------------------|
| Typecheck | `npm run type-check`   | exit 0              |
| Tests     | `npm test`             | all pass            |
| Test one  | `npx vitest run src/__tests__/archive-extractor.test.ts` | new tests pass |

## Scope

**In scope**:
- `src/packages/archive-extractor.ts`
- `src/__tests__/archive-extractor.test.ts` (create)

**Out of scope**:
- `src/threading/offload-worker.ts` — the worker only *parses* and returns relative paths; the security decision (where to write) is made in `archive-extractor.ts`. Guarding at the write site covers both the worker and non-worker paths. Do not change the worker.
- `src/polyfills/path.ts` — `normalize`/`join` are correct; the fix is to *use* them for a containment check, not change them.

## Git workflow

- Branch: `advisor/003-zip-slip-tarball-extraction`
- Conventional commit: `fix(packages): reject path-traversal entries during tarball extraction`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add a containment helper

Near the top of `src/packages/archive-extractor.ts` (after imports), add a pure helper:

```ts
// Returns the safe absolute path if `relative` stays inside `destDir`, else null.
// Guards against zip-slip: malicious tar entries like "../../package.json".
function safeJoin(destDir: string, relative: string): string | null {
  const base = path.normalize(destDir).replace(/\/+$/, "");
  const abs = path.normalize(path.join(base, relative));
  if (abs === base) return abs;
  if (abs.startsWith(base + "/")) return abs;
  return null;
}
```

**Verify**: `npm run type-check` → exit 0.

### Step 2: Guard the main-thread `extractArchive` write path

In `extractArchive`, replace `const absolute = path.join(destDir, relative);` with a `safeJoin` call and skip escaping entries:

```ts
const absolute = safeJoin(destDir, relative);
if (!absolute) continue; // zip-slip attempt — skip this entry
```

**Verify**: `npm run type-check` → exit 0.

### Step 3: Guard the worker-offload `downloadAndExtract` write path (and `downloadAndExtractDirect`)

Apply the same `safeJoin` guard replacing `const absolute = path.join(destDir, file.path);` in `downloadAndExtract`. Then read `downloadAndExtractDirect` (~line 235 to end of file): if it also joins an untrusted relative path onto `destDir` before writing, apply the identical guard there.

**Verify**: `grep -n "path.join(destDir" src/packages/archive-extractor.ts` → **no remaining direct joins on write paths** (all replaced by `safeJoin`).

### Step 4: Add tests

Create `src/__tests__/archive-extractor.test.ts`. The cleanest unit is `safeJoin` behavior — but it isn't exported. Export it (`export function safeJoin`) so it can be tested directly, or test `extractArchive` end-to-end with a crafted in-memory tar. Prefer exporting `safeJoin` and testing it directly (simplest, deterministic). Cases:
- `safeJoin("/node_modules/pkg", "index.js")` → `"/node_modules/pkg/index.js"`
- `safeJoin("/node_modules/pkg", "lib/a.js")` → inside dir
- `safeJoin("/node_modules/pkg", "../../package.json")` → `null`
- `safeJoin("/node_modules/pkg", "../pkg-evil/x.js")` → `null`
- `safeJoin("/node_modules/pkg", "")` → the base dir (allowed)
- `safeJoin("/node_modules/pkg", "sub/../ok.js")` → inside dir (normalizes to `/node_modules/pkg/ok.js`)

**Verify**: `npx vitest run src/__tests__/archive-extractor.test.ts` → all pass.

## Test plan

- New file `src/__tests__/archive-extractor.test.ts` covering the six `safeJoin` cases above (happy path, the traversal exploit this plan blocks, sibling-escape, empty, and a benign `..` that normalizes back inside).
- Structural pattern: `src/__tests__/buffer.test.ts`.
- Verification: `npm test` → all pass including new suite.

## Done criteria

- [ ] `npm run type-check` exits 0
- [ ] `grep -n "path.join(destDir" src/packages/archive-extractor.ts` returns no matches on file-write paths (all go through `safeJoin`)
- [ ] `npm test` exits 0; `src/__tests__/archive-extractor.test.ts` exists and its traversal cases return `null`
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- "Current state" excerpts don't match live code (drift).
- `downloadAndExtractDirect` turns out to write via a different mechanism you can't guard with `safeJoin` — report it rather than leaving a gap.
- Any legitimate real-world package extraction test in the existing suite starts failing because its entries legitimately contain `..` that normalizes inside the dir (should be allowed by `safeJoin`) — if a truly-inside path is being rejected, the helper is wrong; report.

## Maintenance notes

- The tar parser also has `link` entries (symlinks/hardlinks, `EntryKind` at line 29). This plan does not add symlink support (they're currently skipped by the `kind !== "file" && kind !== "directory"` filter). If symlink extraction is ever added, it needs its own traversal guard (a symlink target can escape too) — call that out in review.
- Reviewer should confirm `safeJoin` uses the same `path` polyfill the rest of extraction uses, so normalization semantics match.
