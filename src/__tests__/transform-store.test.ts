import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { SharedTransformStore } from "../threading/transform-store";

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("SharedTransformStore", () => {
  it("serves what was put, per scope", async () => {
    const store = new SharedTransformStore(false);
    store.put("s|vite@6", [["dist/a.js|10|x", "code-a", 0], ["dist/b.js|20|y", "code-b", 3]]);
    await store.flush();
    expect(JSON.parse(await store.packText("s|vite@6"))).toEqual([
      ["dist/a.js|10|x", "code-a", 0],
      ["dist/b.js|20|y", "code-b", 3],
    ]);
    expect(JSON.parse(await store.packText("s|other@1"))).toEqual([]);
    expect(store.knownScopes()).toEqual(["s|vite@6"]);
  });

  it("lets the last entry put under a key win", async () => {
    const store = new SharedTransformStore(false);
    store.put("s|p@1", [["k", "old", 2]]);
    store.put("s|p@1", [["k", "new", 0], ["j", "other", 1]]);
    await store.flush();
    // readers build a Map from the array
    const read = new Map(
      (JSON.parse(await store.packText("s|p@1")) as Array<[string, string, number]>).map(([k, code, flags]) => [k, [code, flags]]),
    );
    expect(read.get("k")).toEqual(["new", 0]);
    expect(read.get("j")).toEqual(["other", 1]);
  });

  it("stores batches serialized by workers as they are", async () => {
    const store = new SharedTransformStore(false);
    store.put("s|w@1", JSON.stringify([["a", "code-a", 0]]));
    store.put("s|w@1", "[]");
    store.put("s|w@1", "not json");
    store.put("s|w@1", JSON.stringify([["b", "code-b", 2]]));
    expect(JSON.parse(await store.packText("s|w@1"))).toEqual([
      ["a", "code-a", 0],
      ["b", "code-b", 2],
    ]);
  });

  it("persists packs to IndexedDB and indexes them for the next session", async () => {
    const first = new SharedTransformStore(true);
    first.put("salt|react@19", [["index.js|5|a", "module.exports = 1", 2]]);
    await settle();
    await first.flush();

    const next = new SharedTransformStore(true);
    await next.loadIndex();
    expect(next.knownScopes()).toContain("salt|react@19");
    expect(JSON.parse(await next.packText("salt|react@19"))).toEqual([
      ["index.js|5|a", "module.exports = 1", 2],
    ]);
  });

  it("merges puts into a persisted pack instead of overwriting it", async () => {
    const a = new SharedTransformStore(true);
    a.put("salt|merge@1", [["one", "1", 0]]);
    await settle();
    await a.flush();

    const b = new SharedTransformStore(true);
    b.put("salt|merge@1", [["two", "2", 0]]);
    await settle();
    await b.flush();

    const c = new SharedTransformStore(true);
    const keys = (JSON.parse(await c.packText("salt|merge@1")) as Array<[string]>).map((e) => e[0]).sort();
    expect(keys).toEqual(["one", "two"]);
  });
});

describe("SharedTransformStore persistence housekeeping", () => {
  it("expires packs not written for too long", async () => {
    const a = new SharedTransformStore(true);
    a.put("salt|old@1", [["k", "code", 0]]);
    a.put("salt|fresh@1", [["k", "code", 0]]);
    await a.flush();
    // age one pack's metadata past the limit
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("nodepod-transforms");
      req.onsuccess = () => {
        const tx = req.result.transaction("meta", "readwrite");
        tx.objectStore("meta").put({ updatedAt: Date.now() - 30 * 24 * 3600 * 1000, chars: 10 }, "salt|old@1");
        tx.oncomplete = () => { req.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    const b = new SharedTransformStore(true);
    expect(b.indexLoaded).toBe(false);
    await b.loadIndex();
    expect(b.indexLoaded).toBe(true);
    expect(b.knownScopes()).toContain("salt|fresh@1");
    expect(b.knownScopes()).not.toContain("salt|old@1");
    expect(JSON.parse(await b.packText("salt|old@1"))).toEqual([]);
  });
});
