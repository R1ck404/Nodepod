import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryVolume } from "../memory-volume";
import {
  buildNapiWorkerBundle,
  createNapiWorkerFactory,
  handleFsProxy,
  isNapiWasiWorkerScript,
} from "../helpers/napi-wasm-worker";
import { getRegistry } from "../helpers/event-loop";
import { EventEmitter } from "../polyfills/events";

afterEach(() => vi.useRealTimers());

describe("napi WASI worker bundle", () => {
  it("recognizes generated NAPI-RS workers without naming a package", () => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/node_modules/example", { recursive: true });
    vol.writeFileSync("/node_modules/example/wasi-worker.mjs", "");
    vol.writeFileSync("/node_modules/example/example.wasm", new Uint8Array());

    expect(
      isNapiWasiWorkerScript("/node_modules/example/wasi-worker.mjs", vol),
    ).toBe(true);
  });

  it("parses multiline imports and dynamic imports through the module graph", () => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/node_modules/example", { recursive: true });
    vol.writeFileSync(
      "/node_modules/example/wasi-worker.mjs",
      'import {\n value\n} from "runtime";\nexport const load = () => import("dynamic-runtime");',
    );
    vol.writeFileSync("/node_modules/example/example.wasm", new Uint8Array());
    vol.writeFileSync("/node_modules/runtime.mjs", "export const value = 1;");
    vol.writeFileSync("/node_modules/dynamic-runtime.mjs", "export const value = 2;");

    const bundle = buildNapiWorkerBundle(
      "/node_modules/example/wasi-worker.mjs",
      vol,
      (id) => `/node_modules/${id}.mjs`,
      {},
    );

    expect(() => new Function(bundle)).not.toThrow();
    expect(bundle).toContain('"runtime":"/node_modules/runtime.mjs"');
    expect(bundle).toContain('"dynamic-runtime":"/node_modules/dynamic-runtime.mjs"');
  });

  it("rejects stale fs responses and requests an explicit resize", () => {
    const staleBuffer = new SharedArrayBuffer(32);
    const stale = new Int32Array(staleBuffer, 0, 4);
    Atomics.store(stale, 0, -1);
    Atomics.store(stale, 3, 9);
    handleFsProxy({ sab: stale, type: "readFileSync", payload: ["/large"], requestId: 8 }, {
      readFileSync: () => new Uint8Array(64),
    });
    expect(Atomics.load(stale, 0)).toBe(-1);

    handleFsProxy({ sab: stale, type: "readFileSync", payload: ["/large"], requestId: 9 }, {
      readFileSync: () => new Uint8Array(64),
    });
    expect(Atomics.load(stale, 0)).toBe(2);
    expect(Atomics.load(stale, 2)).toBe(64);
  });

  it("completes each filesystem mailbox sequence exactly once", () => {
    const buffer = new SharedArrayBuffer(128);
    const control = new Int32Array(buffer, 0, 4);
    Atomics.store(control, 0, -1);
    Atomics.store(control, 3, 12);
    let reads = 0;
    const bridge = {
      readFileSync: () => {
        reads++;
        return new Uint8Array([1, 2, 3]);
      },
    };
    const request = { sab: control, type: "readFileSync", payload: ["/file"], requestId: 12 };
    handleFsProxy(request, bridge);
    handleFsProxy(request, bridge);
    expect(reads).toBe(1);
    expect(Atomics.load(control, 0)).toBe(0);
    expect(Atomics.load(control, 2)).toBe(3);
    expect(Array.from(new Uint8Array(buffer, 16, 3))).toEqual([1, 2, 3]);
  });

  it("leases the bootstrap worker ref while napi-rs starts the server", async () => {
    vi.useFakeTimers();
    const vol = new MemoryVolume();
    vol.mkdirSync("/node_modules/example", { recursive: true });
    vol.writeFileSync("/node_modules/example/wasi-worker.mjs", "");
    vol.writeFileSync("/node_modules/example/example.wasm", new Uint8Array());
    const WorkerCtor = createNapiWorkerFactory(
      vol,
      () => { throw new Error("unexpected dependency"); },
      {},
      {},
      () => ({ postMessage() {}, terminate() {} }),
      true,
    );
    const worker = new EventEmitter() as any;
    worker.threadId = 1;
    const registry = getRegistry();
    const before = registry.activeRefedCount();

    WorkerCtor.call(worker, "/node_modules/example/wasi-worker.mjs", {});
    expect(registry.activeRefedCount()).toBe(before + 1);
    worker.unref();
    expect(registry.activeRefedCount()).toBe(before + 1);
    vi.advanceTimersByTime(3_000);
    expect(registry.activeRefedCount()).toBe(before);

    await worker.terminate();
    expect(registry.activeRefedCount()).toBe(before);
  });

  it("preserves ESM exports and records each resolved dependency exactly", () => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/node_modules/example", { recursive: true });
    vol.mkdirSync("/node_modules/runtime", { recursive: true });
    vol.writeFileSync(
      "/node_modules/example/wasi-worker.mjs",
      [
        'import { createRequire } from "node:module";',
        'import { instantiate } from "runtime";',
        "const require = createRequire(import.meta.url);",
        "export const load = () => instantiate();",
      ].join("\n"),
    );
    vol.writeFileSync(
      "/node_modules/runtime/index.mjs",
      "export const instantiate = () => 42;",
    );

    const bundle = buildNapiWorkerBundle(
      "/node_modules/example/wasi-worker.mjs",
      vol,
      (id, fromDir) => {
        if (id === "runtime" && fromDir === "/node_modules/example") {
          return "/node_modules/runtime/index.mjs";
        }
        throw new Error(`Unexpected resolution: ${id} from ${fromDir}`);
      },
      {},
    );

    expect(bundle).toContain('"runtime":"/node_modules/runtime/index.mjs"');
    expect(bundle).toContain("exports.instantiate = instantiate");
    expect(bundle).toContain("exports.load = load");
    expect(bundle).toContain("if (mod.esm) Object.defineProperty(m.exports, '__esModule'");
    expect(bundle).not.toContain("module.exports.instantiate = instantiate; const instantiate");
    expect(bundle).toContain("Bundled dependency missing");
    expect(bundle).not.toContain("Unknown module:");
  });
});
