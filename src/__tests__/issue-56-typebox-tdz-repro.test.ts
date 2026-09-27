// regression tests for issue #56
// https://github.com/ScelarOrg/Nodepod/issues/56
//
// covers three layered bugs that surfaced from one issue:
//   1. TDZ on `Object.defineProperty(exports, ...)` when user code shadows
//      Object/Array/etc (eg typebox 1.x's `import { Object }`)
//   2. mixed exports clobber: `export * as X from 'mod'` + `export default`
//      together caused the named re-export to be overwritten
//   3. circular ESM destructure capturing undefined during partial load

import { describe, it, expect } from "vitest";
import { ScriptEngine } from "../script-engine";
import { MemoryVolume } from "../memory-volume";

function createEngine(files: Record<string, string>) {
  const vol = new MemoryVolume();
  vol.mkdirSync("/project", { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const dir = path.substring(0, path.lastIndexOf("/")) || "/";
    if (dir !== "/") vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(path, content);
  }
  return new ScriptEngine(vol, { cwd: "/project" });
}

describe("issue 56 typebox 1.x TDZ regression", () => {
  it("repro 1: single file `export function Object` does not break wrapper preamble", () => {
    const engine = createEngine({
      "/project/single.mjs": [
        "export function Object(properties) { return { kind: 'Object', properties }; }",
        "export const SAMPLE = Object({});",
      ].join("\n"),
    });
    // pre-fix: threw "Object.defineProperty is not a function"
    const r = engine.execute(
      "const m = require('./single.mjs'); module.exports = m.SAMPLE;",
      "/project/__entry.js",
    );
    expect(r.exports).toEqual({ kind: "Object", properties: {} });
  });

  it("repro 2: cross-file `import { Object } from './types/object.mjs'` (exact typebox pattern)", () => {
    const engine = createEngine({
      "/project/types/object.mjs": [
        "export function Object(properties) {",
        "  return { '~kind': 'Object', type: 'object', properties };",
        "}",
        "export function IsObject(v) { return v && v['~kind'] === 'Object'; }",
        "export function ObjectOptions(t) { const { properties, ...rest } = t; return rest; }",
      ].join("\n"),
      "/project/engine/instantiate.mjs": [
        "// mirrors typebox/build/type/engine/instantiate.mjs line 20",
        "import { Object, IsObject, ObjectOptions } from '../types/object.mjs';",
        "export function Instantiate(t) {",
        "  if (IsObject(t)) return Object(t.properties);",
        "  return t;",
        "}",
      ].join("\n"),
    });
    // pre-fix: threw "Cannot access 'Object' before initialization"
    const r = engine.execute(
      [
        "const m = require('./engine/instantiate.mjs');",
        "module.exports = m.Instantiate({ '~kind': 'Object', properties: {} });",
      ].join("\n"),
      "/project/__entry.js",
    );
    expect(r.exports).toEqual({
      "~kind": "Object",
      type: "object",
      properties: {},
    });
  });

  it("repro 3: full typebox-style named-import set (Object, Array, Promise, Function, Iterator)", () => {
    const mk = (name: string) =>
      `export function ${name}(x) { return { '~kind': '${name}', body: x }; }\n` +
      `export function Is${name}(v) { return v && v['~kind'] === '${name}'; }\n`;
    const engine = createEngine({
      "/project/types/object.mjs": mk("Object"),
      "/project/types/array.mjs": mk("Array"),
      "/project/types/promise.mjs": mk("Promise"),
      "/project/types/function.mjs": mk("Function"),
      "/project/types/iterator.mjs": mk("Iterator"),
      "/project/engine/instantiate.mjs": [
        "// mirrors typebox/build/type/engine/instantiate.mjs imports verbatim",
        "import { Object, IsObject } from '../types/object.mjs';",
        "import { Array, IsArray } from '../types/array.mjs';",
        "import { Promise, IsPromise } from '../types/promise.mjs';",
        "import { Function, IsFunction } from '../types/function.mjs';",
        "import { Iterator, IsIterator } from '../types/iterator.mjs';",
        "export function Instantiate(t) {",
        "  if (IsObject(t)) return Object(t);",
        "  if (IsArray(t))  return Array(t);",
        "  if (IsPromise(t)) return Promise(t);",
        "  if (IsFunction(t)) return Function(t);",
        "  if (IsIterator(t)) return Iterator(t);",
        "  return t;",
        "}",
      ].join("\n"),
    });
    // pre-fix: threw "Cannot access 'Object' before initialization"
    const r = engine.execute(
      [
        "const m = require('./engine/instantiate.mjs');",
        "module.exports = m.Instantiate({ '~kind': 'Object' });",
      ].join("\n"),
      "/project/__entry.js",
    );
    expect(r.exports).toEqual({ "~kind": "Object", body: { "~kind": "Object" } });
  });

  it("repro 4: `export class Object` (class-style shadowing)", () => {
    const engine = createEngine({
      "/project/types/object.mjs": [
        "export class Object {",
        "  constructor(props) { this.props = props; this.kind = 'Object'; }",
        "  static is(v) { return v && v.kind === 'Object'; }",
        "}",
      ].join("\n"),
      "/project/main.mjs": [
        "import { Object } from './types/object.mjs';",
        "export const sample = new Object({ a: 1 });",
      ].join("\n"),
    });
    // pre-fix: threw "Cannot access 'Object' before initialization"
    const r = engine.execute(
      "const m = require('./main.mjs'); module.exports = m.sample.props;",
      "/project/__entry.js",
    );
    expect(r.exports).toEqual({ a: 1 });
  });

  it("ESM modules still get __esModule = true on their exports object", () => {
    const engine = createEngine({
      "/project/lib.mjs": "export const greeting = 'hi';",
    });
    // marker still gets set (outer scope now). default-import interop uses it.
    const r = engine.execute(
      "const m = require('./lib.mjs'); module.exports = m;",
      "/project/__entry.js",
    );
    const exp = r.exports as { __esModule?: boolean; greeting?: string };
    expect(exp.__esModule).toBe(true);
    expect(exp.greeting).toBe("hi");
  });

  it("non-ESM (CJS) modules do NOT get __esModule = true (interop preserved)", () => {
    const engine = createEngine({
      "/project/cjs.js": "module.exports = { greeting: 'hi' };",
    });
    const r = engine.execute(
      "const m = require('./cjs.js'); module.exports = m;",
      "/project/__entry.js",
    );
    const exp = r.exports as { __esModule?: boolean; greeting?: string };
    expect(exp.__esModule).toBeUndefined();
    expect(exp.greeting).toBe("hi");
  });

  // typebox guard/index.mjs combines `export * as Guard from ...` with
  // `export default Guard`. without the fix, ExportAllDeclaration didnt
  // count as named, so loader did `module.exports = Guard` and clobbered
  // the prior `exports.Guard = ...`. consumers got undefined.
  it("export-all + export-default mix preserves named re-exports (pi-coding-agent regression)", () => {
    const engine = createEngine({
      "/project/guard.mjs": [
        "export function IsObject(v) { return typeof v === 'object' && v !== null; }",
        "export function IsBigInt(v) { return typeof v === 'bigint'; }",
      ].join("\n"),
      "/project/index.mjs": [
        "// mirrors typebox/build/guard/index.mjs",
        "import * as Guard from './guard.mjs';",
        "export * as Guard from './guard.mjs';",
        "export default Guard;",
      ].join("\n"),
      "/project/consumer.mjs": [
        "// mirrors typebox/build/value/delta/diff.mjs",
        "import { Guard } from './index.mjs';",
        "export function check() { return Guard.IsBigInt(1n); }",
      ].join("\n"),
    });
    const r = engine.execute(
      "const m = require('./consumer.mjs'); module.exports = m.check();",
      "/project/__entry.js",
    );
    expect(r.exports).toBe(true);
  });

  // typebox engine/instantiate.mjs <-> engine/awaited/instantiate.mjs is
  // a circular ESM import. real ESM uses live bindings, but nodepod's
  // `const { X } = require(...)` captures the value at require-time. the
  // partial load hasnt run `exports.X = X` yet so destructure gets
  // undefined. fix hoists `exports.X = X` to the top (function decls are
  // value-hoisted so it resolves correctly even before the body).
  it("circular ESM: export function is observable via partial exports during a circular load", () => {
    const engine = createEngine({
      "/project/parent.mjs": [
        "import { fromChild } from './child.mjs';",
        "export function helperFromParent() { return 'parent-helper'; }",
        "export function callsChild() { return fromChild(); }",
      ].join("\n"),
      "/project/child.mjs": [
        "import { helperFromParent } from './parent.mjs';",
        "export function fromChild() {",
        "  if (typeof helperFromParent !== 'function') {",
        "    throw new TypeError('helperFromParent is not a function');",
        "  }",
        "  return helperFromParent();",
        "}",
      ].join("\n"),
    });
    // pre-fix: child captured helperFromParent at require-time during
    // parent's partial load, before `exports.helperFromParent = ...` ran
    const r = engine.execute(
      "const m = require('./parent.mjs'); module.exports = m.callsChild();",
      "/project/__entry.js",
    );
    expect(r.exports).toBe("parent-helper");
  });

  // same cycle in bundler output, where the functions are exported through
  // one `export { ... }` list at the end of the file: astro's
  // core/routing/create-manifest.js <-> assets/endpoint/config.js
  // ("resolveInjectedRoute is not a function" in astro build / dev)
  it("circular ESM: functions exported via a trailing export list are observable during a circular load", () => {
    const engine = createEngine({
      "/project/parent.mjs": [
        "import { fromChild } from './child.mjs';",
        "function helperFromParent() { return 'parent-helper'; }",
        "function callsChild() { return fromChild(); }",
        "let counter = 1;",
        "counter++;",
        "export {",
        "  callsChild,",
        "  counter,",
        "  helperFromParent as helper",
        "};",
      ].join("\n"),
      "/project/child.mjs": [
        "import { helper } from './parent.mjs';",
        "function fromChild() { return helper(); }",
        "export { fromChild };",
      ].join("\n"),
    });
    const r = engine.execute(
      "const m = require('./parent.mjs'); module.exports = [m.callsChild(), m.counter];",
      "/project/__entry.js",
    );
    expect(r.exports).toEqual(["parent-helper", 2]);
  });

  // `export const` can't be hoisted (TDZ), so the importer captured
  // undefined from the partial exports and kept it: zod 4.6's core.js <->
  // util.js `globalConfig` ("reading 'jitless'" in astro dev) and astro's
  // manifest/serialized.js <-> build/plugins/plugin-manifest.js (build).
  // the bindings are live like real ESM once the exporter finishes.
  it("circular ESM: const, default and module.exports imports update once the exporter finishes", () => {
    const engine = createEngine({
      "/project/core.mjs": [
        "import { members } from './util.mjs';",
        "export const globalConfig = { jitless: false };",
        "export default { kind: 'core-default' };",
        "export const hasMembers = typeof members === 'function';",
      ].join("\n"),
      "/project/util.mjs": [
        "import core, { globalConfig } from './core.mjs';",
        "export function members() {}",
        "export function allowsEval() { return !globalConfig.jitless; }",
        "export function defaultKind() { return core.kind; }",
      ].join("\n"),
      // CommonJS exporter replacing module.exports after the cycle
      "/project/legacy.cjs": [
        "require('./consumer.mjs');",
        "module.exports = { name: 'legacy' };",
      ].join("\n"),
      "/project/consumer.mjs": [
        "import legacy, { name } from './legacy.cjs';",
        "export function legacyInfo() { return [legacy.name, name]; }",
      ].join("\n"),
    });
    const r = engine.execute(
      [
        "const core = require('./core.mjs');",
        "const util = require('./util.mjs');",
        "require('./legacy.cjs');",
        "const consumer = require('./consumer.mjs');",
        "module.exports = [util.allowsEval(), util.defaultKind(), core.hasMembers, consumer.legacyInfo()];",
      ].join("\n"),
      "/project/__entry.js",
    );
    expect(r.exports).toEqual([true, "core-default", true, ["legacy", "legacy"]]);
  });

  it("export-all + export-default also exposes `default` correctly", () => {
    const engine = createEngine({
      "/project/inner.mjs":
        "export function probe() { return 'inner'; }",
      "/project/outer.mjs": [
        "import * as Inner from './inner.mjs';",
        "export * as Inner from './inner.mjs';",
        "export default Inner;",
      ].join("\n"),
    });
    // both `import { Inner }` and default-import shapes must work
    const r = engine.execute(
      [
        "const m = require('./outer.mjs');",
        "module.exports = {",
        "  fromNamed: m.Inner.probe(),",
        "  fromDefault: (m.default || m).probe(),",
        "};",
      ].join("\n"),
      "/project/__entry.js",
    );
    expect(r.exports).toEqual({ fromNamed: "inner", fromDefault: "inner" });
  });

});
