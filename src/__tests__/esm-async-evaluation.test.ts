// Top-level await in imported modules evaluates asynchronously, like node's
// ESM loader: importers wait for it, however long it takes. Expected output
// is what node prints for the same files.
import { describe, it, expect } from "vitest";
import { MemoryVolume } from "../memory-volume";
import {
  executeNodeBinary,
  initShellExec,
} from "../polyfills/child_process";
import type { ShellContext } from "../shell/shell-types";

async function run(
  entry: string,
  files: Record<string, string>,
): Promise<{ lines: string[]; stderr: string; exitCode: number }> {
  const vol = new MemoryVolume();
  for (const [path, content] of Object.entries(files)) {
    const dir = path.substring(0, path.lastIndexOf("/")) || "/";
    if (dir !== "/") vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(path, content);
  }
  initShellExec(vol, { cwd: "/" });
  const ctx: ShellContext = {
    cwd: "/",
    env: { HOME: "/home", PATH: "/usr/bin", PWD: "/" },
    volume: vol,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
  const r = await executeNodeBinary(entry, [], ctx);
  return { lines: r.stdout.trim().split("\n"), stderr: r.stderr, exitCode: r.exitCode };
}

const sleep = (ms: number, value = "undefined") =>
  `new Promise(r => setTimeout(() => r(${value}), ${ms}))`;

describe("top-level await in imported modules", () => {
  it("waits for a timer before the importer runs", async () => {
    const r = await run("/main.mjs", {
      "/lib.mjs": `export const v = await ${sleep(10, "42")};\n`,
      "/main.mjs": "import { v } from './lib.mjs';\nconsole.log(v);\n",
    });
    expect(r.lines).toEqual(["42"]);
    expect(r.exitCode).toBe(0);
  });

  it("evaluates in node's order: siblings don't wait for an async sibling", async () => {
    const r = await run("/main.mjs", {
      "/a.mjs": "console.log('a');\n",
      "/lib.mjs": [
        "console.log('lib start');",
        `await ${sleep(10)};`,
        "console.log('lib end');",
        "export const x = 1;",
      ].join("\n"),
      "/b.mjs": "console.log('b');\n",
      "/main.mjs": [
        "import './a.mjs';",
        "import { x } from './lib.mjs';",
        "import './b.mjs';",
        "console.log('main', x);",
      ].join("\n"),
    });
    expect(r.lines).toEqual(["a", "lib start", "b", "lib end", "main 1"]);
  });

  it("waits through an importer chain and for a shared dependency (#93 with real timers)", async () => {
    const r = await run("/main.mjs", {
      "/lib.mjs": [
        "async function f() {",
        `  const a = await ${sleep(5, "1")};`,
        `  const b = await ${sleep(5, "2")};`,
        "  return [a, b];",
        "}",
        "export const r = await f();",
      ].join("\n"),
      "/mid.mjs": [
        "import { r } from './lib.mjs';",
        "export const joined = r.join(',');",
        "console.log('mid', joined);",
      ].join("\n"),
      "/other.mjs": "import { r } from './lib.mjs';\nconsole.log('other', r.length);\n",
      "/main.mjs": [
        "import { joined } from './mid.mjs';",
        "import './other.mjs';",
        "console.log('main', joined);",
      ].join("\n"),
    });
    expect(r.lines).toEqual(["mid 1,2", "other 2", "main 1,2"]);
  });

  it("a rejection fails the importer and the process", async () => {
    const r = await run("/main.mjs", {
      "/lib.mjs": `await ${sleep(5)};\nthrow new Error('boom');\n`,
      "/main.mjs": "import './lib.mjs';\nconsole.log('unreachable');\n",
    });
    expect(r.lines.join("\n")).not.toContain("unreachable");
    expect(r.stderr).toContain("boom");
    expect(r.exitCode).toBe(1);
  });

  it("sibling async modules evaluate concurrently, re-exports wait for them", async () => {
    const r = await run("/main.mjs", {
      "/t1.mjs": `console.log('t1 start'); await ${sleep(30)}; console.log('t1 end'); export const a = 1;\n`,
      "/t2.mjs": `console.log('t2 start'); await ${sleep(10)}; console.log('t2 end'); export const b = 2;\n`,
      "/re.mjs": "export * from './t1.mjs';\nexport { b as bee } from './t2.mjs';\n",
      "/main.mjs": "import { a, bee } from './re.mjs';\nconsole.log('main', a, bee);\n",
    });
    expect(r.lines).toEqual(["t1 start", "t2 start", "t2 end", "t1 end", "main 1 2"]);
  });

  it("import() from CommonJS waits for the module", async () => {
    const r = await run("/main.js", {
      "/lib.mjs": `export const v = await ${sleep(10, "'late'")};\n`,
      "/main.js": [
        "import('./lib.mjs').then(m => console.log('dyn', m.v));",
        "console.log('sync');",
      ].join("\n"),
    });
    expect(r.lines).toEqual(["sync", "dyn late"]);
  });

  it("concurrent import()s share one evaluation", async () => {
    const r = await run("/main.mjs", {
      "/lib.mjs": `console.log('evaluating lib');\nexport const v = await ${sleep(5, "7")};\n`,
      "/main.mjs": [
        "const [a, b] = await Promise.all([import('./lib.mjs'), import('./lib.mjs')]);",
        "console.log(a.v, b.v, a.v === b.v);",
      ].join("\n"),
    });
    expect(r.lines).toEqual(["evaluating lib", "7 7 true"]);
  });

  it("a cycle through an async module doesn't deadlock", async () => {
    const r = await run("/a.mjs", {
      "/a.mjs": [
        "import { later } from './b.mjs';",
        "export function name() { return 'a'; }",
        "console.log('a', await later());",
      ].join("\n"),
      "/b.mjs": [
        "import { name } from './a.mjs';",
        `await ${sleep(5)};`,
        "export const later = async () => 'b saw ' + name();",
        "console.log('b');",
      ].join("\n"),
    });
    expect(r.lines).toEqual(["b", "a b saw a"]);
  });

  it("require() of a module with top-level await still unwraps what settles synchronously", async () => {
    const r = await run("/main.js", {
      "/lib.mjs": "export const v = await Promise.resolve(1).then(x => x + 1);\n",
      "/main.js": "console.log(require('./lib.mjs').v);\n",
    });
    expect(r.lines).toEqual(["2"]);
  });

  it("require() unwraps an async function's awaits that settle synchronously (#93)", async () => {
    const r = await run("/main.js", {
      "/lib.mjs": [
        "async function f() {",
        "  const a = await Promise.resolve(1);",
        "  const b = await Promise.resolve(2);",
        "  return [a, b];",
        "}",
        "export const r = await f();",
      ].join("\n"),
      "/main.js": "console.log(require('./lib.mjs').r.join(','));\n",
    });
    expect(r.lines).toEqual(["1,2"]);
  });
});
