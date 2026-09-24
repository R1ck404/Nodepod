import { describe, it, expect } from "vitest";
import {
  esmToCjs,
  hasTopLevelAwait,
  stripTopLevelAwait,
} from "../syntax-transforms";

describe("esmToCjs", () => {
  describe("import declarations", () => {
    it("converts default import", () => {
      const result = esmToCjs('import foo from "bar";');
      expect(result).toContain('require("bar")');
      expect(result).not.toContain("import");
    });

    it("converts named imports", () => {
      const result = esmToCjs('import { a, b } from "mod";');
      expect(result).toContain('require("mod")');
      expect(result).toContain("a");
      expect(result).toContain("b");
    });

    it("converts namespace import", () => {
      const result = esmToCjs('import * as ns from "mod";');
      expect(result).toContain('require("mod")');
      expect(result).toContain("ns");
    });

    it("converts side-effect-only import", () => {
      const result = esmToCjs('import "polyfill";');
      expect(result).toContain('require("polyfill")');
    });

    it("converts aliased named imports", () => {
      const result = esmToCjs('import { foo as bar } from "mod";');
      expect(result).toContain('require("mod")');
      expect(result).toContain("bar");
    });

    it("handles multiple imports", () => {
      const code = `
import a from "a";
import { b } from "b";
import * as c from "c";
`;
      const result = esmToCjs(code);
      expect(result).toContain('require("a")');
      expect(result).toContain('require("b")');
      expect(result).toContain('require("c")');
      expect(result).not.toContain("import ");
    });

    it("preserves the rest of the code unchanged", () => {
      const code = `import x from "x";\nconst y = 42;\nconsole.log(y);`;
      const result = esmToCjs(code);
      expect(result).toContain("const y = 42");
      expect(result).toContain("console.log(y)");
    });
  });

  describe("export declarations", () => {
    it("converts export default expression", () => {
      const result = esmToCjs("export default 42;");
      expect(result).toContain("module.exports");
      expect(result).toContain("42");
    });

    it("converts export default function", () => {
      const result = esmToCjs("export default function foo() { return 1; }");
      expect(result).toContain("function foo()");
    });

    it("converts named export of const", () => {
      const result = esmToCjs("export const x = 1;");
      expect(result).toContain("const x = 1");
      expect(result).toContain("exports.x");
    });

    it("converts named export of function", () => {
      const result = esmToCjs("export function greet() { return 'hi'; }");
      expect(result).toContain("function greet()");
      expect(result).toContain("exports.greet");
    });

    it("converts export { a, b }", () => {
      const code = "const a = 1; const b = 2; export { a, b };";
      const result = esmToCjs(code);
      expect(result).toContain("exports.a");
      expect(result).toContain("exports.b");
    });

    it("converts export * from", () => {
      const result = esmToCjs('export * from "mod";');
      expect(result).toContain('require("mod")');
      expect(result).toContain("Object.assign");
    });
  });

  describe("passthrough", () => {
    it("returns plain CJS unchanged", () => {
      const code = 'const x = require("foo"); module.exports = x;';
      const result = esmToCjs(code);
      expect(result).toContain('require("foo")');
      expect(result).toContain("module.exports = x");
    });
  });

  describe("mixed exports", () => {
    it("handles both default and named exports", () => {
      const code = `
export const x = 1;
export default 42;
`;
      const result = esmToCjs(code);
      expect(result).toContain("exports");
      expect(result).toContain("x");
    });
  });
});

describe("hasTopLevelAwait", () => {
  it("returns true for top-level await", () => {
    expect(hasTopLevelAwait("const x = await fetch('/api');")).toBe(true);
  });

  it("returns false when await is inside async function", () => {
    expect(
      hasTopLevelAwait("async function f() { await x; }"),
    ).toBe(false);
  });

  it("returns false when no await keyword", () => {
    expect(hasTopLevelAwait("const x = 1;")).toBe(false);
  });

  it("returns true for for-await-of at top level", () => {
    expect(
      hasTopLevelAwait("for await (const x of iter) { console.log(x); }"),
    ).toBe(true);
  });

  it("returns false for 'await' inside a string", () => {
    const code = "const s = 'await is cool';";
    expect(hasTopLevelAwait(code)).toBe(false);
  });
});

describe("stripTopLevelAwait", () => {
  it("replaces top-level await expressions", () => {
    const result = stripTopLevelAwait("const x = await foo();");
    expect(result).not.toContain("await foo()");
  });

  it("returns input unchanged when no await present", () => {
    const code = "const x = 1 + 2;";
    expect(stripTopLevelAwait(code)).toBe(code);
  });

  it("keeps await (yield x) in an async generator parseable in full mode", () => {
    const out = stripTopLevelAwait(
      "async function* g() { const x = await (yield 1); return x; }",
      "full",
    );
    expect(out).not.toContain("await");
    expect(() => new Function(out)).not.toThrow();
  });
});
