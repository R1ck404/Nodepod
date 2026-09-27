---
title: Static hosts
description: Copy Nodepod runtime assets to a static public directory, or use reduced mode without previews.
sidebar:
  order: 4
---

Copy the three runtime assets into your host's public directory during the build:

```bash
cp node_modules/@r1ck404/nodepod/dist/__sw__.js public/__sw__.js
cp node_modules/@r1ck404/nodepod/dist/__nodepod_bridge__.html public/__nodepod_bridge__.html
cp node_modules/@r1ck404/nodepod/dist/__nodepod_bridge__.js public/__nodepod_bridge__.js
```

Your deployment must serve the files at the root paths shown above with the content types and service-worker scope headers described in [Preview deployment](/Nodepod/docs/setup/preview-deployment/).

Static hosts such as GitHub Pages cannot provide Nodepod's complete clean-host preview setup. For a terminal-only or process-only experience, disable the service worker and shared-memory-only features:

```ts
const pod = await Nodepod.boot({
  serviceWorker: false,
  enableSharedArrayBuffer: false,
  watermark: false,
});
```

This mode supports the virtual filesystem, many package and process workflows, and programmatic requests. It does not provide a navigable HTTP preview and cannot run APIs that require synchronous cross-worker access or threaded WASI modules.
