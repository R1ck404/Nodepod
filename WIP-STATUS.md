# WIP: runtime reliability fixes (temporary status file — delete before merge)

Branch: `fix/runtime-reliability`. Work in progress against the NodePod 1.9.20/1.9.21
integration findings report (issues A–K). Everything below was verified locally in
Chrome via throwaway Playwright probes in `tmp-probe/` (kept on the branch on
purpose so the runs can be repeated; delete or promote before merge).

## Done (verified)

| Issue | Fix | Where |
|---|---|---|
| **A** command cannot read `Response`/`fetch` bodies; `kill()` never settles | Root cause: the `executeNodeBinary` wait loop raced an already-resolved `drainPromise()` while a top-level await was pending with nothing refed → infinite microtask spin starving every browser task in the worker (body reads, the `signal` message). Loop now yields a real macrotask in that state. Fetch bodies also hold a `FetchRequest` handle while being consumed. `proc.kill()` goes through `ProcessManager.kill` (SIGINT → SIGKILL fallback) so `completion` always settles. Bonus: in-pod `fetch('http://localhost:PORT/...')` is now delivered to the virtual server on that port (same bridge `http.request` uses) instead of hitting the network. | `src/polyfills/child_process.ts`, `src/script-engine.ts`, `src/sdk/nodepod.ts`, `src/polyfills/http.ts`, `src/threading/{process-manager,process-worker-entry,worker-protocol}.ts` |
| **B** installer: unbounded `latest` resolution, non-atomic extraction, nested holes, one failure aborts all | New `src/packages/registry-fetch.ts`: per-attempt deadlines (30 s metadata / 90 s tarball) + 3 retries with backoff for registry metadata and tarballs. `materializePackages` rewritten: up-to-date check per depth group (after parents were re-extracted), nested `node_modules` parked and restored when a parent is replaced (this was the real cause of "missing better-auth/node_modules/…": the parent re-extraction clobbered installed children), 3 attempts per package, failed packages no longer abort the rest, previous good copy is never removed, archive version validated, whole tree validated at the end. Unit tests: `installer-resilience.test.ts`, `registry-fetch.test.ts`. | `src/packages/*` |
| **C** `__nodepodNavTiming`/location/WS shim injected into `fetch()` responses | SW only injects into document destinations (`document`/`iframe`/`frame`/`embed`/`object`). An app `fetch()` landing on the SPA fallback now sees the raw HTML. | `static/__sw__.js` |
| **D** `<a download>` returns host HTML | Chrome issues anchor downloads with service workers *skipped*, so no SW routing can ever catch them. The injected page script now intercepts download clicks (and programmatic `a.click()` on detached anchors) and streams the same-origin URL via `fetch → Blob → object URL`; falls back to the native download on error. Works in both `/__virtual__/` and hostname preview modes. | `static/__sw__.js` (`getLocationPatchScript`) |
| **E** `node -e` relative imports resolve from `/` | Eval scripts are marked (`/<eval-…>.js`) and run with `resolveDir = cwd` (`runFileTLA` got a `RunFileOptions.resolveDir`). Test: `eval-resolution.test.ts`. | `src/polyfills/child_process.ts`, `src/script-engine.ts` |
| **F** `patchFetchNodeAdapterExports` throws on null exports | Early return for null/undefined/primitive exports + test. | `src/polyfills/fetch-response.ts` |
| **G** stale/over-broad route claim captures the next runtime host | SW forgets an instance's path claims / preview clients on `release-instance` and `release-all` (tab reload). New boot option `reservedHostPaths: string[]` (exact, or prefix when ending in `/`) → SW message `reserve-host-paths`; reserved documents and requests they issue always go to the host. Embedders that patched routing locally can instead pass `reservedHostPaths: ['/runtime.html', '/src/', …]`. | `static/__sw__.js`, `src/request-proxy.ts`, `src/sdk/{nodepod,types}.ts` |
| shell quoting (found along the way) | `"…'x'…"` inside double quotes stripped the single quotes (bash keeps them). `node -e "console.log('a')"` now works. Double-quoted bodies share the here-doc expander. | `src/shell/bash-expansion.ts` |

Not touched: **H** (preview cold start vs. an embedder's fixed request deadline — embedder-owned), **I** (single unexplained autoprefixer miss; most likely the B holes), **J/K** (embedder-side, already fixed there). The reported Node version (`VERSIONS.NODE = v22.12.0`, `src/constants/config.ts`) is still below what React Router 8 wants (>22.22) — one-line change if wanted.

## Where we stopped

- Unit tests for the changed areas pass (`eval-resolution`, `installer-resilience`, `registry-fetch`, `fetch-node-adapter-patch`, `bash-shell`, `bash-differential`, `exit-semantics`, `installer-depth-order`). **The full `pnpm test` run was not completed yet** — run it.
- `pnpm run build:lib` passes; `dist/` on this branch is a fresh build.
- Browser verification lives in `tmp-probe/*.html` + `*.spec.ts` (run with `npx playwright test --config tmp-probe/playwright.config.ts`, adjust `testMatch`). Next step: promote these into `tests/browser/` as a proper regression spec and delete `tmp-probe/`.
- A Node/vitest-only artifact was found while writing tests: a TLA resolved from `setImmediate` or from a `MessagePort` that is closed/unref'd in its handler never lets `executeNodeBinary` return **under vitest** (pre-existing, also on `main`). All the same cases exit cleanly in Chrome (`tmp-probe/probe9.html`), so it was not chased further.
- `src/packages/registry-fetch.ts` constants (timeouts/attempts) are a first guess; tune if the relay is slow.
