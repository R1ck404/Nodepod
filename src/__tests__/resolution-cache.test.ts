import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearResolutionMemoryCache,
  resolveWithCache,
} from "../packages/resolution-cache";

describe("resolution graph cache", () => {
  beforeEach(() => {
    clearResolutionMemoryCache();
    vi.stubGlobal("caches", undefined);
  });

  it("coalesces concurrent resolution and returns isolated maps", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resolver = vi.fn(async () => {
      await gate;
      return new Map([["pkg", {
        name: "pkg",
        version: "1.0.0",
        tarballUrl: "https://example.test/pkg.tgz",
        dependencies: { dep: "^1" },
      }]]);
    });

    const first = resolveWithCache("same", resolver);
    const second = resolveWithCache("same", resolver);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(a.hit).toBe(false);
    expect(b.hit).toBe(true);
    a.tree.get("pkg")!.dependencies.dep = "changed";
    expect(b.tree.get("pkg")!.dependencies.dep).toBe("^1");
  });

  it("serves later resolutions from memory", async () => {
    const resolver = vi.fn(async () => new Map());
    await resolveWithCache("cached", resolver);
    const result = await resolveWithCache("cached", resolver);
    expect(result.hit).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});
