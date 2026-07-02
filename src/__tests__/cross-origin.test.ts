import { describe, it, expect, beforeEach } from "vitest";
import {
  setAllowedDomains,
  setProxy,
  resolveProxyUrl,
  isDomainAllowed,
} from "../cross-origin";

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
});
