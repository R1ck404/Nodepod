import { describe, expect, it } from "vitest";
import { isBuiltin as nativeIsBuiltin } from "node:module";
import nativeTest from "node:test";
import {
  MessageChannel as NativeMessageChannel,
  markAsUncloneable as nativeMarkAsUncloneable,
} from "node:worker_threads";
import { MemoryVolume } from "../memory-volume";
import { ScriptEngine } from "../script-engine";
import { isBuiltin } from "../polyfills/module";
import { toNodeFileUrl } from "../polyfills/url";
import {
  MessageChannel,
  markAsUncloneable,
  prepareWorkerMessage,
} from "../polyfills/worker_threads";

function engine(files: Record<string, string>) {
  const vol = new MemoryVolume();
  for (const [path, source] of Object.entries(files)) vol.writeFileSync(path, source);
  return new ScriptEngine(vol, { cwd: "/workspace" });
}

describe("Forge compatibility regressions", () => {
  it("reads worker message getters once and preserves cycles and aliases", () => {
    let reads = 0;
    const item = { marker: "value" };
    const input = {
      get value() {
        reads++;
        return item;
      },
      alias: item,
    };
    const prepared = prepareWorkerMessage(input) as typeof input;
    const output = structuredClone(prepared);
    expect(reads).toBe(1);
    expect(output.value).toBe(output.alias);
    expect(Object.getOwnPropertyDescriptor(prepared, "value")?.get).toBeUndefined();

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const copy = prepareWorkerMessage(cycle) as typeof cycle;
    expect(copy.self).toBe(copy);
    expect(copy).not.toBe(cycle);
  });

  it("rejects marked getter results without evaluating non-enumerable or symbol getters", () => {
    const blocked = {};
    markAsUncloneable(blocked);
    expect(() =>
      prepareWorkerMessage({
        get value() {
          return blocked;
        },
      }),
    ).toThrow(expect.objectContaining({ name: "DataCloneError" }));
    const input = Object.defineProperties(
      {},
      {
        hidden: {
          get() {
            throw new Error("non-enumerable getter");
          },
        },
        [Symbol.toStringTag]: {
          get() {
            throw new Error("symbol getter");
          },
        },
      },
    );
    expect(prepareWorkerMessage(input)).toEqual({});
  });
  it.each(["require-first", "import-first"])(
    "keeps import and require export conditions separate (%s)",
    async (order) => {
      const files = {
        "/workspace/node_modules/dual/package.json": JSON.stringify({
          name: "dual",
          exports: { import: "./esm.mjs", require: "./cjs.cjs" },
        }),
        "/workspace/node_modules/dual/esm.mjs": "export const parseAst = () => 'esm';",
        "/workspace/node_modules/dual/cjs.cjs": "exports.parseAst = () => 'cjs';",
      };
      const runtime = engine(files);
      const code =
        order === "require-first"
          ? `module.exports = (async () => { const cjs = require('dual'); const esm = await import('dual'); return [cjs.parseAst(), esm.parseAst()]; })();`
          : `module.exports = (async () => { const esm = await import('dual'); const cjs = require('dual'); return [cjs.parseAst(), esm.parseAst()]; })();`;
      expect(await runtime.execute(code, "/workspace/probe.cjs").exports).toEqual(["cjs", "esm"]);
    },
  );
  it("uses import conditions inside an ES module loaded synchronously by require", () => {
    const runtime = engine({
      "/workspace/node_modules/dual/package.json": JSON.stringify({
        exports: { import: "./esm.mjs", require: "./cjs.cjs" },
      }),
      "/workspace/node_modules/dual/esm.mjs": "export const marker = 'esm';",
      "/workspace/node_modules/dual/cjs.cjs": "exports.marker = 'cjs';",
      "/workspace/consumer.mjs": "import { marker } from 'dual'; export { marker };",
    });
    expect(
      runtime.execute("module.exports = require('./consumer.mjs').marker;", "/workspace/probe.cjs")
        .exports,
    ).toBe("esm");
  });
  it("reads a guest-created document dynamically in a headless runtime", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
    try {
      const runtime = engine({});
      expect(
        runtime.execute(
          `
        function read() { return document.getElementById('root'); }
        globalThis.document = { getElementById: id => 'guest-' + id };
        module.exports = read();
      `,
          "/workspace/probe.cjs",
        ).exports,
      ).toBe("guest-root");
    } finally {
      if (previous) Object.defineProperty(globalThis, "document", previous);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
  it("rejects marked objects in worker messages, including cycles, maps and sets", () => {
    // Node only has markAsUncloneable from 22.10; CI's test job runs Node 20,
    // so compare against the native one only where it exists.
    for (const [Channel, mark] of ([
      [MessageChannel, markAsUncloneable],
      [NativeMessageChannel, nativeMarkAsUncloneable],
    ] as const).filter(([, candidate]) => typeof candidate === "function")) {
      const { port1, port2 } = new Channel();
      const markValue = mark as (value: unknown) => void;
      try {
        const blocked = { marker: "blocked" };
        mark(blocked);
        const cycle: Record<string, unknown> = { blocked };
        cycle.self = cycle;
        for (const message of [blocked, cycle, new Map([["key", blocked]]), new Set([blocked])]) {
          expect(() => port1.postMessage(message, [])).toThrow(
            expect.objectContaining({ name: "DataCloneError" }),
          );
        }
        markValue(42);
        markValue(null);
        const buffer = new ArrayBuffer(4);
        mark(buffer);
        expect(() => port1.postMessage(buffer, [])).not.toThrow();
        expect(() => port1.postMessage({ value: 42 }, [])).not.toThrow();
      } finally {
        port1.close();
        port2.close();
      }
    }
  });
  it("distinguishes builtin subpaths from npm packages like punycode/", () => {
    for (const spec of [
      "fs",
      "node:fs/promises",
      "assert/strict",
      "punycode",
      "punycode/",
      "fs/whatever",
      "node:punycode/",
    ]) {
      expect(isBuiltin(spec), spec).toBe(nativeIsBuiltin(spec));
    }
    const runtime = engine({
      "/workspace/node_modules/punycode/package.json": JSON.stringify({
        name: "punycode",
        main: "punycode.js",
      }),
      "/workspace/node_modules/punycode/punycode.js": "module.exports = { marker: 'npm-package' };",
    });
    expect(
      runtime.execute(
        `module.exports = [require.resolve('punycode/'), require('punycode/').marker, require.resolve('punycode')];`,
        "/workspace/probe.cjs",
      ).exports,
    ).toEqual(["/workspace/node_modules/punycode/punycode.js", "npm-package", "punycode"]);
  });

  it("loads a dependency with only an index.json through ancestor node_modules", () => {
    const runtime = engine({
      "/workspace/node_modules/spdx-license-ids/package.json": JSON.stringify({
        name: "spdx-license-ids",
      }),
      "/workspace/node_modules/spdx-license-ids/index.json": '["MIT", "ISC"]',
      "/workspace/node_modules/spdx-expression-parse/scan.js":
        "module.exports = require('spdx-license-ids');",
    });
    expect(
      runtime.execute(
        `module.exports = require('spdx-expression-parse/scan.js');`,
        "/workspace/probe.cjs",
      ).exports,
    ).toEqual(["MIT", "ISC"]);
  });

  it("canonicalizes redundant file URL slashes before Chromium can turn the guest root into a UNC host", async () => {
    const url = "file:////workspace/node_modules/router/module-sync-enabled/index.mjs";
    expect(toNodeFileUrl(url)).toBe(
      "file:///workspace/node_modules/router/module-sync-enabled/index.mjs",
    );
    expect(toNodeFileUrl("file://server/share/file.mjs")).toBe("file://server/share/file.mjs");
    const runtime = engine({
      "/workspace/probe.mjs": `export const value = (await import(${JSON.stringify(url)})).default;`,
      "/workspace/node_modules/router/module-sync-enabled/index.mjs": "export default 42;",
    });
    expect((await runtime.runFileTLA("/workspace/probe.mjs")).exports).toMatchObject({ value: 42 });
  });

  it("exposes the same callable test function through require, default and named imports", async () => {
    expect(typeof nativeTest).toBe("function");
    const runtime = engine({
      "/workspace/probe.mjs": `import test, { test as named } from 'node:test';
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        const cjs = require('node:test');
        let ran = false;
        test('minimal', () => { ran = true; });
        export const result = [typeof test, test === named, test === cjs, cjs.test === cjs, ran];`,
    });
    expect((await runtime.runFileTLA("/workspace/probe.mjs")).exports).toMatchObject({
      result: ["function", true, true, true, true],
    });
  });
});
