# Forge issue verification — 12 October 2026

Checked commit `72f245c96f0315ab64b49111d3de0e85f460ce15` (package version
1.11.2) using a freshly built `dist/__worker__.js` in real Chromium browser
workers. Cross-origin isolation and SharedArrayBuffer were enabled. The original
starter was read from the adjacent agent-harness repository. No model requests
were made and no Nodepod runtime implementation was changed.

## Repairs and retesting

The changes following this verification fix POSIX file URL parsing under
Chromium on Windows, JSON directory entry resolution, exact builtin subpath
matching, and the callable `node:test` export. Retesting uncovered and fixed
three additional blockers: `worker_threads.markAsUncloneable`, guest-created
jsdom globals being permanently hidden by module wrappers, and esbuild's
`packages: 'external'` option being overridden by the filesystem plugin.

The guest compatibility target is now `22.22.0`. This is an emulated JavaScript
API target, not a claim that the browser runs a native Node 22 binary or shares
its engine/security implementation. The complete Router 8 starter validation
already passed with the old `22.12.0` string, before updating the target.

The original Router 8.4.0 starter (resolved Vite 8.3.4) passes type generation,
TypeScript, the actual route-rendering test, and client/SSR builds in a browser
worker. An automated Playwright regression verifies the exit status, absence
of the version warning, runtime probes, and generated client/server files.
Router 7.18.4 / Vite 7.3.7 also passes complete validation and produces builds.
Router 7.1.0 / Vite 6.4.4 now also passes complete validation and produces client
and SSR builds. Its `parseAst` failure came from Nodepod choosing the `require`
export condition during `import()`, and sharing resolved paths between those
two loading modes. Import conditions now remain distinct during asynchronous
and synchronous evaluation, including ES modules loaded by `require`. Regression
tests cover both import/require loading orders and synchronous ES module loading.
The automated browser regression verifies both Router 8.4.0 and Router 7.1.0.

Full unit validation passes 1,659 tests (5 skipped). The final build and
TypeScript checks pass. The HMR regression continues to check five updates
with state preserved; no stale-update defect was established.

Initial installed dependencies did not match the checked-in lockfile.
`pnpm install --frozen-lockfile` restored the declared fast packages without
changing the lockfile; it also resolved the unrelated WASM bootstrap test
failure. Restart the host Vite server after rebuilding `dist`: its module cache
can otherwise keep serving the previous build.

The release review also fixed repeated reads of worker-message getters, idle
Node MessageChannel references, and uncanceled worker warm-up deadlines. Added
regressions cover message snapshots and worker/scheduler lifetime. The packed
npm artifact passes ESM and CommonJS entry-point checks, real headless worker
execution, SDK filesystem operations, and a clean consumer TypeScript check.
The smoke process exits normally after teardown without `process.exit`.

The final browser checks cover both starter versions above, seven existing
runtime/preview reliability cases, and the five-update HMR regression. New
test and probe files were formatted consistently with neighboring files;
existing source files were edited locally to avoid unrelated formatting churn.

## Initial findings (before repairs)

1. **Router startup failure reproduced; conditional-import diagnosis needs correction.**
   The unchanged Router 8.4.0 starter and Router 7.18.4 / Vite 7.3.7 both fail
   type generation looking for
   `/node_modules/@react-router/dev/module-sync-enabled/index.mjs`.
   However, `index.mjs` exists under
   `/workspace/node_modules/@react-router/dev/module-sync-enabled/`.
   Router's installed `dist/vite.js` explicitly constructs and dynamically
   imports that filename after deriving `packageRoot` from
   `nodeRequire.resolve('@react-router/dev/package.json')`. This is not an
   attempt to substitute `index.mjs` for a conditional-import target.
   Direct `createRequire(...).resolve('#module-sync-enabled')` resolves the
   installed `false.cjs` correctly, and an isolated ESM fixture with the same
   imports map passes. The incorrect root path is reproduced; its precise
   internal cause still needs isolation. General conditional-import
   incompatibility is not established by this failure.

2. **Node version mismatch reproduced.** The browser reports `v22.12.0`.
   Router 8.4.0 prints its minimum-version warning, and its installed manifest
   declares `>=22.22.0`. Router 7 avoids this warning but still fails validation.
   No attempt was made to fake a newer version or infer API compatibility.

3. **SPDX dependency resolution failure reproduced.** Router 7.1.0 / Vite 6.4.4
   fails type generation resolving `spdx-license-ids` from
   `/workspace/node_modules/spdx-expression-parse`.
   Guest filesystem reads confirm installed manifests for `spdx-expression-parse`
   3.0.1 and `spdx-license-ids` 3.0.24 in the ancestor `node_modules` directory.
   The latter has no `main` and publishes `index.json`. Nodepod's `INDEX_FILES`
   list omits `index.json`, and its manifest fallback defaults to `index.js`.
   A guest `fs.readFileSync` of the actual `index.json` succeeds and parses 708
   identifiers while package-name resolution fails. The package data is present;
   the missing JSON directory fallback explains this minimal case.

4. **`punycode/` failure reproduced in browser.** With npm `punycode` 2.3.1
   explicitly installed, `require.resolve('punycode/')` returns the bare string
   `punycode/`, then loading it fails with `ENOENT` opening that string.
   Native Node resolves the npm package and converts `mañana.com` to
   `xn--maana-pta.com`. Source inspection shows `isBuiltin` accepts any subpath
   whose first segment is a builtin, including `punycode/`; the loader only has
   a shim for `punycode`. Browser impact is now confirmed for this minimal case.

5. **`node:test` default-import failure reproduced in browser.**
   `import test, { test as named } from 'node:test'` yields an object default,
   a function named export, and unequal values. Calling the default throws
   `TypeError: test is not a function` and exits 1. Native Node yields the same
   callable function for both exports and runs the minimal test successfully.

6. **Stale Vite updates not reproduced.** The existing real-browser
   `hmr-timing.spec.ts` passed five source updates and preserved React state.
   Observed render delays were approximately 25–31 ms. This checks edits to
   one existing module, not every create/rename/delete or cache scenario.
   Three VFS watcher scheduling tests and seven worker transform-cache tests
   also passed. This remains an unconfirmed claim, not a proven absence of bugs.

The initial starter validations stopped during type generation; tests and production
builds were not reached. Installer resilience and extraction-order suites also
passed (10 tests). Together with watcher/cache checks, 20 unit tests passed.

## Reproduce

Run from the Nodepod repository root with the original Forge repository nearby:

```powershell
pnpm run build:lib
node tests/browser/prepare-forge-compatibility.mjs
pnpm exec vite --config vite.perf.config.ts
```

The preparation script also accepts an absolute starter-directory argument.
Open `http://127.0.0.1:3333/tests/browser/forge-compatibility.html`, then run:

```js
await runCompatibility(); // Router 8.4.0, original Vite range
await runCompatibility('7.18.4', '7.3.7');
await runCompatibility('7.1.0', '6.4.4');
```

Results and guest diagnostics are retained in `window.results`; each run tears
down its pod. The probe adds isolated virtual import fixtures and diagnostic
scripts, and explicitly installs punycode before validation. Starter application
files and validation commands remain unchanged; Router/Vite versions are the
only requested manifest overrides. The helper stores fixture and worker SHA-256
hashes in `memory/forge-build.json`. Saved run results are in
`memory/forge-router-8.4.0-results.json` and
`memory/forge-router-7.1.0-results.json` (ignored local evidence). The earlier
repair campaign, including the then-unresolved Vite 6 failure, is retained in
`memory/forge-compatibility-fixed-results.json`.

The generated fixture lives in ignored `memory/`, so Playwright's cleanup of
`test-results` does not delete it. The automated starter test skips when the
original fixture has not been prepared.

```powershell
pnpm exec playwright test --config playwright.preview.config.ts tests/browser/forge-compatibility.spec.ts
pnpm exec playwright test --config playwright.perf.config.ts tests/performance/hmr-timing.spec.ts
```
