import type {
  NodepodProfileReport,
  ProfileAggregate,
  ProfileCategory,
  ProfileEnvironment,
  ProfileLongTaskSample,
  ProfileMemorySample,
  ProfileSample,
  ProfileSession,
  ProfileSpan,
  ProfileSpanOptions,
  ProfileSummary,
  ProfileWarning,
  ProfilerLevel,
  ProfilerOptions,
  NodepodProfiler as NodepodProfilerApi,
} from "./types.js";

const DEFAULT_MAX_SPANS = 100_000;
const DEFAULT_MAX_SAMPLES = 10_000;
const DEFAULT_SLOW_THRESHOLD_MS = 50;
const DEFAULT_MEMORY_INTERVAL_MS = 500;
const MAX_METRIC_KEYS = 1024;
const MAX_METADATA_KEYS = 32;
const MAX_WARNINGS = 100;
const HISTOGRAM_BUCKETS = [
  0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, Infinity,
];
const PROFILE_CATEGORIES: ProfileCategory[] = [
  "boot",
  "packages",
  "filesystem",
  "modules",
  "workers",
  "processes",
  "snapshots",
  "http",
  "browser",
];

export interface ProfileSpanToken {
  readonly id: number;
  readonly startedAt: number;
  readonly name: string;
  readonly category: ProfileCategory;
  readonly thread: string;
  readonly processId?: number;
  readonly parentId?: number;
  readonly metadata?: Record<string, string | number | boolean>;
  ended?: boolean;
}

export type ProfileMemoryProvider = () => Record<string, unknown>;

export function profileTimestamp(): number {
  const perf = typeof performance !== "undefined" ? performance : undefined;
  if (perf && typeof perf.now === "function") {
    const now = perf.now();
    const origin =
      typeof perf.timeOrigin === "number" ? perf.timeOrigin : Date.now() - now;
    return origin + now;
  }
  return Date.now();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function boundedOption(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function hostKind(): ProfileEnvironment["host"] {
  if (typeof window !== "undefined") return "browser";
  if (typeof process !== "undefined" && process.versions?.node) return "node";
  return "unknown";
}

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function stableHash(value: string, salt = ""): string {
  let hash = 0x811c9dc5;
  const input = `${salt}:${value}`;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || "/";
}

function sanitizeMetadata(
  metadata: ProfileSpanOptions["metadata"],
  options: Required<Pick<ProfilerOptions, "pathDetail" | "includeUrls">>,
  hashSalt = "",
): Record<string, string | number | boolean> | undefined {
  if (!metadata) return undefined;
  const result: Record<string, string | number | boolean> = {};

  for (const [key, raw] of Object.entries(metadata)) {
    if (Object.keys(result).length >= MAX_METADATA_KEYS) break;
    if (raw === undefined) continue;
    const lower = key.toLowerCase();
    const isUrl = lower.includes("url");
    const isPath = lower.includes("path") || lower === "file" || lower.endsWith("file");

    if (isUrl) {
      if (!options.includeUrls || typeof raw !== "string") continue;
      result[key] = raw.split(/[?#]/, 1)[0].slice(0, 512);
      continue;
    }

    if (isPath && typeof raw === "string") {
      if (options.pathDetail === "none") continue;
      if (options.pathDetail === "basename") {
        result[key] = basename(raw);
      } else if (options.pathDetail === "hash") {
        result[key] = stableHash(raw, hashSalt);
      } else {
        result[key] = raw.slice(0, 1024);
      }
      continue;
    }

    if (typeof raw === "string") {
      result[key] = raw.slice(0, 512);
    } else {
      result[key] = raw;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

class AggregateBuilder {
  count = 0;
  totalMs = 0;
  minMs = Infinity;
  maxMs = 0;
  private readonly buckets = new Array(HISTOGRAM_BUCKETS.length).fill(0);

  record(durationMs: number): void {
    const value = Math.max(0, durationMs);
    this.count++;
    this.totalMs += value;
    this.minMs = Math.min(this.minMs, value);
    this.maxMs = Math.max(this.maxMs, value);
    const index = HISTOGRAM_BUCKETS.findIndex((bucket) => value <= bucket);
    this.buckets[index === -1 ? this.buckets.length - 1 : index]++;
  }

  percentile(fraction: number): number {
    if (this.count === 0) return 0;
    const target = Math.max(1, Math.ceil(this.count * fraction));
    let cumulative = 0;
    for (let index = 0; index < this.buckets.length; index++) {
      cumulative += this.buckets[index];
      if (cumulative >= target) return HISTOGRAM_BUCKETS[index];
    }
    return this.maxMs;
  }

  snapshot(): ProfileAggregate {
    return {
      count: this.count,
      totalMs: round(this.totalMs),
      minMs: this.count === 0 ? 0 : round(this.minMs),
      maxMs: round(this.maxMs),
      p50Ms: round(this.percentile(0.5)),
      p95Ms: round(this.percentile(0.95)),
      p99Ms: round(this.percentile(0.99)),
    };
  }
}

interface InternalSession extends ProfileSession {
  begin(name: string, options?: ProfileSpanOptions): ProfileSpanToken | null;
  end(token: ProfileSpanToken | null): number;
  recordSpan(name: string, startedAt: number, endedAt: number, options?: ProfileSpanOptions): void;
  count(name: string, amount?: number): void;
  gauge(name: string, value: number): void;
  sample(sample: ProfileSample): void;
  warning(code: string, message: string): void;
  addMemorySample(): Promise<void>;
  addLongTask(startTime: number, durationMs: number, name?: string): void;
}

class ProfileSessionImpl implements InternalSession {
  readonly id: string;
  readonly startedAt: number;
  private readonly profiler: NodepodProfilerImpl;
  private readonly options: Required<ProfilerOptions>;
  private readonly nameValue: string;
  private readonly spansById = new Map<number, ProfileSpan>();
  private readonly spanAggregates = new Map<string, AggregateBuilder>();
  private readonly categoryAggregates = new Map<ProfileCategory, AggregateBuilder>();
  private readonly countersMap = new Map<string, number>();
  private readonly gaugesMap = new Map<string, number>();
  private readonly sampleList: ProfileSample[] = [];
  private readonly warningList: ProfileWarning[] = [];
  private readonly memorySamples: ProfileMemorySample[] = [];
  private readonly hashSalt = makeId("path");
  private nextSpanId = 1;
  private droppedSpansValue = 0;
  private droppedSamplesValue = 0;
  private busyDurationMs = 0;
  private longTaskCount = 0;
  private longTaskTotalMs = 0;
  private longTaskLongestMs = 0;
  private droppedMetricKeys = 0;
  private memoryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly memorySamplePromises = new Set<Promise<void>>();
  private memoryCapabilityWarningIssued = false;
  private memorySampleWarningIssued = false;
  private observer: PerformanceObserver | null = null;
  private stopping: Promise<NodepodProfileReport> | null = null;
  private reportValue: NodepodProfileReport | null = null;

  constructor(profiler: NodepodProfilerImpl, name: string) {
    this.profiler = profiler;
    this.nameValue = name;
    this.id = makeId("profile");
    this.startedAt = profileTimestamp();
    this.options = profiler.options;
    if (profiler.enabled) this.startObservers();
  }

  get name(): string {
    return this.nameValue;
  }

  private startObservers(): void {
    if (this.options.captureLongTasks && typeof PerformanceObserver !== "undefined") {
      try {
        this.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this.addLongTask(
              (performance.timeOrigin || this.startedAt) + entry.startTime,
              entry.duration,
              entry.name,
            );
          }
        });
        this.observer.observe({ type: "longtask", buffered: true });
      } catch {
        this.warning("long-task-unsupported", "Long-task observation is unavailable in this environment.");
      }
    } else if (this.options.captureLongTasks) {
      this.warning("long-task-unsupported", "Long-task observation is unavailable in this environment.");
    }

    if (this.options.captureMemory) {
      this.scheduleMemorySample();
      this.memoryTimer = setInterval(() => {
        this.scheduleMemorySample();
      }, this.options.memorySampleIntervalMs);
      const unref = (this.memoryTimer as unknown as { unref?: () => void }).unref;
      unref?.call(this.memoryTimer);
    }
  }

  private scheduleMemorySample(): void {
    const promise = this.addMemorySample();
    this.memorySamplePromises.add(promise);
    void promise.then(
      () => this.memorySamplePromises.delete(promise),
      () => this.memorySamplePromises.delete(promise),
    );
  }

  begin(name: string, options: ProfileSpanOptions = {}): ProfileSpanToken | null {
    if (this.options.level === "counters") return null;
    const category = options.category ?? "filesystem";
    const startedAt = profileTimestamp();
    return {
      id: this.nextSpanId++,
      startedAt,
      name,
      category,
      thread: options.thread ?? "main",
      processId: options.processId,
      parentId: options.parentId,
      metadata: sanitizeMetadata(options.metadata, this.options, this.hashSalt),
    };
  }

  end(token: ProfileSpanToken | null): number {
    if (!token || token.ended) return 0;
    token.ended = true;
    const durationMs = Math.max(0, profileTimestamp() - token.startedAt);
    this.recordCompletedSpan(token, durationMs);
    return durationMs;
  }

  recordSpan(
    name: string,
    startedAt: number,
    endedAt: number,
    options: ProfileSpanOptions = {},
  ): void {
    if (this.options.level === "counters") return;
    if (endedAt < startedAt) {
      this.warning(
        "clock-skew",
        `The ${name} span ended before it started; its duration was clamped to zero.`,
      );
    }
    const token: ProfileSpanToken = {
      id: this.nextSpanId++,
      startedAt,
      name,
      category: options.category ?? "workers",
      thread: options.thread ?? "main",
      processId: options.processId,
      parentId: options.parentId,
      metadata: sanitizeMetadata(options.metadata, this.options, this.hashSalt),
      ended: true,
    };
    this.recordCompletedSpan(token, Math.max(0, endedAt - startedAt));
  }

  private recordCompletedSpan(token: ProfileSpanToken, durationMs: number): void {
    this.busyDurationMs += durationMs;

    const aggregateKey = `${token.category}:${token.name}`;
    const operationAggregate = this.spanAggregates.get(aggregateKey) ?? new AggregateBuilder();
    operationAggregate.record(durationMs);
    this.spanAggregates.set(aggregateKey, operationAggregate);

    const categoryAggregate = this.categoryAggregates.get(token.category) ?? new AggregateBuilder();
    categoryAggregate.record(durationMs);
    this.categoryAggregates.set(token.category, categoryAggregate);

    const span: ProfileSpan = {
      id: token.id,
      parentId: token.parentId,
      name: token.name,
      category: token.category,
      startTime: token.startedAt,
      durationMs: round(durationMs),
      thread: token.thread,
      processId: token.processId,
      metadata: token.metadata,
    };

    if (this.spansById.size < this.options.maxSpans) {
      this.spansById.set(span.id, span);
    } else {
      const fastest = [...this.spansById.values()].reduce((best, candidate) =>
        candidate.durationMs < best.durationMs ? candidate : best,
      );
      if (durationMs >= this.options.slowSpanThresholdMs && durationMs > fastest.durationMs) {
        this.spansById.delete(fastest.id);
        this.spansById.set(span.id, span);
        this.droppedSpansValue++;
      } else {
        this.droppedSpansValue++;
      }
    }
  }

  count(name: string, amount = 1): void {
    if (!this.countersMap.has(name) && this.countersMap.size >= MAX_METRIC_KEYS) {
      this.droppedMetricKeys++;
      return;
    }
    this.countersMap.set(name, (this.countersMap.get(name) ?? 0) + amount);
  }

  gauge(name: string, value: number): void {
    if (!this.gaugesMap.has(name) && this.gaugesMap.size >= MAX_METRIC_KEYS) {
      this.droppedMetricKeys++;
      return;
    }
    this.gaugesMap.set(name, value);
  }

  sample(sample: ProfileSample): void {
    if (this.sampleList.length >= this.options.maxSamples) {
      this.droppedSamplesValue++;
      return;
    }
    this.sampleList.push(sample);
    if (sample.type === "memory") this.memorySamples.push(sample);
  }

  warning(code: string, message: string): void {
    if (this.warningList.length >= MAX_WARNINGS) return;
    this.warningList.push({ code, message, timestamp: profileTimestamp() });
  }

  addLongTask(startTime: number, durationMs: number, name?: string): void {
    const overlapSpanIds = [...this.spansById.values()]
      .filter((span) => span.startTime < startTime + durationMs && span.startTime + span.durationMs > startTime)
      .map((span) => span.id);
    const sample: ProfileLongTaskSample = {
      type: "long-task",
      timestamp: startTime,
      durationMs: round(durationMs),
      name,
      overlapSpanIds: overlapSpanIds.length > 0 ? overlapSpanIds : undefined,
    };
    this.longTaskCount++;
    this.longTaskTotalMs += durationMs;
    this.longTaskLongestMs = Math.max(this.longTaskLongestMs, durationMs);
    this.sample(sample);
  }

  async addMemorySample(): Promise<void> {
    const timestamp = profileTimestamp();
    let deterministic: Record<string, unknown> = {};
    try {
      deterministic = this.profiler.memoryProvider?.() ?? {};
    } catch {
      this.warning("memory-provider-failed", "The deterministic memory provider failed and was omitted.");
    }
    const sample: ProfileMemorySample = { type: "memory", timestamp, deterministic };
    const perf = typeof performance !== "undefined" ? (performance as any) : null;
    try {
      if (typeof perf?.measureUserAgentSpecificMemory === "function") {
        const measurement = await perf.measureUserAgentSpecificMemory();
        sample.browserHeap = {
          bytes: Number(measurement.bytes),
          source: "measureUserAgentSpecificMemory",
          confidence: "estimated",
        };
    } else if (perf?.memory) {
        sample.browserHeap = {
          usedBytes: Number(perf.memory.usedJSHeapSize),
          totalBytes: Number(perf.memory.totalJSHeapSize),
          limitBytes: Number(perf.memory.jsHeapSizeLimit),
          source: "performance.memory",
          confidence: "estimated",
        };
      } else {
        if (!this.memoryCapabilityWarningIssued) {
          this.warning(
            "memory-browser-api-unsupported",
            "No browser heap measurement API is available; deterministic Nodepod memory data was retained.",
          );
          this.memoryCapabilityWarningIssued = true;
        }
      }
    } catch {
      if (perf?.memory) {
        sample.browserHeap = {
          usedBytes: Number(perf.memory.usedJSHeapSize),
          totalBytes: Number(perf.memory.totalJSHeapSize),
          limitBytes: Number(perf.memory.jsHeapSizeLimit),
          source: "performance.memory",
          confidence: "estimated",
        };
      } else if (!this.memorySampleWarningIssued) {
        this.warning("memory-sample-failed", "The browser memory measurement failed and was omitted.");
        this.memorySampleWarningIssued = true;
      }
    }
    this.sample(sample);
  }

  async stop(): Promise<NodepodProfileReport> {
    if (this.reportValue) return this.reportValue;
    if (this.stopping) return this.stopping;
    this.stopping = this.finish();
    return this.stopping;
  }

  private async finish(): Promise<NodepodProfileReport> {
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer);
      this.memoryTimer = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    if (this.options.captureMemory && this.profiler.enabled) {
      await Promise.allSettled([...this.memorySamplePromises]);
      await this.addMemorySample();
    }

    const finishedAt = profileTimestamp();
    if (this.droppedMetricKeys > 0) {
      this.warning(
        "metric-key-limit",
        `${this.droppedMetricKeys} metric updates were dropped after the metric-key limit was reached.`,
      );
    }
    const categories = {} as Record<ProfileCategory, ProfileAggregate>;
    for (const category of PROFILE_CATEGORIES) {
      categories[category] = (this.categoryAggregates.get(category) ?? new AggregateBuilder()).snapshot();
    }
    const operations: Record<string, ProfileAggregate> = {};
    for (const [name, aggregate] of this.spanAggregates) {
      operations[name] = aggregate.snapshot();
    }
    const spans = [...this.spansById.values()].sort((a, b) => a.startTime - b.startTime);
    const peakMemory = this.memorySamples.reduce<ProfileMemorySample | undefined>((peak, sample) => {
      const currentBytes = sample.browserHeap?.bytes ?? sample.browserHeap?.usedBytes ?? 0;
      const peakBytes = peak?.browserHeap?.bytes ?? peak?.browserHeap?.usedBytes ?? 0;
      return currentBytes > peakBytes ? sample : peak;
    }, undefined);

    const report = createReport({
      id: this.id,
      name: this.nameValue,
      startedAt: this.startedAt,
      durationMs: Math.max(0, finishedAt - this.startedAt),
      environment: this.profiler.environment,
      summary: {
        wallDurationMs: round(Math.max(0, finishedAt - this.startedAt)),
        instrumentedBusyDurationMs: round(this.busyDurationMs),
        categories,
        operations,
        topSpans: [...spans].sort((a, b) => b.durationMs - a.durationMs).slice(0, 20),
        droppedSpans: this.droppedSpansValue,
        droppedSamples: this.droppedSamplesValue,
        longTasks: {
          count: this.longTaskCount,
          totalMs: round(this.longTaskTotalMs),
          longestMs: round(this.longTaskLongestMs),
        },
        peakMemory,
      },
      spans,
      counters: Object.fromEntries(this.countersMap),
      gauges: Object.fromEntries(this.gaugesMap),
      samples: this.sampleList,
      warnings: this.warningList,
    });
    this.reportValue = report;
    this.profiler.finish(this);
    return report;
  }
}

interface ReportData {
  id: string;
  name: string;
  startedAt: number;
  durationMs: number;
  environment: ProfileEnvironment;
  summary: ProfileSummary;
  spans: ProfileSpan[];
  counters: Record<string, number>;
  gauges: Record<string, number>;
  samples: ProfileSample[];
  warnings: ProfileWarning[];
}

function createReport(data: ReportData): NodepodProfileReport {
  const serializable = {
    version: 1 as const,
    ...data,
  };
  return Object.freeze({
    ...serializable,
    spans: Object.freeze([...data.spans]),
    samples: Object.freeze([...data.samples]),
    warnings: Object.freeze([...data.warnings]),
    export(format: "json" | "chrome-trace"): string {
      if (format === "json") return JSON.stringify(serializable, null, 2);
      const base = data.startedAt;
      const traceEvents: Array<Record<string, unknown>> = data.spans.map((span) => ({
        name: span.name,
        cat: `nodepod.${span.category}`,
        ph: "X",
        ts: Math.round((span.startTime - base) * 1000),
        dur: Math.round(span.durationMs * 1000),
        pid: span.processId ?? 1,
        tid: span.thread,
        args: span.metadata ?? {},
      }));
      for (const sample of data.samples) {
        if (sample.type === "long-task") {
          traceEvents.push({
            name: sample.name ?? "browser.long-task",
            cat: "nodepod.browser",
            ph: "X",
            ts: Math.round((sample.timestamp - base) * 1000),
            dur: Math.round(sample.durationMs * 1000),
            pid: 1,
            tid: "main",
            args: { overlapSpanIds: sample.overlapSpanIds ?? [] },
          });
        }
      }
      for (const [name, value] of Object.entries(data.gauges)) {
        traceEvents.push({
          name: `nodepod.gauge.${name}`,
          cat: "nodepod.metrics",
          ph: "C",
          ts: Math.round((data.startedAt - base) * 1000),
          pid: 1,
          tid: "main",
          args: { [name]: value },
        });
      }
      for (const warning of data.warnings) {
        traceEvents.push({
          name: warning.code,
          cat: "nodepod.warning",
          ph: "i",
          s: "t",
          ts: Math.round(((warning.timestamp ?? data.startedAt) - base) * 1000),
          pid: 1,
          tid: "main",
          args: { message: warning.message },
        });
      }
      return JSON.stringify({ traceEvents }, null, 2);
    },
  });
}

export class NodepodProfilerImpl implements NodepodProfilerApi {
  readonly enabled: boolean;
  readonly level: ProfilerLevel;
  readonly options: Required<ProfilerOptions>;
  readonly environment: ProfileEnvironment;
  memoryProvider: ProfileMemoryProvider | null = null;
  private active: ProfileSessionImpl | null = null;

  constructor(options: ProfilerOptions = {}) {
    this.enabled = options.enabled === true;
    this.level = options.level ?? "timings";
    this.options = {
      enabled: this.enabled,
      level: this.level,
      maxSpans: boundedOption(options.maxSpans, DEFAULT_MAX_SPANS, 1, 1_000_000),
      maxSamples: boundedOption(options.maxSamples, DEFAULT_MAX_SAMPLES, 1, 100_000),
      slowSpanThresholdMs: boundedOption(options.slowSpanThresholdMs, DEFAULT_SLOW_THRESHOLD_MS, 0, 60_000),
      memorySampleIntervalMs: boundedOption(options.memorySampleIntervalMs, DEFAULT_MEMORY_INTERVAL_MS, 50, 60_000),
      captureMemory: options.captureMemory === true,
      captureLongTasks: options.captureLongTasks === true,
      pathDetail: options.pathDetail ?? "basename",
      includeUrls: options.includeUrls === true,
    };
    this.environment = {
      host: hostKind(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      hardwareConcurrency: typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined,
      crossOriginIsolated: typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : undefined,
      sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
      level: this.level,
    };
  }

  setMemoryProvider(provider: ProfileMemoryProvider | null): void {
    this.memoryProvider = provider;
  }

  start(name: string): ProfileSession {
    if (this.active) throw new Error("Nodepod profiler already has an active session");
    const session = new ProfileSessionImpl(this, name);
    this.active = session;
    if (!this.enabled) session.warning("profiler-disabled", "Profiling is disabled; this session contains no instrumentation data.");
    else if (this.level !== "counters") session.warning("busy-duration-overlap", "Instrumented busy durations may overlap and must not be interpreted as CPU time.");
    if (this.options.pathDetail === "full") session.warning("unredacted-paths", "This report may contain unredacted file paths.");
    return session;
  }

  profile<T>(name: string, operation: () => T | Promise<T>): Promise<{ result: T; report: NodepodProfileReport }> {
    const session = this.start(name);
    return Promise.resolve()
      .then(operation)
      .then(async (result) => ({ result, report: await session.stop() }))
      .finally(async () => {
        await session.stop();
      });
  }

  begin(name: string, options?: ProfileSpanOptions): ProfileSpanToken | null {
    return this.active && this.enabled ? this.active.begin(name, options) : null;
  }

  end(token: ProfileSpanToken | null): number {
    return this.active && this.enabled ? this.active.end(token) : 0;
  }

  recordSpan(
    name: string,
    startedAt: number,
    endedAt: number,
    options?: ProfileSpanOptions,
  ): void {
    if (this.active && this.enabled) {
      this.active.recordSpan(name, startedAt, endedAt, options);
    }
  }

  count(name: string, amount = 1): void {
    if (this.active && this.enabled) this.active.count(name, amount);
  }

  gauge(name: string, value: number): void {
    if (this.active && this.enabled) this.active.gauge(name, value);
  }

  sample(sample: ProfileSample): void {
    if (this.active && this.enabled) this.active.sample(sample);
  }

  finish(session: ProfileSessionImpl): void {
    if (this.active === session) this.active = null;
  }
}

export type NodepodProfiler = NodepodProfilerImpl;
