/** Small dependency-free async byte stream used by shell pipelines. */

import { ShellLimitError } from "./shell-options.js";
import type { ShellLimits } from "./shell-options.js";

export interface CancellationToken {
  readonly signal: AbortSignal;
  throwIfCancelled(): void;
  onCancel(listener: () => void): () => void;
}

export interface ShellReadable {
  read(token?: CancellationToken): Promise<Uint8Array | null>;
}

export interface ShellWritable {
  write(chunk: Uint8Array, token?: CancellationToken): Promise<void>;
  end(): void;
}

export interface ExecutionContext {
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  limits: ShellLimits;
}

export interface ProcessGroup {
  readonly id: number;
  readonly signal: AbortSignal;
  cancel(reason?: unknown): void;
}

export class JobTable<T extends { id: number }> {
  private readonly jobs = new Map<number, T>();
  set(job: T): void { this.jobs.set(job.id, job); }
  get(id: number): T | undefined { return this.jobs.get(id); }
  delete(id: number): boolean { return this.jobs.delete(id); }
  values(): IterableIterator<T> { return this.jobs.values(); }
  get size(): number { return this.jobs.size; }
}

export class ShellCancellation implements CancellationToken {
  readonly controller = new AbortController();
  get signal(): AbortSignal { return this.controller.signal; }

  cancel(reason?: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  throwIfCancelled(): void {
    if (this.signal.aborted) {
      throw this.signal.reason instanceof Error
        ? this.signal.reason
        : new Error("shell: command cancelled");
    }
  }

  onCancel(listener: () => void): () => void {
    if (this.signal.aborted) {
      listener();
      return () => {};
    }
    this.signal.addEventListener("abort", listener, { once: true });
    return () => this.signal.removeEventListener("abort", listener);
  }
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/**
 * A bounded async queue. Producers wait when the queue is full, which gives
 * shell pipelines real backpressure instead of concatenating unbounded
 * strings in memory.
 */
export class ShellPipe implements ShellReadable, ShellWritable {
  private readonly chunks: Uint8Array[] = [];
  private readonly readers: Array<Waiter<Uint8Array | null>> = [];
  private readonly writers: Array<Waiter<void>> = [];
  private bytes = 0;
  private ended = false;
  private failure: Error | null = null;

  constructor(private readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError("shell: pipe capacity must be positive");
    }
  }

  get bufferedBytes(): number { return this.bytes; }
  get capacityBytes(): number { return this.capacity; }
  get closed(): boolean { return this.ended || this.failure !== null; }

  async write(chunk: Uint8Array, token?: CancellationToken): Promise<void> {
    if (chunk.byteLength === 0) return;
    if (chunk.byteLength > this.capacity) {
      throw new ShellLimitError(
        "maxPipelineBufferBytes",
        `shell: pipeline chunk exceeds ${this.capacity} bytes`,
      );
    }
    token?.throwIfCancelled();
    if (this.closed) {
      throw this.failure ?? new Error("shell: write to closed pipe");
    }

    while (this.bytes + chunk.byteLength > this.capacity) {
      await this.waitForWriter(token);
      token?.throwIfCancelled();
      if (this.closed) {
        throw this.failure ?? new Error("shell: write to closed pipe");
      }
    }

    const reader = this.readers.shift();
    if (reader) {
      reader.resolve(chunk);
      return;
    }

    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
  }

  async read(token?: CancellationToken): Promise<Uint8Array | null> {
    token?.throwIfCancelled();
    const chunk = this.chunks.shift();
    if (chunk) {
      this.bytes -= chunk.byteLength;
      this.releaseWriter();
      return chunk;
    }
    if (this.failure) throw this.failure;
    if (this.ended) return null;

    let removeCancellationListener = () => {};
    const pending = new Promise<Uint8Array | null>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.readers.push(waiter);
      removeCancellationListener = token?.onCancel(() => {
        const index = this.readers.indexOf(waiter);
        if (index >= 0) this.readers.splice(index, 1);
        reject(token.signal.reason ?? new Error("shell: read cancelled"));
      }) ?? (() => {});
    });
    return pending.finally(removeCancellationListener);
  }

  end(): void {
    if (this.closed) return;
    this.ended = true;
    while (this.readers.length) this.readers.shift()!.resolve(null);
    while (this.writers.length) this.writers.shift()!.resolve();
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    while (this.readers.length) this.readers.shift()!.reject(this.failure);
    while (this.writers.length) this.writers.shift()!.reject(this.failure);
  }

  private waitForWriter(token?: CancellationToken): Promise<void> {
    let removeCancellationListener = () => {};
    const pending = new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.writers.push(waiter);
      removeCancellationListener = token?.onCancel(() => {
        const index = this.writers.indexOf(waiter);
        if (index >= 0) this.writers.splice(index, 1);
        reject(token.signal.reason ?? new Error("shell: write cancelled"));
      }) ?? (() => {});
    });
    return pending.finally(removeCancellationListener);
  }

  private releaseWriter(): void {
    this.writers.shift()?.resolve();
  }
}

export async function streamToString(
  pipe: ShellPipe,
  token: CancellationToken,
  maxBytes: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  for (;;) {
    const chunk = await pipe.read(token);
    if (chunk === null) break;
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new ShellLimitError(
        "maxOutputBytes",
        `shell: output exceeds ${maxBytes} bytes`,
      );
    }
    output += decoder.decode(chunk, { stream: true });
  }
  return output + decoder.decode();
}

export function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
