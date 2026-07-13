import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryClient } from "../packages/registry-client";

describe("RegistryClient cache coordination", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("coalesces concurrent metadata requests across clients", async () => {
    const metadata = {
      name: "pkg",
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name: "pkg",
          version: "1.0.0",
          dist: { tarball: "https://example.test/pkg.tgz", shasum: "abc" },
        },
      },
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(metadata), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const endpoint = `https://registry-${Date.now()}.example.test`;
    const first = new RegistryClient({ endpoint });
    const second = new RegistryClient({ endpoint });

    const [a, b] = await Promise.all([
      first.fetchManifest("pkg"),
      second.fetchManifest("pkg"),
    ]);

    expect(a).toEqual(metadata);
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
