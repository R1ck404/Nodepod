import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openTarballCache, shouldRefreshTarball } from "../persistence/tarball-cache";

function openV1(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open("nodepod-tarballs", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("tarballs");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function putV1(db: IDBDatabase, key: string, storedAt: number, size: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tarballs", "readwrite");
    tx.objectStore("tarballs").put({ bytes: new Uint8Array(size).buffer, storedAt, size }, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function keysOf(factory: IDBFactory, store: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = factory.open("nodepod-tarballs");
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(store, "readonly");
      const keysReq = tx.objectStore(store).getAllKeys();
      keysReq.onsuccess = () => {
        db.close();
        resolve((keysReq.result as string[]).sort());
      };
      keysReq.onerror = () => reject(keysReq.error);
    };
    req.onerror = () => reject(req.error);
  });
}

describe("tarball cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps entries stored before the meta store, and prunes them by it", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const v1 = await openV1(factory);
    const now = Date.now();
    await putV1(v1, "https://r/fresh.tgz", now, 10);
    await putV1(v1, "https://r/stale.tgz", now - 30 * 24 * 60 * 60 * 1000, 10);
    v1.close();

    const cache = (await openTarballCache())!;
    expect(cache).not.toBeNull();
    const fresh = await cache.get("https://r/fresh.tgz");
    expect(fresh?.byteLength).toBe(10);
    expect(await keysOf(factory, "meta")).toEqual(["https://r/fresh.tgz", "https://r/stale.tgz"]);

    await cache.prune();
    expect(await keysOf(factory, "tarballs")).toEqual(["https://r/fresh.tgz"]);
    expect(await keysOf(factory, "meta")).toEqual(["https://r/fresh.tgz"]);
    cache.close();
  });

  it("evicts oldest first past the byte budget, from both stores", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const cache = (await openTarballCache())!;
    await cache.put("https://r/a.tgz", new Uint8Array(100).buffer);
    await new Promise((r) => setTimeout(r, 5));
    await cache.put("https://r/b.tgz", new Uint8Array(100).buffer);
    await cache.prune(150);
    expect(await cache.get("https://r/a.tgz")).toBeNull();
    expect((await cache.get("https://r/b.tgz"))?.byteLength).toBe(100);
    cache.close();
  });

  it("doesn't ask to store again an archive it just returned", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const cache = (await openTarballCache())!;
    await cache.put("https://r/a.tgz", new Uint8Array(4).buffer);
    const hit = (await cache.get("https://r/a.tgz"))!;
    expect(shouldRefreshTarball(hit)).toBe(false);
    expect(shouldRefreshTarball(new ArrayBuffer(4))).toBe(true);
    cache.close();
  });
});
