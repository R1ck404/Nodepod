// Plan 017: persistent WASM module cache — hashing, content keying, and
// graceful degradation when IndexedDB / structured clone are unavailable.

import { afterEach, describe, it, expect, vi } from "vitest";
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
import {
  buildCdnWasmUrl,
  prefetchWasmFromCdn,
  resolveWasmAssetPath,
} from "../helpers/wasm-cdn";
import { MemoryVolume } from "../memory-volume";

afterEach(() => vi.unstubAllGlobals());

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

  describe("large binaries", () => {
    const N = 8 * 1024 * 1024;
    const big = (): Uint8Array => {
      const bytes = new Uint8Array(N);
      for (let i = 0; i < N; i++) bytes[i] = (i * 2654435761) >>> 24;
      return bytes;
    };

    it("is deterministic for equal content, also over a subarray view", () => {
      const a = big();
      const b = big();
      expect(quickWasmHash(a)).toBe(quickWasmHash(b));
      const padded = new Uint8Array(N + 16);
      padded.set(a, 8);
      expect(quickWasmHash(padded.subarray(8, 8 + N))).toBe(quickWasmHash(a));
    });

    it("sees a change at either end, in the middle, and in the length", () => {
      const base = big();
      const key = quickWasmHash(base);
      for (const at of [0, 1, 65535, N - 1, N - 65536]) {
        const changed = big();
        changed[at] ^= 0xff;
        expect(quickWasmHash(changed), `byte ${at}`).not.toBe(key);
      }
      // Include bytes the former sampled hash skipped.
      const step = Math.floor((N - 2 * 65536) / 65536);
      const mid = big();
      mid[65536 + step * 1000] ^= 0xff;
      expect(quickWasmHash(mid)).not.toBe(key);
      const betweenSamples = big();
      betweenSamples[65537] ^= 0xff;
      expect(quickWasmHash(betweenSamples)).not.toBe(key);
      expect(quickWasmHash(base.subarray(0, N - 1))).not.toBe(key);
    });
  });
});

describe("wasmContentHash", () => {
  it("uses the same full digest when host crypto is unavailable", async () => {
    vi.stubGlobal("crypto", undefined);
    const bytes = new TextEncoder().encode("abc");
    expect(await wasmContentHash(bytes)).toBe(quickWasmHash(bytes));
    expect(quickWasmHash(bytes)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
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

  it("maps a missing generic napi debug probe to the published release asset", () => {
    const vol = volWith(
      "/p/node_modules/@scope/binding-wasm32-wasi/package.json",
      { name: "@scope/binding-wasm32-wasi", version: "1.2.3" },
    );
    const debugPath =
      "/p/node_modules/@scope/binding-wasm32-wasi/binding.wasm32-wasi.debug.wasm";
    expect(resolveWasmAssetPath(vol, debugPath)).toBe(
      "/p/node_modules/@scope/binding-wasm32-wasi/binding.wasm32-wasi.wasm",
    );
    expect(buildCdnWasmUrl(vol, debugPath)).toBe(
      "https://cdn.jsdelivr.net/npm/@scope/binding-wasm32-wasi@1.2.3/binding.wasm32-wasi.wasm",
    );
  });

  it("prefetches and stores the real asset when a debug probe is missing", async () => {
    const vol = volWith(
      "/p/node_modules/@rolldown/binding-wasm32-wasi/package.json",
      { name: "@rolldown/binding-wasm32-wasi", version: "1.2.3" },
    );
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const fetchMock = vi.fn(async () =>
      new Response(bytes, { status: 200, headers: { "content-type": "application/wasm" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const debugPath =
      "/p/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasm32-wasi.debug.wasm";
    await expect(prefetchWasmFromCdn(vol, debugPath)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.jsdelivr.net/npm/@rolldown/binding-wasm32-wasi@1.2.3/rolldown-binding.wasm32-wasi.wasm",
    );
    expect(vol.existsSync(debugPath)).toBe(false);
    expect(
      vol.existsSync(
        "/p/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasm32-wasi.wasm",
      ),
    ).toBe(true);
  });
});
