// Plan 015: binary snapshot helpers + installer snapshot-cache integration

import { describe, it, expect } from "vitest";
import { MemoryVolume } from "../memory-volume";
import {
  createFilteredBinarySnapshot,
  restoreBinarySnapshot,
} from "../persistence/binary-snapshot";
import type { IDBSnapshotCache } from "../persistence/idb-cache";
import type { VFSBinarySnapshot } from "../threading/worker-protocol";
import { DependencyInstaller } from "../packages/installer";
import { openTarballCache } from "../persistence/tarball-cache";

function memoryCache(): IDBSnapshotCache & { store: Map<string, VFSBinarySnapshot> } {
  const store = new Map<string, VFSBinarySnapshot>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, snapshot) {
      store.set(key, snapshot);
    },
    close() {},
  };
}

describe("createFilteredBinarySnapshot / restoreBinarySnapshot", () => {
  it("round-trips filtered content without base64", () => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/proj/node_modules/pkg", { recursive: true });
    vol.writeFileSync("/proj/node_modules/pkg/index.js", "module.exports = 1;");
    vol.writeFileSync("/proj/node_modules/pkg/bin.dat", new Uint8Array([0, 255, 128]));
    vol.writeFileSync("/proj/app.js", "user code");

    const snap = createFilteredBinarySnapshot(vol, (p) => p.includes("/node_modules/"));
    const paths = snap.manifest.map((e) => e.path);
    expect(paths).toContain("/proj/node_modules/pkg/index.js");
    expect(paths).toContain("/proj/node_modules/pkg/bin.dat");
    expect(paths).not.toContain("/proj/app.js");
    expect(snap.data).toBeInstanceOf(ArrayBuffer);

    const target = new MemoryVolume();
    const restored = restoreBinarySnapshot(target, snap);
    expect(restored).toBeGreaterThan(0);
    expect(target.readFileSync("/proj/node_modules/pkg/index.js", "utf8")).toBe(
      "module.exports = 1;",
    );
    expect(Array.from(target.readFileSync("/proj/node_modules/pkg/bin.dat"))).toEqual([
      0, 255, 128,
    ]);
  });

  it("restore merges into an existing tree without clobbering unrelated files", () => {
    const source = new MemoryVolume();
    source.mkdirSync("/p/node_modules/a", { recursive: true });
    source.writeFileSync("/p/node_modules/a/index.js", "a");
    const snap = createFilteredBinarySnapshot(source, (p) => p.includes("/node_modules/"));

    const target = new MemoryVolume();
    target.mkdirSync("/p/src", { recursive: true });
    target.writeFileSync("/p/src/main.ts", "keep me");
    target.mkdirSync("/p/node_modules/b", { recursive: true });
    target.writeFileSync("/p/node_modules/b/index.js", "b stays");

    restoreBinarySnapshot(target, snap);

    expect(target.readFileSync("/p/src/main.ts", "utf8")).toBe("keep me");
    expect(target.readFileSync("/p/node_modules/b/index.js", "utf8")).toBe("b stays");
    expect(target.readFileSync("/p/node_modules/a/index.js", "utf8")).toBe("a");
  });

  it("captures empty directories that match the filter", () => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/x/node_modules/pkg/empty-dir", { recursive: true });
    const snap = createFilteredBinarySnapshot(vol, (p) => p.includes("/node_modules/"));

    const target = new MemoryVolume();
    restoreBinarySnapshot(target, snap);
    expect(target.existsSync("/x/node_modules/pkg/empty-dir")).toBe(true);
    expect(target.statSync("/x/node_modules/pkg/empty-dir").isDirectory()).toBe(true);
  });

  it("mounts silently and detaches file content on write", () => {
    const source = new MemoryVolume();
    source.writeFileSync("/node_modules/pkg/index.js", "original");
    const snapshot = createFilteredBinarySnapshot(source, () => true);
    const originalBytes = new Uint8Array(snapshot.data).slice();

    const target = new MemoryVolume();
    const events: string[] = [];
    const watcher = target.watch("/", { recursive: true }, (_event, path) => {
      if (path) events.push(path);
    });
    restoreBinarySnapshot(target, snapshot);
    expect(events).toEqual([]);

    target.writeFileSync("/node_modules/pkg/index.js", "changed");
    expect(new Uint8Array(snapshot.data)).toEqual(originalBytes);
    expect(target.readFileSync("/node_modules/pkg/index.js", "utf8")).toBe("changed");
    watcher.close();
  });

  it("preserves links, modes, and timestamps", () => {
    const source = new MemoryVolume();
    source.mkdirSync("/node_modules/pkg", { recursive: true });
    source.writeFileSync("/node_modules/pkg/data", "original");
    source.linkSync("/node_modules/pkg/data", "/node_modules/pkg/hardlink");
    source.symlinkSync("data", "/node_modules/pkg/symlink");
    source.chmodSync("/node_modules/pkg/data", 0o640);
    source.utimesSync("/node_modules/pkg/data", new Date(123_000), new Date(456_000));

    const target = new MemoryVolume();
    restoreBinarySnapshot(target, createFilteredBinarySnapshot(source, () => true));

    expect(target.readlinkSync("/node_modules/pkg/symlink")).toBe("data");
    expect(target.readFileSync("/node_modules/pkg/symlink", "utf8")).toBe("original");
    expect(target.statSync("/node_modules/pkg/data").mode & 0o777).toBe(0o640);
    expect(target.statSync("/node_modules/pkg/data").mtimeMs).toBe(456_000);
    expect(target.statSync("/node_modules/pkg/data").ino).toBe(
      target.statSync("/node_modules/pkg/hardlink").ino,
    );
    target.writeFileSync("/node_modules/pkg/hardlink", "changed");
    expect(target.readFileSync("/node_modules/pkg/data", "utf8")).toBe("changed");
  });

  it("replaces incompatible node kinds while merging the overlay", () => {
    const source = new MemoryVolume();
    source.mkdirSync("/node_modules/pkg/dir", { recursive: true });
    source.writeFileSync("/node_modules/pkg/file", "file");
    source.symlinkSync("file", "/node_modules/pkg/link");
    const snapshot = createFilteredBinarySnapshot(source, () => true);

    const target = new MemoryVolume();
    target.mkdirSync("/node_modules/pkg/file/old", { recursive: true });
    target.writeFileSync("/node_modules/pkg/dir", "wrong kind");
    target.writeFileSync("/node_modules/pkg/other", "keep");
    target.writeFileSync("/elsewhere", "elsewhere");
    target.symlinkSync("/elsewhere", "/node_modules/pkg/link");
    restoreBinarySnapshot(target, snapshot);

    expect(target.statSync("/node_modules/pkg/dir").isDirectory()).toBe(true);
    expect(target.readFileSync("/node_modules/pkg/file", "utf8")).toBe("file");
    expect(target.readlinkSync("/node_modules/pkg/link")).toBe("file");
    expect(target.readFileSync("/node_modules/pkg/other", "utf8")).toBe("keep");
  });
});

describe("installer snapshot cache (binary format)", () => {
  it("installFromManifest restores from cache without hitting the network", async () => {
    const cache = memoryCache();

    // seed the cache exactly like a previous install would have
    const seeded = new MemoryVolume();
    seeded.mkdirSync("/node_modules/left-pad", { recursive: true });
    seeded.writeFileSync(
      "/node_modules/left-pad/package.json",
      '{"name":"left-pad","version":"1.3.0","main":"index.js"}',
    );
    seeded.writeFileSync("/node_modules/left-pad/index.js", "module.exports = (s) => s;");
    const snapshot = createFilteredBinarySnapshot(seeded, (p) =>
      p.includes("/node_modules/"),
    );

    const manifestRaw = JSON.stringify({
      name: "app",
      dependencies: { "left-pad": "^1.3.0" },
    });
    const { manifestSnapshotKey } = await import("../packages/installer");
    await cache.set(manifestSnapshotKey(manifestRaw), snapshot);

    const vol = new MemoryVolume();
    vol.writeFileSync("/package.json", manifestRaw);

    const installer = new DependencyInstaller(vol, { snapshotCache: cache });
    const outcome = await installer.installFromManifest();

    expect(outcome.newPackages).toEqual([]);
    expect(vol.readFileSync("/node_modules/left-pad/index.js", "utf8")).toBe(
      "module.exports = (s) => s;",
    );
  });

  it("rejects an incomplete manifest snapshot", async () => {
    const manifestRaw = JSON.stringify({
      name: "app",
      dependencies: { "left-pad": "^1.3.0", missing: "^1.0.0" },
    });
    const seeded = new MemoryVolume();
    seeded.mkdirSync("/node_modules/left-pad", { recursive: true });
    seeded.writeFileSync("/node_modules/left-pad/package.json", '{"name":"left-pad"}');
    const snapshot = createFilteredBinarySnapshot(seeded, (p) =>
      p.includes("/node_modules/"),
    );
    const { isManifestSnapshotComplete } = await import("../packages/installer");

    expect(isManifestSnapshotComplete(snapshot, "/", JSON.parse(manifestRaw))).toBe(false);
  });
});

describe("tarball cache availability", () => {
  it("degrades to null when indexedDB is unavailable (Node test env)", async () => {
    expect(typeof indexedDB).toBe("undefined");
    expect(await openTarballCache()).toBeNull();
  });
});
