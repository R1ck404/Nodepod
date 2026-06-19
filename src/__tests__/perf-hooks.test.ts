import { describe, it, expect } from "vitest";
import { performance } from "../polyfills/perf_hooks";

describe("perf_hooks", () => {
  it("exposes markResourceTiming for undici", () => {
    expect(typeof performance.markResourceTiming).toBe("function");
    expect(() =>
      performance.markResourceTiming(
        {},
        "http://localhost/",
        "fetch",
        globalThis,
        "",
        {},
        200,
      ),
    ).not.toThrow();
  });
});
