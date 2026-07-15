# nodepod

[![npm](https://img.shields.io/npm/v/@scelar/nodepod.svg)](https://www.npmjs.com/package/@scelar/nodepod)
[![license](https://img.shields.io/npm/l/@scelar/nodepod.svg)](./LICENSE)

Run Node.js in the browser. Filesystem, shell, npm packages, HTTP servers, no backend required.

```bash
npm install @scelar/nodepod
```

## Getting started

Nodepod uses a service worker to route preview iframes and virtual HTTP
servers. It has to be served from your own origin at `/__sw__.js`,
browsers won't register a SW from `node_modules`.

Pick the one-liner for your framework:

### Vite

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import nodepod from '@scelar/nodepod/vite';

export default defineConfig({
  plugins: [nodepod()],
});
```

### Next.js (App Router, works Next 13 through 16)

```typescript
// app/__sw__.js/route.ts
export { GET } from '@scelar/nodepod/next';
```

If you already have a `proxy.ts` (Next 16+) or `middleware.ts` (Next <=15),
compose `nodepodProxy` / `nodepodMiddleware` alongside your own handler
instead. See [docs/sw-setup.md](./docs/sw-setup.md).

### Any framework with a Fetch-style handler (Hono, Bun, Cloudflare, Elysia, etc.)

```typescript
import { serveSW } from '@scelar/nodepod/server';

app.get('/__sw__.js', () => serveSW());
```

### Express / Fastify / bare `http`

```typescript
import { serveSWNode } from '@scelar/nodepod/server';

app.get('/__sw__.js', async (_req, res) => {
  const { body, headers } = await serveSWNode();
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(200).send(body);
});
```

### Static host (copy the file)

No server code? Copy the file once into your public directory:

```bash
cp node_modules/@scelar/nodepod/dist/__sw__.js public/__sw__.js
```

See [docs/sw-setup.md](./docs/sw-setup.md) for the full story and how to
customise the URL.

## Usage

```typescript
import { Nodepod } from '@scelar/nodepod';

const nodepod = await Nodepod.boot({
  files: {
    '/index.js': 'console.log("Hello from the browser!")',
  },
});

const proc = await nodepod.spawn('node', ['index.js']);
proc.on('output', (text) => console.log(text));
await proc.completion;
```

If the service worker isn't reachable at `/__sw__.js`, `boot()` throws a
`NodepodSWSetupError` with the one-liner for your framework. Pass
`{ serviceWorker: false }` to skip SW setup entirely (SSR, Node tests).

### Terminal

Plug in xterm.js for an interactive shell:

```typescript
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const terminal = nodepod.createTerminal({ Terminal, FitAddon });
terminal.attach('#terminal-container');
```

### npm packages

```typescript
await nodepod.packages.install('express');
const proc = await nodepod.spawn('node', ['server.js']);
```

Installs are lazy by default: packages are downloaded and extracted, and
modules are converted on first `require()`. Pass
`{ transformModules: 'eager' }` to run all transforms at install time instead.

### HTTP servers

Works with Express, Hono, Vite, and anything that calls `listen()`:

```typescript
const nodepod = await Nodepod.boot({
  files: {
    '/server.js': `
      const express = require('express');
      const app = express();
      app.get('/', (req, res) => res.json({ ok: true }));
      app.listen(3000);
    `,
  },
});

await nodepod.packages.install('express');
await nodepod.spawn('node', ['server.js']);

const response = await nodepod.proxy.handleRequest(3000, 'GET', '/', {});
console.log(response.body.toString()); // {"ok":true}
```

### Snapshots

Save and restore the filesystem:

```typescript
const snapshot = await nodepod.snapshot();
// ... later
await nodepod.restore(snapshot);
```

## API

### `Nodepod.boot(options?)`

| Option | Type | Description |
|--------|------|-------------|
| `files` | `Record<string, string \| Uint8Array>` | Initial files |
| `workdir` | `string` | Working directory (default `"/"`) |
| `env` | `Record<string, string>` | Environment variables |
| `swUrl` | `string` | Service Worker URL for preview iframes |
| `watermark` | `boolean` | Show nodepod badge in previews (default `true`) |
| `onServerReady` | `(port, url) => void` | Called when a virtual server starts |
| `allowedFetchDomains` | `string[] \| null` | Extra CORS proxy domains. `null` = allow all |
| `spawnSnapshot` | `"lean" \| "full"` | Worker filesystem snapshot mode. Defaults to memory-efficient `"lean"` with SharedArrayBuffer and transparently falls back to `"full"` without it |
| `preloadEsbuild` | `boolean` | Warm esbuild during boot. Defaults to `false`; first use initializes it automatically |
| `sharedVFSBufferSize` | `number` | Capacity of the optional SharedFS mirror, allocated only when `sharedFSBuffer` is first read |
| `memory` | `MemoryHandlerOptions` | Advanced memory budget/cache overrides. The default soft budget is 400 MB |

### Instance methods

| Method | Description |
|--------|-------------|
| `spawn(cmd, args?, opts?)` | Run a command |
| `packages.install(name, version?, flags?)` | Install an npm package |
| `createTerminal(opts)` | Create an xterm.js terminal |
| `fs.readFile(path, enc?)` | Read a file |
| `fs.writeFile(path, data)` | Write a file |
| `fs.readdir(path)` | List directory |
| `fs.stat(path)` | File stats |
| `fs.mkdir(path, opts?)` | Create directory |
| `fs.rm(path, opts?)` | Remove file/directory |
| `snapshot()` | Capture filesystem state |
| `restore(snapshot)` | Restore from snapshot |
| `proxy.handleRequest(port, method, url, headers, body?)` | Send a request to a virtual server |
| `port(num)` | Get preview URL for a port |
| `setPreviewScript(js)` | Inject JS into preview iframes |
| `clearPreviewScript()` | Remove injected script |
| `inspect` | Opt-in live-DOM, layout, console, error, a11y, and best-effort screenshot inspection for an attached preview iframe |
| `memoryStats()` | Current VFS, process, worker, port, cache, SharedFS, and heap counters |
| `teardown()` | Terminal, idempotent cleanup of the pod and all owned resources |

Keep one pod for each genuinely active preview and reuse it when project files
change. Call `teardown()` when a preview is discarded; operational calls after
teardown throw. Nodepod performs SQLite, esbuild, package extraction, and lazy
filesystem preparation automatically, so application code needs no warm-up API.

### Preview inspection

Enable and attach before navigating a host-owned iframe. The inspector observes
the rendered document after JavaScript executes and does not replace a script
installed through `setPreviewScript()`.

```ts
await nodepod.inspect.enable();
nodepod.inspect.attach({ port: 3000, iframe: previewIframe });
previewIframe.src = nodepod.port(3000)!;

const page = await nodepod.inspect.snapshot({
  port: 3000,
  include: ["viewport", "errors", "console", "overflow", "a11y"],
});
const stop = nodepod.inspect.on("error", { port: 3000 }, console.error);
```

Available one-shot methods are `viewport`, `documentSize`, `overflow`, `text`,
`dom`, `query`, `console`, `errors`, `navigation`, `a11y`, `screenshot`, and
`snapshot`. `waitUntil: "networkidle"` means no instrumented `fetch` or XHR
requests for 500ms; it is not a browser DevTools network-idle signal. Screenshot
returns an `InspectResult` whose `data.blob` is a PNG `Blob`, ready for
`URL.createObjectURL(result.data.blob)`. It uses DOM-to-SVG/canvas serialization
and is best-effort: unsupported CSS, canvas, or cross-origin assets can produce
`PreviewScreenshotUnavailableError`.

### Process events

`spawn()` returns a `NodepodProcess`:

```typescript
proc.on('output', (text) => { }); // stdout
proc.on('error', (text) => { });  // stderr
proc.on('exit', (code) => { });   // exit code
await proc.completion;             // wait for exit
```

## Polyfills

**Full:** fs, path, events, stream, buffer, process, http, https, net, crypto, zlib, sqlite, url, querystring, util, os, tty, child_process, assert, readline, module, timers, string_decoder, perf_hooks, constants, punycode, worker_threads

**Stubs:** dns, vm, v8, tls, dgram, cluster, http2, inspector, domain, diagnostics_channel, async_hooks

**In development:** Native WASI/WASM loading for napi-rs based packages (rolldown, lightningcss, etc.)

## Why nodepod?

We built nodepod for [Scelar](https://scelar.com), an AI app builder that takes you from idea to production in minutes. Scelar needed a way to run real Node.js code directly in the browser so users could build, preview, and interact with their apps instantly without waiting for remote servers to spin up. No containers, no cold starts, no infrastructure to manage.

We open-sourced it because we think running Node in the browser shouldn't be a proprietary black box. If you're building a web IDE, coding playground, AI dev tool, or anything that needs server-side JS in the browser, nodepod is for you.

## Development

```bash
git clone https://github.com/ScelarOrg/Nodepod.git
cd Nodepod
corepack enable
pnpm install
pnpm run build:publish   # build library + types
pnpm test                # run tests
```

### Publishing a new version

```bash
npm version patch       # or minor / major
npm publish             # auto-builds before publishing
git push && git push --tags
```

### Contributing

Contributions are really appreciated. This is a big project and it's hard to maintain and push updates on my own. If you want to help out, feel free to open a PR.

Note that nodepod is not my main focus, [Scelar](https://scelar.com) is. I work on nodepod when I have time for it, so responses to issues and PRs might take a bit.

Before opening a PR, make sure these pass:

```bash
pnpm run type-check      # 0 TypeScript errors
pnpm run build:publish   # builds cleanly
pnpm test                # tests pass
```

**Code style:**

- Files are **kebab-case** (`shell-parser.ts`, `memory-volume.ts`). Polyfills match their Node.js module name (`fs.ts`, `crypto.ts`).
- Classes and types are **PascalCase** (`MemoryVolume`, `ShellResult`). Functions and variables are **camelCase**.
- Private properties and internal helpers use a **leading underscore** (`_registry`, `_ensureSlot()`).
- Use **named exports**. Default exports only for polyfills that need to match Node's `module.exports` shape.

**Commit messages** follow conventional commits:

```
feat: add readline support
fix: resolve path edge case in fs.watch
chore: bump dependencies
```

**If you're writing a polyfill:**

- Polyfill files live in `src/polyfills/` and must be named after the Node.js module they replace.
- EventEmitter methods must use `_reg()` for lazy init, never access `this._registry` directly.
- Polyfills registered in `CORE_MODULES` must not use `async` functions.
- ESM-to-CJS replacement strings must include trailing semicolons.

## License

[MIT + Commons Clause](./LICENSE). Use it in anything, just don't resell nodepod itself.

Built by [@R1ck404](https://github.com/R1ck404), part of [Scelar](https://scelar.com).
