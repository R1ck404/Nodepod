// What zx needs to run `$\`cmd\`` (npx zx script.mjs): `which.sync("bash")`
// finds an executable bash on PATH (isexe compares stat mode/uid/gid with
// process.getuid()/getgid()), the command runs through
// spawn(cmd, [], { shell: "/bin/bash" }), and its cli recognizes itself as
// the entry via `new URL("file:" + __filename)`.

import { describe, it, expect, afterEach } from "vitest";
import { MemoryVolume } from "../memory-volume";
import {
  initShellExec,
  setSpawnChildCallback,
  shellExec,
  spawn,
} from "../polyfills/child_process";
import { buildProcessEnv } from "../polyfills/process";
import { URL as NodeURL, fileURLToPath, toNodeFileUrl } from "../polyfills/url";

function collect(child: ReturnType<typeof spawn>): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (d: unknown) => (out += String(d)));
    child.once("error", reject);
    child.once("close", (code: number) => resolve({ code, out }));
  });
}

function run(command: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    shellExec(command, {}, (err, stdout) => {
      resolve({ stdout: String(stdout ?? ""), code: err ? ((err as { code?: number }).code ?? 1) : 0 });
    });
  });
}

describe("spawn's shell option", () => {
  afterEach(() => setSpawnChildCallback(null));

  it("runs the joined command line as `<shell> -c`, like node", async () => {
    const seen: Array<[string, string[]]> = [];
    setSpawnChildCallback(async (command, args) => {
      seen.push([command, args]);
      return { pid: 1, exitCode: 0, stdout: "", stderr: "" };
    });
    await collect(spawn("set -euo pipefail;echo hi", [], { shell: "/bin/bash" }));
    await collect(spawn("echo", ["a", "b"], { shell: true }));
    await collect(spawn("echo", ["plain"]));
    expect(seen).toEqual([
      ["/bin/bash", ["-c", "set -euo pipefail;echo hi"]],
      ["/bin/sh", ["-c", "echo a b"]],
      ["echo", ["plain"]],
    ]);
  });

  it("runs through the nodepod shell", async () => {
    initShellExec(new MemoryVolume(), { cwd: "/" });
    expect(await collect(spawn("echo hi there", [], { shell: true }))).toEqual({ code: 0, out: "hi there\n" });
    expect(
      await collect(spawn("set -euo pipefail;echo zx-says-hi", [], { shell: "/bin/bash" })),
    ).toEqual({ code: 0, out: "zx-says-hi\n" });
  });
});

describe("/bin/sh and /bin/bash", () => {
  it("are executables `which` finds, owned by process.getuid()", () => {
    const vol = new MemoryVolume();
    initShellExec(vol, { cwd: "/" });
    const proc = buildProcessEnv();
    for (const path of ["/bin/sh", "/bin/bash"]) {
      const st = vol.statSync(path);
      expect(st.isFile()).toBe(true);
      // isexe's posix check (which / zx)
      const groups = new Set([proc.getgid(), ...proc.getgroups()]);
      const executable =
        !!(st.mode & 0o001) ||
        (!!(st.mode & 0o010) && groups.has(st.gid)) ||
        (!!(st.mode & 0o100) && st.uid === proc.getuid());
      expect(executable).toBe(true);
    }
    expect(proc.geteuid()).toBe(proc.getuid());
    expect(proc.getegid()).toBe(proc.getgid());
  });

  it("run as the built-in shells by path", async () => {
    initShellExec(new MemoryVolume(), { cwd: "/" });
    expect(await run("/bin/bash -c 'echo from bash'")).toEqual({ stdout: "from bash\n", code: 0 });
    expect(await run("/bin/sh -c 'echo from sh'")).toEqual({ stdout: "from sh\n", code: 0 });
  });
});

describe("file: URLs without //", () => {
  // Chromium's URL reads the first segment as a host (file://home/a); these
  // assert the node/WHATWG reading the polyfill hands the native URL
  it("are read as paths, like node", () => {
    expect(toNodeFileUrl("file:/home/node_modules/zx/build/cli.cjs")).toBe(
      "file:///home/node_modules/zx/build/cli.cjs",
    );
    expect(toNodeFileUrl("FILE:home/a")).toBe("file:///home/a");
    expect(toNodeFileUrl("file:///home/a")).toBe("file:///home/a");
    expect(toNodeFileUrl("file://host/a")).toBe("file://host/a");
    expect(toNodeFileUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(toNodeFileUrl(undefined)).toBe(undefined);

    const url = new NodeURL("file:/home/a.cjs");
    expect(url.href).toBe("file:///home/a.cjs");
    expect(url).toBeInstanceOf(globalThis.URL);
    expect(fileURLToPath("file:/home/a.cjs")).toBe("/home/a.cjs");
  });
});
