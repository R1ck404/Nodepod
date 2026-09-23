import { describe, it, expect } from "vitest";
import { MemoryVolume, type VolumeMutation } from "../memory-volume";

function record(vol: MemoryVolume): VolumeMutation[] {
  const events: VolumeMutation[] = [];
  vol.onMutation((m) => events.push(m));
  return events;
}

describe("MemoryVolume mutation journal", () => {
  it("reports writes, including implicitly created parents", () => {
    const vol = new MemoryVolume();
    const events = record(vol);

    vol.writeFileSync("/a/b/f.txt", "hi");
    vol.writeFileSync("/a/b/f.txt", "again");

    expect(events).toEqual([
      { op: "mkdir", path: "/a" },
      { op: "mkdir", path: "/a/b" },
      { op: "write", path: "/a/b/f.txt" },
      { op: "write", path: "/a/b/f.txt" },
    ]);
  });

  it("reports writeCacheSync even though watchers stay quiet", () => {
    const vol = new MemoryVolume();
    const events = record(vol);
    const global: string[] = [];
    vol.onGlobalChange((path) => global.push(path));

    vol.writeCacheSync("/cache.bin", new Uint8Array([1]));

    expect(events).toEqual([{ op: "write", path: "/cache.bin" }]);
    expect(global).toEqual([]);
  });

  it("reports mkdir, recursive and not", () => {
    const vol = new MemoryVolume();
    const events = record(vol);

    vol.mkdirSync("/x");
    vol.mkdirSync("/y/z", { recursive: true });
    vol.mkdirSync("/y/z", { recursive: true });

    expect(events).toEqual([
      { op: "mkdir", path: "/x" },
      { op: "mkdir", path: "/y" },
      { op: "mkdir", path: "/y/z" },
    ]);
  });

  it("reports removals once per call, subtree included", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/d/one.txt", "1");
    vol.writeFileSync("/d/sub/two.txt", "2");
    vol.writeFileSync("/f.txt", "f");
    vol.mkdirSync("/empty");
    const events = record(vol);

    vol.unlinkSync("/f.txt");
    vol.rmdirSync("/empty");
    vol.removeTreeSync("/d");

    expect(events).toEqual([
      { op: "remove", path: "/f.txt" },
      { op: "remove", path: "/empty" },
      { op: "remove", path: "/d" },
    ]);
  });

  it("reports renames as one mutation for the whole subtree", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/src/a.txt", "a");
    vol.writeFileSync("/src/deep/b.txt", "b");
    const events = record(vol);

    vol.renameSync("/src", "/dst");

    expect(events).toEqual([{ op: "rename", from: "/src", to: "/dst" }]);
  });

  it("reports a write to a symlink against the real file", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/real.txt", "a");
    vol.symlinkSync("/real.txt", "/link.txt");
    const events = record(vol);

    vol.writeFileSync("/link.txt", "b");

    expect(events).toEqual([{ op: "write", path: "/real.txt" }]);
  });

  it("reports symlinks and hardlinks", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/f.txt", "x");
    const events = record(vol);

    vol.symlinkSync("/f.txt", "/s");
    vol.linkSync("/f.txt", "/h");

    expect(events).toEqual([
      { op: "symlink", path: "/s" },
      { op: "link", path: "/h", existing: "/f.txt" },
    ]);
  });

  it("reports metadata changes", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/f.txt", "x");
    vol.symlinkSync("/f.txt", "/s");
    const events = record(vol);

    vol.chmodSync("/f.txt", 0o600);
    vol.lchmodSync("/s", 0o700);
    vol.chownSync("/f.txt", 1, 2);
    vol.lchownSync("/s", 1, 2);
    vol.utimesSync("/f.txt", 1, 2);
    vol.lutimesSync("/s", 1, 2);

    expect(events.map((e) => e.op)).toEqual(["meta", "meta", "meta", "meta", "meta", "meta"]);
  });

  it("reports truncate, append, copy and file-handle writes as writes", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/f.txt", "hello");
    vol.linkSync("/f.txt", "/g.txt");
    const events = record(vol);

    vol.truncateSync("/f.txt", 2);
    vol.appendFileSync("/f.txt", "!");
    vol.copyFileSync("/f.txt", "/copy.txt");
    vol.openFileHandleSync("/f.txt").write(new Uint8Array([1]));

    expect(events).toEqual([
      // truncate and handle writes change the inode: every hardlink is reported
      { op: "write", path: "/f.txt" },
      { op: "write", path: "/g.txt" },
      { op: "write", path: "/f.txt" },
      { op: "write", path: "/copy.txt" },
      // handle writes touch every hardlink alias
      { op: "write", path: "/f.txt" },
      { op: "write", path: "/g.txt" },
    ]);
  });

  it("reports a silent bulk mount as one mount mutation", () => {
    const vol = new MemoryVolume();
    const events = record(vol);
    const data = new TextEncoder().encode("abc");

    vol.mountBinarySnapshot({
      manifest: [
        { path: "/pkg", offset: 0, length: 0, isDirectory: true },
        { path: "/pkg/a.js", offset: 0, length: 3, isDirectory: false },
      ],
      data: data.buffer,
    }, false);

    expect(events).toHaveLength(1);
    const mount = events[0];
    if (mount.op !== "mount") throw new Error(`expected mount, got ${mount.op}`);
    expect(mount.entries.map((e) => e.path)).toEqual(["/pkg", "/pkg/a.js"]);
  });

  it("reports each entry when mounting with notify", () => {
    const vol = new MemoryVolume();
    const events = record(vol);

    vol.mountEntries(
      [
        { path: "/p/a.txt", kind: "file", content: new Uint8Array([1]) },
        { path: "/p/l", kind: "symlink", target: "a.txt" },
      ],
      { notify: true },
    );

    expect(events).toEqual([
      { op: "mkdir", path: "/p" },
      { op: "write", path: "/p/a.txt" },
      { op: "symlink", path: "/p/l" },
    ]);
  });

  it("never reports lazy hydration", () => {
    const vol = new MemoryVolume();
    vol.setMissHandler(
      {
        readFile: () => new TextEncoder().encode("remote"),
        readdir: () => [{ name: "x.js", isDirectory: false, size: 6 }],
        stat: (p) =>
          p.endsWith(".js")
            ? { isFile: true, isDirectory: false, size: 6 }
            : { isFile: false, isDirectory: true, size: 0 },
      },
      ["node_modules"],
    );
    vol.mkdirSync("/node_modules");
    const events = record(vol);

    expect(vol.readFileSync("/node_modules/dep/x.js", "utf8")).toBe("remote");
    expect(vol.readdirSync("/node_modules/dep")).toContain("x.js");

    expect(events).toEqual([]);
  });

  it("stops reporting after unsubscribe and dispose", () => {
    const vol = new MemoryVolume();
    const events: VolumeMutation[] = [];
    const off = vol.onMutation((m) => events.push(m));
    vol.writeFileSync("/a", "1");
    off();
    vol.writeFileSync("/b", "2");
    vol.onMutation((m) => events.push(m));
    vol.dispose();

    expect(events).toEqual([{ op: "write", path: "/a" }]);
  });
});

describe("MemoryVolume.inspectNode", () => {
  it("describes files without following symlinks or copying", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/f.txt", "hello");
    vol.chmodSync("/f.txt", 0o600);
    vol.symlinkSync("/f.txt", "/s");

    const file = vol.inspectNode("/f.txt")!;
    expect(file.kind).toBe("file");
    expect(file.mode).toBe(0o600);
    expect(file.size).toBe(5);
    expect(file.resident).toBe(true);
    expect(file.content).toBe(vol.readFileSync("/f.txt"));

    const link = vol.inspectNode("/s")!;
    expect(link.kind).toBe("symlink");
    expect(link.target).toBe("/f.txt");

    expect(vol.inspectNode("/missing")).toBeNull();
  });

  it("gives hardlinks one identity that survives a rename", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/a", "x");
    vol.linkSync("/a", "/b");
    const token = vol.inspectNode("/a")!.inode;

    vol.renameSync("/a", "/c");

    expect(vol.inspectNode("/b")!.inode).toBe(token);
    expect(vol.inspectNode("/c")!.inode).toBe(token);
  });
});

describe("MemoryVolume.mountEntries", () => {
  it("restores metadata and hardlink groups", () => {
    const vol = new MemoryVolume();
    vol.mountEntries([
      { path: "/d", kind: "directory", mode: 0o700, mtimeMs: 1000 },
      { path: "/d/a", kind: "file", content: new Uint8Array([1, 2]), mode: 0o640, mtimeMs: 2000, linkGroup: "g" },
      { path: "/d/b", kind: "file", linkGroup: "g" },
      { path: "/d/l", kind: "symlink", target: "a", mtimeMs: 3000 },
    ]);

    expect(vol.statSync("/d").mode).toBe(0o700);
    expect(vol.statSync("/d").mtimeMs).toBe(1000);
    expect(vol.statSync("/d/a").mode).toBe(0o640);
    expect(vol.statSync("/d/a").mtimeMs).toBe(2000);
    expect(vol.inspectNode("/d/b")!.inode).toBe(vol.inspectNode("/d/a")!.inode);
    expect(Array.from(vol.readFileSync("/d/b"))).toEqual([1, 2]);
    expect(vol.readlinkSync("/d/l")).toBe("a");
    expect(vol.lstatSync("/d/l").mtimeMs).toBe(3000);
  });

  it("replaces a node of another kind", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/x/inner.txt", "1");
    vol.writeFileSync("/y", "file");

    vol.mountEntries([
      { path: "/x", kind: "file", content: new Uint8Array([7]) },
      { path: "/y", kind: "directory" },
    ]);

    expect(vol.statSync("/x").isFile()).toBe(true);
    expect(vol.statSync("/y").isDirectory()).toBe(true);
  });
});

describe("MemoryVolume.toSnapshot", () => {
  it("skips lazy stubs instead of writing them out as empty files", () => {
    const vol = new MemoryVolume();
    vol.setMissHandler(
      {
        readFile: () => null,
        readdir: () => [{ name: "stub.js", isDirectory: false, size: 10 }],
        stat: () => ({ isFile: false, isDirectory: true, size: 0 }),
      },
      ["node_modules"],
    );
    vol.mkdirSync("/node_modules");
    vol.readdirSync("/node_modules");

    const paths = vol.toSnapshot().entries.map((e) => e.path);
    expect(paths).toContain("/node_modules");
    expect(paths).not.toContain("/node_modules/stub.js");
  });
});

describe("MemoryVolume rename global events", () => {
  it("announces moved directories as addDir", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/a/sub/f.txt", "x");
    const events: Array<[string, string]> = [];
    vol.onGlobalChange((path, event) => events.push([path, event]));

    vol.renameSync("/a", "/b");

    expect(events).toContainEqual(["/b", "addDir"]);
    expect(events).toContainEqual(["/b/sub", "addDir"]);
    expect(events).toContainEqual(["/b/sub/f.txt", "add"]);
  });
});

describe("MemoryVolume.onMetaChange", () => {
  it("reports only the changed fields, against the real node", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/real.sh", "x");
    vol.symlinkSync("/real.sh", "/run");
    const seen: unknown[] = [];
    vol.onMetaChange((path, change) => seen.push({ path, ...change }));

    vol.chmodSync("/run", 0o755);
    vol.lchownSync("/run", 1, 2);
    vol.writeFileSync("/other", "not metadata");

    expect(seen).toEqual([
      { path: "/real.sh", mode: 0o755 },
      { path: "/run", uid: 1, gid: 2 },
    ]);
  });
});
