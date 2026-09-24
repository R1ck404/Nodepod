import { afterEach, describe, expect, it } from "vitest";
import { ScriptEngine } from "../script-engine";
import { MemoryVolume } from "../memory-volume";

// The loader side of the main thread's shared transform store: modules under
// node_modules publish their transforms per package pack, and a later process
// (here: a fresh engine with an empty local cache) takes them from the pack
// instead of converting again.

type Entry = [string, string, number];

// one main-thread store; each call models a new process connecting to it
function installClient(packs = new Map<string, Entry[]>()) {
  const puts: Array<{ scope: string; key: string; code: string; flags: number }> = [];
  const loads: string[] = [];
  (globalThis as any).__nodepodSharedTransforms = {
    loadPack(scope: string): Entry[] {
      loads.push(scope);
      return packs.get(scope) ?? [];
    },
    put(scope: string, key: string, code: string, flags: number) {
      puts.push({ scope, key, code, flags });
      const list = packs.get(scope) ?? [];
      list.push([key, code, flags]);
      packs.set(scope, list);
    },
  };
  return { packs, puts, loads };
}

function volume(): MemoryVolume {
  const vol = new MemoryVolume();
  vol.mkdirSync("/app/node_modules/esm-pkg", { recursive: true });
  vol.writeFileSync("/app/node_modules/esm-pkg/package.json", JSON.stringify({ name: "esm-pkg", version: "2.0.0", main: "index.js" }));
  vol.writeFileSync("/app/node_modules/esm-pkg/index.js", "export const answer = 41 + 1;\nexport default 'esm';\n");
  vol.writeFileSync("/app/entry.js", "module.exports = require('esm-pkg').answer;");
  return vol;
}

afterEach(() => {
  delete (globalThis as any).__nodepodSharedTransforms;
});

describe("shared transform store (loader side)", () => {
  it("publishes a package module's transform under its package scope", () => {
    const { puts } = installClient();
    const engine = new ScriptEngine(volume(), { cwd: "/app", transformCache: new Map() });
    expect(engine.runFile("/app/entry.js").exports).toBe(42);
    const put = puts.find((p) => p.key.startsWith("index.js|"));
    expect(put).toBeDefined();
    expect(put!.scope.endsWith("|esm-pkg@2.0.0")).toBe(true);
    expect(put!.code).toContain("answer");
  });

  it("uses a pack hit instead of converting again", () => {
    const { packs } = installClient();
    // first engine converts and publishes
    new ScriptEngine(volume(), { cwd: "/app", transformCache: new Map() }).runFile("/app/entry.js");
    // tamper with the published transform: a hit must use it verbatim
    for (const list of packs.values()) {
      for (const entry of list) {
        if (entry[0].startsWith("index.js|")) entry[1] = "module.exports = { answer: 'from-pack' };";
      }
    }
    installClient(packs); // the next process
    const second = new ScriptEngine(volume(), { cwd: "/app", transformCache: new Map() });
    expect(second.runFile("/app/entry.js").exports).toBe("from-pack");
  });

  it("misses when the source changed (key carries its length and digest)", () => {
    const { packs } = installClient();
    new ScriptEngine(volume(), { cwd: "/app", transformCache: new Map() }).runFile("/app/entry.js");
    for (const list of packs.values()) for (const entry of list) entry[1] = "module.exports = { answer: 'stale' };";
    installClient(packs);
    const vol = volume();
    vol.writeFileSync("/app/node_modules/esm-pkg/index.js", "export const answer = 7;\n");
    const engine = new ScriptEngine(vol, { cwd: "/app", transformCache: new Map() });
    expect(engine.runFile("/app/entry.js").exports).toBe(7);
  });
});

describe("loader fast path edge cases", () => {
  it("publishes an empty module once, then takes it from the pack", () => {
    const { puts, packs } = installClient();
    const vol = volume();
    vol.writeFileSync("/app/node_modules/esm-pkg/empty.js", "");
    vol.writeFileSync("/app/entry.js", "require('esm-pkg/empty.js'); module.exports = 1;");
    new ScriptEngine(vol, { cwd: "/app", transformCache: new Map() }).runFile("/app/entry.js");
    expect(puts.filter((p) => p.key.startsWith("empty.js|")).length).toBe(1);
    const next = installClient(packs);
    new ScriptEngine(vol, { cwd: "/app", transformCache: new Map() }).runFile("/app/entry.js");
    expect(next.puts.filter((p) => p.key.startsWith("empty.js|")).length).toBe(0);
  });

  it("detects `await (...)` at the top level of a script-like module", async () => {
    installClient();
    const vol = volume();
    vol.writeFileSync("/app/tla.js", "const v = await (Promise.resolve(5));\nmodule.exports = v * 2;\n");
    const engine = new ScriptEngine(vol, { cwd: "/app", transformCache: new Map() });
    const result = await engine.runFileTLA("/app/tla.js");
    expect(result.exports).toBe(10);
  });

  it("keeps a CommonJS module with awaits inside functions on the fast path", () => {
    const { puts } = installClient();
    const vol = volume();
    vol.writeFileSync(
      "/app/node_modules/esm-pkg/cjs.js",
      "async function f() {\n  await (0, g)();\n}\nfunction g() {}\nmodule.exports = typeof f;\n",
    );
    vol.writeFileSync("/app/entry.js", "module.exports = require('esm-pkg/cjs.js');");
    const engine = new ScriptEngine(vol, { cwd: "/app", transformCache: new Map() });
    expect(engine.runFile("/app/entry.js").exports).toBe("function");
    const put = puts.find((p) => p.key.startsWith("cjs.js|"));
    expect(put && put.flags & 2).toBe(2); // lexer fast path
  });
});
