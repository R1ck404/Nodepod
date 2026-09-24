import { describe, expect, it } from "vitest";
import { importedMemoryMinPages, installWasmMemoryClamp } from "../helpers/wasm-memory-clamp";

// A module whose only content is `(import "env" "memory" (memory 998 65536 shared))`,
// the shape of napi-rs wasm32-wasi bindings such as rolldown's.
function moduleImportingSharedMemory(minPages: number): Uint8Array<ArrayBuffer> {
  const leb = (n: number): number[] => {
    const out: number[] = [];
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return out;
  };
  const name = (s: string) => [s.length, ...Array.from(s, (c) => c.charCodeAt(0))];
  const entry = [...name("env"), ...name("memory"), 0x02, 0x03, ...leb(minPages), ...leb(65536)];
  const section = [0x01, ...entry];
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x02, ...leb(section.length), ...section]);
}

describe("wasm memory clamp", () => {
  it("reads the imported memory's declared minimum", () => {
    expect(importedMemoryMinPages(moduleImportingSharedMemory(998))).toBe(998);
    expect(importedMemoryMinPages(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))).toBeNull();
    expect(importedMemoryMinPages(new Uint8Array([1, 2, 3]))).toBeNull();
    // over-long LEB128 for the minimum (5 bytes for 998) still reads right
    const padded = moduleImportingSharedMemory(998);
    const long = [...padded];
    const at = long.length - 3 - 2; // min's 2 bytes sit before the 3-byte maximum
    long.splice(at, 2, 0xe6, 0x87, 0x80, 0x80, 0x00);
    long[9] += 3; // section size
    long[10] += 0; // count unchanged
    expect(importedMemoryMinPages(new Uint8Array(long))).toBe(998);
  });

  it("starts large shared memories small and grows them to the module's minimum", () => {
    installWasmMemoryClamp();
    const memory = new WebAssembly.Memory({ initial: 16384, maximum: 65536, shared: true });
    expect(memory).toBeInstanceOf(WebAssembly.Memory);

    const module = new WebAssembly.Module(moduleImportingSharedMemory(998));
    const instance = new WebAssembly.Instance(module, { env: { memory } });
    expect(instance).toBeInstanceOf(WebAssembly.Instance);
    // never grew to the 16384 pages asked for: exactly the module's minimum
    expect(memory.buffer.byteLength).toBe(998 * 65536);
    expect(memory.grow(1)).toBe(998);
  });

  it("gives a memory used before any module imported it the size asked for", () => {
    installWasmMemoryClamp();
    const early = new WebAssembly.Memory({ initial: 2048, maximum: 4096, shared: true });
    expect(early.buffer.byteLength).toBe(2048 * 65536);
    const grown = new WebAssembly.Memory({ initial: 2048, maximum: 4096, shared: true });
    expect(grown.grow(2)).toBe(2048);
    expect(grown.buffer.byteLength).toBe(2050 * 65536);
    // and instantiating afterwards keeps that size
    new WebAssembly.Instance(new WebAssembly.Module(moduleImportingSharedMemory(998)), { env: { memory: early } });
    expect(early.buffer.byteLength).toBe(2048 * 65536);
  });

  it("leaves fixed-size shared memories alone", () => {
    installWasmMemoryClamp();
    const fixed = new WebAssembly.Memory({ initial: 2048, maximum: 2048, shared: true });
    expect(fixed.buffer.byteLength).toBe(2048 * 65536);
  });

  it("sizes a clamped memory for WebAssembly.instantiate and instantiateStreaming", async () => {
    installWasmMemoryClamp();
    const bytes = moduleImportingSharedMemory(998);
    const a = new WebAssembly.Memory({ initial: 16384, maximum: 65536, shared: true });
    const result = await WebAssembly.instantiate(bytes, { env: { memory: a } });
    expect(result.instance).toBeInstanceOf(WebAssembly.Instance);
    expect(a.buffer.byteLength).toBe(998 * 65536);
    if (typeof WebAssembly.instantiateStreaming === "function") {
      const b = new WebAssembly.Memory({ initial: 16384, maximum: 65536, shared: true });
      const streamed = await WebAssembly.instantiateStreaming(
        new Response(bytes, { headers: { "content-type": "application/wasm" } }),
        { env: { memory: b } },
      );
      expect(streamed.instance).toBeInstanceOf(WebAssembly.Instance);
      expect(b.buffer.byteLength).toBe(998 * 65536);
    }
  });

  it("leaves small and non-shared memories alone", () => {
    installWasmMemoryClamp();
    expect(new WebAssembly.Memory({ initial: 16384, maximum: 65536 }).buffer.byteLength).toBe(16384 * 65536);
    expect(new WebAssembly.Memory({ initial: 16, maximum: 64, shared: true }).buffer.byteLength).toBe(16 * 65536);
  });
});
