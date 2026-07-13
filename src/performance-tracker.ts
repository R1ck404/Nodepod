export interface PerformanceTiming {
  count: number;
  totalMs: number;
  lastMs: number;
  minMs: number;
  maxMs: number;
}

export interface PerformanceStats {
  timings: Record<string, PerformanceTiming>;
  counters: Record<string, number>;
}

function now(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export class PerformanceTracker {
  private readonly timings = new Map<string, PerformanceTiming>();
  private readonly counters = new Map<string, number>();

  start(name: string): () => number {
    const startedAt = now();
    let stopped = false;
    return () => {
      if (stopped) return 0;
      stopped = true;
      const elapsed = Math.max(0, now() - startedAt);
      this.record(name, elapsed);
      return elapsed;
    };
  }

  record(name: string, durationMs: number): void {
    const value = Math.max(0, durationMs);
    const current = this.timings.get(name);
    if (!current) {
      this.timings.set(name, {
        count: 1,
        totalMs: value,
        lastMs: value,
        minMs: value,
        maxMs: value,
      });
      return;
    }
    current.count++;
    current.totalMs += value;
    current.lastMs = value;
    current.minMs = Math.min(current.minMs, value);
    current.maxMs = Math.max(current.maxMs, value);
  }

  increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  snapshot(): PerformanceStats {
    const timings: Record<string, PerformanceTiming> = {};
    for (const [name, timing] of this.timings) {
      timings[name] = {
        count: timing.count,
        totalMs: round(timing.totalMs),
        lastMs: round(timing.lastMs),
        minMs: round(timing.minMs),
        maxMs: round(timing.maxMs),
      };
    }
    return {
      timings,
      counters: Object.fromEntries(this.counters),
    };
  }

  clear(): void {
    this.timings.clear();
    this.counters.clear();
  }
}
