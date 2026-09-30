import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileWasmInWorker,
  disposeWasmCache,
  getCachedModule,
  precompileWasm,
  registerCompiledModule,
  reclaimWasmCache,
  wasmCacheStats,
} from "../helpers/wasm-cache";
import { installWasmMemoryClamp, readWasmMemoryImports, rememberWasmMemoryRequirements } from "../helpers/wasm-memory-clamp";
import { wasmContentHash } from "../persistence/wasm-module-cache";
import { MemoryVolume } from "../memory-volume";
import { ScriptEngine } from "../script-engine";

const NativeModule = WebAssembly.Module;
const nativeCompile = WebAssembly.compile.bind(WebAssembly);
const leb = (value: number): number[] => {
  const bytes: number[] = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
};
const name = (value: string) => [value.length, ...new TextEncoder().encode(value)];

function wasm(memories: Array<[string, number]> = [], padding = 0): Uint8Array<ArrayBuffer> {
  const entries = memories.flatMap(([field, min]) => [
    ...name("env"), ...name(field), 2, 3, ...leb(min), ...leb(65536),
  ]);
  const imports = [memories.length, ...entries];
  const header = [0, 97, 115, 109, 1, 0, 0, 0, 2, ...leb(imports.length), ...imports];
  const custom = padding ? [0, ...leb(padding + 1), 0] : [];
  const bytes = new Uint8Array(header.length + custom.length + padding);
  bytes.set(header);
  bytes.set(custom, header.length);
  return bytes;
}

const supportsMultiMemory = WebAssembly.validate(wasm([["a", 2], ["b", 5]]));

afterEach(() => {
  disposeWasmCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WASM resources", () => {
  it("executes changed instructions between former hash samples and preserves constructor identity", () => {
    const padding = 65540;
    const prefix = [0, 97, 115, 109, 1, 0, 0, 0, 0, ...leb(padding + 1), 0];
    const code = [1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 5, 1, 1, 102, 0, 0, 10, 6, 1, 4, 0, 65, 1, 11];
    const suffix = [0, ...leb(1024 * 1024), 0];
    const a = new Uint8Array(prefix.length + padding + code.length + suffix.length + 1024 * 1024 - 1);
    a.set(prefix);
    a.set(code, prefix.length + padding);
    a.set(suffix, prefix.length + padding + code.length);
    const b = a.slice();
    b[prefix.length + padding + code.length - 2] = 2;
    const execute = (module: WebAssembly.Module) => (new WebAssembly.Instance(module).exports.f as () => number)();
    expect([execute(new NativeModule(a)), execute(new NativeModule(b))]).toEqual([1, 2]);

    const volume = new MemoryVolume();
    volume.writeFileSync("/a.wasm", a);
    volume.writeFileSync("/b.wasm", b);
    volume.writeFileSync("/main.cjs", `
      const fs = require("fs");
      const a = new WebAssembly.Module(fs.readFileSync("/a.wasm"));
      const b = new WebAssembly.Module(fs.readFileSync("/b.wasm"));
      const again = new WebAssembly.Module(fs.readFileSync("/a.wasm"));
      module.exports = [new WebAssembly.Instance(a).exports.f(), new WebAssembly.Instance(b).exports.f(), a !== again];
    `);
    try {
      expect(new ScriptEngine(volume).runFile("/main.cjs").exports).toEqual([1, 2, true]);
    } finally {
      volume.dispose();
    }
  });
  it("shares an in-flight precompile with all worker compile callers", async () => {
    const compile = vi.spyOn(WebAssembly, "compile").mockImplementation(async (bytes) => {
      await Promise.resolve();
      return nativeCompile(bytes);
    });
    const bytes = wasm([], 4 * 1024 * 1024);
    precompileWasm(bytes);
    const first = compileWasmInWorker(bytes);
    const second = compileWasmInWorker(bytes);
    expect(second).toBe(first);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(getCachedModule(bytes)).toBe(a);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("caches synchronous constructors without starting a duplicate async compile", async () => {
    const compile = vi.spyOn(WebAssembly, "compile");
    const bytes = wasm([], 4 * 1024 * 1024);
    const volume = new MemoryVolume();
    volume.writeFileSync("/engine.wasm", bytes);
    volume.writeFileSync("/app.cjs", `
      const bytes = require('fs').readFileSync('/engine.wasm');
      module.exports = new WebAssembly.Module(bytes);
    `);
    const result = new ScriptEngine(volume).runFile("/app.cjs");
    expect(getCachedModule(bytes)).toBe(result.exports);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(compile).not.toHaveBeenCalled();
    volume.dispose();
  });

  it("lets a synchronous result satisfy a pending warm-up without recompiling", async () => {
    const compile = vi.spyOn(WebAssembly, "compile");
    const bytes = wasm([], 4 * 1024 * 1024);
    precompileWasm(bytes);
    const module = new NativeModule(bytes);
    registerCompiledModule(bytes, module);
    expect(await compileWasmInWorker(bytes)).toBe(module);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(compile).not.toHaveBeenCalled();
  });

  it("lets a synchronous result satisfy a pending worker digest without recompiling", async () => {
    const compile = vi.spyOn(WebAssembly, "compile");
    const bytes = wasm([], 4 * 1024 * 1024);
    const pending = compileWasmInWorker(bytes);
    const module = new NativeModule(bytes);
    registerCompiledModule(bytes, module);
    expect(await pending).toBe(module);
    expect(compile).not.toHaveBeenCalled();
  });

  it("bounds compiled-code entries even for tiny binaries", () => {
    for (let i = 0; i < 80; i++) {
      const bytes = wasm([], i + 1);
      registerCompiledModule(bytes, new NativeModule(bytes));
    }
    expect(wasmCacheStats()).toEqual({ entries: 64, pending: 0 });
    expect(getCachedModule(wasm([], 1))).toBeNull();
    expect(getCachedModule(wasm([], 80))).not.toBeNull();
  });

  it("releases failed worker-post callbacks before falling back", async () => {
    const terminate = vi.fn();
    class BrokenWorker {
      onmessage: unknown;
      onerror: unknown;
      postMessage() { throw new Error("post failed"); }
      terminate = terminate;
    }
    vi.stubGlobal("Worker", BrokenWorker);
    const bytes = wasm();
    expect(await compileWasmInWorker(bytes)).toBeInstanceOf(NativeModule);
    reclaimWasmCache();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(wasmCacheStats()).toEqual({ entries: 0, pending: 0 });
  });

  it("retains sizing metadata when compiled code arrives from another realm", () => {
    const bytes = wasm([["memory", 2]]);
    const module = new NativeModule(bytes);
    installWasmMemoryClamp();
    registerCompiledModule(bytes, module);
    const memory = new WebAssembly.Memory({ initial: 4096, maximum: 65536, shared: true });
    new WebAssembly.Instance(getCachedModule(bytes)!, { env: { memory } });
    expect(memory.buffer.byteLength).toBe(2 * 65536);
  });

  it("transfers one owned binary and preserves sizing after the transfer", async () => {
    const payloads: ArrayBuffer[] = [];
    class CompileWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: unknown;
      postMessage(message: { id: number; bytes: ArrayBuffer }, transfers: Transferable[]) {
        const received = structuredClone(message, { transfer: transfers });
        payloads.push(received.bytes);
        queueMicrotask(() => this.onmessage?.({ data: {
          id: received.id, ok: true, module: new NativeModule(received.bytes),
        } }));
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", CompileWorker);
    installWasmMemoryClamp();
    const bytes = wasm([["memory", 2]], 4 * 1024 * 1024);
    const module = await compileWasmInWorker(bytes);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].byteLength).toBe(bytes.byteLength);
    expect(bytes.byteLength).toBeGreaterThan(4 * 1024 * 1024);
    const memory = new WebAssembly.Memory({ initial: 4096, maximum: 65536, shared: true });
    new WebAssembly.Instance(module, { env: { memory } });
    expect(memory.buffer.byteLength).toBe(2 * 65536);
  });

  it("prepares parsed multi-memory requirements independently of host support", () => {
    const requirements = readWasmMemoryImports(wasm([["a", 2], ["b", 5]]));
    expect(requirements?.map(memory => memory.minPages)).toEqual([2, 5]);
    installWasmMemoryClamp();
    for (const shared of [false, true]) {
      // Exercise the metadata handoff and import preparation using a module
      // every host can link. Actual multi-memory linking is checked separately.
      const module = new NativeModule(wasm());
      rememberWasmMemoryRequirements(module, requirements);
      const a = new WebAssembly.Memory({ initial: 4096, maximum: 65536, shared: true });
      const b = shared ? a : new WebAssembly.Memory({ initial: 4096, maximum: 65536, shared: true });
      new WebAssembly.Instance(module, { env: { a, b } });
      expect(a.buffer.byteLength).toBe((shared ? 5 : 2) * 65536);
      expect(b.buffer.byteLength).toBe(5 * 65536);
    }
  });

  it.skipIf(!supportsMultiMemory)("sizes several imported memories independently", () => {
    const bytes = wasm([["a", 2], ["b", 5]]);
    expect(readWasmMemoryImports(bytes)?.map((m) => m.minPages)).toEqual([2, 5]);
    installWasmMemoryClamp();
    const module = new WebAssembly.Module(bytes);
    const a = new WebAssembly.Memory({ initial: 4096, maximum: 65536, shared: true });
    const b = new WebAssembly.Memory({ initial: 4096, maximum: 65536, shared: true });
    new WebAssembly.Instance(module, { env: { a, b } });
    expect(a.buffer.byteLength).toBe(2 * 65536);
    expect(b.buffer.byteLength).toBe(5 * 65536);
  });

  it.skipIf(!supportsMultiMemory)("meets all requirements when one memory is imported under several names", () => {
    installWasmMemoryClamp();
    const module = new WebAssembly.Module(wasm([["a", 2], ["b", 5]]));
    const memory = new WebAssembly.Memory({ initial: 4096, maximum: 65536, shared: true });
    new WebAssembly.Instance(module, { env: { a: memory, b: memory } });
    expect(memory.buffer.byteLength).toBe(5 * 65536);
  });

  it("hashes shared-memory views with the same strong digest as ordinary bytes", async () => {
    const bytes = new TextEncoder().encode("abc");
    const shared = new Uint8Array(new SharedArrayBuffer(7));
    shared.set(bytes, 2);
    expect(await wasmContentHash(shared.subarray(2, 5))).toBe(await wasmContentHash(bytes));
    expect(await wasmContentHash(shared.subarray(2, 5))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
