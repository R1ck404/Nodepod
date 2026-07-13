import { afterEach, describe, expect, it, vi } from "vitest";
import { openOPFSSnapshotCache } from "../persistence/opfs-snapshot-cache";

describe("OPFS snapshot cache", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips a pack and treats corrupt data as a miss", async () => {
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
    vi.stubGlobal("navigator", {
      storage: { async getDirectory() { return directory; } },
    });

    const cache = await openOPFSSnapshotCache();
    expect(cache).not.toBeNull();
    const snapshot = {
      manifest: [{ path: "/a", offset: 0, length: 3, isDirectory: false }],
      data: new Uint8Array([1, 2, 3]).buffer,
    };
    await cache!.set("key", snapshot);
    expect(await cache!.get("key")).toEqual(snapshot);

    files.set("key.bin", new Blob([new Uint8Array([9])]));
    expect(await cache!.get("key")).toBeNull();
  });
});
