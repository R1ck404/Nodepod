import { describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { NodepodShell } from "../shell/shell-interpreter";

function makeShell() {
  const volume = new MemoryVolume();
  volume.mkdirSync("/workspace", { recursive: true });
  const shell = new NodepodShell(volume, {
    cwd: "/workspace",
    env: { HOME: "/home/user", PATH: "/usr/bin", PWD: "/workspace" },
  });
  return { shell, volume };
}

describe("/dev devices", () => {
  it("stats /dev/null as a character device, as on Linux", async () => {
    const { shell, volume } = makeShell();
    await shell.exec("true");
    const st = volume.statSync("/dev/null");
    expect(st.isCharacterDevice()).toBe(true);
    expect(st.isFile()).toBe(false);
    expect(st.mode & 0o170000).toBe(0o020000);
    expect(volume.statSync("/dev/stdout").isCharacterDevice()).toBe(false);
  });

  it("answers test -c and [[ -c ]]", async () => {
    const { shell } = makeShell();
    expect((await shell.exec("[ -c /dev/null ] && echo yes")).stdout).toBe("yes\n");
    expect((await shell.exec("[[ -c /dev/null ]] && echo yes")).stdout).toBe("yes\n");
    expect((await shell.exec("echo x > f; [ -c f ] || echo no")).stdout).toBe("no\n");
    expect((await shell.exec("echo hi > /dev/null; echo $?")).stdout).toBe("0\n");
  });
});
