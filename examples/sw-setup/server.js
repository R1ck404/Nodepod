// Alt dev server showing `@r1ck404/nodepod/server`. Same behaviour as
// examples/serve.js, but serves /__sw__.js via `serveSWNode()` instead of
// a hand-rolled readFileSync + headers block.
//
// Run from the repo root:
//   node examples/sw-setup/server.js
// Then open http://localhost:3334/examples/sw-setup/
//
// In a real app the import would be '@r1ck404/nodepod/server'. Here it
// reaches into dist/ because the example lives in this repo.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { serveSWNode } from "../../dist/integrations/server.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const port = 3334;

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

// Warm up the cache so the first /__sw__.js hit doesn't pay the fs read.
await serveSWNode();

createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  // The one-liner from @r1ck404/nodepod/server. We tack on COOP/COEP
  // because those are the host's job, not nodepod's.
  if (url === "/__sw__.js") {
    const { body, headers } = await serveSWNode();
    res.writeHead(200, {
      ...headers,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    });
    res.end(body);
    return;
  }

  // Static file serving for everything else (mirrors examples/serve.js).
  const file = url.endsWith("/") ? url + "index.html" : url;
  try {
    const content = readFileSync(join(root, file));
    res.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(port, () => {
  console.log(`sw-setup example server → http://localhost:${port}/examples/sw-setup/`);
  console.log("  (uses serveSWNode() from @r1ck404/nodepod/server for /__sw__.js)");
});
