import { describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";
import {
  buildNapiWorkerBundle,
  isNapiWasiWorkerScript,
} from "../helpers/napi-wasm-worker";

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
