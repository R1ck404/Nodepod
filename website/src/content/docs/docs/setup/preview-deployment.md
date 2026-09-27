---
title: Preview deployment
description: Configure the Nodepod service worker, preview-origin bridge, and production isolation headers.
sidebar:
  order: 5
---

# Service worker setup

Nodepod routes preview iframes (`nodepod.port(3000)`) and virtual HTTP
servers through a service worker. Clean hostname previews also use a tiny
HTML/JS bootstrap at `/__nodepod_bridge__.html` and
`/__nodepod_bridge__.js`. These assets install the same proxy worker on the
preview origin and connect it to Nodepod's in-browser runtime.

Unlike the rest of the package, the SW **cannot be bundled into your app
JS**. Browsers impose two hard requirements:

1. A service worker must be served from the **same origin** as the page
   that registers it.
2. It must be served with a **JavaScript `Content-Type`** (e.g.
   `application/javascript`). Serving it as `text/html`, which is what
   SPA dev servers fall back to for unknown routes, silently breaks
   registration.

So: a file has to sit on your host at `/__sw__.js`, answering with a JS
`Content-Type`. This doc shows how to make that happen in every common
framework, and what error you'll see if you don't.

## The one-liners

### Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import nodepod from '@r1ck404/nodepod/vite';

export default defineConfig({
  plugins: [nodepod()],
});
```

- **Dev**: the plugin serves the worker and both hostname-preview bridge
  assets from memory.
- **Build**: the plugin emits all three assets next to your other build
  output, so your production host serves them automatically.

Optional: `nodepod({ path: '/foo/__sw__.js' })` to mount under a custom
path. Pair with `Nodepod.boot({ swUrl: '/foo/__sw__.js' })`.

### Next.js (App Router)

Works the same across Next 13 through 16. Route handlers weren't touched
by the Next 16 rename.

```ts
// app/__sw__.js/route.ts
export { GET } from '@r1ck404/nodepod/next';

// app/__nodepod_bridge__.html/route.ts
export { GET_PREVIEW_BRIDGE as GET } from '@r1ck404/nodepod/next';

// app/__nodepod_bridge__.js/route.ts
export { GET_PREVIEW_BRIDGE_SCRIPT as GET } from '@r1ck404/nodepod/next';
```

Next matches this file at `GET /__sw__.js` because the folder name is
literally `__sw__.js`. No other config required.

#### Next 16+ (`proxy.ts`)

[Next 16 renamed `middleware.ts` to `proxy.ts`](https://nextjs.org/docs/app/getting-started/proxy).
If you already have a `proxy.ts`, compose `nodepodProxy`:

```ts
// proxy.ts
import { nodepodProxy, nodepodMatchers } from '@r1ck404/nodepod/next';

export async function proxy(req) {
  const sw = await nodepodProxy(req);
  if (sw) return sw;
  // ...your own proxy logic
}

export const config = { matcher: [...nodepodMatchers /*, your paths */] };
```

#### Next <=15 (`middleware.ts`)

`nodepodMiddleware` is a back-compat alias of `nodepodProxy`, for projects
still on `middleware.ts`:

```ts
// middleware.ts
import { nodepodMiddleware, nodepodMatchers } from '@r1ck404/nodepod/next';

export async function middleware(req) {
  const sw = await nodepodMiddleware(req);
  if (sw) return sw;
  // ...your own middleware
}

export const config = { matcher: [...nodepodMatchers /*, your paths */] };
```

> Upgrading to Next 16? Run `npx @next/codemod@canary middleware-to-proxy .`
> to rename your file + function, then swap `nodepodMiddleware` for
> `nodepodProxy`. They're the same function re-exported under both names.

### Any Fetch-style framework (Hono, Bun, Cloudflare, Elysia, etc.)

```ts
import { serveSW } from '@r1ck404/nodepod/server';
import { servePreviewBridge, servePreviewBridgeScript } from '@r1ck404/nodepod/server';

app.get('/__sw__.js', () => serveSW());
app.get('/__nodepod_bridge__.html', () => servePreviewBridge());
app.get('/__nodepod_bridge__.js', () => servePreviewBridgeScript());
```

### Express / Fastify / bare `http`

```ts
import { serveSWNode } from '@r1ck404/nodepod/server';
import { servePreviewBridgeNode } from '@r1ck404/nodepod/server';

app.get('/__sw__.js', async (_req, res) => {
  const { body, headers } = await serveSWNode();
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(200).send(body);
});

app.get('/__nodepod_bridge__.html', async (req, res) => {
  const mode = req.query.mode === 'top' || req.query.mode === 'parent'
    ? req.query.mode
    : null;
  const { body, headers } = await servePreviewBridgeNode('html', mode);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(200).send(body);
});

app.get('/__nodepod_bridge__.js', async (_req, res) => {
  const { body, headers } = await servePreviewBridgeNode('script');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(200).send(body);
});
```

### Static host (copy once)

No server to edit? Copy the file into your public/static directory and
let the host serve it:

```bash
cp node_modules/@r1ck404/nodepod/dist/__sw__.js public/__sw__.js
cp node_modules/@r1ck404/nodepod/dist/__nodepod_bridge__.html public/__nodepod_bridge__.html
cp node_modules/@r1ck404/nodepod/dist/__nodepod_bridge__.js public/__nodepod_bridge__.js
```

Re-run the copy when you upgrade `@r1ck404/nodepod`.

## What the error looks like

Starting in 1.2, `Nodepod.boot()` registers the service worker by
default. If the SW can't be reached or is served as HTML, boot throws:

```
NodepodSWSetupError: service worker at /__sw__.js returned HTTP 404

  Requested:    /__sw__.js
  HTTP status:  404

Detected Vite. Add the nodepod plugin to serve __sw__.js automatically:

  // vite.config.ts
  import nodepod from '@r1ck404/nodepod/vite';
  export default defineConfig({ plugins: [nodepod()] });
```

The framework hint is picked automatically by sniffing the runtime
(`import.meta.hot`, `window.__NEXT_DATA__`, etc.).

## Opting out

Two knobs:

```ts
await Nodepod.boot({
  // Skip SW registration entirely (SSR, Node tests, hosts without a SW).
  serviceWorker: false,

  // Or: keep SW on, but skip the HEAD preflight (use if your host
  // disallows HEAD, requires auth, or trips the check some other way).
  skipSWPreflight: true,
});
```

With `serviceWorker: false` you keep the rest of Nodepod (filesystem,
spawn, packages, and programmatic `nodepod.request()` calls). Only navigable
preview iframes and preview URLs are unavailable.

## Customising the URL

If you can't use `/__sw__.js` (maybe it's already taken), serve the SW
somewhere else and tell the SDK:

```ts
await Nodepod.boot({ swUrl: '/assets/nodepod-sw.js' });
```

Framework integrations support this too:

```ts
// Vite
nodepod({ path: '/assets/nodepod-sw.js' });

// Fetch-style
app.get('/assets/nodepod-sw.js', () => serveSW());
```

## Clean preview hostnames

On a local app, Nodepod defaults to a browser-reserved `.localhost` subdomain:

```text
http://pod6e7bc4e9-5173.localhost:3333/
```

No hosts-file or DNS setup is needed, and `.localhost` remains a trustworthy
context for browser APIs such as service workers. For a deployed app, set a
wildcard preview origin:

```ts
await Nodepod.boot({
  previewOrigin: 'https://{instanceId}-{port}.preview.yourdomain.com',
});
```

Configure `*.preview.yourdomain.com` DNS and a matching wildcard TLS
certificate to reach the same frontend deployment. The worker and both bridge
assets must answer on every preview hostname. Production preview origins must
use HTTPS for service workers and other secure-context APIs.

Modern browsers partition service workers installed in a cross-site iframe.
That means the embedded preview and a separately opened tab cannot share one
worker registration. Nodepod handles this with a first-party host handoff: the
first direct visit installs a worker in the top-level preview partition, then
briefly opens the host origin. The host worker wakes the page running Nodepod if
needed and transfers a dedicated HTTP/WebSocket transport to the direct preview
worker. The preview only navigates after that worker confirms its route is
bound, and the address bar remains at the clean root URL.
Browsers may require one click to allow that temporary connection tab. This is
the same extra step required by separately opened WebContainer previews.

The Vite integration serves this top-level bootstrap automatically for HTML
navigations on hosts matching `*-<port>.localhost` and
`*-<port>.preview.*`, including first-visit client-router deep links. With
another production server, route document navigations on the wildcard preview
hostname to `servePreviewBootstrap()` (or
`servePreviewBridgeNode('html', 'top')`). Keep
`/__nodepod_bridge__.html` routed through `servePreviewBridge(request)` so its
`?mode=parent` response receives the required opener policy. The conventional
`{instanceId}-{port}.preview.yourdomain.com` form lets the bootstrap infer the
pod, port, and parent `https://yourdomain.com`; custom hostname layouts should
rewrite to the bridge with `instanceId`, `port`, and `parentOrigin` query
parameters.

The preview origin's root service-worker scope is reserved for Nodepod's HTTP
transport. Browser APIs remain available in the guest, but a guest app cannot
replace that root worker with its own and still keep browser-only virtual HTTP
routing; the browser allows only one controlling worker for a document. This
is the same architectural reason [WebContainers install a worker on every
project domain](https://webcontainers.io/guides/browser-config). A backend
reverse proxy would be required to remove that constraint entirely.

You can also pass a resolver function, or use `previewOrigin: false` to keep
the path-shaped `/__virtual__/{instanceId}/{port}` URLs. If bridge setup fails,
Nodepod reports the path URL to `onServerReady` as a compatibility fallback.

Loopback URLs printed by active dev servers are visually rewritten to this same
resolved preview URL in Nodepod-owned terminals by default, including
ANSI-colored output. Raw process stdout/stderr, the process environment, and
network behavior remain unchanged. Pass `rewriteTerminalUrls: false` to
`Nodepod.boot()` to preserve the original terminal display too.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `NodepodSWSetupError: HTTP 404` | No handler mounted | Add the plugin / route for your framework above |
| `NodepodSWSetupError: wrong Content-Type (text/html)` | SPA fallback catching `/__sw__.js` | Ensure your router serves the SW *before* the fallback |
| `NodepodSWSetupError: could not be reached` | CORS, network error, or timeout | Check devtools → Network; make sure the URL is same-origin |
| SW registers but preview iframes are blank | Nodepod's `Cross-Origin-*` headers missing | Set `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` (or the stricter `require-corp`) on HTML responses |
| Hostname preview falls back and says the bridge document did not load | Bridge assets are missing, stale, or lack required headers on the preview hostname | Serve all three Nodepod assets on every preview hostname and restart stale dev servers after adding the routes |
| A clean URL opened in a new tab shows the host site's root | The preview-host root is not routed to Nodepod's top-level bootstrap | Use the Vite integration or route preview-host `/` to `servePreviewBootstrap()`; keep the Nodepod host tab open and allow the one-time connection popup |
