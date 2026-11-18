// helpers for deploying a cross-origin sandbox environment

// Node.js-only helper. Uses opaque dynamic require so bundlers can't resolve it.
function readServiceWorkerSource(): string | null {
  try {
    // invisible to bundlers' static analysis
    const _req = globalThis['require' as keyof typeof globalThis] as typeof require | undefined;
    if (typeof _req !== 'function') return null;
    const fs = _req('fs' + '');
    const path = _req('path' + '');
    let dir: string;
    try {
      const url = _req('url' + '');
      dir = path.dirname(url.fileURLToPath(import.meta.url));
    } catch {
      dir = typeof __dirname !== 'undefined' ? __dirname : '.';
    }

    let swFile = path.join(dir, '__sw__.js');
    if (fs.existsSync(swFile)) return fs.readFileSync(swFile, 'utf-8');
    swFile = path.join(dir, '../dist/__sw__.js');
    if (fs.existsSync(swFile)) return fs.readFileSync(swFile, 'utf-8');
    return null;
  } catch {
    return null;
  }
}

import { DEFAULT_NODEPOD_CDN } from "./constants/config.js";

export interface SandboxPageConfig {
  nodepodUrl?: string;
  enableServiceWorker?: boolean;
  /** parent page origin, e.g. 'https://myapp.com'. locks down who can
   *  talk to the sandbox. defaults to '*' for backwards compat */
  parentOrigin?: string;
}

export function getSandboxPageHtml(config: SandboxPageConfig | string = {}): string {
  const opts: SandboxPageConfig = typeof config === 'string' ? { nodepodUrl: config } : config;
  const nodepodUrl = opts.nodepodUrl ?? DEFAULT_NODEPOD_CDN;
  const withSW = opts.enableServiceWorker ?? true;
  const parentOriginJs = opts.parentOrigin ? JSON.stringify(opts.parentOrigin) : "'*'";

  const swBlock = withSW ? `
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/__sw__.js', { scope: '/' })
      .then(() => console.log('[Sandbox] SW registered'))
      .catch(e => console.warn('[Sandbox] SW failed:', e));
  }
` : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Nodepod Sandbox</title></head>
<body>
<script type="module">
  import { MemoryVolume, ScriptEngine } from '${nodepodUrl}';
${swBlock}
  const PARENT_ORIGIN = ${parentOriginJs};
  let volume = null;
  let engine = null;

  window.addEventListener('message', async (event) => {
    if (PARENT_ORIGIN !== '*' && event.origin !== PARENT_ORIGIN) return;
    const { type, id, code, filename, snapshot, config, path, content } = event.data;
    try {
      switch (type) {
        case 'init':
          volume = MemoryVolume.fromSnapshot(snapshot);
          engine = new ScriptEngine(volume, {
            cwd: config?.cwd,
            env: config?.env,
            onConsole: (method, args) => {
              parent.postMessage({ type: 'console', consoleMethod: method, consoleArgs: args }, PARENT_ORIGIN);
            },
          });
          break;
        case 'syncFile':
          if (volume) {
            if (content === null) { try { volume.unlinkSync(path); } catch {} }
            else { volume.writeFileSync(path, content); }
          }
          break;
        case 'execute':
          if (!engine) { parent.postMessage({ type: 'error', id, error: 'Engine not initialized' }, PARENT_ORIGIN); return; }
          parent.postMessage({ type: 'result', id, result: engine.execute(code, filename) }, PARENT_ORIGIN);
          break;
        case 'runFile':
          if (!engine) { parent.postMessage({ type: 'error', id, error: 'Engine not initialized' }, PARENT_ORIGIN); return; }
          parent.postMessage({ type: 'result', id, result: engine.runFile(filename) }, PARENT_ORIGIN);
          break;
        case 'clearCache':
          if (engine) engine.clearCache();
          break;
      }
    } catch (err) {
      if (id) parent.postMessage({ type: 'error', id, error: err instanceof Error ? err.message : String(err) }, PARENT_ORIGIN);
    }
  });

  parent.postMessage({ type: 'ready' }, PARENT_ORIGIN);
</script>
</body>
</html>`;
}

// Vercel config with CORS headers for cross-origin iframe embedding
export function getSandboxHostingConfig(): object {
  return {
    headers: [{
      source: '/(.*)',
      headers: [
        { key: 'Access-Control-Allow-Origin', value: '*' },
        { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
      ],
    }],
  };
}

export interface GeneratedSandboxFiles {
  'index.html': string;
  'vercel.json': string;
  '__sw__.js'?: string;
}

export function generateSandboxDeployment(config: SandboxPageConfig | string = {}): GeneratedSandboxFiles {
  const opts: SandboxPageConfig = typeof config === 'string' ? { nodepodUrl: config } : config;
  const withSW = opts.enableServiceWorker ?? true;
  const swSource = withSW ? readServiceWorkerSource() : null;

  const files: GeneratedSandboxFiles = {
    'index.html': getSandboxPageHtml(opts),
    'vercel.json': JSON.stringify(getSandboxHostingConfig(), null, 2),
  };

  if (swSource) files['__sw__.js'] = swSource;
  return files;
}

export const SANDBOX_DEPLOYMENT_GUIDE = `
# Deploying a Nodepod Sandbox

## 1. Generate sandbox files
   Use generateSandboxDeployment() to create the required files.

## 2. Deploy to a hosting provider
   cd sandbox && vercel --prod

## 3. Use in your app
   const engine = await spawnEngine(volume, {
     sandboxUrl: 'https://your-sandbox.example.com'
   });
`.trim();
