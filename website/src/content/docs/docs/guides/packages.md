---
title: npm packages
description: Install and resolve npm packages inside a Nodepod project.
sidebar:
  order: 2
---

Install a package through the instance package manager:

```ts
await nodepod.packages.install('express');
```

Installs are lazy by default. Nodepod downloads and extracts package contents, then transforms modules on first `require()`. Choose eager conversion when the first execution must absorb less transform latency:

```ts
await nodepod.packages.install('express', undefined, {
  transformModules: 'eager',
});
```

Network installs are subject to CORS, host policy, browser storage limits, and the package's own runtime assumptions. Native Node add-ons do not run directly in the browser. Packages that depend on unsupported operating-system APIs may install successfully and still fail at execution.

Use `allowedFetchDomains` to extend the built-in package fetch allowlist, or `null` only when your product intentionally permits every domain. A broad allowlist changes your application's trust boundary.

## Keeping package content out of memory

Installed packages are cached in the browser (IndexedDB or OPFS), and repeat
installs are restored from that cache. By default the restored files are also
held in memory on the main thread. For large dependency trees you can page
them out instead:

```ts
const nodepod = await Nodepod.boot({
  memory: { evictPackageContent: true, residentContentBudgetMB: 128 },
});
```

A cached package is then restored from its file list alone. File contents
are read back from the cache when a process or `nodepod.fs.readFile()` needs
them. Only the most recently used content, up to the budget, stays in
memory. `package.json` files always stay in memory.

This requires cross-origin isolation (SharedArrayBuffer) and the package
snapshot cache. Without them Nodepod logs a warning and keeps content in
memory as usual. With it enabled:

- `nodepod.volume.readFileSync()` throws `EAGAIN` for a paged-out file. Use
  `await nodepod.fs.readFile()`, or `await nodepod.volume.ensureResident(path)` first.
- `snapshot({ shallow: false })` throws. Shallow snapshots work as before.
- `sharedFSBuffer` / `Nodepod.attachFS()` are unavailable.
- Packages installed from the network for the first time stay in memory until
  the next boot, when they are restored from the cache paged out.

`nodepod.memoryStats().vfs` reports `pagedOutFiles`, `pagedOutBytes` and
`residentPackBytes`. It also reports `pagedOutSyncMisses`, which counts
synchronous reads that hit a paged-out file.
