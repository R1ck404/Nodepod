// Dev server for all examples. Serves from project root with cross-origin isolation headers.
// Usage: node examples/serve.js

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = 3333;

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url.endsWith('/')) url += 'index.html';
  // Serve SW from root path so its scope can cover "/"
  const file = url === '/__sw__.js' ? '/dist/__sw__.js'
    : url === '/index.html' ? '/examples/basic/index.html' : url;
  try {
    const content = readFileSync(join(root, file));
    const headers = {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cache-Control': 'no-store',
    };
    // Allow SW to control root scope even when served from /dist/
    if (url === '/__sw__.js') headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(port, () => {
  console.log(`Examples server running at http://localhost:${port}`);
  console.log(`  Basic:                http://localhost:${port}/examples/basic/`);
  console.log(`  Brotli test:          http://localhost:${port}/examples/brotli-test/`);
  console.log(`  Child process test:   http://localhost:${port}/examples/child-process-test/`);
  console.log(`  Vite build test:      http://localhost:${port}/examples/vite-build-test/`);
  console.log(`  Native WASI test:     http://localhost:${port}/examples/native-wasi-test/`);
  console.log(`  SW setup DX:          http://localhost:${port}/examples/sw-setup/`);
  console.log(`  Custom commands:      http://localhost:${port}/examples/custom-commands/`);
  console.log(`  Terminal resize:      http://localhost:${port}/examples/terminal-resize/`);
  console.log(`  Shared FS attach:     http://localhost:${port}/examples/shared-fs-attach/`);
  console.log(`  SAB opt-out:          http://localhost:${port}/examples/sab-opt-out/`);
  console.log(`  Multi-boot race (#39):http://localhost:${port}/examples/multi-boot-race/`);
  console.log(`  Tailwind v4 (#54):    http://localhost:${port}/examples/issue-54-tailwind-v4/`);
  console.log(`  Tailwind v3 + vite 8: http://localhost:${port}/examples/tailwind-v3-test/`);
  console.log(`  typebox 1.x (#56):    http://localhost:${port}/examples/issue-56-typebox-1x/`);
  console.log(`  Vite HMR test:        http://localhost:${port}/examples/vite-hmr-test/`);
  console.log(`  Dev playground:       http://localhost:${port}/examples/dev-playground/`);
  console.log(`  SQLite test:          http://localhost:${port}/examples/sqlite-test/`);
  console.log(`  Better Auth + Vite:   http://localhost:${port}/examples/better-auth-vite/  (React Router demo in app/)`);
  console.log(`  Vite dev exit 1:      http://localhost:${port}/examples/vite-dev-exit-1/  (auth+sqlite repro)`);
  console.log(`  Scelar auth template: http://localhost:${port}/examples/scelar-auth-template/`);
  console.log(`  Scelar Vite repro:    http://localhost:${port}/examples/scelar-vite-config-repro/`);
  console.log(`  Terminal + preview:   http://localhost:${port}/examples/terminal/`);
  console.log(`  Preview inspector:     http://localhost:${port}/examples/preview-inspector/`);
});
