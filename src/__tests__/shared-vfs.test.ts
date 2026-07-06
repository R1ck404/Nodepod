import { describe, it, expect } from "vitest";
import { Worker } from "node:worker_threads";
import {
  SharedVFSController,
  SharedVFSReader,
  isSharedArrayBufferAvailable,
} from "../threading/shared-vfs";
import { NodepodFSClient, NodepodFSClientError } from "../sdk/nodepod-fs-client";
import { MemoryVolume } from "../memory-volume";
import { VFSBridge } from "../threading/vfs-bridge";

describe("isSharedArrayBufferAvailable", () => {
  it("returns true in Node 20+ test env", () => {
    expect(isSharedArrayBufferAvailable()).toBe(true);
  });
});

describe("SharedVFSController + SharedVFSReader", () => {
  describe("readFileSync / writeFile roundtrip", () => {
    it("reads back exact bytes written", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      const data = new Uint8Array([1, 2, 3, 4, 255]);

      expect(ctrl.writeFile("/bin.dat", data)).toBe(true);
      const out = reader.readFileSync("/bin.dat");

      expect(out).toBeInstanceOf(Uint8Array);
      expect(Array.from(out!)).toEqual([1, 2, 3, 4, 255]);
    });

    it("returns null for missing file", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      expect(reader.readFileSync("/nope.txt")).toBeNull();
    });

    it("returns null when reading a directory", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      ctrl.writeDirectory("/mydir");
      expect(reader.readFileSync("/mydir")).toBeNull();
    });

    it("readFileSync result is an independent copy (mutation-safe)", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      ctrl.writeFile("/safe.dat", new Uint8Array([10, 20, 30]));

      const first = reader.readFileSync("/safe.dat")!;
      first[0] = 99;

      const second = reader.readFileSync("/safe.dat")!;
      expect(second[0]).toBe(10);
    });

    it("overwrites existing file (append-only storage, but path still resolves to latest)", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);

      ctrl.writeFile("/f.txt", new TextEncoder().encode("first"));
      ctrl.writeFile("/f.txt", new TextEncoder().encode("second-longer"));

      const out = reader.readFileSync("/f.txt")!;
      expect(new TextDecoder().decode(out)).toBe("second-longer");
    });
  });

  describe("existsSync / isDirectorySync", () => {
    it("existsSync returns true for files and dirs, false for missing", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      ctrl.writeFile("/a.txt", new Uint8Array([1]));
      ctrl.writeDirectory("/dir");

      expect(reader.existsSync("/a.txt")).toBe(true);
      expect(reader.existsSync("/dir")).toBe(true);
      expect(reader.existsSync("/gone")).toBe(false);
    });

    it("isDirectorySync distinguishes dirs from files", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      ctrl.writeFile("/file", new Uint8Array([1]));
      ctrl.writeDirectory("/dir");

      expect(reader.isDirectorySync("/dir")).toBe(true);
      expect(reader.isDirectorySync("/file")).toBe(false);
      expect(reader.isDirectorySync("/missing")).toBe(false);
    });
  });

  describe("statSync", () => {
    it("returns file stat with correct size", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      const content = new TextEncoder().encode("hello world");
      ctrl.writeFile("/hello.txt", content);

      const stat = reader.statSync("/hello.txt")!;
      expect(stat.isFile).toBe(true);
      expect(stat.isDirectory).toBe(false);
      expect(stat.size).toBe(content.byteLength);
      expect(stat.mtime).toBeGreaterThan(0);
    });

    it("returns dir stat with size 0", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      ctrl.writeDirectory("/mydir");

      const stat = reader.statSync("/mydir")!;
      expect(stat.isFile).toBe(false);
      expect(stat.isDirectory).toBe(true);
      expect(stat.size).toBe(0);
    });

    it("returns null for missing path", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      expect(reader.statSync("/nope")).toBeNull();
    });
  });

  describe("readdirSync", () => {
    it("returns immediate children only (no nested paths)", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      ctrl.writeFile("/a.txt", new Uint8Array([1]));
      ctrl.writeFile("/b.txt", new Uint8Array([1]));
      ctrl.writeFile("/sub/nested.txt", new Uint8Array([1]));
      ctrl.writeDirectory("/sub");
      ctrl.writeDirectory("/other");

      const root = reader.readdirSync("/");
      expect(root.sort()).toEqual(["a.txt", "b.txt", "other", "sub"]);
    });

    it("returns nested children when given a subdir", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      ctrl.writeDirectory("/proj");
      ctrl.writeFile("/proj/one.js", new Uint8Array([1]));
      ctrl.writeFile("/proj/two.js", new Uint8Array([1]));
      ctrl.writeFile("/proj/deep/nested.js", new Uint8Array([1]));

      expect(reader.readdirSync("/proj").sort()).toEqual(["deep", "one.js", "two.js"]);
    });

    it("returns [] for missing directory", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      expect(reader.readdirSync("/does/not/exist")).toEqual([]);
    });

    it("does not include deleted entries", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      ctrl.writeFile("/a.txt", new Uint8Array([1]));
      ctrl.writeFile("/b.txt", new Uint8Array([1]));
      ctrl.deleteFile("/a.txt");

      expect(reader.readdirSync("/")).toEqual(["b.txt"]);
    });

    it("handles trailing slash on dir path", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      ctrl.writeFile("/x/y.txt", new Uint8Array([1]));
      ctrl.writeDirectory("/x");

      expect(reader.readdirSync("/x")).toEqual(["y.txt"]);
      expect(reader.readdirSync("/x/")).toEqual(["y.txt"]);
    });
  });

  describe("version counter", () => {
    it("increments on every write", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      const v0 = reader.version;

      ctrl.writeFile("/a", new Uint8Array([1]));
      const v1 = reader.version;
      expect(v1).toBeGreaterThan(v0);

      ctrl.writeFile("/b", new Uint8Array([1]));
      expect(reader.version).toBeGreaterThan(v1);
    });

    it("increments on delete", () => {
      const ctrl = new SharedVFSController();
      const reader = new SharedVFSReader(ctrl.buffer);
      ctrl.writeFile("/a", new Uint8Array([1]));
      const v = reader.version;
      ctrl.deleteFile("/a");
      expect(reader.version).toBeGreaterThan(v);
    });
  });

  describe("caps", () => {
    it("path over 248 bytes gets truncated, still writes", () => {
      // path cap doesn't return false, it just truncates. documents the quirk.
      const ctrl = new SharedVFSController();
      const longPath = "/" + "a".repeat(300);
      const res = ctrl.writeFile(longPath, new Uint8Array([1]));
      expect(typeof res).toBe("boolean");
    });

    it("writeFile returns false when data won't fit", () => {
      // need a buffer big enough for the fixed table (32+16384*272, see
      // shared-vfs.ts layout) plus a tiny bit of data, then try to overflow
      // that tiny bit.
      const HEADER_AND_TABLE = 32 + 16384 * 272;
      const ctrl = new SharedVFSController(HEADER_AND_TABLE + 1024);

      expect(ctrl.writeFile("/small.dat", new Uint8Array(500))).toBe(true);
      expect(ctrl.writeFile("/big.dat", new Uint8Array(2000))).toBe(false);
    });
  });
});

describe("NodepodFSClient", () => {
  it("readFile returns bytes", async () => {
    const ctrl = new SharedVFSController();
    ctrl.writeFile("/data.bin", new Uint8Array([9, 8, 7]));

    const client = new NodepodFSClient(new SharedVFSReader(ctrl.buffer));
    const bytes = await client.readFile("/data.bin");
    expect(Array.from(bytes as Uint8Array)).toEqual([9, 8, 7]);
  });

  it("readFile with utf8 returns decoded string", async () => {
    const ctrl = new SharedVFSController();
    ctrl.writeFile("/hi.txt", new TextEncoder().encode("hello"));

    const client = new NodepodFSClient(new SharedVFSReader(ctrl.buffer));
    const text = await client.readFile("/hi.txt", "utf8");
    expect(text).toBe("hello");
  });

  it("readFile throws ENOENT on missing file", async () => {
    const ctrl = new SharedVFSController();
    const client = new NodepodFSClient(new SharedVFSReader(ctrl.buffer));
    await expect(client.readFile("/nope")).rejects.toMatchObject({
      code: "ENOENT",
      name: "NodepodFSClientError",
    });
  });

  it("stat returns correct shape", async () => {
    const ctrl = new SharedVFSController();
    ctrl.writeFile("/a.txt", new TextEncoder().encode("abc"));
    const client = new NodepodFSClient(new SharedVFSReader(ctrl.buffer));

    const stat = await client.stat("/a.txt");
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.size).toBe(3);
  });

  it("stat throws ENOENT on missing path", async () => {
    const ctrl = new SharedVFSController();
    const client = new NodepodFSClient(new SharedVFSReader(ctrl.buffer));
    await expect(client.stat("/nope")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("readdir returns children", async () => {
    const ctrl = new SharedVFSController();
    ctrl.writeDirectory("/proj");
    ctrl.writeFile("/proj/a.js", new Uint8Array([1]));
    ctrl.writeFile("/proj/b.js", new Uint8Array([1]));

    const client = new NodepodFSClient(new SharedVFSReader(ctrl.buffer));
    const entries = await client.readdir("/proj");
    expect(entries.sort()).toEqual(["a.js", "b.js"]);
  });

  it("readdir throws ENOENT on missing non-root dir", async () => {
    const ctrl = new SharedVFSController();
    const client = new NodepodFSClient(new SharedVFSReader(ctrl.buffer));
    await expect(client.readdir("/nope")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exists reflects state", async () => {
    const ctrl = new SharedVFSController();
    ctrl.writeFile("/a", new Uint8Array([1]));
    const client = new NodepodFSClient(new SharedVFSReader(ctrl.buffer));

    expect(await client.exists("/a")).toBe(true);
    expect(await client.exists("/b")).toBe(false);
  });

  describe("write operations throw ENOTSUP", () => {
    const ctrl = new SharedVFSController();
    const client = new NodepodFSClient(new SharedVFSReader(ctrl.buffer));

    it("writeFile", async () => {
      await expect(client.writeFile("/x", "y")).rejects.toMatchObject({ code: "ENOTSUP" });
    });
    it("mkdir", async () => {
      await expect(client.mkdir("/x")).rejects.toMatchObject({ code: "ENOTSUP" });
    });
    it("unlink", async () => {
      await expect(client.unlink("/x")).rejects.toMatchObject({ code: "ENOTSUP" });
    });
    it("rmdir", async () => {
      await expect(client.rmdir("/x")).rejects.toMatchObject({ code: "ENOTSUP" });
    });
    it("rename", async () => {
      await expect(client.rename("/x", "/y")).rejects.toMatchObject({ code: "ENOTSUP" });
    });
    it("appendFile", async () => {
      await expect(client.appendFile("/x", "y")).rejects.toMatchObject({ code: "ENOTSUP" });
    });

    it("throws NodepodFSClientError (named)", async () => {
      try {
        await client.writeFile("/x", "y");
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(NodepodFSClientError);
      }
    });
  });

  it("version getter reflects reader version", async () => {
    const ctrl = new SharedVFSController();
    const client = new NodepodFSClient(new SharedVFSReader(ctrl.buffer));
    const v0 = client.version;
    ctrl.writeFile("/a", new Uint8Array([1]));
    expect(client.version).toBeGreaterThan(v0);
  });
});

describe("VFSBridge -> SharedVFS mirror (main-thread write visibility)", () => {
  // regression: watch callbacks pass relative paths, bridge used to forward
  // them as-is into SharedVFS so "/hello.txt" landed under "hello.txt" and
  // sibling workers got ENOENT. bridge now promotes to absolute first.
  it("stores entries under absolute paths so SharedVFSReader finds them", () => {
    const vol = new MemoryVolume();
    const ctrl = new SharedVFSController();
    const bridge = new VFSBridge(vol);
    bridge.setSharedVFS(ctrl);
    const unwatch = bridge.watch();

    vol.writeFileSync("/top.txt", "hi");
    vol.mkdirSync("/proj", { recursive: true });
    vol.mkdirSync("/proj/src", { recursive: true });
    vol.writeFileSync("/proj/src/index.js", "module.exports = 1");

    const reader = new SharedVFSReader(ctrl.buffer);
    expect(reader.existsSync("/top.txt")).toBe(true);
    expect(reader.existsSync("/proj")).toBe(true);
    expect(reader.existsSync("/proj/src/index.js")).toBe(true);
    expect(reader.isDirectorySync("/proj")).toBe(true);

    const bytes = reader.readFileSync("/proj/src/index.js")!;
    expect(new TextDecoder().decode(bytes)).toBe("module.exports = 1");

    // the old buggy relative form must not be present
    expect(reader.existsSync("top.txt")).toBe(false);
    expect(reader.existsSync("proj/src/index.js")).toBe(false);

    unwatch();
  });

  it("readdirSync on the reader sees bridge-mirrored dirs", () => {
    const vol = new MemoryVolume();
    const ctrl = new SharedVFSController();
    const bridge = new VFSBridge(vol);
    bridge.setSharedVFS(ctrl);
    const unwatch = bridge.watch();

    vol.mkdirSync("/app", { recursive: true });
    vol.writeFileSync("/app/a.js", "a");
    vol.writeFileSync("/app/b.js", "b");

    const reader = new SharedVFSReader(ctrl.buffer);
    expect(reader.readdirSync("/app").sort()).toEqual(["a.js", "b.js"]);

    unwatch();
  });

  it("mirrors deletes as well as writes", () => {
    const vol = new MemoryVolume();
    const ctrl = new SharedVFSController();
    const bridge = new VFSBridge(vol);
    bridge.setSharedVFS(ctrl);
    const unwatch = bridge.watch();

    vol.writeFileSync("/gone.txt", "x");
    const reader = new SharedVFSReader(ctrl.buffer);
    expect(reader.existsSync("/gone.txt")).toBe(true);

    vol.unlinkSync("/gone.txt");
    expect(reader.existsSync("/gone.txt")).toBe(false);

    unwatch();
  });
});

describe("cross-thread attach (SAB via worker_threads)", () => {
  it("a separate thread constructing a reader from the same SAB sees main-thread writes", async () => {
    const ctrl = new SharedVFSController();
    ctrl.writeFile("/greeting.txt", new TextEncoder().encode("hello from main"));
    ctrl.writeFile("/data.bin", new Uint8Array([42, 43, 44]));
    ctrl.writeDirectory("/proj");
    ctrl.writeFile("/proj/one.js", new TextEncoder().encode("module.exports = 1"));

    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");

      // inline reader so the worker doesn't have to import the TS source.
      // same shape as what a sibling worker would do in production.
      // NOTE: constants mirror the layout in src/threading/shared-vfs.ts —
      // keep in sync when the layout changes (plan 014 added the hash field).
      const HEADER_SIZE = 32;
      const ENTRY_SIZE = 272;
      const ENTRY_FLAGS_OFFSET = 0;
      const ENTRY_CONTENT_OFFSET = 4;
      const ENTRY_CONTENT_LENGTH = 8;
      const ENTRY_PATH_OFFSET = 20;
      const ENTRY_PATH_MAX = 248;
      const DATA_OFFSET = HEADER_SIZE + 16384 * ENTRY_SIZE;
      const FLAG_ACTIVE = 1;

      const buf = workerData.buffer;
      const view = new DataView(buf);
      const int32 = new Int32Array(buf);
      const uint8 = new Uint8Array(buf);
      const enc = new TextEncoder();
      const dec = new TextDecoder();

      function findEntry(path) {
        const n = Atomics.load(int32, 1);
        const bytes = enc.encode(path);
        outer: for (let i = 0; i < n; i++) {
          const off = HEADER_SIZE + i * ENTRY_SIZE;
          const flags = view.getUint32(off + ENTRY_FLAGS_OFFSET);
          if (!(flags & FLAG_ACTIVE)) continue;
          for (let j = 0; j < bytes.length; j++) {
            if (uint8[off + ENTRY_PATH_OFFSET + j] !== bytes[j]) continue outer;
          }
          if (uint8[off + ENTRY_PATH_OFFSET + bytes.length] === 0) return i;
        }
        return -1;
      }

      function readFile(path) {
        const idx = findEntry(path);
        if (idx === -1) return null;
        const off = HEADER_SIZE + idx * ENTRY_SIZE;
        const coff = view.getUint32(off + ENTRY_CONTENT_OFFSET);
        const clen = view.getUint32(off + ENTRY_CONTENT_LENGTH);
        return Array.from(uint8.subarray(DATA_OFFSET + coff, DATA_OFFSET + coff + clen));
      }

      parentPort.postMessage({
        greeting: dec.decode(new Uint8Array(readFile("/greeting.txt"))),
        dataBytes: readFile("/data.bin"),
        projOneJs: dec.decode(new Uint8Array(readFile("/proj/one.js"))),
        missing: readFile("/nope"),
      });
    `;

    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { buffer: ctrl.buffer },
    });

    const result: any = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    await worker.terminate();

    expect(result.greeting).toBe("hello from main");
    expect(result.dataBytes).toEqual([42, 43, 44]);
    expect(result.projOneJs).toBe("module.exports = 1");
    expect(result.missing).toBeNull();
  });
});

describe("compaction + waste accounting (plan 014)", () => {
  // fixed header+table plus a 4MB data region for churn tests
  const HEADER_AND_TABLE = 32 + 16384 * 272;
  const DATA_REGION = 4 * 1024 * 1024;
  const SMALL = HEADER_AND_TABLE + DATA_REGION;

  it("tracks wasteBytes on overwrite and delete", () => {
    const ctrl = new SharedVFSController(SMALL);
    ctrl.writeFile("/a.txt", new Uint8Array(100));
    expect(ctrl.getStats().wasteBytes).toBe(0);

    ctrl.writeFile("/a.txt", new Uint8Array(50)); // orphans the 100 old bytes
    expect(ctrl.getStats().wasteBytes).toBe(100);

    ctrl.writeFile("/b.txt", new Uint8Array(30));
    ctrl.deleteFile("/b.txt");
    expect(ctrl.getStats().wasteBytes).toBe(130);
  });

  it("churn does not exhaust the data region (overwrites reclaim via compaction)", () => {
    const ctrl = new SharedVFSController(SMALL);
    const payload = new Uint8Array(64 * 1024);
    // 1000 × 64KB appends = ~64MB — impossible in a 4MB region without compaction
    for (let i = 0; i < 1000; i++) {
      payload[0] = i % 256;
      expect(ctrl.writeFile("/hot.js", payload)).toBe(true);
    }
    const stats = ctrl.getStats();
    expect(stats.droppedWrites).toBe(0);
    expect(stats.compactions).toBeGreaterThan(0);
    expect(stats.wasteBytes).toBeLessThanOrEqual(16 * 1024 * 1024);

    const out = ctrl.readFile("/hot.js")!;
    expect(out[0]).toBe(999 % 256);
    expect(out.byteLength).toBe(64 * 1024);
  });

  it("deleted files' space is reclaimed for new writes", () => {
    const ctrl = new SharedVFSController(SMALL);
    const big = new Uint8Array(1024 * 1024);
    // fill most of the 4MB data region
    expect(ctrl.writeFile("/one.bin", big)).toBe(true);
    expect(ctrl.writeFile("/two.bin", big)).toBe(true);
    expect(ctrl.writeFile("/three.bin", big)).toBe(true);
    ctrl.deleteFile("/one.bin");
    ctrl.deleteFile("/two.bin");
    // without reclamation this would fail for space; rescue-compaction saves it
    expect(ctrl.writeFile("/four.bin", big)).toBe(true);
    expect(ctrl.readFile("/four.bin")!.byteLength).toBe(big.byteLength);
    expect(ctrl.readFile("/three.bin")!.byteLength).toBe(big.byteLength);
    expect(ctrl.readFile("/one.bin")).toBeNull();
  });

  it("a reader sees correct content immediately after compaction", () => {
    const ctrl = new SharedVFSController(SMALL);
    const reader = new SharedVFSReader(ctrl.buffer);
    ctrl.writeFile("/keep.txt", new TextEncoder().encode("keep me"));
    ctrl.writeDirectory("/dir");
    ctrl.writeFile("/dir/nested.txt", new TextEncoder().encode("nested"));
    ctrl.writeFile("/gone.txt", new TextEncoder().encode("bye"));
    ctrl.deleteFile("/gone.txt");
    ctrl.writeFile("/keep.txt", new TextEncoder().encode("keep me v2"));

    const versionBefore = reader.version;
    ctrl.compact();
    expect(reader.version).toBeGreaterThan(versionBefore);

    expect(new TextDecoder().decode(reader.readFileSync("/keep.txt")!)).toBe("keep me v2");
    expect(new TextDecoder().decode(reader.readFileSync("/dir/nested.txt")!)).toBe("nested");
    expect(reader.isDirectorySync("/dir")).toBe(true);
    expect(reader.readFileSync("/gone.txt")).toBeNull();
    expect(reader.readdirSync("/dir")).toEqual(["nested.txt"]);
    expect(ctrl.getStats().wasteBytes).toBe(0);
  });

  it("compaction drops tombstoned entries from the table", () => {
    const ctrl = new SharedVFSController(SMALL);
    ctrl.writeFile("/a", new Uint8Array(1));
    ctrl.writeFile("/b", new Uint8Array(1));
    ctrl.deleteFile("/a");
    expect(ctrl.getStats().entries).toBe(2);
    ctrl.compact();
    const stats = ctrl.getStats();
    expect(stats.entries).toBe(1);
    expect(stats.activeEntries).toBe(1);
    expect(ctrl.exists("/b")).toBe(true);
    expect(ctrl.exists("/a")).toBe(false);
  });

  it("dropped writes are counted when the region genuinely cannot fit", () => {
    const ctrl = new SharedVFSController(SMALL);
    // larger than the whole data region — impossible even after compaction
    const tooBig = new Uint8Array(DATA_REGION + 1024);
    expect(ctrl.writeFile("/huge.bin", tooBig)).toBe(false);
    expect(ctrl.getStats().droppedWrites).toBe(1);
  });

  it("hash collisions still resolve by byte compare", () => {
    // brute-force two distinct paths with equal fnv1a
    function fnv1a(str: string): number {
      let hash = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
      }
      return hash;
    }
    const buckets = new Map<number, string>();
    let a: string | null = null;
    let b: string | null = null;
    outer: for (let i = 0; i < 5_000_000; i++) {
      const p = `/f${i.toString(36)}`;
      const h = fnv1a(p);
      const prev = buckets.get(h);
      if (prev !== undefined && prev !== p) {
        a = prev;
        b = p;
        break outer;
      }
      buckets.set(h, p);
    }
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const ctrl = new SharedVFSController(SMALL);
    const reader = new SharedVFSReader(ctrl.buffer);
    ctrl.writeFile(a!, new TextEncoder().encode("content-a"));
    ctrl.writeFile(b!, new TextEncoder().encode("content-b"));

    expect(new TextDecoder().decode(reader.readFileSync(a!)!)).toBe("content-a");
    expect(new TextDecoder().decode(reader.readFileSync(b!)!)).toBe("content-b");
    expect(new TextDecoder().decode(ctrl.readFile(a!)!)).toBe("content-a");
    expect(new TextDecoder().decode(ctrl.readFile(b!)!)).toBe("content-b");
  });
});
