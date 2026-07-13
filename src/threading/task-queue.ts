// TaskQueue — priority-sorted queue that dispatches tasks to the WorkerPool.

import type { WorkerPool } from "./worker-pool";
import type {
  OffloadTask,
  OffloadResult,
  TransformTask,
  TransformResult,
  ExtractTask,
  ExtractResult,
  BuildTask,
  BuildResult,
} from "./offload-types";
import { transfer } from "comlink";

// --- Internal types ---

interface QueuedTask {
  task: OffloadTask;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  cancelled: boolean;
}

// --- TaskQueue ---

export class TaskQueue {
  private queue: QueuedTask[] = [];
  private pool: WorkerPool;
  private dispatching = false;

  constructor(pool: WorkerPool) {
    this.pool = pool;
  }

  // --- Public API ---

  submit<T extends OffloadTask>(
    task: T,
  ): Promise<
    T extends TransformTask
      ? TransformResult
      : T extends ExtractTask
        ? ExtractResult
        : T extends BuildTask
          ? BuildResult
          : OffloadResult
  > {
    return new Promise((resolve, reject) => {
      const queued: QueuedTask = {
        task,
        resolve,
        reject,
        cancelled: false,
      };

      // Lower number = higher priority
      const idx = this.queue.findIndex(
        (q) => q.task.priority > task.priority,
      );
      if (idx === -1) {
        this.queue.push(queued);
      } else {
        this.queue.splice(idx, 0, queued);
      }

      this.dispatch();
    });
  }

  submitBatch(tasks: OffloadTask[]): Promise<OffloadResult[]> {
    return Promise.all(tasks.map((t) => this.submit(t)));
  }

  cancel(taskId: string): boolean {
    const idx = this.queue.findIndex(
      (q) => q.task.id === taskId && !q.cancelled,
    );
    if (idx >= 0) {
      const queued = this.queue[idx];
      queued.cancelled = true;
      queued.reject(new Error(`Task ${taskId} cancelled`));
      this.queue.splice(idx, 1);
      return true;
    }
    return false;
  }

  get pending(): number {
    return this.queue.length;
  }

  // --- Internal ---

  private async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;

    try {
      while (this.queue.length > 0) {
        const queued = this.queue.shift()!;
        if (queued.cancelled) continue;

        let worker: any;
        let release: (() => void) | undefined;
        try {
          const acquired = await this.pool.acquire();
          worker = acquired.worker;
          release = acquired.release;
        } catch (err) {
          // Pool broken — reject everything so offload() can fall back to main thread
          const reason =
            err instanceof Error ? err : new Error(String(err));
          queued.reject(reason);
          this.rejectAll(reason);
          return;
        }

        // Don't block the dispatch loop — fire and re-trigger on completion
        this.executeTask(worker.endpoint, queued).finally(() => {
          release!();
          // More tasks may have arrived while we were busy
          if (this.queue.length > 0) {
            this.dispatching = false;
            this.dispatch();
          }
        });
      }
    } finally {
      this.dispatching = false;
    }
  }

  private rejectAll(reason: Error): void {
    const pending = this.queue.splice(0);
    for (const q of pending) {
      if (!q.cancelled) {
        q.reject(reason);
      }
    }
  }

  private async executeTask(
    endpoint: any,
    queued: QueuedTask,
  ): Promise<void> {
    if (queued.cancelled) return;

    try {
      let result: OffloadResult;
      switch (queued.task.type) {
        case "transform":
          result = await endpoint.transform(queued.task);
          break;
        case "extract":
          result = await endpoint.extract(
            queued.task.streamPort
              ? transfer(queued.task, [queued.task.streamPort])
              : queued.task,
          );
          break;
        case "build":
          result = await endpoint.build(queued.task);
          break;
        default:
          throw new Error(
            `Unknown task type: ${(queued.task as any).type}`,
          );
      }

      if (!queued.cancelled) {
        queued.resolve(result);
      }
    } catch (err) {
      if (!queued.cancelled) {
        queued.reject(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
  }
}
