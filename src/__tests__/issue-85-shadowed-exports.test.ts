// regression tests for issue #85
// https://github.com/R1ck404/Nodepod/issues/85
//
// vite's node chunk (5.4.x) bundles dotenv, whose inlined package.json
// becomes a top-level `var exports = { ".": {...} }`. `var` hoists over the
// wrapper's own `var exports = $exports`, so every `exports.X = X` the
// ESM->CJS converter appended landed on that object and the chunk exported
// nothing: `import('vite')` gave `{ build: undefined }` and the CLI died
// with "Cannot destructure property 'build' of '(intermediate value)'".
// Named exports must go through the same unshadowable binding the default
// export already uses.

import { describe, it, expect } from "vitest";
import { esmToCjs } from "../syntax-transforms";
import { ScriptEngine } from "../script-engine";
import { MemoryVolume } from "../memory-volume";

function createEngine(files: Record<string, string>) {
  const vol = new MemoryVolume();
  vol.mkdirSync("/project", { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const dir = path.substring(0, path.lastIndexOf("/")) || "/";
    if (dir !== "/") vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(path, content);
  }
  return new ScriptEngine(vol, { cwd: "/project" });
}

// the shape rollup emits for a bundled package.json
const SHADOWED_CHUNK = [
  'var version = "16.4.5";',
  "var exports = {",
  '  ".": { require: "./lib/main.js", "default": "./lib/main.js" }',
  "};",
  "var require$$0 = { version, exports };",
  "function build(opts) { return { built: true, opts }; }",
  "function createServer() { return { listening: true }; }",
  "const defineConfig = (c) => c;",
  "export { build as b, createServer as c, defineConfig as d, require$$0 as pkg };",
].join("\n");

describe("issue 85: named exports survive a module-level `var exports`", () => {
  it("converter writes named exports to the given exportTarget, never bare `exports`", () => {
    const out = esmToCjs(SHADOWED_CHUNK, { exportTarget: "__nodepodModule.exports" });
    expect(out).toContain("__nodepodModule.exports.b = build");
    expect(out).toContain("__nodepodModule.exports.c = createServer");
    expect(out).toContain("__nodepodModule.exports.pkg = require$$0");
    // the module's own binding is untouched
    expect(out).toContain('var exports = {');
    expect(out).not.toMatch(/(^|[^.\w])exports\.[a-z]+ = /m);
  });

  it("converter covers every named-export form", () => {
    const src = [
      "var exports = {};",
      "export const a = 1;",
      "export function f() {}",
      "export class K {}",
      "export { a as renamed };",
      "export { x as y } from './dep.js';",
      "export * from './star.js';",
      "export * as ns from './ns.js';",
      "export default 42;",
    ].join("\n");
    const out = esmToCjs(src, { exportTarget: "__m.exports" });
    for (const frag of [
      "__m.exports.a = a",
      "__m.exports.f = f",
      "__m.exports.K = K",
      "__m.exports.renamed = a",
      "__m.exports.y = ",
      "Object.assign(__m.exports, require(\"./star.js\"))",
      "__m.exports[\"ns\"] = require(\"./ns.js\")",
      "__m.exports.default = 42",
    ]) {
      expect(out, frag).toContain(frag);
    }
    expect(out).not.toMatch(/(^|[^.\w])exports\.[a-zA-Z]+ = /m);
    expect(out).not.toMatch(/Object\.assign\(exports,/);
  });

  it("engine: a chunk with `var exports` still exports its bindings via require()", () => {
    const engine = createEngine({
      "/project/node_modules/vite/package.json": JSON.stringify({ name: "vite", version: "5.4.20", type: "module" }),
      "/project/node_modules/vite/dist/chunk.js": SHADOWED_CHUNK,
      "/project/node_modules/vite/dist/index.js":
        "export { b as build, c as createServer, d as defineConfig } from './chunk.js';\n",
    });
    const r = engine.execute(
      "const v = require('vite/dist/index.js'); module.exports = { build: typeof v.build, createServer: typeof v.createServer, result: v.build({ x: 1 }) };",
      "/project/__entry.js",
    );
    expect(r.exports).toEqual({
      build: "function",
      createServer: "function",
      result: { built: true, opts: { x: 1 } },
    });
  });

  it("engine: the same through dynamic import() (vite's cli pattern)", async () => {
    const engine = createEngine({
      "/project/node_modules/vite/package.json": JSON.stringify({ name: "vite", version: "5.4.20", type: "module" }),
      "/project/node_modules/vite/dist/chunk.js": SHADOWED_CHUNK,
      "/project/cli.mjs": [
        "const { b: build } = await import('./node_modules/vite/dist/chunk.js');",
        "export const result = build('cli');",
      ].join("\n"),
    });
    const { exports } = await engine.runFileTLA("/project/cli.mjs");
    expect((exports as { result: unknown }).result).toEqual({ built: true, opts: "cli" });
  });
});
