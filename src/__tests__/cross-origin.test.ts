import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setAllowedDomains,
  setProxy,
  resolveProxyUrl,
  isDomainAllowed,
  proxyUrlForFetch,
  getFetchPolicy,
  applyFetchPolicy,
} from "../cross-origin";
import { RegistryClient } from "../packages/registry-client";
import { ScriptEngine } from "../script-engine";
import { MemoryVolume } from "../memory-volume";

describe("cross-origin allowlist", () => {
  beforeEach(() => {
    setProxy(null);
    setAllowedDomains([]);
    (globalThis as any).localStorage = {
      _store: {} as Record<string, string>,
      getItem(k: string) {
        return this._store[k] ?? null;
      },
      setItem(k: string, v: string) {
        this._store[k] = v;
      },
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows subdomain of a real domain", () => {
    setAllowedDomains(["example.com"]);
    setProxy("https://proxy.test/?url=");
    expect(resolveProxyUrl("https://api.example.com/x")).toContain("proxy.test");
  });

  it("blocks domains not on the allowlist", () => {
    setAllowedDomains(["example.com"]);
    setProxy("https://proxy.test/?url=");
    expect(() => resolveProxyUrl("https://evil.com/x")).toThrow(/Fetch blocked/);
  });

  it("rejects evil.localhost when only localhost is allowed", () => {
    setProxy("https://proxy.test/?url=");
    expect(() => resolveProxyUrl("https://evil.localhost/x")).toThrow(/Fetch blocked/);
  });

  it("allows exact localhost match", () => {
    setProxy("https://proxy.test/?url=");
    expect(resolveProxyUrl("http://localhost/x")).toContain("proxy.test");
  });

  it("allows all when allowlist is null", () => {
    setAllowedDomains(null);
    setProxy("https://proxy.test/?url=");
    expect(resolveProxyUrl("https://anything.example/x")).toContain("proxy.test");
  });

  it("returns url unchanged when no proxy configured", () => {
    expect(resolveProxyUrl("https://example.com/x")).toBe("https://example.com/x");
  });

  it("isDomainAllowed rejects evil.localhost", () => {
    expect(isDomainAllowed("https://evil.localhost/x")).toBe(false);
  });

  it("retries a registry 404 from the configured proxy directly", async () => {
    setAllowedDomains(null);
    setProxy("https://proxy.test/?url=");
    const metadata = {
      name: "react",
      "dist-tags": { latest: "1.0.0" },
      versions: {},
    };
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).startsWith("https://proxy.test/")
        ? new Response("proxy unavailable", { status: 404 })
        : new Response(JSON.stringify(metadata), {
            headers: { "content-type": "application/json" },
          }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new RegistryClient({
      endpoint: "https://registry.example.test",
    });
    await expect(client.fetchManifest("react")).resolves.toEqual(metadata);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://registry.example.test/react",
    );
  });

  it("proxies a script fetch only for cross-origin, allowlisted http(s) targets", () => {
    expect(proxyUrlForFetch("https://github.com/a/b")).toBeNull(); // no proxy

    setProxy("https://proxy.test/?url=");
    setAllowedDomains(["example.com"]);
    expect(proxyUrlForFetch("https://github.com/a/b?x=1")).toBe(
      "https://proxy.test/?url=" + encodeURIComponent("https://github.com/a/b?x=1"),
    );
    // off the allowlist: fetched directly, the browser's CORS rules apply
    expect(proxyUrlForFetch("https://evil.com/x")).toBeNull();
    expect(proxyUrlForFetch("data:text/plain,hi")).toBeNull();
    expect(proxyUrlForFetch("https://proxy.test/?url=x")).toBeNull();

    vi.stubGlobal("location", { origin: "https://github.com" });
    expect(proxyUrlForFetch("https://github.com/a/b")).toBeNull(); // same-origin
  });

  it("hands the host's proxy and allowlist to another realm", () => {
    setProxy("https://proxy.test/?url=");
    setAllowedDomains(["example.com"]);
    const policy = structuredClone(getFetchPolicy());
    expect(policy.proxy).toBe("https://proxy.test/?url=");
    expect(policy.allowedDomains).toContain("example.com");

    setProxy(null);
    setAllowedDomains(null);
    applyFetchPolicy(policy);
    expect(resolveProxyUrl("https://api.example.com/x")).toContain("proxy.test");
    expect(() => resolveProxyUrl("https://evil.com/x")).toThrow(/Fetch blocked/);

    applyFetchPolicy({ proxy: null, allowedDomains: null });
    expect(resolveProxyUrl("https://evil.com/x")).toBe("https://evil.com/x");
  });

  // create-astro verifies its template with fetch(HEAD github.com/...), a page
  // without CORS headers: with a proxy configured, a script's fetch uses it
  it("routes a script's global fetch through the configured proxy", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        seen.push(`${req.method} ${req.url} ${req.headers.get("accept") ?? ""}`);
        return new Response("ok");
      }),
    );
    new ScriptEngine(new MemoryVolume(), { cwd: "/" });

    const target = "https://github.com/withastro/astro/tree/examples/minimal/";
    const proxied = "https://proxy.test/?url=" + encodeURIComponent(target);
    await fetch(target, { method: "HEAD" }); // no proxy yet: direct
    setAllowedDomains(null);
    setProxy("https://proxy.test/?url=");
    await fetch(target, { method: "HEAD", headers: { accept: "application/json" } });
    await fetch(new Request(target, { headers: { accept: "text/html" } }));
    await fetch(new URL(target));

    expect(seen).toEqual([
      `HEAD ${target} `,
      `HEAD ${proxied} application/json`,
      `GET ${proxied} text/html`,
      `GET ${proxied} `,
    ]);
  });
});
