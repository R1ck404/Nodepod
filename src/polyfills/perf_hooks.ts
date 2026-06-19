// perf_hooks polyfill wrapping browser Performance API

export type MarkResourceTimingFn = (
  timingInfo?: unknown,
  requestedUrl?: unknown,
  initiatorType?: unknown,
  global?: unknown,
  cacheMode?: unknown,
  bodyInfo?: unknown,
  responseStatus?: unknown,
  deliveryType?: unknown,
) => void;

function noopMarkResourceTiming(..._args: unknown[]): void {
  // undici calls this after fetch; browsers lack the node extension.
}

type PerfHooksPerformance = Performance & { markResourceTiming: MarkResourceTimingFn };

function createPerformance(): PerfHooksPerformance {
  const base = globalThis.performance;
  const perf = {
    now: () => Date.now(),
    timeOrigin: Date.now(),
    mark: () => {},
    measure: () => {},
    getEntries: () => [] as PerformanceEntry[],
    getEntriesByName: () => [] as PerformanceEntry[],
    getEntriesByType: () => [] as PerformanceEntry[],
    clearMarks: () => {},
    clearMeasures: () => {},
    clearResourceTimings: () => {},
    markResourceTiming: noopMarkResourceTiming,
  } as unknown as PerfHooksPerformance;
  if (base) {
    Object.assign(perf, base);
    perf.markResourceTiming = noopMarkResourceTiming;
  }
  return perf;
}

export const performance: PerfHooksPerformance = createPerformance();


export interface TimingEntryList {
  getEntries(): PerformanceEntry[];
  getEntriesByName(name: string, kind?: string): PerformanceEntry[];
  getEntriesByType(kind: string): PerformanceEntry[];
}

export interface PerformanceObserver {
  observe(cfg: { entryTypes?: string[]; type?: string }): void;
  disconnect(): void;
  takeRecords(): PerformanceEntry[];
}

export const PerformanceObserver = function PerformanceObserver(this: any, fn: (list: TimingEntryList) => void) {
  if (!this) return;
  this._fn = fn;
  this._types = [];
} as unknown as { new(fn: (list: TimingEntryList) => void): PerformanceObserver; prototype: any; supportedEntryTypes: string[] };

PerformanceObserver.supportedEntryTypes = ['mark', 'measure', 'resource', 'navigation'];

PerformanceObserver.prototype.observe = function observe(cfg: { entryTypes?: string[]; type?: string }): void {
  this._types = cfg.entryTypes ?? (cfg.type ? [cfg.type] : []);
};

PerformanceObserver.prototype.disconnect = function disconnect(): void {
  this._types = [];
};

PerformanceObserver.prototype.takeRecords = function takeRecords(): PerformanceEntry[] {
  return [];
};


export interface TimingHistogram {
  min: number;
  max: number;
  mean: number;
  stddev: number;
  percentiles: Map<number, number>;
  exceeds: number;
  reset(): void;
  percentile(p: number): number;
}

export const TimingHistogram = function TimingHistogram(this: any) {
  if (!this) return;
  this.min = 0;
  this.max = 0;
  this.mean = 0;
  this.stddev = 0;
  this.percentiles = new Map<number, number>();
  this.exceeds = 0;
} as unknown as { new(): TimingHistogram; prototype: any };

TimingHistogram.prototype.reset = function reset(): void {
  this.min = 0;
  this.max = 0;
  this.mean = 0;
  this.stddev = 0;
  this.percentiles.clear();
  this.exceeds = 0;
};

TimingHistogram.prototype.percentile = function percentile(p: number): number {
  return this.percentiles.get(p) ?? 0;
};

export function createHistogram(): TimingHistogram {
  return new TimingHistogram();
}

export function monitorEventLoopDelay(
  _opts?: { resolution?: number }
): TimingHistogram {
  return new TimingHistogram();
}


export default {
  performance,
  PerformanceObserver,
  createHistogram,
  monitorEventLoopDelay,
};
