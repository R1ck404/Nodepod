import { describe, it, expect } from "vitest";
import { MemoryVolume } from "../memory-volume";
import {
  executeNodeBinary,
  initShellExec,
} from "../polyfills/child_process";
import type { ShellContext } from "../shell/shell-types";

function setup(files: Record<string, string>) {
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
  return { vol, ctx };
}

async function runLines(code: string): Promise<string[]> {
  const { ctx } = setup({ "/order.js": code });
  const r = await executeNodeBinary("/order.js", [], ctx);
  return r.stdout.trim().split("\n");
}

async function runFiles(
  entry: string,
  files: Record<string, string>,
): Promise<string[]> {
  const { ctx } = setup(files);
  const r = await executeNodeBinary(entry, [], ctx);
  return r.stdout.trim().split("\n");
}

describe("event-loop ordering parity with node", () => {
  it("sync statements run before any .then callback", async () => {
    const lines = await runLines(
      [
        "Promise.resolve().then(()=>console.log('promise'));",
        "console.log('sync');",
      ].join("\n"),
    );
    expect(lines).toEqual(["sync", "promise"]);
  });

  it("nextTick runs before promise callbacks, both after sync code", async () => {
    const lines = await runLines(
      [
        "process.nextTick(()=>console.log('tick'));",
        "Promise.resolve().then(()=>console.log('promise'));",
        "console.log('sync');",
      ].join("\n"),
    );
    expect(lines).toEqual(["sync", "tick", "promise"]);
  });

  it("chained nextTick ordering is preserved", async () => {
    const lines = await runLines(
      [
        "process.nextTick(()=>{console.log('n1');process.nextTick(()=>console.log('n2'));});",
        "Promise.resolve().then(()=>console.log('p1'));",
        "console.log('s');",
      ].join("\n"),
    );
    expect(lines).toEqual(["s", "n1", "n2", "p1"]);
  });

  it("setImmediate still fires (top-level timer-vs-immediate order is a known browser limitation)", async () => {
    const lines = await runLines(
      "setImmediate(()=>console.log('immediate'));\nconsole.log('sync');",
    );
    expect(lines).toEqual(["sync", "immediate"]);
  });

  it("top-level await with a .then chain unwraps on import", async () => {
    const lines = await runFiles("/a.mjs", {
      "/lib.mjs": "export const v = await Promise.resolve(1).then(x => x + 1);\n",
      "/a.mjs": "import { v } from './lib.mjs';\nconsole.log(v);\n",
    });
    expect(lines).toEqual(["2"]);
  });

  it("top-level await unwraps promise chains built before the await", async () => {
    const lines = await runFiles("/a.mjs", {
      "/lib.mjs": [
        "const log = (...a) => console.log(...a);",
        "const p = Promise.resolve().then(() => { log('p'); return 7; });",
        "const ps = [1, 2].map(x => Promise.resolve(x).then(y => y * 10));",
        "const nested = new Promise(r => r(Promise.resolve(5)));",
        "log('s');",
        "export const v = [await p, (await Promise.all(ps)).join('+'), await nested].join(',');",
      ].join("\n"),
      "/a.mjs": "import { v } from './lib.mjs';\nconsole.log(v);\n",
    });
    expect(lines).toEqual(["s", "p", "7,10+20,5"]);
  });

  it("a rejected top-level await throws at the await site", async () => {
    const lines = await runFiles("/a.mjs", {
      "/lib.mjs": [
        "let v;",
        "try { v = await Promise.reject(new Error('x')); } catch (e) { v = 'caught ' + e.message; }",
        "export const w = await Promise.reject(new Error('y')).catch(e => 'c:' + e.message);",
        "export { v };",
      ].join("\n"),
      "/a.mjs": "import { v, w } from './lib.mjs';\nconsole.log(v, w);\n",
    });
    expect(lines).toEqual(["caught x c:y"]);
  });

  it("a settled .then() step drops its link to the parent promise", async () => {
    // the link that lets top-level await force a chain must not outlive the
    // step, or `q = q.then(task)` queues keep every earlier step reachable
    const lines = await runLines(
      [
        "let q = Promise.resolve(1).then(x => x);",
        "const pending = q._lazy !== undefined;",
        "for (let i = 0; i < 3; i++) q = q.then(x => x);",
        "setTimeout(() => console.log(pending, q._lazy === undefined), 0);",
      ].join("\n"),
    );
    expect(lines).toEqual(["true true"]);
  });

  it("a throwing nextTick goes to uncaughtException and the drain continues", async () => {
    const lines = await runLines(
      [
        "process.on('uncaughtException', e => console.log('uncaught', e.message));",
        "process.nextTick(() => { throw new Error('boom'); });",
        "process.nextTick(() => console.log('b'));",
      ].join("\n"),
    );
    expect(lines).toEqual(["uncaught boom", "b"]);
  });

  it("process.exit() inside a nextTick stops the remaining ticks", async () => {
    const { ctx } = setup({
      "/order.js": [
        "process.nextTick(() => process.exit(0));",
        "process.nextTick(() => console.log('after exit'));",
      ].join("\n"),
    });
    const r = await executeNodeBinary("/order.js", [], ctx);
    expect(r.stdout).not.toContain("after exit");
    expect(r.exitCode).toBe(0);
  });
});
