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
    const vol = new MemoryVolume();
    vol.writeFileSync(
      "/lib.mjs",
      "export const v = await Promise.resolve(1).then(x => x + 1);\n"
    );
    vol.writeFileSync(
      "/a.mjs",
      "import { v } from './lib.mjs';\nconsole.log(v);\n"
    );
    initShellExec(vol, { cwd: "/" });
    const ctx: ShellContext = {
      cwd: "/",
      env: { HOME: "/home", PATH: "/usr/bin", PWD: "/" },
      volume: vol,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };
    const { executeNodeBinary: run } = await import(
      "../polyfills/child_process"
    );
    const r = await run("/a.mjs", [], ctx);
    expect(r.stdout.trim().split("\n").pop()).toBe("2");
  });
});
