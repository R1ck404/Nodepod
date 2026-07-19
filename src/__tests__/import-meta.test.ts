import { describe, it, expect } from "vitest";
import { createImportMeta } from "../helpers/import-meta";
import { MemoryVolume } from "../memory-volume";
import { ScriptEngine } from "../script-engine";
import { isBuiltin } from "../polyfills/module";

describe("createImportMeta", () => {
  it("exposes url/filename/dirname/main", () => {
    const meta = createImportMeta({
      filename: "/app/entry.mjs",
      dirname: "/app",
      isMain: true,
      isBuiltin,
      resolvePath: (spec, from) => {
        if (spec === "./x.mjs") return `${from}/x.mjs`;
        throw Object.assign(new Error("not found"), { code: "MODULE_NOT_FOUND" });
      },
    });
    expect(meta.url).toBe("file:///app/entry.mjs");
    expect(meta.filename).toBe("/app/entry.mjs");
    expect(meta.dirname).toBe("/app");
    expect(meta.main).toBe(true);
  });

  it("resolve() returns file URLs for relative specifiers", () => {
    const meta = createImportMeta({
      filename: "/app/entry.mjs",
      dirname: "/app",
      isMain: true,
      isBuiltin,
      resolvePath: (spec, from) => `${from}/${spec.replace(/^\.\//, "")}`,
    });
    expect(meta.resolve("./x.mjs")).toBe("file:///app/x.mjs");
  });

  it("resolve() returns node: URLs for builtins", () => {
    const meta = createImportMeta({
      filename: "/app/entry.mjs",
      dirname: "/app",
      isMain: false,
      isBuiltin,
      resolvePath: (spec) => spec.replace(/^node:/, ""),
    });
    expect(meta.resolve("fs")).toBe("node:fs");
    expect(meta.resolve("node:path")).toBe("node:path");
  });

  it("resolve() honors parentURL", () => {
    const meta = createImportMeta({
      filename: "/app/entry.mjs",
      dirname: "/app",
      isMain: true,
      isBuiltin,
      resolvePath: (spec, from) => `${from}/${spec.replace(/^\.\//, "")}`,
    });
    expect(meta.resolve("./y.mjs", "file:///other/dir/mod.mjs")).toBe(
      "file:///other/dir/y.mjs",
    );
  });
});

describe("ScriptEngine import.meta", () => {
  function boot(files: Record<string, string>) {
    const vol = new MemoryVolume();
    for (const [path, src] of Object.entries(files)) {
      const dir = path.slice(0, path.lastIndexOf("/")) || "/";
      if (dir !== "/") vol.mkdirSync(dir, { recursive: true });
      vol.writeFileSync(path, src);
    }
    return new ScriptEngine(vol, { cwd: "/" });
  }

  it("entry module has import.meta.main === true", async () => {
    const eng = boot({
      "/entry.mjs": `
        export const isMain = import.meta.main;
        export const url = import.meta.url;
        export const filename = import.meta.filename;
        export const dirname = import.meta.dirname;
      `,
    });
    const { exports } = await eng.runFileTLA("/entry.mjs");
    const mod = exports as {
      isMain: boolean;
      url: string;
      filename: string;
      dirname: string;
    };
    expect(mod.isMain).toBe(true);
    expect(mod.url).toBe("file:///entry.mjs");
    expect(mod.filename).toBe("/entry.mjs");
    expect(mod.dirname).toBe("/");
  });

  it("dependency module has import.meta.main === false", async () => {
    const eng = boot({
      "/entry.mjs": `
        import { isMain as depMain } from "./dep.mjs";
        export const entryMain = import.meta.main;
        export { depMain };
      `,
      "/dep.mjs": `
        export const isMain = import.meta.main;
      `,
    });
    const { exports } = await eng.runFileTLA("/entry.mjs");
    const mod = exports as { entryMain: boolean; depMain: boolean };
    expect(mod.entryMain).toBe(true);
    expect(mod.depMain).toBe(false);
  });

  it("import.meta.resolve resolves relatives and builtins", async () => {
    const eng = boot({
      "/app/entry.mjs": `
        export const rel = import.meta.resolve("./sibling.mjs");
        export const builtin = import.meta.resolve("fs");
        export const nodeBuiltin = import.meta.resolve("node:path");
      `,
      "/app/sibling.mjs": `export default 1;`,
    });
    const { exports } = await eng.runFileTLA("/app/entry.mjs");
    const mod = exports as {
      rel: string;
      builtin: string;
      nodeBuiltin: string;
    };
    expect(mod.rel).toBe("file:///app/sibling.mjs");
    expect(mod.builtin).toBe("node:fs");
    expect(mod.nodeBuiltin).toBe("node:path");
  });

  it("regex fallback does not rewrite import.meta inside string literals", async () => {
    // Force a source that mentions the guard string Vite uses, plus a real
    // import.meta.url read. AST path preserves strings; this asserts the
    // runtime still sees the literal text either way.
    const eng = boot({
      "/guard.mjs": `
        export const guard = 'import.meta.glob';
        export const url = import.meta.url;
        export const hasGlobText = guard.includes('import.meta.glob');
      `,
    });
    const { exports } = await eng.runFileTLA("/guard.mjs");
    const mod = exports as {
      guard: string;
      url: string;
      hasGlobText: boolean;
    };
    expect(mod.guard).toBe("import.meta.glob");
    expect(mod.hasGlobText).toBe(true);
    expect(mod.url).toBe("file:///guard.mjs");
  });

  it("raw import of import.meta.glob fails with ScriptEngine fingerprint", async () => {
    const eng = boot({
      "/server/api/hello.ts": `export default function hello() { return 1; }`,
      "/server/register-api.ts": `
        const modules = import.meta.glob("./api/**/*.ts", { eager: true });
        export function listApis() { return Object.keys(modules); }
      `,
      "/probe.mjs": `
        try {
          await import("./server/register-api.ts");
          export const ok = true;
        } catch (e) {
          export const ok = false;
          export const message = e instanceof Error ? e.message : String(e);
        }
      `,
    });
    // Top-level try/catch with export inside is awkward after transform; run the
    // register-api file directly instead.
    await expect(eng.runFileTLA("/server/register-api.ts")).rejects.toThrow(
      /import_meta\.glob is not a function/,
    );
  });
});

describe("Vite import.meta.glob transform (host Node)", () => {
  it("ssr transform expands import.meta.glob before evaluation", async () => {
    const { mkdtemp, writeFile, mkdir, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { createServer } = await import("vite");

    const dir = await mkdtemp(join(tmpdir(), "nodepod-glob-"));
    try {
      await mkdir(join(dir, "server", "api"), { recursive: true });
      await writeFile(
        join(dir, "server", "api", "hello.ts"),
        `export default function hello() { return 1; }\n`,
      );
      await writeFile(
        join(dir, "server", "register-api.ts"),
        `
const modules = import.meta.glob("./api/**/*.ts", { eager: true });
export function listApis() { return Object.keys(modules).sort(); }
`,
      );

      const server = await createServer({
        configFile: false,
        root: dir,
        server: { middlewareMode: true },
        appType: "custom",
        logLevel: "silent",
      });

      const tr = await server.transformRequest("/server/register-api.ts", {
        ssr: true,
      });
      expect(tr?.code).toBeTruthy();
      expect(tr!.code).not.toMatch(/import\.meta\.glob\s*\(/);
      expect(tr!.code).toMatch(/hello\.ts/);

      const mod = await server.ssrLoadModule("/server/register-api.ts");
      expect(mod.listApis()).toEqual(["./api/hello.ts"]);

      await server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
