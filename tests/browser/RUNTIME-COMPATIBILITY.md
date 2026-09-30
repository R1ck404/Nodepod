# Runtime compatibility fixes and validation

Date: 2026-09-30, Europe/Amsterdam. Branch: `perf/minimum-memory`.
Baseline: `9b18bef7a96c49377fc4179b6b2e74fd2d7fa235`.
Validation was completed in the local working tree before committing.

The preceding [memory validation](MEMORY-COMPATIBILITY.md) identified failures
that were also present in the original SDK. This report covers the subsequent
runtime fixes. None branches on a framework/package name to change its runtime
behavior. Framework names and version choices occur in test fixtures.

## Fixed causes

| Failure | Generic cause and change |
| --- | --- |
| Bundled fetch libraries crash during import | `buffer` did not expose the host Blob/File classes. Export them through named and default builtin exports. |
| Fetch/resource instrumentation crashes | Browser performance lacks `markResourceTiming`; supply the missing extension while preserving an existing native implementation and binding native prototype methods. |
| Worker pool startup/communication fails | Fork IPC used structured clone regardless of requested serialization. Implement default JSON semantics, preserve advanced transport, forward execArgv/conditions, and buffer early messages until a process listener exists. |
| Completed builds leave idle fork workers alive | Parent exit did not close child IPC. Propagate disconnect in both directions, release IPC liveness, and deliver a pending disconnect after a child finishes initializing. Keep a child's own pending work alive. |
| Compiler imports cannot resolve | Normalize valid `file:/` and `file:///` URLs through fileURLToPath, preserving encoded filename characters. |
| Router compilation produces a runtime 500 | Legacy url.parse's queryless object had null query and url.format returned stale href after callers mutated fields. Match the relevant native behavior; preserve repeated query values and prototype-named query keys. |
| Default-output API routes/builds fail in SWC | querystring.stringify omitted undefined options. Node emits the key with an empty value, which Next later serializes as a valid string injection. Preserve these fields and use Node's primitive conversion rules for scalars and arrays. |
| Newer HTTP tooling cannot validate request bytes | Add buffer.isUtf8/isAscii with direct byte validation, typed-array view boundaries, and native-style input/detachment handling. |
| Node-stream rendering hangs or produces empty HTML | Notify paused readers, complete EOF after buffered manual reads, honor pipe's end:false option, and serialize asynchronous transforms before awaiting flush and EOF. |
| webpack's persistent cache renames missing files | WriteStream emitted finish before opening/persisting its file. Write through the descriptor, persist before finish, flush corks and honor explicit close. |
| Dependency tracing crashes during capability probes | A missing synchronous command threw inside spawnSync instead of returning its failure result. Preserve execSync's throwing behavior through its normal result handling. |
| Bundled tracing module cannot enumerate builtins | Expose repl._builtinLibs using the runtime's existing builtin module list. |
| Headless tests could silently use an older worker bundle | Keep an explicitly configured workerPath when probing the default worker URL. |
| React state resets on the first edit after idle | The preview document reloaded on sw-needs-init while the existing bridge also recovered the service worker. Remove the competing navigation and let bridge/port recovery finish. |
| Generated application's ESLint crashes in axe-core | CommonJS top-level `this` was the browser worker/global, causing browser capability detection. Bind it to the initial exports object, matching native Node, including strict code and lexical arrows. |
| ESLint cannot dynamically import its formatter | `import()` rejected URL objects. Apply the ECMAScript string conversion once, and return a rejected promise for conversion failures, including Symbols. Keep require's string-only contract. |
| Successful CLI prints an empty failure after process.exit(0) | The runtime exit sentinel became a promise rejection. Guard native promise reactions and synchronous unwrap reactions so the sentinel terminates that chain without invoking application catch/finally callbacks. Ordinary errors keep their normal behavior. |

The installer also recognizes literal companion names with generic
wasm32-wasi, wasm-nodejs and wasm-web suffixes. A missing companion version is
still a registry/install failure; no framework-specific version guessing or
compiler source patch is introduced. New companion discovery invalidates older
package snapshot caches.

## Browser results

Real installs, real dev processes and real build commands ran in the published
browser SDK. Applications loaded their isolated preview-origin iframes. DOM
messages, HTTP results and build exit codes supplement T3 recordings whose
pixels were inspected. A listening port or successful HTML response alone was
not treated as proof of hydration or refresh.

| Version / mode | Visible dev | Build / production |
| --- | --- | --- |
| Next 13.5.11, React 18 | State-preserving refresh PASS; home/about/API | Automatic fixture PASS: build exit 0, production home/about/API 200 and hydrated counter |
| Next 14.2.35, React 18 | State-preserving refresh PASS; home/about/API | Build exit 0 after IPC fix; production home/about/API and JS assets 200, visible hydrated counter |
| Next 15.5.26, React 19, default output | State-preserving refresh PASS | Default build exit 0; next start renders/hydrates, production counter and home/about/API 200 |
| Next 15.5.26, React 19, standalone | State-preserving refresh and API PASS | Automatic fixture PASS after pending-IPC fix: build exit 0, server.js home/about/API 200, production counter click PASS |
| Next 16.2.10, React 19, webpack, default output | State-preserving refresh PASS | Default build exit 0; next start renders/hydrates, production counter and home/about/API 200 |
| Next 16.2.10, React 19, webpack, standalone | Refresh retains counter 1 without reload | Build exit 0; standalone server.js renders/hydrates, counter click and home/about/API PASS |
| Next 16.3.7, React 19, webpack, default output | State-preserving refresh and home/about/API PASS | Build exit 0; next start renders/hydrates, production counter and home/about/API PASS |
| Next 16.3.7, React 19, webpack, standalone | State-preserving refresh and home/about/API PASS | Build exit 0; server.js renders/hydrates, production counter and home/about/API PASS |

Next 16 is explicitly tested with webpack. Its tested Turbopack path requires
compiler functionality unavailable in the WASM binding. These changes do not
implement a native Turbopack host or silently switch application bundlers.

The standalone tests copy `.next/static` before starting server.js, following
the [Next.js standalone deployment procedure](https://nextjs.org/docs/app/api-reference/config/next-config-js/output).
Starting the server before copying caused expected asset 404s because its
initial filesystem scan did not include those files. Restarting after copying
restored production hydration.

Vite 8.3.1 React refresh retained counter 1 after edits, including an edit after
approximately 18 minutes idle. The measured final update took about 110 ms
(one observation, not a latency benchmark). There was no beforeunload event on
service-worker recovery. A regression test runs the real injected SW script
against a VM browser stub and verifies recovery without reload.

After the querystring, byte-validator and stream fixes, fresh runs also passed
Next 13/14/15/16 default output, Next 15 and 16.3.7 standalone output, all six
server frameworks, and React/Vue/Svelte/vanilla TypeScript builds. The final
Vite 8.0.10 React check applied a source edit in 292 ms and retained counter 3;
this is one observation, not a performance benchmark. Client render messages
reported no errors in the four-template run. After the final module-loader
changes, a fresh 21-template scaffold/install/dev/build matrix passed all cases;
all 21 preview render messages arrived and client-error reports were empty.

Fresh checks after the main compatibility/FS fixes built and visibly rendered
React TS, Vue TS, Svelte TS and vanilla TS starter applications; client-error
reports were empty. Node HTTP, Express 5, Fastify 5, Koa 3, Hono 4 and Connect 3
visibly rendered working counter buttons and API OK. All six API probes returned
200 when supplied a Host header. The earlier Hono SDK-only 400 was a test request
without Host; the actual browser request was successful throughout.

The earlier Vite 5–8 version matrix is preserved in MEMORY-COMPATIBILITY.md.
The latest 21 cases cover JavaScript/TypeScript vanilla, Vue, React, React
Compiler, Preact, Lit, Svelte, Solid and Qwik, plus three SvelteKit scaffold
paths. These fixtures do not cover every feature, third-party plugin or app.

## Actual create-next-app flow and CLI checks

`create-next-app-flow.html` starts from an empty virtual workspace and runs:

```sh
npx create-next-app@latest app --yes --use-npm --webpack --disable-git
npm run
npm run lint
npx tsc --noEmit
npm run dev -- --webpack
npm run lint
npm run build -- --webpack
npm run start
```

The registry resolved create-next-app and Next to 16.3.7. The generated App
Router/TypeScript/Tailwind 4/ESLint template, next.config.ts, Google Geist fonts
and public logos were retained. The original styled page rendered; then the
fixture added a client counter and API route. A real click hydrated the counter,
a source edit retained count 1 without frame reload, and dev home/API returned
200. The production build exited 0; next start visibly rendered the styled page,
a fresh production click worked, and home/API returned 200 with correct bodies.
Client error reports were empty. The newly added dev route is awaited until its
watcher discovers it, rather than treating its initial 404 as a runtime failure.

The generated scripts still use plain `next dev` and `next build`, despite the
scaffolder's webpack option, so the commands explicitly forward `--webpack`.
This proves the webpack flow, not default Turbopack compatibility. Git
initialization is explicitly disabled. A second scaffold without `--yes` also
exited 0; this create-next-app version deliberately selects defaults when any
long option is supplied, so that invocation does not exercise its wizard.
The earlier scaffolds printed a nonfatal route-type-generation warning after
successful generation. The generic promise exit fix below resolves this; the
latest full flow asserts `typegenCleanExit` and passes without that warning.

`cli-compatibility.html` passed 12 checks: shell pipeline and file operations;
npm/pnpm/yarn scripts; npm pkg get; npx/npm exec/pnpm exec argument forwarding;
Prettier write/check with verified file contents; and npm pack with a real
tarball. The fresh runtime-reliability run passed 16 expected outcomes, including
fetch/body promise chains, relative imports, top-level await, fatal versus
handled errors, SQLite cold loads, and three intentional timeouts whose killed
processes settled in 1–2 ms. Fresh Node HTTP, Express 5, Fastify 5, Koa 3, Hono 4
and Connect 3 checks returned correct API bodies and rendered clicked counters.
The final rebuilt Vite React runtime also applied a real source edit and kept
counter 3 through Fast Refresh (781 ms in that observation, not a benchmark).

## Explicit exit across promise boundaries

Next's typegen command calls process.exit(0) inside a success reaction, followed
by a catch handler that reports failures. Nodepod unwinds execution with a
branded ProcessExitSentinel; previously the host promise machinery converted
that unwind into an application rejection. Next then printed an error header,
while the runtime suppressed the internal sentinel's own log entry.

The fix guards intrinsic promise reactions (including promises from native async
functions) and the engine's synchronous top-level-await unwrap path. An exit
stops that chain through an unrooted pending promise; process completion still
uses the runner's existing exit signal. Pending promises are not shared across
exited commands, avoiding retention of their adoption callbacks in persistent
shell workers. Installation happens once when an engine is constructed;
importing the SDK leaves the surrounding application's promises unchanged.
This changes runtime control flow, without filtering framework log messages or
patching any package.

Eleven regression cases compare stdout, stderr and status directly with native
Node: successful/nonzero exits, native async bodies and reactions, executors,
rejection callbacks, async context, synchronous TLA, genuine errors, similarly
worded user errors, and normal finally/combinator behavior. An additional test
checks import isolation and one-time installation. The final full suite passed
1,618 tests with five skips; type-check and publish build passed.

Fresh browser verification repeated all 21 Vite/SvelteKit dev/build cases,
all 12 CLI checks and 16 expected runtime outcomes. The actual Next scaffold,
lint, TypeScript, dev, state-preserving refresh, webpack production build and
hydrated production page passed with a clean typegen exit. A separate real Next
typegen run against a deliberately throwing next.config.js returned exit 1 and
printed EXPECTED_CONFIG_FAILURE, confirming genuine failures still surface.
A fresh terminal readline answer followed by promise-based exit returned to
the shell. The collaborative browser disconnected during the final error probe;
the final full Next flow and failure probe were completed in headless Chromium,
and the production screenshot's pixels were inspected.

Raw results are in `memory/promise-exit-browser-results.json` and
`memory/promise-exit-final-tests.log`; earlier CLI/matrix proof is preserved in
`memory/promise-exit-regression-results.json`.

## Interactive terminal checks

Fresh checks in `terminal.html` used its real xterm terminal and actual browser
keyboard events for prompt answers. Both stdin and stdout reported isTTY true
and stdout reported the attached terminal's 124 columns / 37 rows.

- Readline question: typed `boz`, Backspace, `b`, Enter; received `ANSWER:bob`
  and returned to the shell prompt.
- Interactive `npm create vite@latest keyboard-vite`: ArrowDown selected React,
  Enter selected TypeScript and Oxlint, then confirmed installation and startup.
  The generated package matched the choices; npm installed 33 packages and the
  Vite 8.3.1 dev server became ready. `h` + Enter displayed its help menu, and
  Ctrl+C stopped it and returned the shell prompt.
- Raw-mode input remained alive while waiting; ArrowDown arrived as the exact
  escape sequence and `x` arrived as a single character without Enter, then exited.
- `npx create-next-app@latest` with no long options displayed its actual wizard.
  Typed project name, arrow-key selection of customized settings, TypeScript
  toggle and Biome selection all worked. Ctrl+C at the React Compiler question
  canceled and restored the shell; a subsequent echo ran successfully. The
  wizard was canceled before project creation to prevent default git initialization.

These checks cover readline, the real clack-based Vite menus and the real
prompts-based Next wizard. They do not establish compatibility with every TUI.
The visually inspected terminal menu and raw input/output results are preserved
locally in `memory/interactive-terminal-validation.json` (ignored evidence).

## Default-output failure: corrected diagnosis and generic fix

The earlier report attributed this failure to the compiler alone. The raw-input
probe did reproduce `invalid type: unit value, expected a string` outside
Nodepod, but it omitted an important step in the real application: Next passes
its loader options through querystring.stringify/parse first.

Native Node writes `{nextConfigOutput: undefined}` as `nextConfigOutput=`.
Parsing yields the empty string; JSON.stringify then yields the string `"\"\""`,
which SWC can inject. Nodepod incorrectly omitted the key, so the loader received
undefined and passed an invalid undefined injection to SWC.

The fix changes only the querystring builtin: retain own keys with unsupported
values as empty strings, handle non-finite numbers the same way, and serialize
finite numbers, strings, booleans and bigints (including array elements) using
Node's rules. Tests compare directly against native Node and cover the loader
round trip. No package-name branch, compiler patch or blanket WASM conversion
is involved.

[native-swc-template-probe.mjs](native-swc-template-probe.mjs) now compares the
invalid raw input with the real native querystring round trip. The latter and
standalone input both expand a template successfully. Supply the absolute
installed wasm.js path, plus wasm_bg.wasm for the web package.

## Newer Node-stream rendering

Testing Next 16.3.7 exposed additional missing builtin behavior. Its Node-stream
render path buffered HTML but stalled while reading a paused stream: draining
its final buffered chunk did not complete EOF, and asynchronously arriving data
never emitted readable. Multi-source piping also ignored end:false and ended
the destination after the first source. Transform.end could terminate before
asynchronous transform/flush callbacks, losing the entire HTML body.

Package-independent tests execute identical consumers against native Node and
Nodepod. All four cases passed in Node and failed in Nodepod before the fixes;
both now pass. The fix retains the framework's normal stream path and compiler,
with no package patch or environment override. A fresh default and standalone
run rendered, hydrated, refreshed with preserved state, built and served routes.
The default production responses contained 4,312 bytes for home, 4,374 for about
and the expected JSON body for the API, rather than the earlier empty HTML.

## Reproduction and checks

Run `pnpm run build:publish`, then `node examples/serve.js`. Open:

- `/tests/browser/next-compatibility.html?version=14.2.35`
- `/tests/browser/next-compatibility.html?version=15.5.26`
- `/tests/browser/next-compatibility.html?version=16.2.10`
- `/tests/browser/next-compatibility.html?version=16.3.7`
- `/tests/browser/next-compatibility.html?version=15.5.26&output=standalone`
- `/tests/browser/next-compatibility.html?version=16.2.10&output=standalone`
- `/tests/browser/next-compatibility.html?version=16.3.7&output=standalone`
- `/tests/browser/create-next-app-flow.html`
- `/tests/browser/cli-compatibility.html`

The fixture checks real dev clicks, source edits without state loss, actual
build exit, standalone asset preparation, production clicks and HTTP route bodies.
Its `window.__nextCompatibility` object exposes stage-tagged proof and results.
Stage tags prevent the old stopped dev page from masquerading as a freshly
rendered production page while the new server is still starting.

- Full Vitest suite, type-check and publish build passed. The final suite
  had 156 files pass and one skip; 1,633 tests passed and five skipped.
- The real headless integration covers IPC JSON/advanced transport, condition
  exports, compiled WASM worker transfer, and parent-exit disconnect followed
  by a child's surviving timer callback.
- Manager tests cover explicit bidirectional disconnect and a child becoming
  ready only after its owner exits. Filesystem tests cover finish/rename order,
  buffer mutation, append/start, nested corks, explicit close and logical EOF.
- Five tests are formally skipped; the Vite SSR glob check also skips its
  internal check on this machine because of the esbuild platform mismatch.

## Local visual evidence

Screenshot and recording paths are retained in the ignored local result files
under `memory/`, including `promise-exit-browser-results.json` and
`final-cli-browser-validation.json`. These machine-specific artifacts are not
portable repository links. The fixtures above provide reproducible checks.

Performance measurements and further architecture experiments are in
[RUNTIME-THROUGHPUT.md](../performance/RUNTIME-THROUGHPUT.md).

## Corrections after the regression audit

All seven reproduced failures now have package-independent regression coverage:

- WASM cache identity hashes every byte with SHA-256. A changed instruction in
  a formerly unsampled region cannot reuse stale compiled code. Cached module
  constructors return distinct cloned objects, or compile when cloning is unavailable.
- Explicit exit unwinds runtime async-context scopes separately from application
  promise reactions. Nested scopes restore in reverse order, scoped to their
  owning process; stale captured frames cannot reactivate an exited scope.
- Exit detection inspects an own data-property brand and handles hostile proxy
  traps. Ordinary rejection reasons survive unchanged, including revoked proxies
  and objects with throwing accessors.
- Destroying a Transform releases queued payloads immediately, preserves active
  callback ordering, and settles queued write/end callbacks with the appropriate
  destruction errors.
- Append descriptors ignore explicit positions, including WriteStream start,
  string flags and numeric O_APPEND flags.
- WriteStream callbacks run asynchronously outside the I/O error handler. A user
  callback that throws is invoked once.
- Legacy URL parse/format preserves opaque schemes instead of inserting //.

Shared bound promise handlers also reduce queued reaction allocation; the
measurement and its limits are documented in the throughput report.

The final regular browser suite passes all 32 tests, including the new
create-next-app fixture, every create-vite template, interactive CLI menus,
raw-mode input, readline, Ctrl+C and SvelteKit startup/shutdown. All four
performance browser tests pass and the benchmark runner completes with exit 0.
Some pre-existing benchmark fixtures still produce NaN statistics; those rows
are not used as performance evidence.
The standalone CLI compatibility fixture passes all 12 checks.

The create-next-app fixture is now included in the regular browser test suite.
It verifies scaffold/install, clean type generation, lint, TypeScript, dev
routes, state-preserving refresh, build, production routes and a hydrated click.
Its production screenshot was inspected and showed the edited heading and
counter. Test output includes the screenshot and raw JSON results.

The documentation build now bundles server dependencies consistently with the
build graph. The full documentation check passes with zero diagnostics, 515
pages, no broken internal links and 2,752 verified API source links. Website
tests pass on desktop and mobile: 16 passed, two existing mobile skips for
terminal cases already covered on desktop. No dependency versions or lockfiles
were changed.
