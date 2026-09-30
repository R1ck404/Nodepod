# Memory experiments

Branch: `perf/minimum-memory`. Baseline: `9b18bef`.
The production changes use file/inode identity, binary content and WASM import
metadata; they contain no package-name rules.

## Results

Windows, Node 24.16.0, Ryzen 7 7800X3D. Resource results are medians of five
sequential runs in fresh processes, with GC requested before retained-memory
samples. MiB means 1,048,576 bytes. These are deliberately controlled stress
cases, not a claim about every application.

| Measurement | Baseline | Experiment |
| --- | ---: | ---: |
| Hardlink snapshot payload, per representation | 32 MiB | 4 MiB |
| Snapshot stress case: retained ArrayBuffers | 100.0 MiB | 16.0 MiB |
| Snapshot stress case: process RSS | 148.0 MiB | 63.9 MiB |
| Snapshot creation, three representations | 18.13 ms | 3.05 ms |
| Default packing: backing-buffer count | 16,002 | 22 |
| Default packing: retained JS heap | 14.68 MiB | 12.64 MiB |
| Default packing: content backing bytes | 12.65 MiB | 12.65 MiB |
| Default packing: process RSS | 96.67 MiB | 93.73 MiB |
| Concurrent WASM compilation count | 3 | 1 |
| WASM stress case: retained ArrayBuffers | 32.0 MiB | 8.0 MiB |
| WASM stress case: process RSS | 105.04 MiB | 65.16 MiB |
| Cached module's imported memory capacity | 1 GiB | 2 MiB |

The snapshot corpus contains eight unique 512 KiB files with seven hardlink
aliases each. The harness retains full, chunked and persistent snapshots at
once. It checks that writing a restored alias updates the original file.
Ordinary trees without hardlinks will not get the same payload reduction;
direct chunk construction still eliminates the temporary full snapshot.

The packing corpus contains 16,000 small files, 24 MiB of repetitive cold text,
and a 10.1 MiB release WASM binary. Keeping small files in shared slabs removes
thousands of buffer allocations without changing their payload. Median default
packing time was 154.09 vs 155.46 ms; 80,000 small-file reads took 49.01 vs
45.92 ms. These small timing differences do not establish a universal speed
guarantee.

The WASM corpus uses an imported shared memory with a 32-page minimum, a
1 GiB loader request, and an 8 MiB binary custom section. Cached import metadata
now survives compilation outside the intercepting realm. The 1 GiB to 2 MiB
figure is **logical capacity**, not 1 GiB of physically resident RAM reclaimed.
Compilation took 44.05 vs 24.74 ms. Real modules have different requirements.

## Optional additional compression

`memory.packWasmContent: true` includes dormant WASM source binaries in existing
package compression. Its default is **false**. In the packing corpus:

| Measurement | Default | WASM packing enabled |
| --- | ---: | ---: |
| Retained content backing bytes | 12.65 MiB | 6.28 MiB |
| Packing round | 155.46 ms | 436.56 ms |
| Cold WASM read | approximately 0 ms | 57.50 ms |

This option buys memory with decompression work. It does not compress a live
WASM heap or compiled machine code. Incompressible data is kept resident when
its compressed representation would be larger.

A browser smoke run using a 60-component React application, Vite 8.2.0 and
plugin-react 6.0.1 rendered correctly and received five edited markers. This
checked update delivery. Later state-preservation checks found full reloads
and a counter reset in the original Vite 8.0.10 fixture and the current
Vite 8.3.1 run; see [compatibility results](../browser/MEMORY-COMPATIBILITY.md).
After two
explicit packing rounds with WASM packing enabled, main-volume content went
from 42.40 MiB to 0.64 MiB resident plus 10.11 MiB compressed. A subsequent
production build exited successfully. This is main-volume content accounting,
not total browser RAM: the available page heap counter excludes worker heaps,
and `measureUserAgentSpecificMemory()` was blocked in the preview environment.

## Native Node comparison

### Compiled WASM sent to a worker

Five fresh-process samples per build ran the **same application source and
WASM binary** in native Node and Nodepod, rotating measurement order. The
application compiles a module, sends it through `workerData`, and allocates a
growable shared heap in that worker. The loader requests 512 MiB; the module
declares a 2 MiB minimum. The worker clears its available heap, writes its
2 MiB working range, and executes a WASM export that reads the range's first
and last bytes. Every run returns checksum 14.

| Entire running workload | Private committed memory | Resident working set | Application startup |
| --- | ---: | ---: | ---: |
| Native Node process including its nested worker | 550.78 MiB | 578.11 MiB | 164.51 ms |
| Original Nodepod host including both workers | 646.63 MiB | 628.21 MiB | 287.42 ms |
| Experiment Nodepod host including both workers | 136.00 MiB | 118.38 MiB | 184.34 ms |

The experiment uses **79.5% less resident memory and 75.3% less private
committed memory than native Node** in this case. These Nodepod numbers include
the booted SDK host; the native measurement excludes its benchmark controller.
Startup timing begins after SDK boot for Nodepod and before child spawn for
native Node, so it is not an equal end-to-end cold-start measurement. Even on
that basis Nodepod is 12.1% slower than native startup, although 35.9% faster
than its original build. This is a memory win, not a zero-slowdown guarantee.

Previously, structured clone transported compiled code but dropped the
WeakMap holding its imported-memory requirements. The receiver could not
recover the minimum from a compiled module, so the existing memory clamp
restored the full loader allocation. Internal process messages now carry
small import annotations with compiled modules, preserving object identity
through clone and re-registering metadata before application delivery. This
works for nested maps/sets and return messages without copying WASM source
binaries or specializing for any package.

**This is a synthetic oversized-heap initialization workload.** Clearing the
whole available heap makes the capacity difference physically resident. The
memory's observable capacity changes from 512 MiB to 2 MiB, so this is not
transparent compaction of an arbitrary live heap. Applications whose runtime
assumes more than the declared import minimum may be incompatible with the
clamp. It does not demonstrate that Vite with its native binding, every WASM
application, or idle processes use less memory under Nodepod.

### Idle processes (negative control)

Three fresh-process samples measured five idle processes, using Windows private
committed bytes to avoid adding shared executable pages repeatedly:

| Five idle processes | Median private memory |
| --- | ---: |
| Native Node child processes, aggregate | 92.25 MiB |
| Baseline Nodepod workers, additional to booted host | 154.82 MiB |
| Experiment Nodepod workers, additional to booted host | 154.21 MiB |

Nodepod still exceeds native Node in this case, even excluding its booted host.
Reducing isolate and runtime initialization overhead remains necessary to beat
that baseline. These optimizations do not establish that Nodepod uses less RAM
than native Node generally.

## Implementation and verification

- Deduplicate hardlink payloads in full, chunked and persistent snapshots.
- Build transfer chunks directly rather than copying a full snapshot first.
- Keep dense resident slabs; compact sparse slabs into bounded shared buffers.
- Share in-flight WASM compilation, hash before transferring one owned copy,
  and use synchronous results when they arrive during background work.
- Remove asynchronous compilation warm-ups from immediate synchronous reads
  and writes; cache the synchronous constructor's completed module instead.
- Preserve imported-memory names and limits across cache/worker boundaries,
  handling multiple imports of the same memory with their largest minimum.
- Carry known import metadata through worker structured-clone messages in
  both directions; skip binary data and avoid invoking application getters.
- Bound completed module-cache entries as well as estimated source bytes;
  retain pending work until it settles. Clean up failed worker submissions.
- Use SHA-256 correctly for views backed by shared memory.

Validation: 1,566 tests passed, five skipped; type checking and production build
passed. Regression tests cover transferred compression input, hardlinks,
shared-memory hashing, cache races, failed worker posts, multiple memories and
compiled-module transport in both directions.

The existing shared-memory clamp remains a heuristic for growable oversized
loader heaps. A module's declared import minimum proves link requirements,
not every application's allocation assumptions. Unknown metadata falls back
to the requested size. This branch is experimental; passing these cases does
not prove compatibility with every possible WASM program. Arbitrary live heaps
cannot safely be compacted by treating their bytes as relocatable objects.

## Reproduce

Run the source harness with any representative local WASM binary:

```powershell
pnpm exec esbuild tests/performance/memory-resources.ts --bundle --platform=node --format=esm --outfile=memory/current-memory-resources.mjs
node --expose-gc memory/current-memory-resources.mjs snapshots
node --expose-gc memory/current-memory-resources.mjs packing-default memory/engine.wasm
node --expose-gc memory/current-memory-resources.mjs packing memory/engine.wasm
node --expose-gc memory/current-memory-resources.mjs wasm
pnpm run build:publish
node --expose-gc tests/performance/idle-process-memory.mjs native 5
node --expose-gc tests/performance/idle-process-memory.mjs dist/headless.mjs 5
node --expose-gc tests/performance/idle-process-memory.mjs native 1 wasm-worker
node --expose-gc tests/performance/idle-process-memory.mjs memory/baseline-dist/headless.mjs 1 wasm-worker
node --expose-gc tests/performance/idle-process-memory.mjs dist/headless.mjs 1 wasm-worker
```

The baseline source was extracted with `git archive` from `9b18bef` into
`memory/baseline-src`. An identical copy of the harness imported that source
instead of `../../src`. The original published build was saved separately to
`memory/baseline-dist`; the idle harness explicitly selects its matching
worker bundle. Local raw samples are in `memory/repeated-resource-results.jsonl`
and `memory/repeated-idle-results.jsonl`. The newer worker comparison is saved
in `memory/repeated-wasm-worker-results.jsonl`. `memory/` is ignored by Git.
