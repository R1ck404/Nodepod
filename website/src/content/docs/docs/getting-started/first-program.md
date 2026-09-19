---
title: First program
description: Install Nodepod, boot a browser runtime, and stream output from a Node.js process.
sidebar:
  order: 2
---

## Install

Nodepod's browser entry requires Node 20 or newer in your build tooling.

```bash
npm install @scelar/nodepod
```

For pnpm or Yarn, use the equivalent add command. Nodepod publishes both ESM
and CommonJS builds; the examples here use ESM syntax.

## Boot and run

```ts
import { Nodepod } from '@scelar/nodepod';

const nodepod = await Nodepod.boot({
  files: {
    '/home/project/hello.js': 'console.log("Hello from the browser!")',
  },
  workdir: '/home/project',
});

const process = await nodepod.spawn('node', ['hello.js']);
process.on('output', (text) => console.log(text));
await process.completion;
```

`Nodepod.boot()` creates an isolated runtime instance and seeds its in-memory filesystem. `spawn()` creates a worker-backed process. Always release an instance when your application no longer needs it:

```ts
await nodepod.teardown();
```

## Choose service-worker behaviour

The browser entry enables the service worker by default because previews use it. If you only need files, packages, processes, or programmatic HTTP calls, you can opt out:

```ts
const nodepod = await Nodepod.boot({
  serviceWorker: false,
});
```

This reduced mode does not produce navigable preview URLs. See [Preview deployment](/Nodepod/docs/setup/preview-deployment/) before enabling hosted previews.
