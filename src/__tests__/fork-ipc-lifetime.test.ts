import { describe, it, expect } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { executeNodeBinary, initShellExec } from "../polyfills/child_process";
import type { ShellContext } from "../shell/shell-types";

function runForked(code: string) {
  const vol = new MemoryVolume();
  vol.writeFileSync("/child.js", code);
  initShellExec(vol, { cwd: "/" });
  const ctx: ShellContext = {
    cwd: "/",
    env: { HOME: "/home", PATH: "/usr/bin", PWD: "/" },
    volume: vol,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
  return executeNodeBinary("/child.js", [], ctx, { isFork: true });
}

describe("forked child IPC channel", () => {
  it("does not keep a child that never listens for messages alive", async () => {
    const r = await runForked("console.log('done');");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("done");
  }, 10_000);

  it("keeps the child alive while it listens, and lets it go when it stops", async () => {
    const r = await runForked(
      [
        "const onMessage = () => {};",
        "process.on('message', onMessage);",
        "setTimeout(() => { console.log('still here'); process.off('message', onMessage); }, 50);",
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("still here");
  }, 10_000);
});
