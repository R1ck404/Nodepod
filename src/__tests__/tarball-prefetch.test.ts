import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function load() {
  vi.resetModules();
  // no IndexedDB: the tarball cache is off, downloads go to fetch
  vi.stubGlobal("indexedDB", undefined);
  return import("../packages/tarball-prefetch");
}

describe("tarball prefetch", () => {
  it("hands a download started during resolution to extraction, once", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    const { prefetchTarball, takePrefetchedTarball } = await load();
    prefetchTarball("https://r.example/a.tgz");
    prefetchTarball("https://r.example/a.tgz");
    const bytes = await takePrefetchedTarball("https://r.example/a.tgz");
    expect(Array.from(new Uint8Array(bytes!))).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(takePrefetchedTarball("https://r.example/a.tgz")).toBeNull();
    expect(takePrefetchedTarball("https://r.example/other.tgz")).toBeNull();
  });

  it("leaves failed downloads to extraction", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const { prefetchTarball, takePrefetchedTarball } = await load();
    prefetchTarball("https://r.example/missing.tgz");
    expect(await takePrefetchedTarball("https://r.example/missing.tgz")).toBeNull();
  });

  it("lets go of archives the install did not take", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]))));
    const { prefetchTarball, takePrefetchedTarball, releasePrefetchedTarballs } = await load();
    prefetchTarball("https://r.example/kept.tgz");
    prefetchTarball("https://r.example/installed.tgz");
    releasePrefetchedTarballs(["https://r.example/installed.tgz", undefined]);
    expect(takePrefetchedTarball("https://r.example/installed.tgz")).toBeNull();
    expect(await takePrefetchedTarball("https://r.example/kept.tgz")).not.toBeNull();
  });

  it("keeps at most 16 downloads in flight", async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => {
      active++;
      peak = Math.max(peak, active);
      return new Promise<Response>((resolve) => release.push(() => {
        active--;
        resolve(new Response(new Uint8Array([7])));
      }));
    }));
    const { prefetchTarball, takePrefetchedTarball } = await load();
    const urls = Array.from({ length: 40 }, (_, i) => `https://r.example/p${i}.tgz`);
    for (const url of urls) prefetchTarball(url);
    const all = Promise.all(urls.map((url) => takePrefetchedTarball(url)));
    for (let done = 0; done < urls.length; ) {
      await new Promise((r) => setTimeout(r, 0));
      const next = release.shift();
      if (next) {
        next();
        done++;
      }
    }
    expect((await all).every((b) => b && new Uint8Array(b)[0] === 7)).toBe(true);
    expect(peak).toBeLessThanOrEqual(16);
  });
});
