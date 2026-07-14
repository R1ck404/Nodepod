import { describe, it, expect, vi } from "vitest";
import { MemoryVolume } from "../memory-volume";

describe("MemoryVolume", () => {
  it("keeps hard links attached to one inode across writes and truncation", () => {
    const volume = new MemoryVolume();
    volume.writeFileSync("/original", "one");
    volume.linkSync("/original", "/linked");
    expect(volume.statSync("/original").nlink).toBe(2);
    expect(volume.statSync("/linked").ino).toBe(volume.statSync("/original").ino);

    volume.writeFileSync("/linked", "shared");
    expect(volume.readFileSync("/original", "utf8")).toBe("shared");
    volume.truncateSync("/original", 3);
    expect(volume.readFileSync("/linked", "utf8")).toBe("sha");

    volume.unlinkSync("/original");
    expect(volume.statSync("/linked").nlink).toBe(1);
    expect(volume.readFileSync("/linked", "utf8")).toBe("sha");
  });

  it("updates link counts when rename replaces files or trees", () => {
    const volume = new MemoryVolume();
    volume.writeFileSync("/source", "source");
    volume.writeFileSync("/target", "target");
    volume.linkSync("/target", "/target-link");
    volume.renameSync("/source", "/target");
    expect(volume.statSync("/target-link").nlink).toBe(1);
    expect(volume.readFileSync("/target", "utf8")).toBe("source");

    volume.linkSync("/target", "/same-inode");
    volume.renameSync("/target", "/same-inode");
    expect(volume.statSync("/target").nlink).toBe(2);
    expect(volume.statSync("/same-inode").nlink).toBe(2);

    volume.mkdirSync("/tree", { recursive: true });
    volume.linkSync("/target-link", "/tree/nested-link");
    volume.removeTreeSync("/tree");
    expect(volume.statSync("/target-link").nlink).toBe(1);
  });

  it("resolves relative symlinks and reports symlink loops", () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/root/dir", { recursive: true });
    volume.writeFileSync("/root/target.txt", "target");
    volume.symlinkSync("../target.txt", "/root/dir/link.txt");
    expect(volume.readlinkSync("/root/dir/link.txt")).toBe("../target.txt");
    expect(volume.readFileSync("/root/dir/link.txt", "utf8")).toBe("target");
    expect(volume.realpathSync("/root/dir/link.txt")).toBe("/root/target.txt");
    volume.writeFileSync("/root/dir/link.txt", "updated");
    expect(volume.readFileSync("/root/target.txt", "utf8")).toBe("updated");

    volume.symlinkSync("loop-b", "/root/loop-a");
    volume.symlinkSync("loop-a", "/root/loop-b");
    expect(() => volume.statSync("/root/loop-a")).toThrow(/ELOOP/);
  });

  it("preserves hard links, symlinks, modes, and timestamps in snapshots", () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/root", { recursive: true });
    volume.writeFileSync("/root/original", "content");
    volume.linkSync("/root/original", "/root/linked");
    volume.symlinkSync("original", "/root/symlink");
    volume.chmodSync("/root/original", 0o750);
    volume.utimesSync("/root/original", 10, 20);

    const restored = MemoryVolume.fromSnapshot(volume.toSnapshot());
    expect(restored.statSync("/root/original").ino).toBe(restored.statSync("/root/linked").ino);
    expect(restored.statSync("/root/original").mode).toBe(0o750);
    expect(restored.statSync("/root/original").mtimeMs).toBe(20_000);
    expect(restored.readlinkSync("/root/symlink")).toBe("original");
    restored.writeFileSync("/root/linked", "changed");
    expect(restored.readFileSync("/root/original", "utf8")).toBe("changed");
  });

  it("stores file modes and explicit timestamps", () => {
    const volume = new MemoryVolume();
    volume.writeFileSync("/metadata", "data");
    volume.chmodSync("/metadata", 0o750);
    volume.utimesSync("/metadata", 10, 20);
    const stat = volume.statSync("/metadata");
    expect(stat.mode).toBe(0o750);
    expect(stat.atimeMs).toBe(10_000);
    expect(stat.mtimeMs).toBe(20_000);
  });
  describe("writeFileSync / readFileSync", () => {
    it("writes and reads a string file", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/test.txt", "hello");
      expect(vol.readFileSync("/test.txt", "utf8")).toBe("hello");
    });

    it("writes and reads binary data (Uint8Array)", () => {
      const vol = new MemoryVolume();
      const data = new Uint8Array([1, 2, 3, 4]);
      vol.writeFileSync("/bin", data);
      const result = vol.readFileSync("/bin");
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toEqual(data);
    });

    it("overwrites existing file content", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/f.txt", "first");
      vol.writeFileSync("/f.txt", "second");
      expect(vol.readFileSync("/f.txt", "utf8")).toBe("second");
    });

    it("auto-creates parent directories", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/a/b/c.txt", "deep");
      expect(vol.readFileSync("/a/b/c.txt", "utf8")).toBe("deep");
    });

    it("returns Uint8Array when no encoding specified", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/f", "data");
      expect(vol.readFileSync("/f")).toBeInstanceOf(Uint8Array);
    });

    it("returns string with utf8 encoding", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/f", "text");
      expect(typeof vol.readFileSync("/f", "utf8")).toBe("string");
    });

    it("throws ENOENT on read of nonexistent file", () => {
      const vol = new MemoryVolume();
      expect(() => vol.readFileSync("/nope")).toThrow();
    });

    it("handles empty file content", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/empty", "");
      expect(vol.readFileSync("/empty", "utf8")).toBe("");
    });

    it("handles file at root level", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/root.txt", "root");
      expect(vol.readFileSync("/root.txt", "utf8")).toBe("root");
    });
  });

  describe("mkdirSync", () => {
    it("creates a directory", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/dir");
      expect(vol.statSync("/dir").isDirectory()).toBe(true);
    });

    it("creates nested directories with recursive:true", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/a/b/c/d", { recursive: true });
      expect(vol.statSync("/a/b/c/d").isDirectory()).toBe(true);
    });

    it("does not throw when directory exists with recursive:true", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/dir", { recursive: true });
      expect(() =>
        vol.mkdirSync("/dir", { recursive: true }),
      ).not.toThrow();
    });
  });

  describe("readdirSync", () => {
    it("lists files and directories", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/project", { recursive: true });
      vol.writeFileSync("/project/a.txt", "a");
      vol.writeFileSync("/project/b.txt", "b");
      vol.mkdirSync("/project/sub");
      const entries = vol.readdirSync("/project");
      expect(entries).toContain("a.txt");
      expect(entries).toContain("b.txt");
      expect(entries).toContain("sub");
    });

    it("returns empty array for empty directory", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/empty");
      expect(vol.readdirSync("/empty")).toEqual([]);
    });

    it("throws ENOENT for nonexistent directory", () => {
      const vol = new MemoryVolume();
      expect(() => vol.readdirSync("/nope")).toThrow();
    });
  });

  describe("existsSync", () => {
    it("returns true for existing file", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/f", "data");
      expect(vol.existsSync("/f")).toBe(true);
    });

    it("returns true for existing directory", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/dir");
      expect(vol.existsSync("/dir")).toBe(true);
    });

    it("returns false for nonexistent path", () => {
      const vol = new MemoryVolume();
      expect(vol.existsSync("/nope")).toBe(false);
    });

    it("returns true for root /", () => {
      const vol = new MemoryVolume();
      expect(vol.existsSync("/")).toBe(true);
    });
  });

  describe("statSync", () => {
    it("returns correct stat for a file", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/f.txt", "hello");
      const stat = vol.statSync("/f.txt");
      expect(stat.isFile()).toBe(true);
      expect(stat.isDirectory()).toBe(false);
      expect(stat.size).toBe(5);
    });

    it("returns correct stat for a directory", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/dir");
      const stat = vol.statSync("/dir");
      expect(stat.isDirectory()).toBe(true);
      expect(stat.isFile()).toBe(false);
    });

    it("has numeric mtimeMs and size fields", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/f", "data");
      const stat = vol.statSync("/f");
      expect(typeof stat.mtimeMs).toBe("number");
      expect(typeof stat.size).toBe("number");
    });

    it("throws ENOENT for nonexistent path", () => {
      const vol = new MemoryVolume();
      expect(() => vol.statSync("/nope")).toThrow();
    });
  });

  describe("unlinkSync", () => {
    it("removes a file", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/f", "data");
      vol.unlinkSync("/f");
      expect(vol.existsSync("/f")).toBe(false);
    });

    it("throws ENOENT for nonexistent file", () => {
      const vol = new MemoryVolume();
      expect(() => vol.unlinkSync("/nope")).toThrow();
    });
  });

  describe("rmdirSync", () => {
    it("removes an empty directory", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/dir");
      vol.rmdirSync("/dir");
      expect(vol.existsSync("/dir")).toBe(false);
    });

    it("throws ENOTEMPTY for non-empty directory", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/dir");
      vol.writeFileSync("/dir/f.txt", "data");
      expect(() => vol.rmdirSync("/dir")).toThrow();
    });

    it("throws ENOENT for nonexistent directory", () => {
      const vol = new MemoryVolume();
      expect(() => vol.rmdirSync("/nope")).toThrow();
    });

    it("removes a populated tree atomically and reports every path", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/cache/temp/nested", { recursive: true });
      vol.writeFileSync("/cache/temp/a.js", "a");
      vol.writeFileSync("/cache/temp/nested/b.js", "b");
      const removed: string[] = [];
      vol.onGlobalChange((path, event) => {
        if (event === "unlink") removed.push(path);
      });

      vol.removeTreeSync("/cache/temp");

      expect(vol.existsSync("/cache/temp")).toBe(false);
      expect(removed).toEqual([
        "/cache/temp/nested/b.js",
        "/cache/temp/nested",
        "/cache/temp/a.js",
        "/cache/temp",
      ]);
    });
  });

  describe("renameSync", () => {
    it("moves a file from one path to another", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/old.txt", "data");
      vol.renameSync("/old.txt", "/new.txt");
      expect(vol.readFileSync("/new.txt", "utf8")).toBe("data");
      expect(vol.existsSync("/old.txt")).toBe(false);
    });

    it("throws ENOENT when source does not exist", () => {
      const vol = new MemoryVolume();
      expect(() => vol.renameSync("/nope", "/dest")).toThrow();
    });
  });

  describe("copyFileSync", () => {
    it("copies file content to new path", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/src.txt", "content");
      vol.copyFileSync("/src.txt", "/dst.txt");
      expect(vol.readFileSync("/dst.txt", "utf8")).toBe("content");
      expect(vol.readFileSync("/src.txt", "utf8")).toBe("content");
    });

    it("throws ENOENT when source does not exist", () => {
      const vol = new MemoryVolume();
      expect(() => vol.copyFileSync("/nope", "/dst")).toThrow();
    });
  });

  describe("appendFileSync", () => {
    it("appends to existing file", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/f", "hello");
      vol.appendFileSync("/f", " world");
      expect(vol.readFileSync("/f", "utf8")).toBe("hello world");
    });

    it("creates file if it does not exist", () => {
      const vol = new MemoryVolume();
      vol.appendFileSync("/new.txt", "fresh");
      expect(vol.readFileSync("/new.txt", "utf8")).toBe("fresh");
    });
  });

  describe("truncateSync", () => {
    it("truncates file to specified length", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/f", "hello world");
      vol.truncateSync("/f", 5);
      expect(vol.readFileSync("/f", "utf8")).toBe("hello");
    });

    it("throws ENOENT for nonexistent file", () => {
      const vol = new MemoryVolume();
      expect(() => vol.truncateSync("/nope", 5)).toThrow();
    });
  });

  describe("symlinks", () => {
    it("symlinkSync creates a symlink, readlinkSync reads target", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/target", "data");
      vol.symlinkSync("/target", "/link");
      expect(vol.readlinkSync("/link")).toBe("/target");
    });

    it("reading a symlinked file follows the symlink", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/target", "data");
      vol.symlinkSync("/target", "/link");
      expect(vol.readFileSync("/link", "utf8")).toBe("data");
    });

    it("realpathSync resolves symlink to real path", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/real", "data");
      vol.symlinkSync("/real", "/sym");
      expect(vol.realpathSync("/sym")).toBe("/real");
    });

    it("lstatSync reports symlink for symlink node", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/target", "data");
      vol.symlinkSync("/target", "/link");
      expect(vol.lstatSync("/link").isSymbolicLink()).toBe(true);
    });
  });

  describe("path normalization", () => {
    it("normalizes paths with ..", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/a", { recursive: true });
      vol.writeFileSync("/a/b/../c.txt", "data");
      expect(vol.readFileSync("/a/c.txt", "utf8")).toBe("data");
    });

    it("normalizes paths with .", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/./test.txt", "data");
      expect(vol.readFileSync("/test.txt", "utf8")).toBe("data");
    });

    it("handles paths without leading /", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("foo.txt", "data");
      expect(vol.readFileSync("/foo.txt", "utf8")).toBe("data");
    });
  });

  describe("toSnapshot / fromSnapshot", () => {
    it("round-trips empty volume", () => {
      const vol = new MemoryVolume();
      const snap = vol.toSnapshot();
      const vol2 = MemoryVolume.fromSnapshot(snap);
      expect(vol2.readdirSync("/")).toEqual([]);
    });

    it("round-trips volume with files and directories", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/project/src", { recursive: true });
      vol.writeFileSync("/project/src/index.ts", "export default 1;");
      vol.writeFileSync("/project/readme.md", "# Hello");

      const snap = vol.toSnapshot();
      const vol2 = MemoryVolume.fromSnapshot(snap);

      expect(vol2.readFileSync("/project/src/index.ts", "utf8")).toBe(
        "export default 1;",
      );
      expect(vol2.readFileSync("/project/readme.md", "utf8")).toBe("# Hello");
    });

    it("round-trips binary file content", () => {
      const vol = new MemoryVolume();
      const data = new Uint8Array([0, 128, 255]);
      vol.writeFileSync("/bin", data);
      const snap = vol.toSnapshot();
      const vol2 = MemoryVolume.fromSnapshot(snap);
      expect(vol2.readFileSync("/bin")).toEqual(data);
    });
  });

  describe("watchers", () => {
    it("watch() fires callback on file write", () => {
      const vol = new MemoryVolume();
      const events: string[] = [];
      vol.watch("/", {}, (event, filename) => {
        events.push(`${event}:${filename}`);
      });
      vol.writeFileSync("/test.txt", "data");
      expect(events.length).toBeGreaterThan(0);
    });

    it("watch.close() stops receiving events", () => {
      const vol = new MemoryVolume();
      const events: string[] = [];
      const handle = vol.watch("/", {}, (event, filename) => {
        events.push(`${event}:${filename}`);
      });
      handle.close();
      vol.writeFileSync("/test.txt", "data");
      expect(events.length).toBe(0);
    });
  });

  describe("createReadStream", () => {
    it("emits data and end events", async () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/f.txt", "stream content");
      const rs = vol.createReadStream("/f.txt");

      const chunks: Uint8Array[] = [];
      await new Promise<void>((resolve) => {
        rs.on("data", (chunk: any) => chunks.push(chunk));
        rs.on("end", () => resolve());
      });

      const text = new TextDecoder().decode(chunks[0]);
      expect(text).toBe("stream content");
    });
  });

  describe("createWriteStream", () => {
    it("write + end flushes data to volume", async () => {
      const vol = new MemoryVolume();
      const ws = vol.createWriteStream("/out.txt");
      ws.write("hello ");
      ws.end("world");

      // wait for async flush
      await new Promise((r) => setTimeout(r, 50));
      expect(vol.readFileSync("/out.txt", "utf8")).toBe("hello world");
    });
  });

  describe("event subscription", () => {
    it("on('change') fires when file is written", () => {
      const vol = new MemoryVolume();
      const changes: string[] = [];
      vol.on("change", (path: string) => changes.push(path));
      vol.writeFileSync("/f.txt", "data");
      expect(changes).toContain("/f.txt");
    });

    it("off() unsubscribes handler", () => {
      const vol = new MemoryVolume();
      const changes: string[] = [];
      const handler = (path: string) => changes.push(path);
      vol.on("change", handler);
      vol.off("change", handler);
      vol.writeFileSync("/f.txt", "data");
      expect(changes).toEqual([]);
    });
  });

  describe("async methods", () => {
    it("readFile with callback returns data", async () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/f.txt", "async data");
      const data = await new Promise<any>((resolve, reject) => {
        vol.readFile("/f.txt", { encoding: "utf8" }, (err: any, d: any) => {
          if (err) reject(err);
          else resolve(d);
        });
      });
      expect(data).toBe("async data");
    });

    it("stat with callback returns stats", async () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/f.txt", "data");
      const stats = await new Promise<any>((resolve, reject) => {
        vol.stat("/f.txt", (err: any, s: any) => {
          if (err) reject(err);
          else resolve(s);
        });
      });
      expect(stats.isFile()).toBe(true);
    });
  });

  // regression tests for issue #23. mkdir and a few other mutators were
  // changing the tree without telling onGlobalChange subscribers, so anything
  // tracking fs changes (HMR, vfs-bridge, user code) silently missed them
  describe("onGlobalChange dispatch", () => {
    it("fires 'addDir' when mkdirSync creates a directory", () => {
      const vol = new MemoryVolume();
      const events: Array<{ path: string; event: string }> = [];
      vol.onGlobalChange((path, event) => events.push({ path, event }));

      vol.mkdirSync("/dir");

      expect(events).toEqual([{ path: "/dir", event: "addDir" }]);
    });

    it("fires 'addDir' for every newly created segment with recursive:true", () => {
      const vol = new MemoryVolume();
      const events: Array<{ path: string; event: string }> = [];
      vol.onGlobalChange((path, event) => events.push({ path, event }));

      vol.mkdirSync("/a/b/c", { recursive: true });

      expect(events).toEqual([
        { path: "/a", event: "addDir" },
        { path: "/a/b", event: "addDir" },
        { path: "/a/b/c", event: "addDir" },
      ]);
    });

    it("stays silent when mkdirSync(recursive:true) hits an existing tree", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/a/b/c", { recursive: true });

      const events: Array<{ path: string; event: string }> = [];
      vol.onGlobalChange((path, event) => events.push({ path, event }));

      vol.mkdirSync("/a/b/c", { recursive: true });
      expect(events).toEqual([]);
    });

    it("fires only for missing segments when mkdirSync(recursive:true) partially exists", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/a", { recursive: true });

      const events: Array<{ path: string; event: string }> = [];
      vol.onGlobalChange((path, event) => events.push({ path, event }));

      vol.mkdirSync("/a/b/c", { recursive: true });
      expect(events).toEqual([
        { path: "/a/b", event: "addDir" },
        { path: "/a/b/c", event: "addDir" },
      ]);
    });

    it("fires 'add' / 'change' for writeFileSync", () => {
      const vol = new MemoryVolume();
      const events: Array<{ path: string; event: string }> = [];
      vol.onGlobalChange((path, event) => events.push({ path, event }));

      vol.writeFileSync("/f.txt", "hello");
      vol.writeFileSync("/f.txt", "world");

      expect(events).toEqual([
        { path: "/f.txt", event: "add" },
        { path: "/f.txt", event: "change" },
      ]);
    });

    it("fires 'unlink' for unlinkSync", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/f.txt", "data");

      const events: Array<{ path: string; event: string }> = [];
      vol.onGlobalChange((path, event) => events.push({ path, event }));

      vol.unlinkSync("/f.txt");
      expect(events).toEqual([{ path: "/f.txt", event: "unlink" }]);
    });

    it("fires 'unlink' for rmdirSync", () => {
      const vol = new MemoryVolume();
      vol.mkdirSync("/dir");

      const events: Array<{ path: string; event: string }> = [];
      vol.onGlobalChange((path, event) => events.push({ path, event }));

      vol.rmdirSync("/dir");
      expect(events).toEqual([{ path: "/dir", event: "unlink" }]);
    });

    it("fires 'change' for truncateSync", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/f.txt", "hello world");

      const events: Array<{ path: string; event: string }> = [];
      vol.onGlobalChange((path, event) => events.push({ path, event }));

      vol.truncateSync("/f.txt", 5);
      expect(events).toEqual([{ path: "/f.txt", event: "change" }]);
    });

    it("fires 'add' for symlinkSync", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/target.txt", "target");

      const events: Array<{ path: string; event: string }> = [];
      vol.onGlobalChange((path, event) => events.push({ path, event }));

      vol.symlinkSync("/target.txt", "/link.txt");
      expect(events).toEqual([{ path: "/link.txt", event: "add" }]);
    });

    it("fires 'add' for linkSync", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/original.txt", "data");

      const events: Array<{ path: string; event: string }> = [];
      vol.onGlobalChange((path, event) => events.push({ path, event }));

      vol.linkSync("/original.txt", "/hardlink.txt");
      expect(events).toEqual([{ path: "/hardlink.txt", event: "add" }]);
    });

    it("fires 'unlink' + 'add' for renameSync", () => {
      const vol = new MemoryVolume();
      vol.writeFileSync("/old.txt", "data");

      const events: Array<{ path: string; event: string }> = [];
      vol.onGlobalChange((path, event) => events.push({ path, event }));

      vol.renameSync("/old.txt", "/new.txt");
      expect(events).toContainEqual({ path: "/old.txt", event: "unlink" });
      expect(events).toContainEqual({ path: "/new.txt", event: "add" });
    });

    it("onGlobalChange returns an unsubscribe fn", () => {
      const vol = new MemoryVolume();
      const events: Array<{ path: string; event: string }> = [];
      const unsubscribe = vol.onGlobalChange((path, event) =>
        events.push({ path, event }),
      );

      vol.mkdirSync("/a");
      unsubscribe();
      vol.mkdirSync("/b");

      expect(events).toEqual([{ path: "/a", event: "addDir" }]);
    });

    it("also fires a parallel fs.watch event for mkdir", () => {
      const vol = new MemoryVolume();
      const watchEvents: Array<{ event: string; filename: string | null }> = [];
      vol.watch("/", { recursive: true }, (event, filename) => {
        watchEvents.push({ event, filename });
      });

      vol.mkdirSync("/dir");

      // triggerWatchers uses Node's fs.watch vocabulary ('rename' / 'change')
      expect(watchEvents).toEqual([{ event: "rename", filename: "dir" }]);
    });
  });
});
