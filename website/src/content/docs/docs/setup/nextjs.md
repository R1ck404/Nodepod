---
title: Next.js
description: Add Nodepod runtime assets to a Next.js App Router project.
sidebar:
  order: 2
---

Create three route handlers. These exports work with the App Router in Next.js 13 through 16.

```ts
// app/__sw__.js/route.ts
export { GET } from 'nodepod/next';
```

```ts
// app/__nodepod_bridge__.html/route.ts
export { GET_PREVIEW_BRIDGE as GET } from 'nodepod/next';
```

```ts
// app/__nodepod_bridge__.js/route.ts
export { GET_PREVIEW_BRIDGE_SCRIPT as GET } from 'nodepod/next';
```

If the project already has `proxy.ts` in Next.js 16 or `middleware.ts` in an earlier version, compose `nodepodProxy` or `nodepodMiddleware` with the existing handler. The helpers return `null` when a request does not belong to Nodepod, so your own routing can continue.

Use `nodepodMatchers` when exporting a matcher configuration that covers all three assets.

The runtime itself still belongs in a client boundary because it requires browser APIs:

```ts
'use client';

import { Nodepod } from 'nodepod';
```

See [Preview deployment](/Nodepod/docs/setup/preview-deployment/) for isolation headers and production preview origins.
