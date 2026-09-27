// Some require() results are Proxies over an empty target that forward to the
// real exports (child_process until the shell loads, async-WASM modules). A
// getOwnPropertyDescriptor trap must not report a property non-configurable
// when the target lacks it (Proxy invariant). A browser ES module namespace
// (the lazily imported child_process polyfill) and esbuild's __export getters
// are exactly that, so esbuild's `__toESM(require("child_process"), 1)` in
// zx threw: "'getOwnPropertyDescriptor' on proxy: trap reported
// non-configurability for property 'ShellProcess'".

import { describe, it, expect, afterEach } from "vitest";
import { ScriptEngine, setChildProcessPolyfill } from "../script-engine";
import { MemoryVolume } from "../memory-volume";
import * as childProcess from "../polyfills/child_process";

function createEngine(files: Record<string, string> = {}) {
  const vol = new MemoryVolume();
  vol.mkdirSync("/project", { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const dir = path.substring(0, path.lastIndexOf("/")) || "/";
    if (dir !== "/") vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(path, content);
  }
  return new ScriptEngine(vol, { cwd: "/project" });
}

// esbuild's CJS interop helpers, as bundled by zx (build/esblib.cjs)
const ESBUILD_TO_ESM = `
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of Object.getOwnPropertyNames(from))
      if (!Object.prototype.hasOwnProperty.call(to, key) && key !== except)
        Object.defineProperty(to, key, { get: () => from[key], enumerable: !(desc = Object.getOwnPropertyDescriptor(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? Object.create(Object.getPrototypeOf(mod)) : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? Object.defineProperty(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
`;

// Browser ES module namespaces report every export as non-configurable;
// vitest's namespace objects don't, so model one explicitly.
function namespaceLike(src: Record<string, unknown>): Record<string, unknown> {
  const ns = Object.create(null);
  for (const key of Object.keys(src)) {
    Object.defineProperty(ns, key, {
      value: src[key], writable: true, enumerable: true, configurable: false,
    });
  }
  Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" });
  return Object.preventExtensions(ns);
}

describe("module export proxies", () => {
  afterEach(() => setChildProcessPolyfill(childProcess));

  it("lets esbuild's __toESM copy require('child_process')", async () => {
    const engine = createEngine();
    // let the constructor's lazy child_process import settle first
    await new Promise((r) => setTimeout(r, 0));
    setChildProcessPolyfill(
      namespaceLike({ ...childProcess, promises: namespaceLike(childProcess.promises as any) }),
    );
    const r = engine.execute(
      ESBUILD_TO_ESM +
        [
          "const cp = __toESM(require('child_process'), 1);",
          "const cpp = __toESM(require('child_process/promises'), 1);",
          "const d = Object.getOwnPropertyDescriptor(require('child_process'), 'ShellProcess');",
          "module.exports = {",
          "  spawn: typeof cp.spawn, shell: typeof cp.ShellProcess, dflt: cp.default === require('child_process'),",
          "  exec: typeof cpp.exec, enumerable: d.enumerable,",
          "  keys: Object.keys(require('child_process')).includes('execSync'),",
          "};",
        ].join("\n"),
      "/project/__entry.js",
    ).exports;
    expect(r).toEqual({
      spawn: "function", shell: "function", dflt: true, exec: "function", enumerable: true, keys: true,
    });
  });

  it("lets esbuild's __toESM copy an async-WASM module's exports", () => {
    const engine = createEngine({
      // throws once like an over-limit synchronous WebAssembly compile, so the
      // loader re-runs it on the async path and hands out its exports Proxy
      "/project/wasm-ish.cjs": [
        // esbuild's __toCommonJS(__export(...)): non-configurable getters
        "module.exports = Object.defineProperty({}, 'answer', { get: () => 42, enumerable: true });",
        "if (!globalThis.__wasmIshRetried) {",
        "  globalThis.__wasmIshRetried = true;",
        "  throw new Error('__WASM_COMPILE_PENDING__');",
        "}",
      ].join("\n"),
    });
    try {
      const r = engine.execute(
        ESBUILD_TO_ESM +
          "const m = __toESM(require('./wasm-ish.cjs'), 1); module.exports = { answer: m.answer };",
        "/project/__entry.js",
      ).exports;
      expect(r).toEqual({ answer: 42 });
    } finally {
      delete (globalThis as any).__wasmIshRetried;
    }
  });
});
