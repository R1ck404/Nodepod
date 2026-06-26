# Contribution: Pluggable VFS Adapter (`IVolume`)

> **Issue:** Allow users to provide a custom virtual filesystem adapter instead of the hardcoded in-memory implementation, so they can back the VFS with IndexedDB, localStorage, remote storage, or any preferred backend — avoiding memory bloat when dealing with many files.

This document describes the design, every file changed, the public API additions, an example adapter, and the verification steps. It is intended to accompany the pull request and to serve as a reference for future contributors building on the abstraction.

---

## TL;DR

- Extracted an `IVolume` interface from `MemoryVolume`'s public synchronous API.
- Typed the entire engine / SDK / threading / polyfills / packages / shell / helpers layer against `IVolume` instead of the concrete `MemoryVolume` class.
- `MemoryVolume` remains the default in-memory implementation (no breaking change).
- Added a `volume?: IVolume` option to `NodepodOptions` and `WorkspaceConfig`, threaded through `Nodepod.boot()` and `createWorkspace()`.
- Exported `IVolume` and related types from the public API (`src/index.ts`).
- Added `MemoryVolume.replaceFromSnapshot()` to the public contract so `restore()` no longer pokes private tree state.
- Shipped an example IndexedDB write-through adapter + demo page.
- All gates green: `type-check`, `build:lib`, `build:types`, `test` (598 passed, 1 pre-existing skip).

---

## Design

### Why an interface, not a class hierarchy

The codebase referenced `MemoryVolume` as a *concrete type* in ~30 files (constructor params, field types, return types, structurally-typed locals). Subclassing would have forced every consumer to depend on `MemoryVolume`'s implementation details and would not have allowed adapters that don't inherit from it (e.g. a proxy that delegates to a remote store). An interface (`IVolume`) is the minimal, non-breaking abstraction: `MemoryVolume implements IVolume`, every consumer is typed against `IVolume`, and any object satisfying the contract can be injected.

### Why the contract is synchronous

Nodepod emulates Node's synchronous `fs.readFileSync` / `require()` semantics via `eval` + `SyncPromise`. The VFS contract must therefore be synchronous. Async backends (IndexedDB, `fetch`) must pre-load into an in-memory cache at boot and write-through on mutations. A future revision may add a SharedArrayBuffer-bridged async mode (see "Future work" below).

### Memory-bloat note (honest constraint)

Every `spawn()` walks the whole VFS tree via `readdirSync` / `statSync` / `readFileSync` to build a binary snapshot for the worker (`VFSBridge.createSnapshot()`). This is pre-existing behavior, not introduced by this PR, but it is directly relevant to the issue's "avoiding memory bloat" goal:

- A custom adapter that lazily loads from a remote/IDB store will have all reachable files materialized into the snapshot on each spawn.
- The write-through adapter pattern (load-into-memory + write-through) gives **persistence** and removes the "only copy in heap" risk, but does not by itself reduce **peak heap**.
- True peak-heap reduction needs the planned SAB-bridged async mode (PR 2), where workers read directly from the adapter instead of receiving a full snapshot copy.

This constraint is documented in the `IVolume` interface header (`src/types/volume.ts`) and in the example adapter so adapter authors are not surprised.

---

## Public API additions

### `src/types/volume.ts` (new file)

The `IVolume` interface. Surface mirrors `MemoryVolume`'s public sync API:

| Category | Methods |
| --- | --- |
| Sync read | `existsSync`, `statSync`, `lstatSync`, `accessSync`, `readFileSync` (overloads for `Uint8Array` / `string`) |
| Sync write | `writeFileSync`, `appendFileSync`, `truncateSync`, `copyFileSync`, `mkdirSync`, `rmdirSync`, `unlinkSync`, `renameSync`, `symlinkSync`, `readlinkSync`, `linkSync`, `realpathSync`, `chmodSync`, `chownSync` |
| Sync listing | `readdirSync` |
| Async wrappers | `readFile`, `stat`, `lstat`, `readdir`, `realpath`, `access` (callback-style) |
| Watchers / events | `watch`, `on` (overloads for `"change"` / `"delete"` / generic), `off`, `onGlobalChange` |
| Streams | `createReadStream`, `createWriteStream` |
| Snapshot / lifecycle | `toSnapshot`, `replaceFromSnapshot`, `getStats`, `dispose` |

Exported helper types: `VolumeWriteData`, `VolumeStats`, `VolumeReadStream`, `VolumeWriteStream`.

The `on` / `off` generic overloads use `(...args: any[]) => void` so custom adapters can implement a single generic signature instead of mirroring every overload (the specific `"change"` / `"delete"` overloads remain for caller ergonomics).

### `src/sdk/types.ts`

Added `volume?: IVolume` to `NodepodOptions` with a doc comment explaining the sync contract and the `opts.files` write-through behavior.

### `src/index.ts`

- Re-exports `IVolume`, `VolumeWriteData`, `VolumeStats`, `VolumeReadStream`, `VolumeWriteStream` as type exports.
- Added `volume?: IVolume` to `WorkspaceConfig`.
- `createWorkspace()` return type's `volume` field is now `IVolume` (was `MemoryVolume`).
- `createWorkspace()` honors `config?.volume ?? new MemoryVolume()`.

### `src/memory-volume.ts`

- `export class MemoryVolume implements IVolume` (explicit interface declaration).
- Added `replaceFromSnapshot(snapshot: VolumeSnapshot): void` — swaps the entire tree from a snapshot via the public contract. Used by `Nodepod.restore()`.

---

## File-by-file changes

### New files

| File | Purpose |
| --- | --- |
| `src/types/volume.ts` | The `IVolume` interface + exported helper types |
| `src/__tests__/ivolume-adapter.test.ts` | Tests: `MemoryVolume` is an `IVolume`; a custom impl works in its place; `replaceFromSnapshot` swaps contents; `NodepodOptions.volume` accepts an `IVolume` |
| `examples/custom-vfs/indexeddb-volume.ts` | Example IndexedDB write-through adapter (load-at-boot, write-through on mutation, `flush()` for persistence) |
| `examples/custom-vfs/index.html` | Demo page using `Nodepod.boot({ volume })` with the IDB adapter; survives reloads |

### Modified files — type swap (`MemoryVolume` → `IVolume`)

Each file had its `import type { MemoryVolume }` swapped to `import type { IVolume }` from `../types/volume`, and every `MemoryVolume` type annotation changed to `IVolume`. Value imports for `new MemoryVolume()` were preserved where construction happens.

**Engine:**
- `src/engine-factory.ts` — factory param + return type
- `src/engine-types.ts` — `VolumeSnapshot` comment
- `src/script-engine.ts` — constructor param, field, internal helpers

**SDK:**
- `src/sdk/nodepod.ts` — constructor param, `_volume` field, `volume` getter, `boot()` (reads `opts.volume ?? new MemoryVolume(handler)`), `restore()` (uses `replaceFromSnapshot()` instead of private `.tree`)
- `src/sdk/nodepod-fs.ts` — async facade field + methods
- `src/sdk/types.ts` — added `volume?: IVolume` to `NodepodOptions`

**Threading:**
- `src/threading/process-manager.ts` — constructor param, field
- `src/threading/process-context.ts` — context field
- `src/threading/vfs-bridge.ts` — constructor param, field, `_walkVolume`, `createSnapshot`, `watch`, all mutation handlers

**Polyfills:**
- `src/polyfills/fs.ts` — registry + bindings
- `src/polyfills/child_process.ts` — spawn bindings
- `src/polyfills/chokidar.ts` — watcher adapter
- `src/polyfills/readdirp.ts` — stream adapter
- `src/polyfills/esbuild.ts` — plugin fs access
- `src/polyfills/volume-registry.ts` — global registry type

**Packages:**
- `src/packages/installer.ts` — installer field
- `src/packages/browser-bundler.ts` — bundler field
- `src/packages/archive-extractor.ts` — extraction target

**Shell:**
- `src/shell/shell-types.ts` — shell context field
- `src/shell/shell-parser.ts` — parser param
- `src/shell/shell-interpreter.ts` — interpreter field + constructor
- `src/shell/shell-completions.ts` — completion functions
- `src/shell/commands/git.ts` — `GitRepo` field, `findGitDir`, `requireRepo`

**Helpers / sandboxes:**
- `src/module-transformer.ts` — `listJsFiles`, `isEsmPackage`, transform params
- `src/iframe-sandbox.ts` — sandbox field + constructor + `getVolume()`
- `src/worker-sandbox.ts` — sandbox field + constructor + `getVolume()`
- `src/helpers/napi-wasm-worker.ts` — WASI fs bridge params (4 functions) + comments

**Public API:**
- `src/index.ts` — re-exports `IVolume` + helper types; `WorkspaceConfig.volume?`; `createWorkspace()` return type + construction

**Core:**
- `src/memory-volume.ts` — `implements IVolume`; added `replaceFromSnapshot()`

### Files intentionally NOT changed

- `src/threading/process-worker-entry.ts` and `src/threading/engine-worker.ts` — worker entries rebuild a `MemoryVolume` from a binary snapshot. Workers receive a *copy*, not the user's adapter. The adapter lives on the main thread. Keeping the concrete type here is correct.
- `src/isolation-helpers.ts` — string literals inside generated iframe-sandbox code (runtime eval, not a type reference).
- Test files (`src/__tests__/*`) other than the new one — they construct `new MemoryVolume()` directly to exercise the default implementation; that's the right level for unit tests.

---

## Usage

### Default (unchanged)

```ts
const nodepod = await Nodepod.boot({
  files: { "/index.js": "console.log('hi')" },
});
// volume is an in-memory MemoryVolume
```

### Custom adapter

```ts
import { IndexedDBVolume } from "./indexeddb-volume";

const volume = await IndexedDBVolume.create("my-app-fs");
const nodepod = await Nodepod.boot({
  volume,                                   // <-- inject custom VFS
  files: { "/index.js": "console.log('hi')" }, // still written into the provided volume
});
// ... run code ...
await volume.flush();                        // persist before unload
```

### `createWorkspace`

```ts
const ws = createWorkspace({ volume: myAdapter });
ws.volume; // typed as IVolume
```

---

## Example adapter: `IndexedDBVolume`

Located at `examples/custom-vfs/indexeddb-volume.ts`. Pattern:

1. **`IndexedDBVolume.create(dbName)`** — opens the IDB database, hydrates every file + directory into an inner `MemoryVolume`, returns the adapter.
2. **Reads** delegate to the inner `MemoryVolume` (synchronous, fast).
3. **Mutations** (`writeFileSync`, `mkdirSync`, `unlinkSync`, `renameSync`, `rmdirSync`, etc.) write to the inner `MemoryVolume` first, then write-through to IDB in the background via a serialized `_pendingFlush` promise chain.
4. **`flush()`** — awaits all pending IDB writes. Call before `unload` to guarantee persistence.
5. **`replaceFromSnapshot()`** — re-seeds both the inner `MemoryVolume` and IDB from the snapshot entries.
6. **Watchers / events / streams** — delegate to the inner `MemoryVolume` so HMR, chokidar, and `fs.createReadStream` work unchanged.

The file includes a TODO for LRU eviction of cold entries (the natural next step for peak-heap reduction) and an honest note that true "IDB as the live source of truth with nothing in memory" needs the SAB bridge.

---

## Tests

`src/__tests__/ivolume-adapter.test.ts` (4 tests, all passing):

1. **`MemoryVolume implements IVolume (structural assignability)`** — `const vol: IVolume = new MemoryVolume()` compiles and is instanceof `MemoryVolume`.
2. **`a custom IVolume implementation can be used in place of MemoryVolume`** — a `DelegatingVolume` (minimal in-memory adapter) supports write/read/mkdir/readdir/unlink.
3. **`replaceFromSnapshot swaps contents via the public contract`** — old files gone, new files present, directories created.
4. **`NodepodOptions accepts a volume field (type-level wiring)`** — `NodepodOptions.volume` accepts an `IVolume`; verifies the option is wired through the type system. (Does not call `Nodepod.boot()` because boot pulls in `process-manager.ts` which depends on the vite build-time virtual module `virtual:process-worker-bundle`, unavailable in vitest's node env. The full boot path is exercised by the browser example.)

---

## Verification

All gates run and green:

```bash
npm run type-check    # 0 errors
npm run build:lib     # builds cleanly (only pre-existing warnings)
npm run build:types   # 0 errors; dist/index.d.ts exports IVolume + volume?: IVolume
npm test              # 30/30 files, 598 passed, 1 pre-existing skip
```

The example adapter also type-checks under `tsc --strict --target ES2020 --module ESNext --moduleResolution bundler --lib ES2020,DOM,DOM.Iterable`.

### Public API surface in `dist/index.d.ts`

```
export type { IVolume, VolumeWriteData, VolumeStats, VolumeReadStream, VolumeWriteStream } from "./types/volume";
```

And in `dist/sdk/types.d.ts`:

```
volume?: IVolume;
```

---

## Non-breaking

- `MemoryVolume` is still exported and still the default. Existing code that does `new MemoryVolume()` or relies on the default boot behavior is unaffected.
- No public method signatures changed (only widened from `MemoryVolume` to `IVolume` where the user could already pass a `MemoryVolume`).
- `MemoryVolume.replaceFromSnapshot()` is a new public method (additive).
- `NodepodOptions.volume` and `WorkspaceConfig.volume` are optional (additive).

---

## Future work (PR 2)

- **SAB-bridged async mode:** allow `IVolume` to be backed by a truly async store (IDB / remote) with nothing held in memory on the main thread. A worker services reads via `SharedArrayBuffer` + `Atomics.wait` while the main thread blocks. Requires COOP/COEP. This is the path to real peak-heap reduction.
- **LRU eviction in adapters:** once the SAB bridge exists, adapters can evict cold file paths from their in-memory cache and rehydrate on read.
- **Worker VFS refinement:** currently workers rebuild a `MemoryVolume` from a binary snapshot. With the SAB bridge, workers could read directly from the adapter via the shared buffer, avoiding the full-tree snapshot on every `spawn()`.

---

## Commit message

```
feat: pluggable VFS adapter via IVolume interface

Extract an IVolume interface from MemoryVolume's public sync API and type
the engine/sdk/threading/polyfills/packages/shell/helpers against it.
MemoryVolume remains the default in-memory implementation. Add a `volume`
option to NodepodOptions and createWorkspace so users can inject any
IVolume adapter (IndexedDB, localStorage, remote storage) to avoid memory
bloat with many files. Includes an example IndexedDB write-through adapter
and tests. restore() now uses the public replaceFromSnapshot() contract
instead of poking private tree state.
```
