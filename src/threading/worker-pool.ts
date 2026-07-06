// WorkerPool — on-demand Web Worker pool for offload tasks.
// Workers are pre-warmed, reused, and reaped after idle timeout.
// If Worker creation fails (CSP, etc.), acquire() throws so the caller can fall back.

import { wrap, type Remote } from "comlink";
import type { OffloadWorkerEndpoint, PoolConfig } from "./offload-types";
import { createInlineWorker, revokeInlineWorkerUrl } from "./inline-worker";
import { TIMEOUTS, LIMITS } from "../constants/config";

// --- Internal types ---

interface PooledWorker {
  thread: Worker;
  endpoint: Remote<OffloadWorkerEndpoint>;
  busy: boolean;
  initialized: boolean;
  initPromise: Promise<void> | null;
  lastUsed: number;
  id: number;
}

interface WaitEntry {
  resolve: (result: { worker: PooledWorker; release: () => void }) => void;
  reject: (err: Error) => void;
}

// --- WorkerPool ---

export class WorkerPool {
  private workers: PooledWorker[] = [];
  private waitQueue: WaitEntry[] = [];
  private nextId = 0;
  private config: Required<PoolConfig>;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  broken = false;

  constructor(config: PoolConfig = {}) {
    const cores =
      typeof navigator !== "undefined"
        ? navigator.hardwareConcurrency || 4
        : 4;

    this.config = {
      minWorkers: config.minWorkers ?? 1,
      maxWorkers: config.maxWorkers ?? Math.min(cores, LIMITS.MAX_WORKERS_CAP),
      idleTimeoutMs: config.idleTimeoutMs ?? TIMEOUTS.WORKER_IDLE_TIMEOUT,
      warmUpOnCreate: config.warmUpOnCreate ?? true,
    };

    this.idleTimer = setInterval(() => this.reapIdle(), TIMEOUTS.WORKER_REAP_INTERVAL);
  }

  // --- Public API ---

  // Returns a worker + release callback. Caller MUST call release() when done.
  async acquire(): Promise<{ worker: PooledWorker; release: () => void }> {
    if (this.disposed) throw new Error("WorkerPool is disposed");
    if (this.broken) throw new Error("WorkerPool is broken — Workers unavailable");

    // Try idle initialized worker first
    const idle = this.workers.find((w) => !w.busy && w.initialized);
    if (idle) {
      idle.busy = true;
      idle.lastUsed = Date.now();
      return { worker: idle, release: () => this.release(idle) };
    }

    // Create new worker if under capacity
    if (this.workers.length < this.config.maxWorkers) {
      const pooled = this.tryCreateWorker();
      if (!pooled) {
        // Construction failed — mark pool as broken
        this.broken = true;
        this.rejectAllWaiters();
        throw new Error("WorkerPool is broken — Worker construction failed");
      }

      pooled.busy = true;

      // Wait for init to finish
      if (!pooled.initialized && pooled.initPromise) {
        try {
          await pooled.initPromise;
        } catch (err) {
          // Init failed — mark pool as broken
          this.terminateWorker(pooled);
          this.broken = true;
          this.rejectAllWaiters();
          throw new Error(
            `WorkerPool is broken — Worker init failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      pooled.lastUsed = Date.now();
      return { worker: pooled, release: () => this.release(pooled) };
    }

    // At capacity — wait for a worker to become free
    return new Promise<{ worker: PooledWorker; release: () => void }>(
      (resolve, reject) => {
        this.waitQueue.push({ resolve, reject });
      },
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    for (const w of [...this.workers]) {
      this.terminateWorker(w);
    }
    this.rejectAllWaiters();
    revokeInlineWorkerUrl();
  }

  stats(): {
    total: number;
    busy: number;
    idle: number;
    initialized: number;
  } {
    return {
      total: this.workers.length,
      busy: this.workers.filter((w) => w.busy).length,
      idle: this.workers.filter((w) => !w.busy).length,
      initialized: this.workers.filter((w) => w.initialized).length,
    };
  }

  // --- Internal ---

  private rejectAllWaiters(): void {
    for (const entry of this.waitQueue) {
      entry.reject(new Error("WorkerPool is no longer available"));
    }
    this.waitQueue.length = 0;
  }

  private release(pooled: PooledWorker): void {
    pooled.busy = false;
    pooled.lastUsed = Date.now();

    // Wake up anyone waiting for a worker
    if (this.waitQueue.length > 0) {
      const entry = this.waitQueue.shift()!;
      pooled.busy = true;
      pooled.lastUsed = Date.now();
      entry.resolve({ worker: pooled, release: () => this.release(pooled) });
    }
  }

  // Returns null if Worker construction fails (CSP, etc.)
  private tryCreateWorker(): PooledWorker | null {
    const thread = createInlineWorker();
    if (!thread) return null;

    try {
      const endpoint = wrap<OffloadWorkerEndpoint>(thread);
      const id = this.nextId++;

      const pooled: PooledWorker = {
        thread,
        endpoint,
        busy: false,
        initialized: false,
        initPromise: null,
        lastUsed: Date.now(),
        id,
      };

      // Pre-warm pako only (esbuild loads lazily on the first transform/build
      // task). Timeout prevents stalled CDN from hanging.
      if (this.config.warmUpOnCreate) {
        const INIT_TIMEOUT = TIMEOUTS.WORKER_INIT_TIMEOUT;
        const initCall = endpoint.init();
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Worker init timed out")), INIT_TIMEOUT),
        );
        pooled.initPromise = Promise.race([initCall, timeout])
          .then(() => {
            pooled.initialized = true;
            pooled.initPromise = null;
          })
          .catch((err) => {
            this.terminateWorker(pooled);
            throw err; // propagate so acquire() can catch it
          });
      }

      this.workers.push(pooled);
      return pooled;
    } catch {
      try { thread.terminate(); } catch { /* ignore */ }
      return null;
    }
  }

  private reapIdle(): void {
    const now = Date.now();
    const candidates = this.workers.filter(
      (w) =>
        !w.busy &&
        w.initialized &&
        now - w.lastUsed > this.config.idleTimeoutMs,
    );

    // Keep at least minWorkers
    const canRemove = Math.max(
      0,
      this.workers.length - this.config.minWorkers,
    );
    const toRemove = candidates.slice(0, canRemove);

    for (const w of toRemove) {
      this.terminateWorker(w);
    }
  }

  private terminateWorker(pooled: PooledWorker): void {
    const idx = this.workers.indexOf(pooled);
    if (idx >= 0) this.workers.splice(idx, 1);
    try {
      pooled.thread.terminate();
    } catch {
      /* ignore */
    }
  }
}
