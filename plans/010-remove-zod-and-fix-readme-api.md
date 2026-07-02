# Plan 010: Remove the unused `zod` dependency and correct the README's public API

> **Executor instructions**: Follow step by step. Run every verification
> command before moving on. If a "STOP condition" occurs, stop and report.
> When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 78bec2c..HEAD -- package.json README.md src/sdk/nodepod.ts src/sdk/nodepod-fs.ts`
> If any changed, compare its "Current state" excerpt against live code; on
> mismatch, STOP for that item.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs / tech-debt
- **Planned at**: commit `78bec2c`, 2026-07-02

## Why this matters

Two independent, low-risk cleanups:

1. **`zod` is a declared runtime dependency but is never imported** anywhere in `src/`. It ships to every consumer of `@scelar/nodepod` and inflates the install/bundle surface for nothing.
2. **The README documents methods that don't exist**, so copy-pasting from it throws at runtime: `nodepod.install(...)`, `nodepod.request(...)`, and `nodepod.fs.rm(...)`. The real surface is `nodepod.packages.install(...)`, `nodepod.proxy.handleRequest(...)`, and `NodepodFS` exposes `unlink`/`rmdir` (no `rm`). The polyfill table also mislabels `worker_threads` as a stub when it's a full implementation.

After this plan the dependency list is accurate, the README examples run as written (with a small `fs.rm` addition to make the documented method real), and the polyfill table is correct.

## Current state

- `package.json` — `zod` in dependencies:

```92:101:package.json
  "dependencies": {
    "acorn": "^8.15.0",
    "acorn-jsx": "^5.3.2",
    "brotli": "^1.3.3",
    "brotli-wasm": "^3.0.1",
    "comlink": "^4.4.2",
    "pako": "^2.1.0",
    "resolve.exports": "^2.0.3",
    "zod": "^4.3.6"
  },
```

- Actual SDK surface (`src/sdk/nodepod.ts`): `spawn`, `createTerminal`, `setPreviewScript`, `clearPreviewScript`, `port`, `snapshot`, `restore`, `readonly fs: NodepodFS` (line 77), `get packages(): DependencyInstaller` (line 841), `get proxy(): RequestProxy` (line 844). There is **no** `install` or `request` method.
- `DependencyInstaller.install(packageName: string, version?: string, flags?)` — installs a single package (`src/packages/installer.ts:119`). Not an array.
- `RequestProxy.handleRequest(...)` is variadic (`src/request-proxy.ts:391`): `(port, method, url, headers, body?)` or `(instanceId, port, method, url, headers, body?)`, returns `{ statusCode, statusMessage, headers, body: Buffer }`.
- `NodepodFS` (`src/sdk/nodepod-fs.ts`) has `unlink` (line 51) and `rmdir` (line 55) but **no `rm`**.
- README problem lines: `README.md:109` (`nodepod.install(['express'])`), `README.md:129-130`, `README.md:132` (`nodepod.request(3000, 'GET', '/')`), API table rows `README.md:165` (`install(packages)`) and `README.md:175` (`request(port, method, path)`), `README.md:172` (`fs.rm(path, opts?)`), and `README.md:195` (`worker_threads` listed under **Stubs**).
- `src/index.ts:50` exports the `worker_threads` polyfill; `src/polyfills/worker_threads.ts` is a full ~391-line implementation ("polyfill using fork infrastructure for real Web Workers"), not a stub.

## Commands you will need

| Purpose   | Command              | Expected |
|-----------|----------------------|----------|
| Typecheck | `npm run type-check` | exit 0   |
| Tests     | `npm test`           | all pass |
| Confirm no zod import | `grep -rn "from \"zod\"\|require(\"zod\")" src/` | no matches |

## Scope

**In scope**:
- `package.json` (remove `zod`)
- `src/sdk/nodepod-fs.ts` (add `rm`)
- `README.md` (fix examples, API table, polyfill table)

**Out of scope**:
- `package-lock.json` regeneration — do NOT run `npm install` to update the lock in this plan (it may pull unrelated updates). Note in your report that the maintainer should refresh the lockfile.
- Adding `install()`/`request()` wrapper methods to `Nodepod` — the plan instead corrects the README to the real API (smaller blast radius). Do not add those wrappers.
- The `brotli` vs `brotli-wasm` dependency question — separate finding; leave both.

## Git workflow

- Branch: `advisor/010-remove-zod-fix-readme`
- Conventional commits: `chore: remove unused zod dependency` and `docs: correct README public API and polyfill table`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Confirm `zod` is truly unused, then remove it

**Verify first**: `grep -rn "zod" src/` → no matches (if there are matches, STOP — it's used).

Remove the `"zod": "^4.3.6"` line from `package.json` dependencies (and fix the trailing comma on the line above so the JSON stays valid — `resolve.exports` becomes the last entry).

**Verify**: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` → no error (valid JSON); `grep -n "zod" package.json` → no matches.

### Step 2: Add `rm()` to `NodepodFS`

In `src/sdk/nodepod-fs.ts`, add an `rm` method (matching Node's `fs.promises.rm`) that delegates to the existing helpers. Place it near `unlink`/`rmdir`:

```ts
async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
  const exists = this._vol.existsSync(path);
  if (!exists) {
    if (opts?.force) return;
    throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
  }
  const st = this._vol.statSync(path);
  if (st.isDirectory()) {
    if (opts?.recursive) this._removeRecursive(path);
    else this._vol.rmdirSync(path);
  } else {
    this._vol.unlinkSync(path);
  }
}
```

(`_removeRecursive` already exists as a private method at line 84.)

**Verify**: `npm run type-check` → exit 0.

### Step 3: Fix the README usage examples

- `README.md:109` (npm packages section): change `await nodepod.install(['express']);` → `await nodepod.packages.install('express');`
- `README.md:129-130` (HTTP servers example): change `await nodepod.install(['express']);` → `await nodepod.packages.install('express');` (leave the `spawn` line as-is).
- `README.md:132-133`: change

```
const response = await nodepod.request(3000, 'GET', '/');
console.log(response.body); // { ok: true }
```
to
```
const response = await nodepod.proxy.handleRequest(3000, 'GET', '/', {});
console.log(response.body.toString()); // {"ok":true}
```

**Verify**: `grep -n "nodepod.install\|nodepod.request" README.md` → no matches.

### Step 4: Fix the README API table and polyfill table

- Table row `README.md:165` `| \`install(packages)\` | Install npm packages |` → `| \`packages.install(name, version?, flags?)\` | Install an npm package |`
- Table row `README.md:175` `| \`request(port, method, path)\` | Send request to virtual server |` → `| \`proxy.handleRequest(port, method, url, headers, body?)\` | Send a request to a virtual server |`
- Row `README.md:172` `| \`fs.rm(path, opts?)\` | Remove file/directory |` — now correct because Step 2 adds `rm`; leave it (optionally also confirm `fs.unlink`/`fs.rmdir` exist — they do).
- `README.md:195`: remove `worker_threads` from the **Stubs** line and add it to the **Full** line (or a new "Partial" note), since it is a real implementation.

**Verify**: `grep -n "worker_threads" README.md` → appears in the Full/Partial list, not the Stubs list.

### Step 5: Full build/test

**Verify**: `npm run type-check` → exit 0; `npm test` → all pass.

## Test plan

- Add a small test for the new `rm` to an existing SDK fs test if one exists, else create `src/__tests__/nodepod-fs-rm.test.ts` modeled on `src/__tests__/buffer.test.ts` structure, constructing `NodepodFS` over a `MemoryVolume` (see how `src/__tests__/memory-volume.test.ts` builds a volume). Cases: `rm` a file removes it; `rm` a directory with `{ recursive: true }` removes it and its contents; `rm` a missing path throws unless `{ force: true }`.
- Docs changes need no test beyond `npm test` staying green.
- Verification: `npm test` → all pass including the `rm` cases.

## Done criteria

- [ ] `grep -rn "zod" package.json src/` returns no matches; `package.json` is valid JSON
- [ ] `NodepodFS.rm` exists and its tests pass
- [ ] `grep -n "nodepod.install\|nodepod.request" README.md` returns no matches
- [ ] README polyfill table lists `worker_threads` as implemented, not a stub
- [ ] `npm run type-check` exits 0; `npm test` exits 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- `grep -rn "zod" src/` finds a real import (dependency is actually used) — STOP, do not remove it.
- The README line numbers have drifted; locate the equivalent text by content and proceed only if the wrong-method text clearly matches "Current state", else STOP.
- `NodepodFS` construction in tests requires wiring you can't determine from existing tests — report rather than guess.

## Maintenance notes

- After removing `zod`, the maintainer should regenerate `package-lock.json` (`npm install`) in a separate commit; this plan intentionally does not touch the lockfile.
- If the team later wants ergonomic top-level `nodepod.install()` / `nodepod.request()` methods, add them as thin delegators to `packages.install` / `proxy.handleRequest` — but that's a separate API-addition decision, deliberately not done here.
- Reviewer should skim the rest of the README polyfill lists for any other stale entries while confirming the `worker_threads` move.
