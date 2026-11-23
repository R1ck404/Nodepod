import { describe, it, expect } from "vitest";
import { stripTypeScript, isTypeScriptFile } from "../strip-typescript";
import { ScriptEngine } from "../script-engine";
import { MemoryVolume } from "../memory-volume";

function assertParsesAsScript(code: string): void {
  const body = code
    .replace(/^\s*import\s+[^;]+;/gm, "")
    .replace(/^\s*export\s+\{[^}]*\}\s*;?/gm, "")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^\s*export\s+/gm, "");
  expect(() => {
    new Function(`"use strict"; return (async () => {\n${body}\n});`);
  }).not.toThrow();
}

describe("isTypeScriptFile", () => {
  it("detects ts/tsx/mts/cts extensions", () => {
    expect(isTypeScriptFile("/a.ts")).toBe(true);
    expect(isTypeScriptFile("/a.tsx")).toBe(true);
    expect(isTypeScriptFile("/a.mts")).toBe(true);
    expect(isTypeScriptFile("/a.cts")).toBe(true);
    expect(isTypeScriptFile("/a.js")).toBe(false);
  });

  it("detects Vite lang.ts query params", () => {
    expect(isTypeScriptFile("/App.vue?type=script&lang.ts")).toBe(true);
    expect(isTypeScriptFile("/App.vue?lang=tsx")).toBe(true);
  });
});

describe("stripTypeScript", () => {
  it("strips inline object generics with optional props (the Unexpected token '?' bug)", () => {
    const src = `
export async function PATCH(ctx: ApiContext) {
  const body = await ctx.readJson<{ value?: string | null }>();
  return body.value ?? null;
}
`;
    const out = stripTypeScript(src, "/cells/[rowId].[columnId].ts");
    expect(out).not.toContain("value?:");
    expect(out).not.toContain("<{");
    expect(out).toContain("readJson()");
    expect(out).toContain("?? null");
    assertParsesAsScript(out);
  });

  it("strips nested object generics and named utility generics", () => {
    const out = stripTypeScript(
      `
const a = await readJson<{ value?: string | null; meta?: { ok?: boolean } }>();
const b = Promise.resolve<number>(1);
const c = new Map<string, number>();
`,
      "g.ts",
    );
    expect(out).not.toContain("value?:");
    expect(out).not.toContain("ok?:");
    expect(out).toContain("readJson()");
    expect(out).toContain("Promise.resolve(1)");
    assertParsesAsScript(out);
  });

  it("removes import type", () => {
    const out = stripTypeScript(
      `import type { Foo } from "./x";\nimport { bar } from "./y";\nconst a = bar;`,
      "a.ts",
    );
    expect(out).not.toMatch(/import\s+type/);
    expect(out).toContain('import { bar } from "./y"');
  });

  it("emits runtime enums", () => {
    const out = stripTypeScript(
      `enum Color { Red = 1, Green }\nconst c = Color.Green;`,
      "e.ts",
    );
    expect(out).toContain("Color");
    expect(out).toContain("Green");
    assertParsesAsScript(out);
  });

  it("strips satisfies and as casts", () => {
    const out = stripTypeScript(
      `const x = { a: 1 } satisfies Record<string, number>;\nconst y = z as Foo;`,
      "s.ts",
    );
    expect(out).not.toContain("satisfies");
    expect(out).not.toMatch(/\sas\s+Foo/);
    assertParsesAsScript(out);
  });

  it("preserves ?? and ?. while stripping non-null and casts", () => {
    const out = stripTypeScript(
      `const v = obj?.method?.(a as number) ?? y!.z!;`,
      "p.ts",
    );
    expect(out).toContain("?.");
    expect(out).toContain("??");
    expect(out).not.toContain(" as ");
    assertParsesAsScript(out);
  });

  it("does not strip numeric comparisons", () => {
    const out = stripTypeScript(`const ok = a < b && b > c;`, "cmp.ts");
    expect(out).toContain("a < b");
    expect(out).toContain("b > c");
  });

  it("strips a typical API route (timed in bench/strip-typescript.bench.ts)", () => {
    const src = `
import type { ApiContext } from "./http";
export async function PATCH(ctx: ApiContext) {
  const body = await ctx.readJson<{ value?: string | null }>();
  return body.value ?? null;
}
`.repeat(20);
    const out = stripTypeScript(src, "cells.ts");
    expect(out).not.toContain("ApiContext");
    expect(out).not.toContain("readJson<");
    expect(out).toContain("body.value ?? null");
    assertParsesAsScript(out);
  });
});

describe("stripTypeScript via ScriptEngine", () => {
  it("executes the databases cells PATCH pattern without Unexpected token '?'", () => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/app", { recursive: true });
    vol.writeFileSync(
      "/app/cells.ts",
      `
export async function PATCH(ctx: any) {
  const body = await ctx.readJson<{ value?: string | null }>();
  return body.value ?? null;
}
`,
    );

    const engine = new ScriptEngine(vol, { cwd: "/app" });
    const { exports } = engine.runFile("/app/cells.ts") as {
      exports: { PATCH: (ctx: any) => Promise<unknown> };
    };
    expect(typeof exports.PATCH).toBe("function");
  });

  it("runs mixed modern TS features used by API routes", async () => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/app", { recursive: true });
    vol.writeFileSync(
      "/app/mixed.ts",
      `
enum Kind { A = 1, B }

export async function run(input: string, opts?: { flag?: boolean }) {
  const body = await Promise.resolve<{ value?: string }>({ value: input });
  const kind: Kind = Kind.B;
  const name = (undefined as any)?.name ?? "anon";
  return { body, kind, name, flag: opts?.flag ?? false };
}
`,
    );

    const logs: string[] = [];
    const engine = new ScriptEngine(vol, {
      cwd: "/app",
      onConsole: (_m, args) => logs.push(args.map(String).join(" ")),
    });
    const { exports } = (await engine.runFileTLA("/app/mixed.ts")) as {
      exports: { run: (input: string, opts?: { flag?: boolean }) => any };
    };

    const result = await exports.run("hello", { flag: true });
    expect(result).toEqual({
      body: { value: "hello" },
      kind: 2,
      name: "anon",
      flag: true,
    });
  });
});
