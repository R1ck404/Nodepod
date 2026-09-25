import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { openSnapshotCache } from "../persistence/idb-cache";
import { openOPFSSnapshotCache } from "../persistence/opfs-snapshot-cache";
import { openFsSnapshotCache } from "../host/node/fs-snapshot-cache";
import type { IDBSnapshotCache } from "../persistence/idb-cache";
import type { VFSBinarySnapshot } from "../threading/worker-protocol";

const pack: VFSBinarySnapshot = {
  manifest: [
    { path: "/nm/a", offset: 0, length: 3, isDirectory: false },
    { path: "/nm/b", offset: 3, length: 4, isDirectory: false },
  ],
  data: new Uint8Array([1, 2, 3, 4, 5, 6, 7]).buffer,
};

async function expectRangeReads(cache: IDBSnapshotCache): Promise<void> {
  await cache.set("key", pack);
  const head = (await cache.getManifest!("key"))!;
  expect(head.manifest).toEqual(pack.manifest);
  expect(Array.from((await cache.readRange!("key", head.version, 3, 4))!)).toEqual([4, 5, 6, 7]);
  expect(Array.from((await cache.readRange!("key", head.version, 0, 3))!)).toEqual([1, 2, 3]);
  // the whole pack still round-trips
  const full = await cache.get("key");
  expect(Array.from(new Uint8Array(full!.data))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(await cache.getManifest!("missing")).toBeNull();
  expect(await cache.readRange!("missing", "nope", 0, 1)).toBeNull();

  // rewriting the key makes old byte ranges fail instead of reading new bytes
  await cache.set("key", { manifest: pack.manifest, data: new Uint8Array([9, 9, 9, 9, 9, 9, 9]).buffer });
  const next = (await cache.getManifest!("key"))!;
  expect(next.version).not.toBe(head.version);
  expect(Array.from((await cache.readRange!("key", next.version, 0, 3))!)).toEqual([9, 9, 9]);
  const stale = await cache.readRange!("key", head.version, 0, 3);
  if (stale) expect(Array.from(stale)).toEqual([1, 2, 3]);
}

afterEach(() => vi.unstubAllGlobals());

describe("package pack range reads", () => {
  it("IndexedDB", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    const cache = await openSnapshotCache();
    expect(cache).not.toBeNull();
    await expectRangeReads(cache!);
    cache!.close();
  });

  it("OPFS", async () => {
    const files = new Map<string, Blob>();
    const directory = {
      async getDirectoryHandle() { return directory; },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        if (!options?.create && !files.has(name)) throw new Error("missing");
        return {
          async getFile() { return files.get(name)!; },
          async createWritable() {
            let value: BlobPart = "";
            return {
              async write(next: BlobPart) { value = next; },
              async close() { files.set(name, new Blob([value])); },
            };
          },
        };
      },
    };
    vi.stubGlobal("navigator", { storage: { async getDirectory() { return directory; } } });
    const cache = await openOPFSSnapshotCache();
    await expectRangeReads(cache!);
  });

  it("Node filesystem", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nodepod-packs-"));
    try {
      const cache = await openFsSnapshotCache(dir);
      await expectRangeReads(cache!);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("saving a pack from its parts", () => {
  it("stores the files' bytes as one pack without joining them first", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    const cache = (await openSnapshotCache())!;
    const { collectBinarySnapshotParts, saveSnapshotParts } = await import("../persistence/binary-snapshot");
    const { MemoryVolume } = await import("../memory-volume");
    const vol = new MemoryVolume();
    vol.writeFileSync("/app/node_modules/a/index.js", "export default 1;");
    vol.writeFileSync("/app/node_modules/a/package.json", '{"name":"a"}');
    vol.writeFileSync("/app/src/main.js", "not in the pack");
    const parts = collectBinarySnapshotParts(vol, (p) => p.includes("/node_modules/"));
    expect(parts.parts.length).toBe(2);
    await saveSnapshotParts(cache, "parts", parts);
    const back = (await cache.get("parts"))!;
    const target = new MemoryVolume();
    target.mountBinarySnapshot(back);
    expect(target.readFileSync("/app/node_modules/a/index.js", "utf8")).toBe("export default 1;");
    expect(target.readFileSync("/app/node_modules/a/package.json", "utf8")).toBe('{"name":"a"}');
    expect(target.existsSync("/app/src/main.js")).toBe(false);
    cache.close();
  });
});
