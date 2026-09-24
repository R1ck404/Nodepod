// Offload API — routes CPU-heavy tasks (esbuild, tarball extraction, bundling)
// to a Web Worker pool. Falls back to main-thread if Workers aren't available.

import { WorkerPool } from "./worker-pool";
import { TaskQueue } from "./task-queue";
import type {
  OffloadTask,
  OffloadResult,
  PoolConfig,
  TransformTask,
  TransformResult,
  TransformBatchTask,
  TransformBatchResult,
  ExtractTask,
  ExtractResult,
  BuildTask,
  BuildResult,
} from "./offload-types";
import type { NodepodProfilerImpl } from "../profiling/profiler";
import { profileTimestamp } from "../profiling/profiler";

export { TaskPriority } from "./offload-types";
export type {
  TransformTask,
  TransformResult,
  TransformBatchTask,
  TransformBatchResult,
  ExtractTask,
  ExtractResult,
  BuildTask,
  BuildResult,
  OffloadTask,
  OffloadResult,
  PoolConfig,
} from "./offload-types";

// --- Singleton state ---

let pool: WorkerPool | null = null;
let queue: TaskQueue | null = null;
let fallbackMode = false;
let storedConfig: PoolConfig | undefined;
let nextTaskIdValue = 1;

// --- Environment detection ---

function canUseWorkers(): boolean {
  // Do not import RuntimeHost here — process-worker bundles archive-extractor → offload.
  return (
    typeof Worker !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}

// --- Pool lifecycle ---

function ensurePool(): TaskQueue {
  if (queue) return queue;

  if (!canUseWorkers()) {
    fallbackMode = true;
    throw new Error("Workers not available");
  }

  pool = new WorkerPool(storedConfig);
  queue = new TaskQueue(pool);
  return queue;
}

// --- Main-thread fallback implementations ---

async function mainThreadTransform(
  task: TransformTask,
): Promise<TransformResult> {
  // convertFileDirect, not convertFile — avoids circular: convertFile → offload → fallback → loop
  const { convertFileDirect, patchBuiltinImports, prepareTransformer } = await import(
    "../module-transformer"
  );
  await prepareTransformer();

  const code = patchBuiltinImports(await convertFileDirect(task.source, task.filePath));
  return { type: "transform", id: task.id, code, warnings: [] };
}

async function mainThreadTransformBatch(
  task: TransformBatchTask,
): Promise<TransformBatchResult> {
  const { convertFileDirect, patchBuiltinImports, prepareTransformer } = await import(
    "../module-transformer"
  );
  await prepareTransformer();
  const results = await Promise.all(task.files.map(async (file) => {
    try {
      const code = patchBuiltinImports(await convertFileDirect(file.source, file.filePath));
      return { filePath: file.filePath, code, warnings: [] };
    } catch (err) {
      return {
        filePath: file.filePath,
        code: file.source,
        warnings: [err instanceof Error ? err.message : String(err)],
      };
    }
  }));
  return { type: "transformBatch", id: task.id, results };
}

// gzip via the platform's native inflater; pako (JavaScript, several times
// slower, with a JS CRC pass on top) only if that's missing or rejects the
// stream (e.g. trailing bytes after the gzip member)
async function gunzip(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "function") {
    try {
      const stream = new Blob([compressed as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      /* fall back below */
    }
  }
  const pako = await import("pako");
  return pako.inflate(compressed);
}

async function mainThreadExtract(
  task: ExtractTask,
): Promise<ExtractResult> {
  const { parseTarArchive } = await import("../packages/archive-extractor");
  const { bytesToBase64 } = await import("../helpers/byte-encoding");

  let compressed: Uint8Array;
  if (task.tarballBytes && task.tarballBytes.byteLength > 0) {
    compressed = new Uint8Array(task.tarballBytes);
  } else {
    const response = await fetch(task.tarballUrl);
    if (!response.ok) {
      throw new Error(
        `Archive download failed (HTTP ${response.status}): ${task.tarballUrl}`,
      );
    }
    compressed = new Uint8Array(await response.arrayBuffer());
  }
  const tarBytes = await gunzip(compressed);

  const files: ExtractResult["files"] = [];
  for (const entry of parseTarArchive(tarBytes)) {
    if (entry.kind !== "file" || !entry.payload) continue;

    let relative = entry.filepath;
    if (task.stripComponents > 0) {
      const segments = relative.split("/").filter(Boolean);
      if (segments.length <= task.stripComponents) continue;
      relative = segments.slice(task.stripComponents).join("/");
    }

    files.push({
      path: relative,
      data: new Uint8Array(entry.payload),
      isBinary: true,
    });
  }

  const result: ExtractResult = { type: "extract", id: task.id, files };
  if (task.wantTarball) {
    result.tarballBytes =
      compressed.buffer instanceof ArrayBuffer && compressed.byteLength === compressed.buffer.byteLength
        ? compressed.buffer
        : compressed.slice().buffer as ArrayBuffer;
  }
  return result;
}

async function mainThreadBuild(task: BuildTask): Promise<BuildResult> {
  const esbuild = await import("../polyfills/esbuild");
  try {
    const result = await (esbuild as any).build({
      entryPoints: task.entryPoints,
      stdin: task.stdin,
      bundle: task.bundle,
      format: task.format,
      platform: task.platform,
      target: task.target,
      minify: task.minify,
      external: task.external,
      write: false,
      absWorkingDir: task.absWorkingDir,
    });
    return {
      type: "build",
      id: task.id,
      outputFiles: (result.outputFiles || []).map((f: any) => ({
        path: f.path,
        text: f.text || new TextDecoder().decode(f.contents),
      })),
      errors: (result.errors || []).map((e: any) => e.text || String(e)),
      warnings: (result.warnings || []).map(
        (w: any) => w.text || String(w),
      ),
    };
  } catch (err: any) {
    return {
      type: "build",
      id: task.id,
      outputFiles: [],
      errors: [err?.message || "build failed"],
      warnings: [],
    };
  }
}

// --- Public API ---

export function taskId(): number {
  const id = nextTaskIdValue;
  nextTaskIdValue = nextTaskIdValue >= Number.MAX_SAFE_INTEGER ? 1 : nextTaskIdValue + 1;
  return id;
}

export async function offload<T extends OffloadTask>(
  task: T,
): Promise<
  T extends TransformTask
    ? TransformResult
    : T extends TransformBatchTask
      ? TransformBatchResult
      : T extends ExtractTask
        ? ExtractResult
      : T extends BuildTask
        ? BuildResult
        : OffloadResult
> {
  // Fast path: already know Workers aren't available
  if (fallbackMode) {
    return runFallback(task) as any;
  }

  try {
    const q = ensurePool();
    return await q.submit(task) as any;
  } catch (err) {
    // Log once so consumers know fallback is active
    if (!fallbackMode) {
      console.debug(
        "[offload] Falling back to main thread:",
        err instanceof Error ? err.message : err,
      );
    }
    switchToFallback();
    return runFallback(task) as any;
  }
}

/**
 * Opt-in timing wrapper for worker-backed tasks. Kept separate from offload()
 * so the default task path does not allocate profiling tokens or metadata.
 */
export async function profiledOffload<T extends OffloadTask>(
  task: T,
  profiler: NodepodProfilerImpl,
): Promise<
  T extends TransformTask
    ? TransformResult
    : T extends TransformBatchTask
      ? TransformBatchResult
      : T extends ExtractTask
        ? ExtractResult
      : T extends BuildTask
        ? BuildResult
        : OffloadResult
> {
  const span = profiler.begin(`workers.${task.type}`, {
    category: "workers",
    metadata: { taskId: task.id },
  });
  const profiledTask = {
    ...task,
    profiling: { createdAt: profileTimestamp() },
  } as T;
  try {
    const result = await offload(profiledTask);
    profiler.count("workers.tasks");
    const timing = result.profiling;
    if (timing?.dispatchedAt !== undefined) {
      profiler.recordSpan("workers.queue", timing.createdAt, timing.dispatchedAt, {
        category: "workers",
        thread: `worker-${timing.workerId ?? "unknown"}`,
      });
    }
    if (timing?.startedAt !== undefined && timing.completedAt !== undefined) {
      profiler.recordSpan("workers.execution", timing.startedAt, timing.completedAt, {
        category: "workers",
        thread: `worker-${timing.workerId ?? "unknown"}`,
      });
    }
    if (timing?.dispatchedAt !== undefined && timing.startedAt !== undefined) {
      profiler.recordSpan("workers.transfer.to", timing.dispatchedAt, timing.startedAt, {
        category: "workers",
        thread: `worker-${timing.workerId ?? "unknown"}`,
      });
    }
    if (timing?.completedAt !== undefined && timing.receivedAt !== undefined) {
      profiler.recordSpan("workers.transfer.from", timing.completedAt, timing.receivedAt, {
        category: "workers",
        thread: `worker-${timing.workerId ?? "unknown"}`,
      });
    }
    return result as any;
  } finally {
    profiler.end(span);
  }
}

export async function offloadBatch(
  tasks: OffloadTask[],
): Promise<OffloadResult[]> {
  if (fallbackMode) {
    return Promise.all(tasks.map((t) => runFallback(t)));
  }

  try {
    const q = ensurePool();
    return await q.submitBatch(tasks);
  } catch {
    switchToFallback();
    return Promise.all(tasks.map((t) => runFallback(t)));
  }
}

function switchToFallback(): void {
  fallbackMode = true;
  if (pool) {
    pool.dispose();
    pool = null;
  }
  queue = null;
}

async function runFallback(task: OffloadTask): Promise<OffloadResult> {
  switch (task.type) {
    case "transform":
      return mainThreadTransform(task);
    case "transformBatch":
      return mainThreadTransformBatch(task);
    case "extract":
      return mainThreadExtract(task);
    case "build":
      return mainThreadBuild(task);
    default:
      throw new Error(`Unknown task type: ${(task as any).type}`);
  }
}

export function cancelTask(id: number): boolean {
  return queue?.cancel(id) ?? false;
}

export function poolStats(): {
  total: number;
  busy: number;
  idle: number;
  initialized: number;
  fallback: boolean;
} {
  const stats = pool?.stats() ?? {
    total: 0,
    busy: 0,
    idle: 0,
    initialized: 0,
  };
  return { ...stats, fallback: fallbackMode };
}

export function disposePool(): void {
  queue = null;
  pool?.dispose();
  pool = null;
  fallbackMode = false;
}

// Must be called before any offload() task is submitted
export function configurePool(config: PoolConfig): void {
  if (pool) {
    throw new Error("Pool already created; call disposePool() first");
  }
  storedConfig = config;
}
