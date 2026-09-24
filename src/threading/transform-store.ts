// Main-thread store of module transforms (TypeScript stripping, ESM->CJS
// conversion) shared by every process worker and persisted across sessions.
//
// Transforms are grouped into packs, one per installed package version: a
// worker that loads its first module from a package fetches the whole pack
// in one synchronous round trip, then converts nothing it finds there. New
// conversions flow back asynchronously and are written to IndexedDB in the
// background, so the next process (a `vite build` after `vite`, a restarted
// dev server) and the next page load skip the parse-and-rewrite work.
//
// Pack entries are keyed by package-relative path + source length + digest,
// and pack scopes carry a digest of the transform code itself (computed by
// the worker), so edited files and new transform logic simply miss.
//
// This thread never parses or serializes entries: it also answers every lazy
// filesystem read, and a multi-MB JSON round trip here stalled page loads. A
// pack is kept as JSON array texts (segments) exactly as the workers sent
// them and as IndexedDB stores them; adding transforms appends a segment,
// and a pack's segments are joined into one array text when it is read or
// written. A key put twice carries the same content (the key includes its
// digest) and readers keep the last one.

const DB_NAME = "nodepod-transforms";
const STORE_NAME = "packs";
// per scope: when it was last written and how big it is, so the index can
// expire and trim packs without reading them
const META_STORE = "meta";
const DB_VERSION = 2;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// persisted packs beyond this total are dropped, least recently written
// first (a new nodepod build or package version starts new scopes)
const DB_BUDGET_CHARS = 64 * 1024 * 1024;
// packs kept in memory; the rest are re-read from IndexedDB on demand
const MEMORY_BUDGET_CHARS = 12 * 1024 * 1024;
const FLUSH_DELAY_MS = 1500;
// persisted packs leave memory after this long without a request or put;
// IndexedDB serves the next process that needs them
const IDLE_RELEASE_MS = 10_000;

/** [key, code, flags]; flags bit 0 = top-level await, bit 1 = lexer fast path */
export type TransformEntry = [key: string, code: string, flags: number];

interface Pack {
  // JSON array texts, joined lazily
  segments: string[];
  chars: number;
}

function isArrayText(text: unknown): text is string {
  return typeof text === "string" && text.length >= 2 && text[0] === "[" && text[text.length - 1] === "]";
}

// one JSON array text holding every segment's entries
function packText(pack: Pack): string {
  if (pack.segments.length === 0) return "[]";
  if (pack.segments.length > 1) {
    const inner: string[] = [];
    for (const segment of pack.segments) {
      if (segment.length > 2) inner.push(segment.slice(1, -1));
    }
    pack.segments = ["[" + inner.join(",") + "]"];
  }
  return pack.segments[0];
}

interface PackRecord {
  text: string;
  updatedAt: number;
}

interface PackMeta {
  updatedAt: number;
  chars: number;
}

function openDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
        // packs from before the meta store can't be expired or trimmed:
        // start over (they are only a cache)
        if (event.oldVersion > 0 && event.oldVersion < 2) req.transaction?.objectStore(STORE_NAME).clear();
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export class SharedTransformStore {
  private _packs = new Map<string, Pack>(); // insertion order = recency
  private _chars = 0;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _db: Promise<IDBDatabase | null> | null = null;
  private _loading = new Map<string, Promise<Pack>>();
  // scopes that have (or will have) a pack: in memory or in IndexedDB
  private _known = new Set<string>();
  private _indexLoad: Promise<void> | null = null;
  private _indexLoaded = false;
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  // segments for packs not loaded yet (merged once they are)
  private _queued = new Map<string, string[]>();
  // packs holding segments not written to IndexedDB yet
  private _dirty = new Set<string>();
  private _flushing: Promise<void> | null = null;

  constructor(private readonly _persist = true) {}

  /**
   * Read the scopes of persisted packs, once, dropping expired ones and the
   * least recently written beyond the storage budget.
   */
  loadIndex(): Promise<void> {
    if (!this._indexLoad) {
      this._indexLoad = (async () => {
        try {
          if (!this._persist) return;
          const db = await this._openDb();
          if (!db) return;
          const tx = db.transaction([STORE_NAME, META_STORE], "readwrite");
          const meta = tx.objectStore(META_STORE);
          const packs = tx.objectStore(STORE_NAME);
          const [keys, metas] = await Promise.all([
            idbRequest(meta.getAllKeys()),
            idbRequest(meta.getAll() as IDBRequest<PackMeta[]>),
          ]);
          const now = Date.now();
          const live: Array<{ scope: string; updatedAt: number; chars: number }> = [];
          (keys ?? []).forEach((key, i) => {
            const m = metas?.[i];
            if (typeof key !== "string" || !m) return;
            if (now - (m.updatedAt || 0) > MAX_AGE_MS) {
              meta.delete(key);
              packs.delete(key);
            } else {
              live.push({ scope: key, updatedAt: m.updatedAt, chars: m.chars || 0 });
            }
          });
          live.sort((a, b) => b.updatedAt - a.updatedAt);
          let total = 0;
          for (const entry of live) {
            total += entry.chars;
            if (total > DB_BUDGET_CHARS) {
              meta.delete(entry.scope);
              packs.delete(entry.scope);
            } else {
              this._known.add(entry.scope);
            }
          }
        } catch {
          /* no index: workers just convert */
        } finally {
          this._indexLoaded = true;
        }
      })();
    }
    return this._indexLoad;
  }

  /** Whether knownScopes() is complete (the index has been read). */
  get indexLoaded(): boolean {
    return this._indexLoaded || !this._persist;
  }

  /**
   * Scopes a worker should ask for. Workers skip the round trip for any
   * other package, so a cold cache costs nothing.
   */
  knownScopes(): string[] {
    return [...this._known];
  }

  /** Serialized entries of a pack (JSON array of TransformEntry), "[]" if empty. */
  async packText(scope: string): Promise<string> {
    this._scheduleIdleRelease();
    return packText(await this._pack(scope));
  }

  /**
   * Add transforms to a pack: a JSON array text of TransformEntry (as
   * workers send them) or the entries themselves.
   */
  put(scope: string, batch: string | TransformEntry[]): void {
    const text = typeof batch === "string" ? batch : JSON.stringify(batch);
    if (!isArrayText(text) || text.length <= 2) return;
    this._known.add(scope);
    const pack = this._packs.get(scope);
    if (pack) {
      this._append(scope, pack, text);
    } else {
      let queued = this._queued.get(scope);
      if (!queued) this._queued.set(scope, (queued = []));
      queued.push(text);
      // load it so the segment merges and counts toward the budget
      void this._pack(scope);
    }
    this._scheduleIdleRelease();
    this._scheduleFlush();
  }

  /** Write pending packs now (tests, teardown). */
  async flush(): Promise<void> {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    // one flush at a time: a second caller waits for the running one, then
    // writes whatever changed meanwhile
    while (this._flushing) await this._flushing;
    if (this._dirty.size === 0 && this._queued.size === 0) return;
    this._flushing = this._write().finally(() => {
      this._flushing = null;
    });
    await this._flushing;
  }

  private async _write(): Promise<void> {
    // queued segments merge into their packs as those load
    for (const scope of [...this._queued.keys()]) await this._pack(scope);
    const records: Array<[string, PackRecord]> = [];
    for (const scope of this._dirty) {
      const pack = this._packs.get(scope);
      if (pack) records.push([scope, { text: packText(pack), updatedAt: Date.now() }]);
    }
    this._dirty.clear();
    if (!this._persist || records.length === 0) return;
    const db = await this._openDb();
    if (!db) return;
    let written = false;
    try {
      const tx = db.transaction([STORE_NAME, META_STORE], "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const meta = tx.objectStore(META_STORE);
      for (const [scope, record] of records) {
        store.put(record, scope);
        meta.put({ updatedAt: record.updatedAt, chars: record.text.length } satisfies PackMeta, scope);
      }
      written = await new Promise<boolean>((resolve) => {
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      });
    } catch {
      /* persistence is best effort */
    }
    // not written (quota, a closing database): keep them for the next flush
    // instead of letting an idle release drop them
    if (!written) for (const [scope] of records) if (this._packs.has(scope)) this._dirty.add(scope);
  }

  stats(): { packs: number; chars: number } {
    return { packs: this._packs.size, chars: this._chars };
  }

  clear(): void {
    this._known.clear();
    this._packs.clear();
    this._loading.clear();
    this._queued.clear();
    this._dirty.clear();
    this._chars = 0;
  }

  private _openDb(): Promise<IDBDatabase | null> {
    if (!this._db) this._db = openDB();
    return this._db;
  }

  private _append(scope: string, pack: Pack, text: string): void {
    pack.segments.push(text);
    this._dirty.add(scope);
    this._touch(scope, pack);
    this._resize(pack, text.length);
  }

  private _pack(scope: string): Promise<Pack> {
    const existing = this._packs.get(scope);
    if (existing) {
      this._touch(scope, existing);
      return Promise.resolve(existing);
    }
    let loading = this._loading.get(scope);
    if (!loading) {
      loading = this._load(scope).then((pack) => {
        this._loading.delete(scope);
        this._packs.set(scope, pack);
        this._resize(pack, pack.chars, true);
        const queued = this._queued.get(scope);
        if (queued) {
          this._queued.delete(scope);
          for (const text of queued) this._append(scope, pack, text);
        }
        return pack;
      });
      this._loading.set(scope, loading);
    }
    return loading;
  }

  private async _load(scope: string): Promise<Pack> {
    const pack: Pack = { segments: [], chars: 0 };
    if (!this._persist) return pack;
    const db = await this._openDb();
    if (!db) return pack;
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const record = await idbRequest<PackRecord | undefined>(
        tx.objectStore(STORE_NAME).get(scope) as IDBRequest<PackRecord | undefined>,
      );
      if (!record || !isArrayText(record.text)) return pack;
      if (Date.now() - (record.updatedAt || 0) > MAX_AGE_MS) return pack;
      pack.segments.push(record.text);
      pack.chars = record.text.length;
    } catch {
      /* unreadable record: start empty */
    }
    return pack;
  }

  private _touch(scope: string, pack: Pack): void {
    this._packs.delete(scope);
    this._packs.set(scope, pack);
  }

  // `adopt` counts a freshly loaded pack's existing size toward the budget
  private _resize(pack: Pack, delta: number, adopt = false): void {
    if (!adopt) pack.chars += delta;
    this._chars += delta;
    // drop written packs from memory, oldest first; IndexedDB still has them
    // (a memory-only store keeps everything)
    if (!this._persist) return;
    for (const [scope, candidate] of this._packs) {
      if (this._chars <= MEMORY_BUDGET_CHARS) break;
      if (candidate === pack || this._dirty.has(scope)) continue;
      this._packs.delete(scope);
      this._chars -= candidate.chars;
    }
  }

  private _scheduleIdleRelease(): void {
    if (!this._persist) return; // memory-only store: packs live nowhere else
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      void this.flush().then(() => {
        for (const [scope, pack] of this._packs) {
          if (this._dirty.has(scope)) continue; // new work arrived: stay loaded
          this._packs.delete(scope);
          this._chars -= pack.chars;
        }
      });
    }, IDLE_RELEASE_MS);
  }

  private _scheduleFlush(): void {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }
}

let shared: SharedTransformStore | null = null;

/** The page-wide store (IndexedDB-backed where available). */
export function getSharedTransformStore(): SharedTransformStore {
  if (!shared) shared = new SharedTransformStore(typeof indexedDB !== "undefined");
  return shared;
}
