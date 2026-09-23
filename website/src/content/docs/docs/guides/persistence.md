---
title: Workspace persistence
description: Keep a project filesystem across page reloads and process restarts.
sidebar:
  order: 5
---

Boot with a `persistence` id and Nodepod saves the project filesystem as it
changes, then restores it the next time you boot with the same id.

```ts
const nodepod = await Nodepod.boot({
  workdir: '/app',
  persistence: { id: 'my-project' },
  // written only the first time; afterwards the saved workspace wins
  files: { '/app/package.json': '{ "name": "app" }' },
});
```

In browsers the workspace is saved to IndexedDB. On Node.js and Bun it is
saved under the host cache directory (`createNodeHost({ cacheDir })`,
`NODEPOD_CACHE`, or the OS temp directory). If the browser won't open
IndexedDB (for example storage blocked in a third-party iframe), the pod
boots without saving, `nodepod.persistence` is `null`, and a warning is
logged.

## What gets saved

Everything written to the filesystem, whether through `nodepod.fs`, a
terminal, or a spawned process, is saved: file contents, directories,
permissions and modification times. Symlinks and hardlinks are saved as links
when they are created through `nodepod.fs` or `nodepod.volume`. Links created
inside a running process currently reach the saved workspace as regular files
(and a symlink to a directory as an empty directory).

`node_modules`, `.cache` and `.npm` directories are not saved. After a
restore, dependencies (including `devDependencies`, like `npm install`) are
reinstalled from `package.json`, normally straight from the package snapshot
cache. `/tmp` and Nodepod's internal `/.nodepod`
directory are never saved.

```ts
persistence: {
  id: 'my-project',
  excludeDirNames: ['node_modules', '.cache', '.npm', 'dist'],
  exclude: (path) => path.endsWith('.log'),
  autoInstall: true,
}
```

## Options

| Option | Default | |
| --- | --- | --- |
| `id` | required | Workspace key. Different ids are independent workspaces on the same origin. |
| `store` | IndexedDB / cache directory | A custom `WorkspaceStore`, see below. |
| `excludeDirNames` | `["node_modules", ".cache", ".npm"]` | Directory names that are never saved, at any depth. Replaces the default list, so include `node_modules` if you set it. |
| `exclude` | none | Extra filter. Return `true` to skip a path; excluding a directory excludes everything in it. |
| `seed` | `"if-empty"` | `"if-empty"` writes `files` only into a workspace that was never saved. `"always"` writes them over the restored state on every boot. |
| `autoInstall` | `true` | Reinstall dependencies from `package.json` after restoring. |
| `lock` | `"error"` | Behavior when another tab holds the workspace. See below. |
| `requestPersistentStorage` | `false` | Ask the browser not to evict this origin's storage. |
| `debounceMs` | `250` | Quiet time before changes are saved. |

## When changes are saved

Changes are saved 250ms after the last write, and at least every 2 seconds
while writes keep coming in. They are also saved when the page is hidden or
unloaded, and when you call `teardown()`. To save right away:

```ts
await nodepod.persistence?.flush();
```

A page that is killed in the middle of a debounce window can lose the last
changes. `pagehide` saving is best effort, because browsers don't wait for
asynchronous work while unloading.

## Status and errors

```ts
nodepod.persistence?.on('saved', ({ entries, bytes }) => {});
nodepod.persistence?.on('error', (err) => {
  // err.name === 'QuotaExceededError' when storage is full
});

nodepod.persistence?.status;         // 'idle' | 'pending' | 'saving' | 'error' | 'closed'
nodepod.persistence?.pendingChanges; // paths waiting to be saved
```

Failed background saves are retried with backoff and reported through
`error` events, never thrown into your application. `flush()` and `clear()`
return promises that reject if they fail. Large saves send file content first and the file
tree last, so a save that is cut off partway leaves the previously saved
tree intact.

On Node.js, a saved workspace whose `manifest.json` is not valid JSON makes
boot fail with `code === 'EWORKSPACECORRUPT'`; delete that workspace's
directory to start over.

## Multiple tabs

Only one tab at a time can hold a workspace. Booting the same id in a second
tab throws an error with `code === 'EWORKSPACELOCKED'`. Pass `lock: 'steal'`
to take over instead. The first tab then gets an `EWORKSPACELOCKLOST` error
event and stops saving.

Within one page the same rule applies to two live pods. A pod that is being
torn down doesn't block: `pod.teardown(); await Nodepod.boot(...)` (for
example under React StrictMode or HMR) waits for the old pod's final save and
then restores it.

## Clearing and listing workspaces

```ts
import { listIndexedDBWorkspaces, deleteIndexedDBWorkspace } from '@scelar/nodepod';

const saved = await listIndexedDBWorkspaces(); // [{ id, updatedAt }]
await deleteIndexedDBWorkspace('old-project');

// or, from a running pod: delete its saved copy and stop saving
await nodepod.persistence?.clear();
```

## Custom stores

A `WorkspaceStore` saves the workspace anywhere: your own server, S3, or a
native bridge. Nodepod keeps the running filesystem in memory and only calls
the store asynchronously, so a store can be as slow as a network request.

```ts
import type { WorkspaceStore } from '@scelar/nodepod';

const store: WorkspaceStore = {
  // the saved entries, or null if the workspace was never saved
  async load() {},
  // file contents by blob id
  async readBlobs(ids) {},
  // apply atomically: deletePrefixes, deletePaths, putEntries, putBlobs, deleteBlobs
  async commit(batch) {},
  // optional: delete blobs no entry references
  async sweep() {},
  async clear() {},
};

await Nodepod.boot({ persistence: { id: 'my-project', store } });
```

Each entry describes one path, and file content is stored separately as a
blob. Hardlinks share one blob. A rename only rewrites entries and never
re-sends file content. `createMemoryWorkspaceStore()` is a complete reference
implementation. Nodepod calls the store's optional `close()` when the pod is torn down; a
store you pass to another boot afterwards must be usable again. On Node.js, `createFsWorkspaceStore(dir)` is also exported
from `@scelar/nodepod/headless`.

Treat saved workspaces as untrusted local state, not as your application's
source of truth. Anything with access to the origin's storage can read or
change them.
