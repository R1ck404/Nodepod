import { describe, it, expect } from "vitest";
import { ScriptEngine } from "../script-engine";
import { MemoryVolume } from "../memory-volume";

function createEngine(files?: Record<string, string>) {
  const vol = new MemoryVolume();
  vol.mkdirSync("/project", { recursive: true });
  if (files) {
    for (const [path, content] of Object.entries(files)) {
      const dir = path.substring(0, path.lastIndexOf("/")) || "/";
      if (dir !== "/") vol.mkdirSync(dir, { recursive: true });
      vol.writeFileSync(path, content);
    }
  }
  return { vol, engine: new ScriptEngine(vol, { cwd: "/project" }) };
}

describe("ScriptEngine", () => {
  describe("execute()", () => {
    it("runs basic JS and returns exports", () => {
      const { engine } = createEngine();
      const result = engine.execute("module.exports = 42;", "/index.js");
      expect(result.exports).toBe(42);
    });

    it("module.exports = object", () => {
      const { engine } = createEngine();
      const result = engine.execute(
        "module.exports = { x: 1 };",
        "/index.js",
      );
      expect(result.exports).toEqual({ x: 1 });
    });

    it("exports.x = value shorthand", () => {
      const { engine } = createEngine();
      const result = engine.execute("exports.x = 1;", "/index.js");
      expect((result.exports as any).x).toBe(1);
    });

    it("has access to __dirname and __filename", () => {
      const { engine } = createEngine();
      const result = engine.execute(
        "module.exports = { dir: __dirname, file: __filename };",
        "/project/test.js",
      );
      expect((result.exports as any).dir).toBe("/project");
      expect((result.exports as any).file).toBe("/project/test.js");
    });

    it("has access to process object", () => {
      const { engine } = createEngine();
      const result = engine.execute(
        "module.exports = process.platform;",
        "/index.js",
      );
      expect(result.exports).toBe("linux");
    });

    it("exposes the Console constructor from node:console", () => {
      const { engine } = createEngine();
      const result = engine.execute(
        'const { Console } = require("node:console"); module.exports = typeof Console;',
        "/index.js",
      );
      expect(result.exports).toBe("function");
    });

    it("handles syntax errors by throwing", () => {
      const { engine } = createEngine();
      expect(() => engine.execute("const {", "/bad.js")).toThrow();
    });
  });

  describe("runFile()", () => {
    it("reads file from volume and executes", () => {
      const { engine } = createEngine({
        "/project/app.js": 'module.exports = "hello";',
      });
      const result = engine.runFile("/project/app.js");
      expect(result.exports).toBe("hello");
    });

    it("throws for nonexistent file", () => {
      const { engine } = createEngine();
      expect(() => engine.runFile("/nonexistent.js")).toThrow();
    });

  });

  describe("require()", () => {
    it("requires a local file with relative path", () => {
      const { engine } = createEngine({
        "/project/lib.js": "module.exports = 10;",
      });
      const result = engine.execute(
        'const lib = require("./lib"); module.exports = lib;',
        "/project/index.js",
      );
      expect(result.exports).toBe(10);
    });

    it("reads a package-local file URL from CommonJS", () => {
      const { engine } = createEngine({
        "/project/node_modules/pkg/package.json": '{"main":"index.cjs"}',
        "/project/node_modules/pkg/index.cjs":
          'const fs = require("fs"); const href = new (require("url").URL)("file:" + __filename).href; module.exports = fs.readFileSync(new URL("asset.wasm", href), "utf8");',
        "/project/node_modules/pkg/asset.wasm": "wasm-bytes",
      });
      const result = engine.execute(
        'module.exports = require("pkg");',
        "/project/index.js",
      );
      expect(result.exports).toBe("wasm-bytes");
    });

    it("requires chained files (A requires B requires C)", () => {
      const { engine } = createEngine({
        "/project/c.js": "module.exports = 3;",
        "/project/b.js":
          'module.exports = require("./c") * 2;',
        "/project/a.js":
          'module.exports = require("./b") + 1;',
      });
      const result = engine.runFile("/project/a.js");
      expect(result.exports).toBe(7);
    });

    it("caches modules (same object returned on second require)", () => {
      const { engine } = createEngine({
        "/project/mod.js": "module.exports = { count: 0 };",
      });
      const result = engine.execute(
        'const a = require("./mod"); const b = require("./mod"); a.count++; module.exports = b.count;',
        "/project/test.js",
      );
      expect(result.exports).toBe(1);
    });

    it("requires built-in modules: path", () => {
      const { engine } = createEngine();
      const result = engine.execute(
        'const p = require("path"); module.exports = p.join("/a", "b");',
        "/index.js",
      );
      expect(result.exports).toBe("/a/b");
    });

    it("requires built-in modules: events", () => {
      const { engine } = createEngine();
      const result = engine.execute(
        'const EE = require("events"); module.exports = typeof EE;',
        "/index.js",
      );
      expect(result.exports).toBe("function");
    });

    it("resolves package shims to VFS paths while preserving builtins", async () => {
      const { engine } = createEngine({
        "/project/node_modules/rollup/package.json": JSON.stringify({
          name: "rollup",
          version: "4.0.0",
          main: "dist/rollup.js",
        }),
        "/project/node_modules/rollup/dist/rollup.js":
          "module.exports = {};",
        "/project/resolve-probe.mjs": [
          'import { createRequire } from "node:module";',
          'import path from "node:path";',
          "const requireFromFile = createRequire(import.meta.url);",
          'const resolved = requireFromFile.resolve("rollup");',
          'const builtin = requireFromFile.resolve("path");',
          "export default { resolved, packagePath: path.resolve(resolved, \"../../package.json\"), builtin };",
        ].join("\n"),
      });

      const result = await engine.runFileTLA("/project/resolve-probe.mjs");
      expect(result.exports).toEqual({
        resolved: "/project/node_modules/rollup/dist/rollup.js",
        packagePath: "/project/node_modules/rollup/package.json",
        builtin: "path",
      });
    });

    // napi-rs wasm bindings each nest @napi-rs/wasm-runtime@1.2.4 next to the
    // @emnapi/core they were built with; one shared instance handed satteri's
    // wasm rolldown's emnapi 2.x ("napi_set_last_error" LinkError in astro)
    it("keeps same-version package copies apart when their peers differ", () => {
      const rt = (at: string) => ({
        [`${at}/rt/package.json`]: JSON.stringify({
          name: "rt",
          version: "1.0.0",
          peerDependencies: { core: "*" },
        }),
        [`${at}/rt/index.js`]: 'module.exports = { core: require("core") };',
      });
      const core = (at: string, version: string) => ({
        [`${at}/core/package.json`]: JSON.stringify({ name: "core", version }),
        [`${at}/core/index.js`]: `module.exports = "core ${version}";`,
      });
      const binding = (name: string) => ({
        [`/project/node_modules/${name}/package.json`]: JSON.stringify({ name }),
        [`/project/node_modules/${name}/index.js`]: 'module.exports = require("rt");',
      });
      const { engine } = createEngine({
        ...binding("a"),
        ...rt("/project/node_modules/a/node_modules"),
        ...core("/project/node_modules/a/node_modules", "2.0.0"),
        ...binding("b"),
        ...rt("/project/node_modules/b/node_modules"),
        ...core("/project/node_modules/b/node_modules", "1.0.0"),
        ...binding("c"),
        ...rt("/project/node_modules/c/node_modules"),
        ...binding("d"),
        ...rt("/project/node_modules/d/node_modules"),
        ...core("/project/node_modules", "1.1.0"),
      });
      const result = engine.execute(
        'const [a, b, c, d] = ["a", "b", "c", "d"].map((n) => require(n)); module.exports = { a: a.core, b: b.core, c: c.core, cdShared: c === d };',
        "/project/index.js",
      );
      expect(result.exports).toEqual({
        a: "core 2.0.0",
        b: "core 1.0.0",
        c: "core 1.1.0",
        // copies that see the same dependencies are still one instance
        cdShared: true,
      });
    });

    it("requires JSON files", () => {
      const { engine } = createEngine({
        "/project/data.json": '{"key": "value"}',
      });
      const result = engine.execute(
        'module.exports = require("./data.json");',
        "/project/index.js",
      );
      expect(result.exports).toEqual({ key: "value" });
    });

    it("throws for missing module", () => {
      const { engine } = createEngine();
      expect(() =>
        engine.execute('require("./nonexistent");', "/index.js"),
      ).toThrow();
    });
  });

  describe("ESM auto-conversion", () => {
    it("auto-converts import/export to CJS when required", () => {
      const { engine } = createEngine({
        "/project/mod.js": "export const x = 42;",
      });
      const result = engine.execute(
        'const m = require("./mod"); module.exports = m.x;',
        "/project/index.js",
      );
      expect(result.exports).toBe(42);
    });

    it("preserves a default export when ESM imports a binding named module", () => {
      const { engine } = createEngine({
        "/project/binding.js":
          'module.exports = { marker: "binding" };',
        "/project/get-exe-path.mjs": [
          'import module from "./binding.js";',
          "export default function getExePath() { return module.marker; }",
        ].join("\n"),
      });
      const result = engine.execute(
        'module.exports = require("./get-exe-path.mjs");',
        "/project/index.js",
      );
      expect(typeof result.exports).toBe("function");
      expect((result.exports as () => string)()).toBe("binding");
    });

    it("handles export function containing dynamic import() without corruption", () => {
      const { engine } = createEngine({
        "/project/plugin.js": [
          'import path from "path";',
          "export function helper() { return 1; }",
          "export function main() {",
          "  const loader = () => import('./other.js');",
          "  return { loader, val: path.join('a', 'b') };",
          "}",
        ].join("\n"),
      });
      const result = engine.execute(
        'const m = require("./plugin"); module.exports = m.main().val;',
        "/project/index.js",
      );
      expect(result.exports).toBe("a/b");
    });

    it("exposes a callable CommonJS module as dynamic-import default", () => {
      const { engine } = createEngine({
        "/project/plugin.cjs": "module.exports = function plugin() { return 42; };",
        "/project/entry.mjs": [
          "const mod = await import('./plugin.cjs');",
          "export const shape = [typeof mod.default, mod.default()];",
        ].join("\n"),
      });
      const result = engine.execute(
        'module.exports = require("./entry.mjs").shape;',
        "/project/index.js",
      );
      expect(result.exports).toEqual(["function", 42]);
    });

    it("recognizes native promises returned by async module callbacks", () => {
      const { engine } = createEngine({
        "/project/entry.js": [
          "const callback = async () => ({ id: 'entry', external: true });",
          "const result = callback();",
          "module.exports = result instanceof Promise;",
        ].join("\n"),
      });
      const result = engine.runFile("/project/entry.js");
      expect(result.exports).toBe(true);
    });
  });

  describe("clearCache()", () => {
    it("clears module cache so modules are re-evaluated", () => {
      const { engine } = createEngine({
        "/project/counter.js":
          "let c = 0; module.exports = { inc() { return ++c; } };",
      });
      engine.execute(
        'module.exports = require("./counter").inc();',
        "/project/a.js",
      );
      engine.clearCache();
      const result = engine.execute(
        'module.exports = require("./counter").inc();',
        "/project/b.js",
      );
      // c resets to 0 after cache clear
      expect(result.exports).toBe(1);
    });
  });

  describe("createREPL()", () => {
    it("evaluates expressions", () => {
      const { engine } = createEngine();
      const repl = engine.createREPL();
      expect(repl.eval("1 + 1")).toBe(2);
    });

    it("evaluates variable declarations across calls", () => {
      const { engine } = createEngine();
      const repl = engine.createREPL();
      repl.eval("var x = 10");
      expect(repl.eval("x")).toBe(10);
    });
  });

  describe("shebang handling", () => {
    it("strips shebang line", () => {
      const { engine } = createEngine({
        "/project/script.js":
          "#!/usr/bin/env node\nmodule.exports = 42;",
      });
      const result = engine.runFile("/project/script.js");
      expect(result.exports).toBe(42);
    });
  });
});
