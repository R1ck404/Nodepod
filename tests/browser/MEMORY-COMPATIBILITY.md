# Memory branch compatibility validation (before the compatibility fixes)

This is the historical validation that found the Next.js and HMR failures.
See [RUNTIME-COMPATIBILITY.md](RUNTIME-COMPATIBILITY.md) for the fixes and
subsequent validation. The results below intentionally preserve the earlier
failures; they do not describe the final branch's compatibility status.

Date: 2026-09-30 (Europe/Amsterdam). Local branch: `perf/minimum-memory`.
Original baseline: `9b18bef7a96c49377fc4179b6b2e74fd2d7fa235`.
This validation ran before staging or committing and added reports and local diagnostic
harnesses; it did not change production code.

**No all-clear:** the tested Vite/template/server matrix renders and builds,
but several Next.js paths fail and React HMR loses state. The corresponding
older fixtures fail on the original SDK too. No new memory-change regression
was identified in this matrix; that does not prove universal compatibility.

## Method and automated checks

The current published browser SDK and embedded process-worker bundle ran real
npm installs, dev servers, builds and clean preview-origin iframes. T3 browser
recordings were captured and their pixels inspected locally, in addition to
application DOM messages and HTTP/build diagnostics. A listening port or HTTP
200 alone was not accepted as visual application success. Lit's shadow-DOM
content was confirmed in the rendered pixels.

- Full Vitest suite rerun: 152 files passed, one file skipped; 1,566 tests passed,
  five tests skipped.
- `pnpm run type-check` rerun: PASS.
- `pnpm run build:publish`: PASS from the preceding optimization validation;
  production sources were unchanged during this browser matrix.
- Browser `tests/browser/runtime-reliability.html`: all 16 expected outcomes
  checked, including intentional error exits, cancellation, fetch/body chains,
  relative imports, shell quoting and cold SQLite loads.
- Import-meta/glob diagnostic: zero unexpected failures. Raw untransformed
  `import.meta.glob` is an expected negative case.
- Issue 84 Vite 6.4.3 CLI and programmatic builds: both exit zero and emit files.
- Inline optional generic TypeScript route: HTTP 200 with updated cell value.
  Broader TypeScript stripping matrix: PASS.

Several older example pages probe clean preview origins using parent-page
fetches that are blocked by CORS. The diagnostic harness routed only those
parent probes through the existing same-origin virtual HTTP route. Actual
application iframes still loaded their clean preview origins. Hono's SDK API
probe supplied a valid Host header; its browser API request also passed.

## Template build and visual dev-server matrix

All 21 cases passed their actual build command and visibly rendered their dev
application. These are current scaffolds, predominantly Vite 8.3.1, including
TypeScript build commands where the scaffold defines them. Dependency ranges
and detailed outcomes are saved in the local raw result JSON.

| Template | Build | Visible dev application |
| --- | --- | --- |
| lit | PASS | PASS |
| lit-ts | PASS | PASS |
| preact | PASS | PASS |
| preact-ts | PASS | PASS |
| qwik | PASS | PASS |
| qwik-ts | PASS | PASS |
| react | PASS | PASS |
| react-compiler | PASS | PASS |
| react-compiler-ts | PASS | PASS |
| react-ts | PASS | PASS |
| solid | PASS | PASS |
| solid-ts | PASS | PASS |
| svelte | PASS | PASS |
| svelte-ts | PASS | PASS |
| sveltekit-demo | PASS | PASS |
| sveltekit-minimal | PASS | PASS |
| sveltekit-minimal-direct | PASS | PASS |
| vanilla | PASS | PASS |
| vanilla-ts | PASS | PASS |
| vue | PASS | PASS |
| vue-ts | PASS | PASS |

Recordings: [Vanilla / React](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-fdea4963-32f1-4f0e-8f96-55291a5a0749-mp4.mp4>),
[Vue / Preact](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-2e28bef1-afe8-402a-b531-99052b405a7c-mp4.mp4>),
[Lit / Svelte](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-de448cc5-1632-4dd9-908e-5dd04c3bce38-mp4.mp4>),
[Solid / Qwik](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-d1fdb835-2a66-4df6-aff8-afbac32387e2-mp4.mp4>),
[React Compiler / SvelteKit](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-31ecab6c-07f6-4f08-a416-beeff91b722f-mp4.mp4>),
[SvelteKit direct minimal](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-fb290de3-9fe7-47ad-90eb-d588f4b48372-mp4.mp4>).

This checks starter applications, not every feature of each framework. It does
not claim that every generated production artifact was visually previewed.

## Versions, packing and representative production previews

The React workload contains 30 rendered components. Each of the following
completed cold load, warm reload, five edited-marker deliveries, explicit
content packing with `memory.packWasmContent: true`, another cold iframe load
and a successful production build:

| Vite | React plugin | Outcome |
| --- | --- | --- |
| 5.4.21 | 4.7.0 | PASS |
| 6.4.1 | 4.7.0 | PASS |
| 7.3.1 | 5.0.4 | PASS |
| 8.3.1 | 6.1.1 | PASS |

Production `vite preview` on port 4173 also visibly rendered all 30 components
with the final edited marker for Vite 6 and 8, after packing and building.
Evidence: [Vite 6 production preview](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-79aa081d-1cae-4fa9-9edf-f47bc0b044d8-mp4.mp4>),
[Vite 8 production preview](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-644eac0f-e3f7-4121-9bab-39986aa41602-mp4.mp4>).
Edited-marker delivery is **not** a state-preserving HMR pass.

## Other visible applications and servers

| Case | Actual visible outcome |
| --- | --- |
| Node HTTP | Server heading, clicked counter = 1, API OK |
| Express 5 | Server heading, clicked counter = 1, API OK |
| Fastify 5 | Server heading, clicked counter = 1, API OK |
| Koa 3 | Server heading, clicked counter = 1, API OK |
| Hono 4 / Node adapter 1 | Server heading, clicked counter = 1, API OK |
| Connect 3 | Server heading, clicked counter = 1, API OK |
| Expo SDK 54 / Metro web | Styled app and expected Expo heading |
| Tailwind 3 / Vite 8 | Styled React page, gradient background and button |
| Tailwind 4 / Vite 8 | Styled React page, dark background and cyan heading |
| React Router basename regression | Correct home route visibly rendered |

Evidence: [Six server applications](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-ae2ef1de-d613-468b-a020-1e969cbe0c1f-mp4.mp4>),
[Expo web](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-207d454d-4c66-4cde-8a5e-4627a6ef7989-mp4.mp4>),
[Tailwind 3](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-77b43edf-7356-401f-9d79-f27334bfb334-mp4.mp4>),
[Tailwind 4](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-24155b8e-9596-4352-9d78-40e08da01190-mp4.mp4>),
[React Router home](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-16bebd39-9a5e-408c-b9f0-1bf113be2708-mp4.mp4>).

Auth + SQLite at Vite config load, React-only control, and SQLite-only config
load all reached ready in the Vite 5.4.21 startup diagnostic. This is a startup
check, not an authentication workflow or visual auth pass. Better Auth emitted
missing-schema and demo-secret warnings. Router navigation beyond the initial
home route was not exercised.

## Compatibility failures and baseline comparisons

| Case | Current branch | Original SDK |
| --- | --- | --- |
| Next 13.5.11 dev | Fails before rendering: undefined class base in bundled Undici | Same failure |
| Next 14.x dev | Fails before rendering: undefined class base in edge-runtime primitives | Same failure |
| Next 15.5.26 dev | Ready message followed by null/undefined render failure | Same failure |
| Next 16.2.10 webpack basic page | Visibly renders styled heading; edited heading delivered; client counter clicked to 1 | Basic page was not separately pixel-certified on baseline |
| Next 16.2.10 webpack API route | HTTP 500: SWC invalid unit value, expected string | Same API failure |
| Next 16.2.10 webpack production build | Exit 1: function cannot be structured-cloned by worker postMessage | Same build failure |
| Next 16.2.10 default Turbopack | Cannot render: native binding unavailable and WASM binding unsupported | Same failure |
| React state preservation, Vite 8.0.10 fixture | Counter 1 resets to 0 after heading edit; full reload | Same reset/full reload |
| React state preservation, Vite 8.3.1 / plugin 6.1.1 | Counter 1 resets to 0 after heading edit; full reload | Latest version not separately tested on baseline |

For the HMR test, an application message listener triggers an actual DOM button
click, exercising React's onClick handler. After count 1 is observed, the
heading is edited in the virtual filesystem. A new main-loaded event and
app-mounted event accompany count 0. Receiving a beforeUpdate event is therefore
insufficient to claim Fast Refresh works.

Evidence: [Next 16 basic page / heading update](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-8fc535e4-4746-4a39-8881-30a95571e420-mp4.mp4>),
[Vite 8.0.10 reload diagnosis](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-0908edb2-2b29-4964-99fe-52bf54ae319b-mp4.mp4>),
[Vite 8.3.1 reload diagnosis](<C:/Users/rickh/.t3/userdata/attachments/41b62cf5-09cb-48da-b531-a4fd5496fd75-938293c6-a9d0-4875-976d-87ff608c4152-mp4.mp4>).
The basic Next page pass does not cover its failing API/build/Turbopack paths.

## Local artifacts and reproduction

Local detailed results: `memory/compatibility-results-final.json` (ignored).
Baseline bundle: `memory/baseline-dist`, with its matching original embedded
worker. The current and baseline comparisons select both SDK and worker from
the requested bundle; they do not mix versions.

Start `node examples/serve.js` and open these local pages on port 3333:

- `memory/visual-vite-matrix.html?only=vanilla,vanilla-ts,react,react-ts&concurrency=2&build=1`;
  repeat with the other template groups listed above.
- `memory/lab.html?components=30&vite=8.3.1&pluginReact=6.1.1&mem=1&keep=1&pack=1`.
- `memory/visual-servers.html?pack=1`.
- `memory/next-visual.html?version=13`, `?version=14`, `?version=15`,
  default webpack 16, or `?turbo=1`; append
  `&dist=/memory/baseline-dist` for the original SDK.
- `memory/visual-hmr.html`, `?latest=1`, or
  `?dist=/memory/baseline-dist`.
- Existing examples: `expo-web-smoke`, `tailwind-v3-test`,
  `issue-54-tailwind-v4`, `issue-44-react-router-basename`,
  `import-meta-glob-test`, `ts-inline-generic-optional`,
  `issue-84-vite-build`, and `vite-dev-exit-1`.

The prepared diagnostic pages and recordings are local session artifacts;
`memory/` is ignored by Git. Recordings are linked from the local T3 attachment
directory. This finite matrix cannot certify every package, framework feature
or arbitrary WASM allocation assumption. In particular, the import-minimum
memory clamp changes observable capacity; its remaining limits are described
in [memory experiments](../performance/MEMORY-EXPERIMENTS.md).
