// Bounded LRU for transformed module source, shared by every ScriptEngine
// created in the same realm (worker or main). Without this, engines created
// without a MemoryHandler fall back to an unbounded Map that grows for the
// lifetime of the worker.

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024; // UTF-16 estimate: value.length * 2

export class LruTransformCache {
  private _map = new Map<string, string>();
  private _bytes = 0;
  private readonly _maxEntries: number;
  private readonly _maxBytes: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES) {
    this._maxEntries = maxEntries;
    this._maxBytes = maxBytes;
  }

  get(key: string): string | undefined {
    const value = this._map.get(key);
    if (value === undefined) return undefined;
    // refresh recency
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key: string, value: string): this {
    const existing = this._map.get(key);
    if (existing !== undefined) {
      this._bytes -= existing.length * 2;
      this._map.delete(key);
    }
    this._map.set(key, value);
    this._bytes += value.length * 2;
    this._evict();
    return this;
  }

  has(key: string): boolean {
    return this._map.has(key);
  }

  delete(key: string): boolean {
    const existing = this._map.get(key);
    if (existing === undefined) return false;
    this._bytes -= existing.length * 2;
    return this._map.delete(key);
  }

  clear(): void {
    this._map.clear();
    this._bytes = 0;
  }

  get size(): number {
    return this._map.size;
  }

  stats(): { entries: number; approxBytes: number } {
    return { entries: this._map.size, approxBytes: this._bytes };
  }

  private _evict(): void {
    while (
      this._map.size > this._maxEntries ||
      (this._bytes > this._maxBytes && this._map.size > 1)
    ) {
      const oldest = this._map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const value = this._map.get(oldest)!;
      this._bytes -= value.length * 2;
      this._map.delete(oldest);
    }
  }
}

let singleton: LruTransformCache | null = null;

// One cache per realm — exactly the scope we want: all ScriptEngines inside
// one process worker (or the main thread fallback path) share transforms.
export function getWorkerTransformCache(): LruTransformCache {
  if (!singleton) singleton = new LruTransformCache();
  return singleton;
}
