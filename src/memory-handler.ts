// Centralized memory optimization handler for Nodepod.
// Provides LRU caches, heap monitoring, and pressure callbacks.

import type { FileStat } from './memory-volume';

/* ---- LRU Cache ---- */

export class LRUCache<K, V> {
  private _map = new Map<K, V>();
  private _capacity: number;

  constructor(capacity: number) {
    this._capacity = Math.max(1, capacity);
  }

  get(key: K): V | undefined {
    if (!this._map.has(key)) return undefined;
    const value = this._map.get(key)!;
    // Move to most-recently-used position
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this._capacity) {
      // Evict least-recently-used (first entry in Map)
      const oldest = this._map.keys().next().value;
      if (oldest !== undefined) this._map.delete(oldest);
    }
    this._map.set(key, value);
  }

  has(key: K): boolean {
    return this._map.has(key);
  }

  delete(key: K): boolean {
    return this._map.delete(key);
  }

  clear(): void {
    this._map.clear();
  }

  get size(): number {
    return this._map.size;
  }

  keys(): IterableIterator<K> {
    return this._map.keys();
  }

  values(): IterableIterator<V> {
    return this._map.values();
  }
}

/* ---- Options ---- */

export interface MemoryHandlerOptions {
  /** Soft per-pod memory budget in MB. Default: 400. */
  budgetMB?: number;
  /** LRU capacity for path normalization cache. Default: 2048 */
  pathNormCacheSize?: number;
  /** LRU capacity for stat result cache. Default: 512 */
  statCacheSize?: number;
  /** LRU capacity for module resolve cache. Default: 4096 */
  resolveCacheSize?: number;
  /** LRU capacity for package.json manifest cache. Default: 256 */
  manifestCacheSize?: number;
  /** LRU capacity for source transform cache. Default: 512 */
  transformCacheSize?: number;
  /** Max modules before trimming node_modules entries. Default: 512 */
  moduleSoftCacheSize?: number;
  /** Heap usage threshold in MB to trigger pressure callbacks. Default: 350 */
  heapWarnThresholdMB?: number;
  /** Monitoring poll interval in ms. Default: 30000 */
  monitorIntervalMs?: number;
  /** Max process stdout/stderr accumulation in bytes. Default: 4194304 (4MB) */
  maxProcessOutputBytes?: number;
}

const DEFAULTS: Required<MemoryHandlerOptions> = {
  budgetMB: 400,
  pathNormCacheSize: 2048,
  statCacheSize: 512,
  resolveCacheSize: 4096,
  manifestCacheSize: 256,
  transformCacheSize: 512,
  moduleSoftCacheSize: 512,
  heapWarnThresholdMB: 350,
  monitorIntervalMs: 30_000,
  maxProcessOutputBytes: 4_194_304,
};

/* ---- MemoryHandler ---- */

export class MemoryHandler {
  readonly options: Required<MemoryHandlerOptions>;
  readonly pathNormCache: LRUCache<string, string>;
  readonly statCache: LRUCache<string, FileStat>;
  readonly transformCache: LRUCache<string, string>;

  private _monitorTimer: ReturnType<typeof setInterval> | null = null;
  private _pressureCallbacks: Array<() => void> = [];
  private _destroyed = false;

  constructor(opts?: MemoryHandlerOptions) {
    this.options = { ...DEFAULTS, ...opts };
    if (opts?.budgetMB !== undefined && opts.heapWarnThresholdMB === undefined) {
      this.options.heapWarnThresholdMB = Math.floor(opts.budgetMB * 0.875);
    }
    this.pathNormCache = new LRUCache(this.options.pathNormCacheSize);
    this.statCache = new LRUCache(this.options.statCacheSize);
    this.transformCache = new LRUCache(this.options.transformCacheSize);
  }

  /** Invalidate a cached stat entry (call on file write/delete). */
  invalidateStat(normalizedPath: string): void {
    this.statCache.delete(normalizedPath);
  }

  /** Register a callback to be invoked when heap pressure is detected. Returns unsubscribe fn. */
  onPressure(cb: () => void): () => void {
    this._pressureCallbacks.push(cb);
    return () => {
      const idx = this._pressureCallbacks.indexOf(cb);
      if (idx >= 0) this._pressureCallbacks.splice(idx, 1);
    };
  }

  /** Start periodic heap monitoring. */
  startMonitoring(): void {
    if (this._monitorTimer || this._destroyed) return;
    this._monitorTimer = setInterval(() => this._checkHeap(), this.options.monitorIntervalMs);
  }

  /** Stop monitoring. */
  stopMonitoring(): void {
    if (this._monitorTimer) {
      clearInterval(this._monitorTimer);
      this._monitorTimer = null;
    }
  }

  /** Clear all owned caches. */
  flush(): void {
    this.pathNormCache.clear();
    this.statCache.clear();
    this.transformCache.clear();
  }

  /** Full cleanup — stop monitoring, flush caches. */
  destroy(): void {
    this._destroyed = true;
    this.stopMonitoring();
    this.flush();
    this._pressureCallbacks.length = 0;
  }

  private _checkHeap(): void {
    const perf = typeof performance !== 'undefined' ? (performance as any) : null;
    if (!perf?.memory) return;
    const usedMB = perf.memory.usedJSHeapSize / 1_048_576;
    if (usedMB > this.options.heapWarnThresholdMB) {
      for (const cb of this._pressureCallbacks) {
        try { cb(); } catch { /* ignore */ }
      }
    }
  }
}
