import { describe, expect, it } from "vitest";
import { MemoryVolume, type MountEntry, type VolumeContentSource } from "../memory-volume";
import { PackContentSource, adoptMountedPack } from "../persistence/pack-content-source";

const tick = () => new Promise((r) => setTimeout(r, 0));

// a pack: files laid out back to back in one buffer
function makePack(files: Record<string, string>) {
  const enc = new TextEncoder();
  const parts = Object.entries(files).map(([path, text]) => ({ path, bytes: enc.encode(text) }));
  const total = parts.reduce((n, p) => n + p.bytes.byteLength, 0);
  const data = new Uint8Array(total);
  const manifest: Array<{ path: string; offset: number; length: number; isDirectory: boolean }> = [];
  let offset = 0;
  for (const { path, bytes } of parts) {
    data.set(bytes, offset);
    manifest.push({ path, offset, length: bytes.byteLength, isDirectory: false });
    offset += bytes.byteLength;
  }
  return { data, manifest };
}

function source(data: Uint8Array) {
  const reads: Array<{ offset: number; length: number }> = [];
  const src: VolumeContentSource = {
    async read(_pack, offset, length) {
      reads.push({ offset, length });
      return data.slice(offset, offset + length);
    },
  };
  return { src, reads };
}

function stubs(manifest: ReturnType<typeof makePack>["manifest"], pack = 0): MountEntry[] {
  return manifest.map((e) => ({
    path: e.path,
    kind: "file" as const,
    src: { pack, offset: e.offset, length: e.length },
  }));
}

describe("MemoryVolume eviction", () => {
  it("mounts paged-out stubs that refuse synchronous reads until paged in", async () => {
    const { data, manifest } = makePack({ "/nm/a.js": "alpha", "/nm/b.js": "bravo" });
    const { src } = source(data);
    const vol = new MemoryVolume();
    vol.enableEviction(src, 1024);
    vol.mountEntries(stubs(manifest));

    expect(vol.statSync("/nm/a.js").size).toBe(5);
    expect(vol.isPagedOut("/nm/a.js")).toBe(true);
    expect(() => vol.readFileSync("/nm/a.js")).toThrow(/EAGAIN/);
    expect(vol.getStats().pagedOutSyncMisses).toBe(1);

    await vol.ensureResident("/nm/a.js");
    expect(vol.readFileSync("/nm/a.js", "utf8")).toBe("alpha");
    expect(vol.isPagedOut("/nm/a.js")).toBe(false);
  });

  it("reads neighbours ahead in one range read", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`/nm/pkg/f${i}.js`] = `module.exports = ${i};`;
    const { data, manifest } = makePack(files);
    const { src, reads } = source(data);
    const vol = new MemoryVolume();
    vol.enableEviction(src, 1024 * 1024);
    vol.mountEntries(stubs(manifest));

    await vol.ensureResident("/nm/pkg/f0.js");

    expect(reads).toHaveLength(1);
    expect(vol.isPagedOut("/nm/pkg/f19.js")).toBe(false);
    expect(vol.readFileSync("/nm/pkg/f19.js", "utf8")).toBe("module.exports = 19;");
  });

  it("evicts least recently used content over budget, each file into its own buffer", async () => {
    const big = "x".repeat(400);
    const { data, manifest } = makePack({ "/nm/a": big, "/nm/b": big, "/nm/c": big });
    const { src } = source(data);
    const vol = new MemoryVolume();
    vol.enableEviction(src, 900);
    // one pack per file, so read-ahead never brings a neighbour in
    vol.mountEntries(manifest.map((e, i) => ({
      path: e.path,
      kind: "file" as const,
      src: { pack: i, offset: e.offset, length: e.length },
    })));

    await vol.ensureResident("/nm/a");
    await vol.ensureResident("/nm/b");
    vol.readFileSync("/nm/a"); // a is now more recent than b
    await vol.ensureResident("/nm/c");
    await tick(); // eviction runs after the readers had their turn

    const stats = vol.getStats();
    expect(stats.residentPackBytes).toBeLessThanOrEqual(900);
    expect(vol.isPagedOut("/nm/b")).toBe(true);
    expect(vol.isPagedOut("/nm/a")).toBe(false);
    expect(vol.isPagedOut("/nm/c")).toBe(false);
    const a = vol.readFileSync("/nm/a");
    expect(a.byteLength).toBe(400);
    expect(a.buffer.byteLength).toBe(400);
  });

  it("never evicts written content", async () => {
    const { data, manifest } = makePack({ "/nm/a": "a".repeat(100), "/nm/b": "b".repeat(100) });
    const { src } = source(data);
    const vol = new MemoryVolume();
    vol.enableEviction(src, 50);
    vol.mountEntries(stubs(manifest));

    vol.writeFileSync("/nm/a", "patched");
    await vol.ensureResident("/nm/b");

    expect(vol.readFileSync("/nm/a", "utf8")).toBe("patched");
    expect(vol.isPagedOut("/nm/a")).toBe(false);
  });

  it("keeps paged-out content reachable through renames and hardlinks", async () => {
    const { data, manifest } = makePack({ "/nm/a.js": "hello" });
    const { src } = source(data);
    const vol = new MemoryVolume();
    vol.enableEviction(src, 1024);
    vol.mountEntries(stubs(manifest));

    vol.renameSync("/nm/a.js", "/nm/moved.js");
    vol.linkSync("/nm/moved.js", "/nm/alias.js");
    expect(vol.isPagedOut("/nm/alias.js")).toBe(true);
    expect(vol.statSync("/nm/alias.js").size).toBe(5);

    await vol.ensureResident("/nm/alias.js");
    expect(vol.readFileSync("/nm/moved.js", "utf8")).toBe("hello");
    expect(vol.readFileSync("/nm/alias.js", "utf8")).toBe("hello");
  });

  it("does not touch volumes without eviction", async () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/f", "x");
    expect(vol.isPagedOut("/f")).toBe(false);
    await vol.ensureResident("/f");
    expect(vol.readFileSync("/f", "utf8")).toBe("x");
  });

  it("holds off eviction while paused", async () => {
    const { data, manifest } = makePack({ "/nm/a": "a".repeat(100), "/nm/b": "b".repeat(100) });
    const { src } = source(data);
    const vol = new MemoryVolume();
    vol.enableEviction(src, 100);
    vol.mountEntries(stubs(manifest));

    const resume = vol.pauseEviction();
    await vol.ensureResident("/nm/a");
    await vol.ensureResident("/nm/b");
    expect(vol.getStats().residentPackBytes).toBe(200);
    resume();
    await tick();
    expect(vol.getStats().residentPackBytes).toBeLessThanOrEqual(100);
  });

  it("adopts a fully mounted pack so its buffer can be collected", () => {
    const { data, manifest } = makePack({
      "/p/node_modules/dep/package.json": '{"name":"dep"}',
      "/p/node_modules/dep/index.js": "module.exports = 1",
    });
    const vol = new MemoryVolume();
    const pack = new PackContentSource({
      getManifest: async () => ({ manifest, version: "v1" }),
      readRange: async (_key, _version, offset, length) => data.slice(offset, offset + length),
    });
    vol.enableEviction(pack, 1024);
    const buffer = data.buffer.slice(0);
    vol.mountBinarySnapshot({ manifest, data: buffer }, false);

    adoptMountedPack(vol, pack, "key", { manifest, version: "v1" }, manifest, buffer);

    expect(vol.isPagedOut("/p/node_modules/dep/index.js")).toBe(true);
    const pkg = vol.readFileSync("/p/node_modules/dep/package.json");
    expect(pkg.buffer).not.toBe(buffer);
  });
});

describe("PackContentSource.mountPaged", () => {
  it("keeps package.json resident and pages everything else", async () => {
    const { data, manifest } = makePack({
      "/p/node_modules/dep/package.json": '{"name":"dep"}',
      "/p/node_modules/dep/index.js": "module.exports = 1",
    });
    const fullManifest = [
      { path: "/p/node_modules", offset: 0, length: 0, isDirectory: true },
      { path: "/p/node_modules/dep", offset: 0, length: 0, isDirectory: true },
      ...manifest,
    ];
    const pack = new PackContentSource({
      getManifest: async () => ({ manifest: fullManifest, version: "v1" }),
      readRange: async (_key, _version, offset, length) => data.slice(offset, offset + length),
    });
    const vol = new MemoryVolume();
    vol.enableEviction(pack, 1024);

    await pack.mountPaged(vol, "key", { manifest: fullManifest, version: "v1" });

    expect(JSON.parse(vol.readFileSync("/p/node_modules/dep/package.json", "utf8"))).toEqual({ name: "dep" });
    expect(vol.isPagedOut("/p/node_modules/dep/index.js")).toBe(true);
    await vol.ensureResident("/p/node_modules/dep/index.js");
    expect(vol.readFileSync("/p/node_modules/dep/index.js", "utf8")).toBe("module.exports = 1");
  });

  it("fails page-in loudly when the pack is gone", async () => {
    const pack = new PackContentSource({
      getManifest: async () => null,
      readRange: async () => null,
    });
    const vol = new MemoryVolume();
    vol.enableEviction(pack, 1024);
    vol.mountEntries([{ path: "/nm/x", kind: "file", src: { pack: pack.register("gone", "v1"), offset: 0, length: 4 } }]);

    await expect(vol.ensureResident("/nm/x")).rejects.toThrow(/missing, rewritten or truncated/);
    expect(vol.isPagedOut("/nm/x")).toBe(true);
  });
});

describe("lazy worker volumes", () => {
  it("don't remember a timed-out lookup as a missing file", () => {
    let slow = true;
    const timeout = () => Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    const vol = new MemoryVolume();
    // a lean snapshot ships the lazy dir itself, empty
    vol.mkdirSync("/node_modules");
    vol.setMissHandler(
      {
        readFile: () => {
          if (slow) throw timeout();
          return new TextEncoder().encode("late but fine");
        },
        readdir: (p) => {
          if (slow) throw timeout();
          return p === "/node_modules"
            ? [{ name: "dep", isDirectory: true }]
            : [{ name: "index.js", isDirectory: false, size: 13 }];
        },
        stat: (p) => {
          if (slow) throw timeout();
          return p.endsWith(".js")
            ? { isFile: true, isDirectory: false, size: 13 }
            : { isFile: false, isDirectory: true, size: 0 };
        },
      },
      ["node_modules"],
    );

    expect(vol.existsSync("/node_modules/dep/index.js")).toBe(false);
    slow = false;
    expect(vol.readFileSync("/node_modules/dep/index.js", "utf8")).toBe("late but fine");
  });
});

describe("paging races", () => {
  it("a write while a page-in is in flight wins", async () => {
    const { data, manifest } = makePack({ "/nm/a.js": "original" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const vol = new MemoryVolume();
    vol.enableEviction({
      async read(_pack, offset, length) {
        await gate;
        return data.slice(offset, offset + length);
      },
    }, 1024);
    vol.mountEntries(stubs(manifest));

    const paging = vol.ensureResident("/nm/a.js");
    vol.writeFileSync("/nm/a.js", "patched");
    release();
    await paging;

    expect(vol.readFileSync("/nm/a.js", "utf8")).toBe("patched");
    expect(vol.getStats().residentPackBytes).toBe(0);
  });
});

describe("review regressions", () => {
  it("concurrent page-ins don't evict each other before their callers read", async () => {
    const { data, manifest } = makePack({ "/nm/a": "a".repeat(8), "/nm/b": "b".repeat(8) });
    const vol = new MemoryVolume();
    vol.enableEviction({ read: async (_p, o, l) => data.slice(o, o + l) }, 10);
    vol.mountEntries(manifest.map((e, i) => ({
      path: e.path,
      kind: "file" as const,
      src: { pack: i, offset: e.offset, length: e.length },
    })));

    const [ra, rb] = [vol.ensureResident("/nm/a"), vol.ensureResident("/nm/b")];
    await ra;
    expect(vol.readFileSync("/nm/a", "utf8")).toBe("aaaaaaaa");
    await rb;
    expect(vol.readFileSync("/nm/b", "utf8")).toBe("bbbbbbbb");
    await tick();
    expect(vol.getStats().residentPackBytes).toBeLessThanOrEqual(10);
  });

  it("releases paged-in bytes of deleted files", async () => {
    const { data, manifest } = makePack({ "/nm/a": "x".repeat(1000) });
    const vol = new MemoryVolume();
    vol.enableEviction({ read: async (_p, o, l) => data.slice(o, o + l) }, 1 << 20);
    vol.mountEntries(stubs(manifest));
    await vol.ensureResident("/nm/a");
    const token = vol.inspectNode("/nm/a")!.inode as { content?: Uint8Array };

    vol.unlinkSync("/nm/a");
    expect(token.content).toBeUndefined();
    expect(vol.getStats().residentPackBytes).toBe(0);
  });

  it("never registers symlink aliases as hardlinks", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/real/f.txt", "x");
    vol.symlinkSync("/real", "/alias");
    vol.readFileSync("/alias/f.txt");
    vol.statSync("/alias/f.txt");

    expect(vol.linksOf("/real/f.txt")).toEqual(["/real/f.txt"]);
    expect(vol.inspectNode("/alias/f.txt")).toBeNull();
  });

  it("doesn't turn unrelated files with equal ino numbers into hardlinks", () => {
    const vol = new MemoryVolume();
    const enc = new TextEncoder();
    const user = enc.encode("USER");
    const pack = enc.encode("PACK");
    vol.mountBinarySnapshot({
      manifest: [
        { path: "/u", offset: 0, length: 4, isDirectory: false, inode: 1, nlink: 1 },
        { path: "/p", offset: 4, length: 4, isDirectory: false, inode: 1, nlink: 1 },
      ],
      data: new Uint8Array([...user, ...pack]).buffer,
    }, false);

    expect(vol.readFileSync("/u", "utf8")).toBe("USER");
    expect(vol.readFileSync("/p", "utf8")).toBe("PACK");
    expect(vol.inspectNode("/u")!.inode).not.toBe(vol.inspectNode("/p")!.inode);
  });

  it("journals the real file for truncate through a symlink, and only changed metadata", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/real.sh", "echo hi");
    vol.symlinkSync("/real.sh", "/run");
    const events: unknown[] = [];
    vol.onMutation((m) => events.push(m));

    vol.truncateSync("/run", 2);
    vol.chmodSync("/run", 0o755);
    vol.utimesSync("/real.sh", 1, 2);

    expect(events).toEqual([
      { op: "write", path: "/real.sh" },
      { op: "meta", path: "/real.sh", mode: 0o755 },
      { op: "meta", path: "/real.sh", atimeMs: 1000, mtimeMs: 2000 },
    ]);
  });
});
