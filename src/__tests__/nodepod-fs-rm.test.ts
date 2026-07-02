import { describe, it, expect } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { NodepodFS } from "../sdk/nodepod-fs";

describe("NodepodFS.rm", () => {
  it("removes a file", async () => {
    const vol = new MemoryVolume();
    const fs = new NodepodFS(vol);
    await fs.writeFile("/a.txt", "hi");
    await fs.rm("/a.txt");
    expect(await fs.exists("/a.txt")).toBe(false);
  });

  it("removes a directory recursively", async () => {
    const vol = new MemoryVolume();
    const fs = new NodepodFS(vol);
    await fs.mkdir("/dir", { recursive: true });
    await fs.writeFile("/dir/nested.txt", "x");
    await fs.rm("/dir", { recursive: true });
    expect(await fs.exists("/dir")).toBe(false);
  });

  it("throws ENOENT unless force", async () => {
    const vol = new MemoryVolume();
    const fs = new NodepodFS(vol);
    await expect(fs.rm("/missing")).rejects.toThrow(/ENOENT/);
    await expect(fs.rm("/missing", { force: true })).resolves.toBeUndefined();
  });
});
