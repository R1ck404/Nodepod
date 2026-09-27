import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTimeout as nodeSetTimeout } from "node:timers";
import { MemoryVolume } from "../memory-volume";
import { executeNodeBinary, initShellExec } from "../polyfills/child_process";
import { getRegistry, installWasmWorkLifetime, untrackedWasm } from "../helpers/event-loop";
import type { ShellContext } from "../shell/shell-types";

// (module (func (export "f") (result i32) i32.const 42))
const WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, 0x03,
  0x02, 0x01, 0x00, 0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, 0x0a, 0x06, 0x01, 0x04, 0x00, 0x41,
  0x2a, 0x0b,
]);

type WasmApi = Record<string, unknown>;
const W = WebAssembly as unknown as WasmApi;
const API_NAMES = ["compile", "instantiate", "compileStreaming", "instantiateStreaming"];

// CI: `npm run dev` in the qwik templates exited 0 before listening. Qwik's
// Vite plugin loads its optimizer with fs.readFile -> WebAssembly.compile ->
// instantiate; nothing held the loop while the compile ran, so the process
// was judged drained and exited whenever the compile outlived the wait
// loop's last macrotask.
describe("WebAssembly work keeps the process alive", () => {
  let saved: WasmApi;
  beforeEach(() => {
    saved = {};
    for (const name of API_NAMES) saved[name] = W[name];
  });
  afterEach(() => {
    for (const name of API_NAMES) W[name] = saved[name];
  });

  it("holds a WASMWork handle while compile/instantiate are pending", async () => {
    installWasmWorkLifetime();
    installWasmWorkLifetime(); // idempotent
    const registry = getRegistry();
    const base = registry.activeRefedCount();

    const compiling = WebAssembly.compile(WASM);
    expect(registry.activeRefedCount()).toBe(base + 1);
    const module = await compiling;
    expect(registry.activeRefedCount()).toBe(base);

    const fromModule = WebAssembly.instantiate(module, {});
    const fromBytes = WebAssembly.instantiate(WASM, {});
    expect(registry.activeRefedCount()).toBe(base + 2);
    const instance = await fromModule;
    const { instance: instance2 } = await fromBytes;
    expect((instance.exports.f as () => number)()).toBe(42);
    expect((instance2.exports.f as () => number)()).toBe(42);
    expect(registry.activeRefedCount()).toBe(base);

    if (typeof WebAssembly.compileStreaming === "function") {
      const streaming = WebAssembly.compileStreaming(
        new Response(WASM, { headers: { "content-type": "application/wasm" } }),
      );
      expect(registry.activeRefedCount()).toBeGreaterThan(base);
      await streaming;
      expect(registry.activeRefedCount()).toBe(base);
    }
  });

  it("releases the handle when a compile fails", async () => {
    installWasmWorkLifetime();
    const registry = getRegistry();
    const base = registry.activeRefedCount();
    await expect(WebAssembly.compile(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    expect(registry.activeRefedCount()).toBe(base);
  });

  it("leaves untracked warm-up compiles out of the count", async () => {
    installWasmWorkLifetime();
    const registry = getRegistry();
    const base = registry.activeRefedCount();
    const warm = untrackedWasm(() => WebAssembly.compile(WASM));
    expect(registry.activeRefedCount()).toBe(base);
    await warm;
  });

  it("a script awaiting a slow compile runs to completion instead of exiting 0", async () => {
    // a browser compiles off-thread and resolves from a later task; stand in
    // for a compile that outlives a few macrotasks with an untracked timer
    const nativeCompile = W.compile as (bytes: BufferSource) => Promise<WebAssembly.Module>;
    W.compile = (bytes: BufferSource) =>
      new Promise<WebAssembly.Module>((resolve, reject) => {
        nodeSetTimeout(() => nativeCompile.call(WebAssembly, bytes).then(resolve, reject), 50);
      });
    installWasmWorkLifetime();

    const vol = new MemoryVolume();
    vol.mkdirSync("/app", { recursive: true });
    vol.writeFileSync("/app/binding.wasm", WASM);
    // qwik's loadPlatformBinding, reduced
    vol.writeFileSync(
      "/app/main.js",
      [
        "const fs = require('fs');",
        "new Promise((resolve, reject) => {",
        "  fs.readFile('/app/binding.wasm', (err, buf) => err ? reject(err) : resolve(buf));",
        "})",
        "  .then((buf) => WebAssembly.compile(buf))",
        "  .then((mod) => WebAssembly.instantiate(mod, {}))",
        "  .then((instance) => console.log('ready', instance.exports.f()));",
      ].join("\n"),
    );
    initShellExec(vol, { cwd: "/app" });
    const ctx: ShellContext = {
      cwd: "/app",
      env: { HOME: "/home", PATH: "/usr/bin", PWD: "/app" },
      volume: vol,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };
    const result = await executeNodeBinary("/app/main.js", [], ctx);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("ready 42\n");
    expect(result.exitCode).toBe(0);
  });
});
