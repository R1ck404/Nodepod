# Runtime throughput experiments

Date: 2026-09-30. Branch: `perf/minimum-memory`.

The filesystem bridge previously allocated and copied the entire file for
every extending descriptor write. Writing n equal chunks copied O(n²) bytes.
The new bridge keeps a logical-length view over a geometrically growing,
owned buffer. Extending within capacity changes the view, zeroes newly exposed
bytes and copies only the incoming data. It keeps logical EOF, sparse gaps,
truncation and borrowed-buffer isolation intact. Closing persists only the
logical file bytes, rather than unused capacity.

WriteStream now writes into that descriptor buffer instead of retaining all
chunks for a second merge. It waits for open, flushes nested corks on end,
persists data before finish, and closes descriptors on explicit close even
when automatic close is disabled. This also fixes the cache-file rename race
encountered in webpack production builds.

## Reproducible measurement

Run `node tests/performance/run-incremental-fs.mjs` from the checkout. An
optional argument selects the baseline Git revision. The runner reads the
old fs.ts through an esbuild hook, keeps all other dependencies at their
current versions, bundles each case and runs it in a fresh Node process.
It writes raw results into a temporary directory printed in its output.
Neither Git's index nor source files are changed by the runner.

Workload: an 8 MiB file written with 2,048 4 KiB writes, repeated five times.
Every iteration verifies exact output length and checksum (310,378,496).
The time includes descriptor writes and close; checksumming is untimed.
External-memory samples are taken every 128 writes, with GC requested between
rounds. These are sampled process-wide external allocations, not maximum RSS
or an isolated measurement of the descriptor buffer.

| Measure | Previous fs bridge | Current fs bridge |
| --- | ---: | ---: |
| Median elapsed, latest repeat | 995.68 ms | 3.11 ms |
| Median sampled external bytes | 113,947,396 | 26,896,397 |

The latest repeat on Node v24.16.0 shows **320× faster** execution and **76.4%
less sampled external allocation** for this workload. A preceding repeat was
355× faster. These ratios describe this formerly quadratic path, not total
application speed, native filesystem performance or a universal memory win.

## Promise reaction allocation after the audit

The exit guard previously created a closure environment per fulfillment
reaction. It now binds the callback to one shared handler, while preserving
the callback receiver and guarding both fulfillment and rejection paths.
Removing the fulfillment guard failed explicit-exit tests, so it is retained.

A matched Node v24.16.0 probe queued 100,000 increment reactions, requested GC
before and after queuing, drained the chain and checked the result was 100,000.
The table shows median queued heap growth over three measured rounds after
warm-up. Native promises, the previous closure guard and the shared handler
used the same chain and callback.

| Reaction implementation | Median queued heap growth |
| --- | ---: |
| Native promises | 14.50 MiB |
| Previous closure guard | 23.65 MiB |
| Shared bound handler | 19.08 MiB |

This reduces total queued heap growth by 19.4% and halves the guard's additional
allocation above native promises in this probe. Drain timing was also lower,
but these short timings do not establish a general application speedup. The
guard still costs memory compared with native promises.

WASM cache lookup now hashes every input byte with SHA-256 because sampled
identity allowed stale executable code. This adds validation work for large
binaries; correctness takes priority over the unsafe sampled shortcut.

## Other improvements retained on this branch

- Deduplicate in-flight WASM compilation and bound the compiled-module cache
  by entries and estimated source bytes. Estimates do not measure engine code
  memory exactly.
- Carry imported-memory requirements with compiled WASM modules across internal
  worker messages, including workerData, without walking binary payload bytes
  or calling arbitrary property getters.
- Avoid duplicate asynchronous WASM warming after immediate synchronous
  filesystem operations, and avoid redundant owned source copies.
- Deduplicate hard-linked payloads in process/snapshot serialization, and copy
  directly into the final snapshot buffer.
- Pack small immutable source files into slabs and compress sparse backing
  content only when compression saves bytes. WASM-content packing stays opt-in
  because it increases startup/decompression work on some workloads.
- Close fork IPC when its parent exits so idle worker pools release their
  workers instead of retaining their runtime and filesystem indefinitely.

The existing shared-WASM memory clamp changes observable post-link memory
capacity. Its enlarged scope is an experiment, not a guarantee of transparent
Node semantics. See [MEMORY-EXPERIMENTS.md](MEMORY-EXPERIMENTS.md) for the native
comparison and tradeoffs; the idle-process comparison still uses more memory
than native Node. No universal native-Node win or zero slowdown is claimed.

## Further systems worth testing

These are proposed experiments, not implemented or measured improvements.

1. A shared immutable package/source arena with copy-on-write overlays per
   process would remove per-worker copies of identical source and transformed
   code. The fast lookup path must preserve symlinks, file mutations and
   invalidation; compare worker counts and private/resident memory separately.
2. Content-addressed compilation artifacts shared across workers could reuse
   transformations and compiled WASM across projects. Include transform mode,
   loader version and options in keys; cap retention by bytes, and invalidate
   eagerly when source changes. Never share mutable module exports/instances.
3. Sparse paged descriptor storage could remove unused growth capacity for huge
   files and make random writes proportional to touched pages. The hard part
   is preserving existing contiguous-buffer API behavior without adding copies
   to reads; benchmark real package extraction and webpack cache workloads.
4. A batched filesystem operation protocol could amortize cross-thread round
   trips during dependency scans. Batch only independent operations and preserve
   error ordering and filesystem changes between dependent calls.
5. Worker startup snapshots and measured idle reuse could amortize runtime
   initialization. Reset all process/module/environment state, and terminate
   surplus workers under a bounded memory budget. Arbitrary user code makes
   transparent isolate reuse difficult; process lifetime must stay observable.
6. Lazy internal MessageChannels can reduce baseline host resources. Native
   Node currently needs an explicit benchmark exit because internal channels
   remain open. A future fix must keep pending callbacks ref'd while allowing
   idle channels to unref, and cover browser MessagePort accounting too.

A lower benchmark number is accepted only with unchanged results, lifetime
semantics and real build/HMR/server validation. Retaining extra caches is not
automatically a memory optimization, and linear WASM memory cannot generally
be shrunk or safely rewritten after instantiation.
