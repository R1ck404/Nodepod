---
title: SDK overview
description: A concise map of Nodepod's public entry points and main runtime objects.
sidebar:
  order: 1
---

Nodepod publishes five supported entry points.

| Import | Purpose |
| --- | --- |
| `@scelar/nodepod` | Browser runtime, types, filesystem, terminal, packages, process, HTTP, profiling, and inspection APIs |
| `@scelar/nodepod/headless` | Node.js, Bun, and explicitly headless runtime defaults |
| `@scelar/nodepod/server` | Fetch-style and Node-style runtime asset response helpers |
| `@scelar/nodepod/vite` | Vite plugin for development and production assets |
| `@scelar/nodepod/next` | Next.js route, middleware, proxy, matcher, and asset helpers |

## Main browser lifecycle

1. Call `Nodepod.boot(options)`.
2. Use `fs`, `packages`, `spawn()`, `request()`, `port()`, `createTerminal()`, `snapshot()`, `persistence`, or inspection/profiling capabilities.
3. Detach UI integrations.
4. Call `teardown()`.

The generated reference includes every exported declaration from the five entry points and links source locations to the repository revision used for the build.

See the [generated API reference](/Nodepod/docs/reference/api/).
