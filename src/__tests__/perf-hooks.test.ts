import { describe, it, expect } from "vitest";
import { performance, installHostPerformanceExtensions } from "../polyfills/perf_hooks";

describe("perf_hooks", () => {
  it("preserves monotonic host time and native mark/measure entries", () => {
    expect(Math.abs(performance.now() - globalThis.performance.now())).toBeLessThan(100);
    expect(performance.timeOrigin).toBe(globalThis.performance.timeOrigin);
    performance.mark("nodepod-perf-start");
    performance.mark("nodepod-perf-end");
    performance.measure("nodepod-perf-measure", "nodepod-perf-start", "nodepod-perf-end");
    expect(performance.getEntriesByName("nodepod-perf-measure")[0].duration).toBeGreaterThanOrEqual(0);
    performance.clearMarks("nodepod-perf-start");
    performance.clearMarks("nodepod-perf-end");
    performance.clearMeasures("nodepod-perf-measure");
  });

  it("retains a host's existing resource timing implementation", () => {
    const before = (globalThis.performance as any).markResourceTiming;
    installHostPerformanceExtensions();
    if (before) expect((globalThis.performance as any).markResourceTiming).toBe(before);
    expect(typeof (globalThis.performance as any).markResourceTiming).toBe("function");
  });
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
