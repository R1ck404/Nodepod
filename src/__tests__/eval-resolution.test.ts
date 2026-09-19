// `node -e` must resolve relative specifiers from the cwd (node's [eval]
// module semantics). The top-level-await liveness fix lives in the browser
// probes (see WIP-STATUS.md); it cannot be reproduced under vitest/Node.

import { describe, it, expect } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { initShellExec, shellExec } from "../polyfills/child_process";
import type { ShellContext } from "../shell/shell-types";

function setup(files: Record<string, string>, cwd = "/workspace") {
  const vol = new MemoryVolume();
  vol.mkdirSync(cwd, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const dir = path.substring(0, path.lastIndexOf("/")) || "/";
    if (dir !== "/") vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(path, content);
  }
  initShellExec(vol, { cwd });
  const ctx: ShellContext = {
    cwd,
    env: { HOME: "/home", PATH: "/usr/bin", PWD: cwd },
    volume: vol,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
  return { vol, ctx };
}

function run(cmd: string) {
  return new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolve) => {
    shellExec(cmd, {}, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

describe("node -e resolution", () => {
  it("resolves dynamic import() relative to the cwd", async () => {
    setup({ "/workspace/probe.mjs": "export const marker = 'probe-ok';\n" });
    const r = await run(`cd /workspace && node -e "import('./probe.mjs').then(m => console.log(m.marker))"`);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("probe-ok\n");
    expect(r.error).toBeNull();
  });

  it("resolves require() relative to the cwd", async () => {
    setup({ "/workspace/lib/thing.js": "module.exports = { marker: 'req-ok' };\n" });
    const r = await run(`cd /workspace && node -e "console.log(require('./lib/thing').marker)"`);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("req-ok\n");
  });

  it("still reports a missing relative module against the cwd, not /", async () => {
    setup({});
    const r = await run(`cd /workspace && node -e "require('./nope')"`);
    expect(r.stderr).toContain("Cannot find module './nope' from '/workspace'");
  });

  it("leaves no eval scratch file behind", async () => {
    const { vol } = setup({});
    await run(`cd /workspace && node -e "console.log(1)"`);
    expect(vol.readdirSync("/").filter((n) => n.startsWith("<eval-"))).toEqual([]);
  });
});
