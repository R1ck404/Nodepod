---
title: Snapshots
description: Capture and restore a Nodepod filesystem.
sidebar:
  order: 4
---

```ts
const snapshot = nodepod.snapshot();

// Store the serializable snapshot in application-controlled storage.

await nodepod.restore(snapshot);
```

`snapshot()` is synchronous. `restore()` is asynchronous because it can
reinstall dependencies from `package.json`.

Snapshots capture project filesystem state. Shallow snapshots exclude reinstallable package data by default to reduce size. Restoring can reinstall dependencies from `package.json` when that option is enabled.

To keep a workspace across reloads automatically, use [workspace persistence](/Nodepod/docs/guides/persistence/) instead of saving snapshots yourself. `restore()` replaces the filesystem through regular change events, so running processes, watchers and persistence all see the restored files.

Treat imported snapshots as untrusted input. Validate their source and size before restoring them, and do not place secrets in a browser-side project filesystem.
