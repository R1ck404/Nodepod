---
title: HTTP servers
description: Start a virtual Node.js HTTP server and connect to it programmatically or through a preview.
sidebar:
  order: 3
---

```ts
import { Nodepod } from 'nodepod';

let markServerReady: (() => void) | undefined;
const serverReady = new Promise<void>((resolve) => {
  markServerReady = resolve;
});

const nodepod = await Nodepod.boot({
  files: {
    '/server.js': `
      const http = require('http');
      http.createServer((_request, response) => {
        response.end('hello from nodepod');
      }).listen(3000);
    `,
  },
  onServerReady: (port) => {
    if (port === 3000) markServerReady?.();
  },
});

await nodepod.spawn('node', ['server.js']);
await serverReady;
```

`spawn()` waits for the process worker to be ready, not for an HTTP server
inside that process to finish listening. Use `onServerReady` (as above) before
calling `request()` or `port()`.

Call the server without a service worker:

```ts
const response = await nodepod.request(3000, { path: '/' });
console.log(new TextDecoder().decode(response.body));
```

For navigable browser previews, use `nodepod.port(3000)` after configuring the service worker and preview bridge. Production hosts should provide a dedicated wildcard origin:

```ts
const nodepod = await Nodepod.boot({
  previewOrigin: 'https://{instanceId}-{port}.preview.example.com',
});
```

Dedicated preview origins separate cookies and service-worker scope from the host application. They do not make untrusted code harmless; review the [security model](/Nodepod/docs/concepts/security/).
