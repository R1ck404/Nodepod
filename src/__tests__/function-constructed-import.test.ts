// `new Function("specifier", "return import(specifier)")` is how CommonJS
// builds keep an ESM-only dependency loadable without the CJS transform
// turning import() into require() (@preact/preset-vite's
// transform-hook-names, import-meta-resolve, ...). The body is assembled at
// runtime, so the module-source rewrite of import() -> __asyncLoad() never
// saw it and the worker's native import() got a bare specifier:
// "Failed to resolve module specifier 'zimmerframe'".

import { describe, it, expect } from "vitest";
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

const DEP = {
  "/project/node_modules/zimmerframe/package.json": JSON.stringify({
    name: "zimmerframe", version: "1.0.0", type: "module", exports: "./index.js",
  }),
  "/project/node_modules/zimmerframe/index.js": "export function walk(n) { return 'walked:' + n; }\n",
};

describe("Function-constructed dynamic import", () => {
  it("routes import() inside a `new Function` body through the module loader", async () => {
    const engine = createEngine({
      ...DEP,
      "/project/plugin.cjs": [
        "const importEsm = new Function('specifier', 'return import(specifier)');",
        "module.exports = { importEsm };",
      ].join("\n"),
    });
    const { importEsm } = engine.execute(
      "module.exports = require('./plugin.cjs');",
      "/project/__entry.js",
    ).exports as { importEsm: (s: string) => Promise<{ walk: (n: string) => string }> };
    const ns = await importEsm("zimmerframe");
    expect(ns.walk("x")).toBe("walked:x");
  });

  it("resolves relative to the module that built the function", async () => {
    const engine = createEngine({
      "/project/lib/local.mjs": "export const where = 'lib';\n",
      "/project/lib/loader.cjs":
        "module.exports = new Function('s', 'return import(s)');",
    });
    const load = engine.execute(
      "module.exports = require('./lib/loader.cjs');",
      "/project/__entry.js",
    ).exports as (s: string) => Promise<{ where: string }>;
    expect((await load("./local.mjs")).where).toBe("lib");
  });

  it("leaves ordinary Function bodies on the native constructor", () => {
    const engine = createEngine({
      "/project/plain.cjs": [
        "const add = new Function('a', 'b', 'return a + b');",
        "const imp = Function('s', 'return import(s)');",
        "module.exports = {",
        "  sum: add(2, 3), addLen: add.length, impLen: imp.length,",
        "  isFn: add instanceof Function, ctorOk: Function.prototype === Object.getPrototypeOf(add),",
        "  src: add.toString().includes('return a + b'),",
        "};",
      ].join("\n"),
    });
    const r = engine.execute("module.exports = require('./plain.cjs');", "/project/__entry.js").exports;
    expect(r).toEqual({ sum: 5, addLen: 2, impLen: 1, isFn: true, ctorOk: true, src: true });
  });
});
