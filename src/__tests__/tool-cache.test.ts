import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryVolume } from "../memory-volume";
import type { IDBSnapshotCache } from "../persistence/idb-cache";
import type { VFSBinarySnapshot } from "../threading/worker-protocol";
import {
  restoreToolCache,
  snapshotToolCache,
  toolCacheKey,
  watchToolCaches,
} from "../persistence/tool-cache";
import { joinSnapshotParts } from "../persistence/binary-snapshot";

const NM = "/app/node_modules";

function memoryCache(): IDBSnapshotCache & { entries: Map<string, VFSBinarySnapshot> } {
  const entries = new Map<string, VFSBinarySnapshot>();
  return {
    entries,
    async get(key) {
      return entries.get(key) ?? null;
    },
    async set(key, snapshot) {
      entries.set(key, snapshot);
    },
    close() {},
  };
}

function installed(lock = '{"react":{"version":"19.1.0"}}'): MemoryVolume {
  const vol = new MemoryVolume();
  vol.writeFileSync(`${NM}/.package-lock.json`, lock);
  vol.writeFileSync(`${NM}/react/package.json`, '{"name":"react"}');
  return vol;
}

function writeViteCache(vol: MemoryVolume): void {
  vol.writeFileSync(`${NM}/.vite/deps/_metadata.json`, '{"hash":"abc"}');
  vol.writeFileSync(`${NM}/.vite/deps/react.js`, "export default 1;");
  vol.writeFileSync(`${NM}/.vite/deps/package.json`, '{"type":"module"}');
  vol.writeFileSync(`${NM}/.vite/deps_temp_1234/react.js`, "half written");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("tool caches in node_modules", () => {
  it("snapshots a complete cache without its in-flight output", () => {
    const vol = installed();
    writeViteCache(vol);
    const snapshot = snapshotToolCache(vol, NM)!;
    const paths = snapshot.manifest.map((e) => e.path);
    expect(paths).toContain(`${NM}/.vite`);
    expect(paths).toContain(`${NM}/.vite/deps/_metadata.json`);
    expect(paths).toContain(`${NM}/.vite/deps/react.js`);
    expect(paths.some((p) => p.includes("deps_temp"))).toBe(false);
    expect(paths.some((p) => p.includes("/react/package.json"))).toBe(false);
  });

  it("has nothing to keep until the tool finished writing", () => {
    const vol = installed();
    vol.writeFileSync(`${NM}/.vite/deps_temp_1/react.js`, "x");
    expect(snapshotToolCache(vol, NM)).toBeNull();
  });

  it("restores the cache on top of the same installed tree", async () => {
    const cache = memoryCache();
    const first = installed();
    writeViteCache(first);
    await cache.set((await toolCacheKey(first, NM))!, joinSnapshotParts(snapshotToolCache(first, NM)!));

    const next = installed();
    expect(await restoreToolCache(next, cache, NM)).toBeGreaterThan(0);
    expect(next.readFileSync(`${NM}/.vite/deps/react.js`, "utf8")).toBe("export default 1;");
    expect(next.readFileSync(`${NM}/.vite/deps/_metadata.json`, "utf8")).toBe('{"hash":"abc"}');
    expect(next.existsSync(`${NM}/.vite/deps_temp_1234`)).toBe(false);
  });

  it("doesn't restore onto a different tree or over a cache already there", async () => {
    const cache = memoryCache();
    const first = installed();
    writeViteCache(first);
    await cache.set((await toolCacheKey(first, NM))!, joinSnapshotParts(snapshotToolCache(first, NM)!));

    const otherTree = installed('{"react":{"version":"18.3.1"}}');
    expect(await toolCacheKey(otherTree, NM)).not.toBe(await toolCacheKey(first, NM));
    expect(await restoreToolCache(otherTree, cache, NM)).toBe(0);
    expect(otherTree.existsSync(`${NM}/.vite`)).toBe(false);

    const withCache = installed();
    withCache.writeFileSync(`${NM}/.vite/deps/_metadata.json`, '{"hash":"newer"}');
    expect(await restoreToolCache(withCache, cache, NM)).toBe(0);
    expect(withCache.readFileSync(`${NM}/.vite/deps/_metadata.json`, "utf8")).toBe('{"hash":"newer"}');
  });

  it("has no key without an installed tree", async () => {
    expect(await toolCacheKey(new MemoryVolume(), NM)).toBeNull();
  });

  it("saves a cache once its writer goes quiet", async () => {
    vi.useFakeTimers();
    const vol = installed();
    const cache = memoryCache();
    const set = vi.spyOn(cache, "set");
    const stop = watchToolCaches(vol, cache);
    writeViteCache(vol);
    expect(set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0]).toBe(await toolCacheKey(vol, NM));
    // other writes don't save anything
    vol.writeFileSync("/app/src/main.ts", "x");
    await vi.advanceTimersByTimeAsync(5000);
    expect(set).toHaveBeenCalledTimes(1);
    stop();
    vol.writeFileSync(`${NM}/.vite/deps/react.js`, "changed");
    await vi.advanceTimersByTimeAsync(5000);
    expect(set).toHaveBeenCalledTimes(1);
  });
});
