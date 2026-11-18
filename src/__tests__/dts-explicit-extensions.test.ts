import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Published .d.ts files must use explicit extensions on relative imports, or
// moduleResolution node16/nodenext consumers get `any` for every re-export.
// tsc keeps specifiers as written in src/, so src/ has to carry them.

const srcRoot = path.resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

describe("relative module specifiers in src/", () => {
  it("all carry an explicit file extension", () => {
    const bad: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
      const check = (lit: ts.Node | undefined) => {
        if (!lit || !ts.isStringLiteralLike(lit)) return;
        const spec = lit.text;
        if (/^\.{1,2}(\/|$)/.test(spec) && !/\.(?:[cm]?js|json)$/.test(spec)) {
          bad.push(`${path.relative(srcRoot, file)}: ${spec}`);
        }
      };
      const visit = (n: ts.Node): void => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) check(n.moduleSpecifier);
        else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) check(n.arguments[0]);
        else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) check(n.argument.literal);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(bad).toEqual([]);
  });
});

describe("scripts/fix-dts-extensions.mjs", async () => {
  const mod = await import(
    /* @vite-ignore */ pathToFileURL(path.resolve(srcRoot, "../scripts/fix-dts-extensions.mjs")).href
  );
  const files = new Set([
    path.resolve("/dist/polyfills/module.d.ts"),
    path.resolve("/dist/polyfills/events.d.ts"),
    path.resolve("/dist/host/index.d.ts"),
  ]);
  const exists = (p: string) => files.has(path.resolve(p));
  const from = path.resolve("/dist/polyfills/module.d.ts");
  const fix = (text: string) => mod.fixDeclarationText(text, from, exists) as string;

  it("adds .js to the typeof import() that tsc synthesizes", () => {
    expect(fix('var a: typeof import("./module").createRequire;')).toBe(
      'var a: typeof import("./module.js").createRequire;',
    );
  });

  it("rewrites file and directory specifiers", () => {
    expect(fix('export { E } from "./events";')).toBe('export { E } from "./events.js";');
    expect(fix('export * from "../host";')).toBe('export * from "../host/index.js";');
  });

  it("leaves extensioned, bare and unresolvable specifiers alone", () => {
    const text = 'import a from "./events.js"; import b from "node:fs"; import c from "./missing";';
    expect(fix(text)).toBe(text);
  });
});
