import { describe, expect, it, vi } from "vitest";
import { PerformanceTracker } from "../performance-tracker";

describe("PerformanceTracker", () => {
  it("records concurrent spans independently", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(10).mockReturnValueOnce(20)
      .mockReturnValueOnce(35).mockReturnValueOnce(60);

    const tracker = new PerformanceTracker();
    const stopA = tracker.start("work");
    const stopB = tracker.start("work");
    stopA();
    stopB();

    expect(tracker.snapshot().timings.work).toEqual({
      count: 2,
      totalMs: 65,
      lastMs: 40,
      minMs: 25,
      maxMs: 40,
    });
    now.mockRestore();
  });

  it("stops a span only once and snapshots counters", () => {
    const tracker = new PerformanceTracker();
    const stop = tracker.start("boot");
    stop();
    stop();
    tracker.increment("cacheHits");
    tracker.increment("cacheHits", 2);

    expect(tracker.snapshot().timings.boot.count).toBe(1);
    expect(tracker.snapshot().counters.cacheHits).toBe(3);
  });
});
