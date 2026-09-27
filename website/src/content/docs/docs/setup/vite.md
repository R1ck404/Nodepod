---
title: Vite
description: Serve Nodepod runtime and preview assets automatically with the Vite plugin.
sidebar:
  order: 1
---

Add the Nodepod plugin to your Vite configuration:

```ts
import { defineConfig } from 'vite';
import nodepod from '@r1ck404/nodepod/vite';

export default defineConfig({
  plugins: [nodepod()],
});
```

The plugin serves the service worker, process worker, and preview bridge during development and emits the required assets during production builds. It must run on the origin where the Nodepod host page loads.

Then boot the runtime from application code:

```ts
import { Nodepod } from '@r1ck404/nodepod';

const pod = await Nodepod.boot();
```

If the asset path must change, pass the same path to both sides:

```ts
// vite.config.ts
nodepod({ path: '/runtime/nodepod-sw.js' })

// application code
Nodepod.boot({ swUrl: '/runtime/nodepod-sw.js' })
```

For clean production preview hostnames and required headers, continue to [Preview deployment](/Nodepod/docs/setup/preview-deployment/).
