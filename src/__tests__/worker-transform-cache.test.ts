import { describe, it, expect } from "vitest";
import {
  LruTransformCache,
  getWorkerTransformCache,
} from "../threading/worker-transform-cache";

describe("LruTransformCache", () => {
  it("evicts the least recently used entry beyond maxEntries", () => {
    const cache = new LruTransformCache(3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    cache.set("d", "4");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");
    expect(cache.size).toBe(3);
  });

  it("get() refreshes recency and protects an entry from eviction", () => {
    const cache = new LruTransformCache(3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    cache.get("a"); // now b is oldest
    cache.set("d", "4");
    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeUndefined();
  });

  it("byte cap triggers eviction independently of entry count", () => {
    // 100-byte cap = 50 UTF-16 chars
    const cache = new LruTransformCache(1000, 100);
    cache.set("a", "x".repeat(20)); // 40 bytes
    cache.set("b", "y".repeat(20)); // 40 bytes
    cache.set("c", "z".repeat(20)); // 40 bytes -> 120 total, evict a
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.stats().approxBytes).toBeLessThanOrEqual(100);
  });

  it("overwrite replaces byte accounting instead of double counting", () => {
    const cache = new LruTransformCache(10, 1000);
    cache.set("a", "x".repeat(100));
    cache.set("a", "y".repeat(10));
    expect(cache.stats().approxBytes).toBe(20);
    expect(cache.size).toBe(1);
  });

  it("clear() resets entries and bytes", () => {
    const cache = new LruTransformCache();
    cache.set("a", "hello");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.stats().approxBytes).toBe(0);
  });

  it("keeps at least one entry even if it exceeds the byte cap alone", () => {
    const cache = new LruTransformCache(10, 10);
    cache.set("big", "x".repeat(1000));
    expect(cache.get("big")).toBeDefined();
  });

  it("singleton is shared across calls (engines in one realm share transforms)", () => {
    const a = getWorkerTransformCache();
    const b = getWorkerTransformCache();
    expect(a).toBe(b);
    a.set("__test_key__", "value");
    expect(b.get("__test_key__")).toBe("value");
    a.delete("__test_key__");
  });
});
