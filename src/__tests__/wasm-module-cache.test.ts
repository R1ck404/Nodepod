// Plan 017: persistent WASM module cache — hashing, content keying, and
// graceful degradation when IndexedDB / structured clone are unavailable.

import { describe, it, expect } from "vitest";
import {
  quickWasmHash,
  wasmContentHash,
  getWasmModuleCache,
} from "../persistence/wasm-module-cache";
import {
  registerCompiledModule,
  getCachedModule,
  precompileWasm,
} from "../helpers/wasm-cache";
import { buildCdnWasmUrl } from "../helpers/wasm-cdn";
import { MemoryVolume } from "../memory-volume";

// smallest valid wasm binary: magic + version
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

describe("quickWasmHash", () => {
  it("is deterministic and content-sensitive", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    const c = new Uint8Array([1, 2, 3, 5]);
    expect(quickWasmHash(a)).toBe(quickWasmHash(b));
    expect(quickWasmHash(a)).not.toBe(quickWasmHash(c));
  });

  it("distinguishes same-length different-content buffers (old byte-length key could not)", () => {
    const a = new Uint8Array(1024).fill(7);
    const b = new Uint8Array(1024).fill(8);
    expect(a.length).toBe(b.length);
    expect(quickWasmHash(a)).not.toBe(quickWasmHash(b));
  });

  it("includes length so prefix-equal buffers differ", () => {
    const a = new Uint8Array([0, 0, 0, 0]);
    const b = new Uint8Array([0, 0, 0, 0, 0]);
    expect(quickWasmHash(a)).not.toBe(quickWasmHash(b));
  });
});

describe("wasmContentHash", () => {
  it("produces a SHA-256 hex digest when crypto.subtle exists", async () => {
    const hash = await wasmContentHash(new TextEncoder().encode("abc"));
    // Known SHA-256 of "abc"
    expect(hash).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is stable for subarray views", async () => {
    const backing = new Uint8Array(16);
    backing.set([9, 9, 1, 2, 3, 9, 9], 0);
    const view = backing.subarray(2, 5); // [1,2,3]
    expect(await wasmContentHash(view)).toBe(
      await wasmContentHash(new Uint8Array([1, 2, 3])),
    );
  });
});

describe("getWasmModuleCache degradation", () => {
  it("resolves null when indexedDB is unavailable (Node)", async () => {
    expect(typeof indexedDB).toBe("undefined");
    expect(await getWasmModuleCache()).toBeNull();
  });
});

describe("in-memory module cache (L1) content keying", () => {
  it("registerCompiledModule + getCachedModule round-trip", async () => {
    const mod = await WebAssembly.compile(EMPTY_WASM);
    registerCompiledModule(EMPTY_WASM, mod);
    expect(getCachedModule(EMPTY_WASM)).toBe(mod);
    // fresh but identical bytes hit the same entry
    expect(getCachedModule(EMPTY_WASM.slice())).toBe(mod);
  });

  it("different content misses", async () => {
    const mod = await WebAssembly.compile(EMPTY_WASM);
    registerCompiledModule(EMPTY_WASM, mod);
    const other = new Uint8Array(EMPTY_WASM.length).fill(0xff);
    expect(getCachedModule(other)).toBeNull();
  });

  it("precompileWasm ignores sub-threshold buffers without throwing", () => {
    expect(() => precompileWasm(EMPTY_WASM)).not.toThrow();
    // below 4MB threshold — not cached by precompile
  });
});

describe("buildCdnWasmUrl", () => {
  function volWith(pkgJsonPath: string, json: unknown) {
    const vol = new MemoryVolume();
    const dir = pkgJsonPath.substring(0, pkgJsonPath.lastIndexOf("/"));
    vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(pkgJsonPath, JSON.stringify(json));
    return vol;
  }

  it("maps unscoped packages with installed version", () => {
    const vol = volWith("/p/node_modules/lightningcss-wasm/package.json", {
      name: "lightningcss-wasm",
      version: "1.29.1",
    });
    expect(
      buildCdnWasmUrl(vol, "/p/node_modules/lightningcss-wasm/lightningcss_node.wasm"),
    ).toBe(
      "https://cdn.jsdelivr.net/npm/lightningcss-wasm@1.29.1/lightningcss_node.wasm",
    );
  });

  it("maps scoped packages and nested files", () => {
    const vol = volWith("/p/node_modules/@scope/pkg/package.json", {
      name: "@scope/pkg",
      version: "2.0.0",
    });
    expect(buildCdnWasmUrl(vol, "/p/node_modules/@scope/pkg/dist/lib.wasm")).toBe(
      "https://cdn.jsdelivr.net/npm/@scope/pkg@2.0.0/dist/lib.wasm",
    );
  });

  it("falls back to latest when package.json is missing", () => {
    const vol = new MemoryVolume();
    expect(buildCdnWasmUrl(vol, "/p/node_modules/foo/a.wasm")).toBe(
      "https://cdn.jsdelivr.net/npm/foo@latest/a.wasm",
    );
  });

  it("rejects non-wasm and non-node_modules paths", () => {
    const vol = new MemoryVolume();
    expect(buildCdnWasmUrl(vol, "/p/node_modules/foo/a.js")).toBeNull();
    expect(buildCdnWasmUrl(vol, "/p/src/a.wasm")).toBeNull();
    expect(buildCdnWasmUrl(vol, "/p/node_modules/@scope/a.wasm")).toBeNull();
  });
});
