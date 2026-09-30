// Generates a realistic Vite + React + TS project (no framework-specific code in
// nodepod is exercised specially; this is just a representative workload).
// heavy: a dependency tree closer to real apps (UI kit, utilities, 3D,
// TypeScript) with components importing from it.
const HEAVY_DEPS = {
  "@mui/material": "7.3.2", "@emotion/react": "11.14.0", "@emotion/styled": "11.14.1",
  lodash: "4.17.21", three: "0.180.0", "date-fns": "4.1.0", rxjs: "7.8.2",
};
export function makeProject({ components = 300, viteVersion = "6.4.1", pluginReact = "^4.7.0", heavy = false } = {}) {
  const files = {};
  files["package.json"] = JSON.stringify({
    name: "bench-app",
    private: true,
    version: "0.0.0",
    type: "module",
    scripts: { dev: "vite", build: "vite build" },
    dependencies: { react: "19.1.0", "react-dom": "19.1.0", ...(heavy ? HEAVY_DEPS : {}) },
    devDependencies: { vite: viteVersion, "@vitejs/plugin-react": pluginReact, ...(heavy ? { typescript: "5.9.2" } : {}) },
  }, null, 2);
  if (heavy) {
    files["src/utils/heavy.ts"] = `import debounce from 'lodash/debounce';
import { format as fmtDate } from 'date-fns';
import { Subject } from 'rxjs';
import { Vector3 } from 'three';
export const bus = new Subject<number>();
export const tick = debounce(() => bus.next(Date.now()), 10);
export function stamp(): string { return fmtDate(new Date(0), 'yyyy') + new Vector3(1, 2, 3).length().toFixed(2); }
`;
  }
  files["vite.config.js"] = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5173, strictPort: true },
  logLevel: 'info',
});
`;
  files["index.html"] = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>bench</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
`;
  files["src/index.css"] = `:root { font-family: system-ui; }\n.c { padding: 1px; }\n` +
    Array.from({ length: 200 }, (_, i) => `.u${i} { margin: ${i % 7}px; color: #${(i * 4099).toString(16).padStart(6, "0").slice(0, 6)}; }`).join("\n");
  files["src/utils/format.ts"] = `export interface Item { id: number; label: string }
export function format(n: number): string { return 'v' + n.toString(36); }
export function makeItems(count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({ id: i, label: format(i) }));
}
export const enumLike = { A: 1, B: 2, C: 3 } as const;
`;
  files["src/utils/hooks.ts"] = `import { useState, useCallback } from 'react';
export function useCounter(initial = 0) {
  const [n, set] = useState(initial);
  const inc = useCallback(() => set((v) => v + 1), []);
  return [n, inc] as const;
}
`;
  const mod = (i) => `C${i}`;
  for (let i = 0; i < components; i++) {
    const children = [2 * i + 1, 2 * i + 2].filter((c) => c < components);
    const hasCssModule = i % 10 === 0;
    const imports = [
      `import { useMemo } from 'react';`,
      heavy && i % 3 === 0 ? `import { Button, Card } from '@mui/material';
import { stamp } from '../utils/heavy';` : "",
      `import { format, makeItems, type Item } from '../utils/format';`,
      `import { useCounter } from '../utils/hooks';`,
      ...children.map((c) => `import ${mod(c)} from './${mod(c)}';`),
      hasCssModule ? `import styles from './${mod(i)}.module.css';` : "",
    ].filter(Boolean).join("\n");
    if (hasCssModule) files[`src/components/${mod(i)}.module.css`] = `.box { border: 1px solid #${(i * 997).toString(16).padStart(6, "0").slice(0, 6)}; }\n.title { font-weight: ${i % 2 ? 700 : 400}; }\n`;
    files[`src/components/${mod(i)}.tsx`] = `${imports}

interface Props { depth?: number }

/** Component ${i}: exercises TS types, JSX, hooks and child imports. */
export default function ${mod(i)}({ depth = 0 }: Props) {
  const [count, inc] = useCounter(${i});
  const items: Item[] = useMemo(() => makeItems(${(i % 5) + 1}), []);
  const label: string = format(count + depth);
  return (
    <div className={${hasCssModule ? "styles.box + ' c u" + (i % 200) + "'" : `'c u${i % 200}'`}} data-id="${i}" onClick={inc}>
      <span${hasCssModule ? " className={styles.title}" : ""}>${mod(i)}:{label}</span>${heavy && i % 3 === 0 ? `<Card><Button size="small">{stamp()}</Button></Card>` : ""}
      {items.map((it) => <i key={it.id}>{it.label}</i>)}
      ${children.map((c) => `<${mod(c)} depth={depth + 1} />`).join("\n      ")}
    </div>
  );
}
`;
  }
  files["src/App.tsx"] = appSource("MARKER_0");
  files["src/main.tsx"] = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
`;
  return files;
}

export function appSource(marker) {
  return `import { useEffect } from 'react';
import C0 from './components/C0';
export default function App() {
  useEffect(() => {
    const count = document.querySelectorAll('.c').length;
    const marker = document.getElementById('marker')?.textContent;
    (window.parent !== window ? window.parent : window).postMessage({ type: 'bench-rendered', count, marker, href: location.href, t: performance.now() }, '*');
  });
  return <main><h1 id="marker">${marker}</h1><C0 /></main>;
}
`;
}

// Minimal "browser-like" crawler over a fetch-like function. Follows static
// and dynamic imports in served JS modules, like the browser module loader.
export async function crawl(fetchText, { entry = "/" } = {}) {
  const seen = new Set();
  let bytes = 0;
  let requests = 0;
  const importRe = /(?:^|[;\n}\s])(?:import|export)\s*(?:[\w*{}\s,$]*?\sfrom\s*)?["']([^"'\n]+)["']/g;
  const dynRe = /import\(\s*["']([^"'\n]+)["']\s*\)/g;
  const scriptRe = /<script[^>]*\ssrc=["']([^"']+)["']/g;
  const resolve = (spec, base) => {
    if (/^(?:https?:|data:)/.test(spec)) return null;
    return new URL(spec, "http://x" + base).pathname + new URL(spec, "http://x" + base).search;
  };
  async function visit(url, kind) {
    if (seen.has(url)) return;
    seen.add(url);
    const text = await fetchText(url);
    requests++;
    bytes += text.length;
    const next = [];
    if (kind === "html") {
      for (const m of text.matchAll(scriptRe)) next.push(resolve(m[1], url));
    } else {
      for (const m of text.matchAll(importRe)) next.push(resolve(m[1], url));
      for (const m of text.matchAll(dynRe)) next.push(resolve(m[1], url));
    }
    await Promise.all(next.filter(Boolean).map((u) => visit(u, "js")));
  }
  await visit(entry, "html");
  return { requests, bytes, urls: [...seen] };
}
