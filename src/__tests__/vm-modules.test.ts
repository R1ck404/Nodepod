import { describe, it, expect } from "vitest";
import * as vm from "../polyfills/vm";

// Vitest's vmForks and vmThreads pools load every module through these
// (issue: `TypeError: run is not a function` from the old stubs)
describe("vm.SourceTextModule and vm.SyntheticModule", () => {
  function graph(sources: Record<string, string>, context?: object) {
    const modules = new Map<string, vm.Module>();
    const get = (id: string): vm.Module => {
      let m = modules.get(id);
      if (!m) {
        m = new vm.SourceTextModule(sources[id], { identifier: id, context });
        modules.set(id, m);
      }
      return m;
    };
    const linker = (specifier: string) => get(specifier);
    return { get, linker };
  }

  it("links and evaluates a graph of imports and exports", async () => {
    const { get, linker } = graph({
      main: [
        "import def, { a, b as c } from 'dep';",
        "import * as all from 'dep';",
        "export { x } from 'other';",
        "export * from 'other';",
        "export const sum = def + a + c;",
        "export const keys = Object.keys(all).sort().join();",
        "export default function run() { return 'ran'; }",
      ].join("\n"),
      dep: "export const a = 1; export let b = 2; export default 10;",
      other: "export const x = 'x'; export const y = 'y';",
    });
    const main = get("main");
    await main.link(linker);
    expect(main.status).toBe("linked");
    const pending = main.evaluate();
    // a graph without top-level await evaluates synchronously, as in Node
    expect(main.status).toBe("evaluated");
    await pending;
    const ns = main.namespace as any;
    expect(ns.sum).toBe(13);
    expect(ns.keys).toBe("a,b,default");
    expect(ns.x).toBe("x");
    expect(ns.y).toBe("y");
    expect(ns.default()).toBe("ran");
  });

  it("evaluates dependencies in order and supports top-level await", async () => {
    const log: string[] = [];
    const ctx = vm.createContext({ log });
    const { get, linker } = graph({
      main: "import 'a'; import 'b'; log.push('main');",
      a: "await new Promise((r) => setTimeout(r, 5)); log.push('a');",
      b: "log.push('b');",
    }, ctx);
    const main = get("main");
    await main.link(linker);
    const pending = main.evaluate();
    expect(main.status).toBe("evaluating");
    await pending;
    expect(log).toEqual(["a", "b", "main"]);
  });

  it("keeps import bindings live across a cycle", async () => {
    const { get, linker } = graph({
      a: "import { b } from 'b'; export const a = 'a'; export const seen = () => b;",
      b: "import { a, seen } from 'a'; export const b = 'b'; export const early = typeof a;",
    });
    const a = get("a");
    await a.link(linker);
    await a.evaluate();
    expect((a.namespace as any).seen()).toBe("b");
    expect((get("b").namespace as any).early).toBe("undefined");
  });

  it("runs code against its context, with import.meta and import()", async () => {
    const ctx = vm.createContext({ answer: 42 });
    const dynamic = new vm.SyntheticModule(["value"], function () {
      this.setExport("value", "dyn");
    });
    const m = new vm.SourceTextModule(
      [
        "export const fromContext = answer;",
        "export const global = globalThis.answer;",
        "globalThis.written = true;",
        // not in the context: falls back to the real global, as bare names do
        "export const fallback = typeof globalThis.queueMicrotask;",
        "export const url = import.meta.url;",
        "export const load = () => import('dyn').then((ns) => ns.value);",
      ].join("\n"),
      {
        identifier: "file:///m.js",
        context: ctx,
        initializeImportMeta(meta, mod) {
          meta.url = mod.identifier;
        },
        async importModuleDynamically(specifier) {
          expect(specifier).toBe("dyn");
          if (dynamic.status === "unlinked") await dynamic.link(() => { throw new Error("no deps"); });
          return dynamic;
        },
      },
    );
    await m.link(() => { throw new Error("no deps"); });
    await m.evaluate();
    const ns = m.namespace as any;
    expect(ns.fromContext).toBe(42);
    expect(ns.global).toBe(42);
    expect((ctx as any).written).toBe(true);
    expect((globalThis as any).written).toBeUndefined();
    expect(ns.fallback).toBe("function");
    expect(ns.url).toBe("file:///m.js");
    expect(await ns.load()).toBe("dyn");
  });

  it("gives SyntheticModule exports to importers", async () => {
    const lib = new vm.SyntheticModule(["default", "named"], function () {
      this.setExport("default", { cjs: true });
      this.setExport("named", 1);
    });
    const m = new vm.SourceTextModule("import lib, { named } from 'lib'; export const out = [lib.cjs, named];");
    await m.link(() => lib);
    await m.evaluate();
    expect((m.namespace as any).out).toEqual([true, 1]);
    expect(() => lib.setExport("missing", 1)).toThrow(ReferenceError);
  });

  it("records a failed evaluation", async () => {
    const m = new vm.SourceTextModule("throw new Error('boom');");
    await m.link(() => { throw new Error("no deps"); });
    await expect(m.evaluate()).rejects.toThrow("boom");
    expect(m.status).toBe("errored");
    expect((m.error as Error).message).toBe("boom");
  });

  it("throws a SyntaxError at construction", () => {
    expect(() => new vm.SourceTextModule("export const = 1;")).toThrow(SyntaxError);
  });
});
