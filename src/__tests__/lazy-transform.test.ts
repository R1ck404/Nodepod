// Plan 016: prove the runtime module loader handles UNTRANSFORMED packages
// exactly as extracted from npm tarballs (no install-time esbuild pass).
// These fixtures are the regression net for the lazy-transform default.

import { describe, it, expect } from "vitest";
import { ScriptEngine } from "../script-engine";
import { MemoryVolume } from "../memory-volume";
import { isEagerTransform } from "../packages/installer";

function createEngine(files: Record<string, string>) {
  const vol = new MemoryVolume();
  vol.mkdirSync("/project", { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const dir = path.substring(0, path.lastIndexOf("/")) || "/";
    if (dir !== "/") vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(path, content);
  }
  return { vol, engine: new ScriptEngine(vol, { cwd: "/project" }) };
}

describe("untransformed package loading (lazy transform default)", () => {
  it("plain CJS package", () => {
    const { engine } = createEngine({
      "/project/node_modules/cjs-pkg/package.json":
        '{"name":"cjs-pkg","version":"1.0.0","main":"lib/index.js"}',
      "/project/node_modules/cjs-pkg/lib/index.js":
        'const helper = require("./helper");\nmodule.exports = { double: helper.double, name: "cjs" };',
      "/project/node_modules/cjs-pkg/lib/helper.js":
        "exports.double = (x) => x * 2;",
      "/project/main.js":
        'const pkg = require("cjs-pkg");\nmodule.exports = { result: pkg.double(21), name: pkg.name };',
    });
    const result = engine.runFile("/project/main.js");
    expect((result.exports as any).result).toBe(42);
    expect((result.exports as any).name).toBe("cjs");
  });

  it('ESM package with "type": "module"', () => {
    const { engine } = createEngine({
      "/project/node_modules/esm-pkg/package.json":
        '{"name":"esm-pkg","version":"1.0.0","type":"module","main":"index.js"}',
      "/project/node_modules/esm-pkg/index.js":
        'import { triple } from "./math.js";\nexport const value = triple(3);\nexport default { kind: "esm" };',
      "/project/node_modules/esm-pkg/math.js":
        "export function triple(x) { return x * 3; }",
      "/project/main.js":
        'const pkg = require("esm-pkg");\nmodule.exports = { value: pkg.value, kind: (pkg.default || pkg).kind };',
    });
    const result = engine.runFile("/project/main.js");
    expect((result.exports as any).value).toBe(9);
    expect((result.exports as any).kind).toBe("esm");
  });

  it("ESM syntax in .js WITHOUT type:module (common in older packages)", () => {
    const { engine } = createEngine({
      "/project/node_modules/loose-esm/package.json":
        '{"name":"loose-esm","version":"1.0.0","main":"index.js"}',
      "/project/node_modules/loose-esm/index.js":
        'export const answer = 42;\nexport function greet(n) { return "hi " + n; }',
      "/project/main.js":
        'const pkg = require("loose-esm");\nmodule.exports = { answer: pkg.answer, greeting: pkg.greet("x") };',
    });
    const result = engine.runFile("/project/main.js");
    expect((result.exports as any).answer).toBe(42);
    expect((result.exports as any).greeting).toBe("hi x");
  });

  it('dual-mode package with "exports" map (require condition)', () => {
    const { engine } = createEngine({
      "/project/node_modules/dual-pkg/package.json": JSON.stringify({
        name: "dual-pkg",
        version: "1.0.0",
        main: "./cjs/index.js",
        module: "./esm/index.js",
        exports: {
          ".": {
            require: "./cjs/index.js",
            import: "./esm/index.js",
          },
          "./feature": {
            require: "./cjs/feature.js",
            import: "./esm/feature.js",
          },
        },
      }),
      "/project/node_modules/dual-pkg/cjs/index.js":
        'module.exports = { mode: "cjs", feature: require("./feature.js") };',
      "/project/node_modules/dual-pkg/cjs/feature.js":
        'module.exports = { flag: true };',
      "/project/node_modules/dual-pkg/esm/index.js":
        'export const mode = "esm";',
      "/project/node_modules/dual-pkg/esm/feature.js":
        "export const flag = true;",
      "/project/main.js":
        'const pkg = require("dual-pkg");\nconst feature = require("dual-pkg/feature");\nmodule.exports = { mode: pkg.mode, flag: feature.flag };',
    });
    const result = engine.runFile("/project/main.js");
    expect((result.exports as any).mode).toBe("cjs");
    expect((result.exports as any).flag).toBe(true);
  });

  it(".mjs entry resolved through exports map", () => {
    const { engine } = createEngine({
      "/project/node_modules/mjs-pkg/package.json": JSON.stringify({
        name: "mjs-pkg",
        version: "1.0.0",
        exports: { ".": "./index.mjs" },
      }),
      "/project/node_modules/mjs-pkg/index.mjs":
        "export const source = 'mjs';",
      "/project/main.js":
        'const pkg = require("mjs-pkg");\nmodule.exports = pkg.source;',
    });
    const result = engine.runFile("/project/main.js");
    expect(result.exports).toBe("mjs");
  });
});

describe("transformModules option normalization", () => {
  it("defaults to lazy (no install-time transforms)", () => {
    expect(isEagerTransform(undefined)).toBe(false);
    expect(isEagerTransform(false)).toBe(false);
  });

  it('"eager" and legacy true restore install-time transforms', () => {
    expect(isEagerTransform("eager")).toBe(true);
    expect(isEagerTransform(true)).toBe(true);
  });
});
