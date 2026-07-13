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
  ExtractTask,
  ExtractResult,
  BuildTask,
  BuildResult,
} from "./offload-types";

export { TaskPriority } from "./offload-types";
export type {
  TransformTask,
  TransformResult,
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

// --- Environment detection ---

function canUseWorkers(): boolean {
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
  const { convertFileDirect, prepareTransformer } = await import(
    "../module-transformer"
  );
  await prepareTransformer();

  const code = await convertFileDirect(task.source, task.filePath);
  return { type: "transform", id: task.id, code, warnings: [] };
}

async function mainThreadExtract(
  task: ExtractTask,
): Promise<ExtractResult> {
  const pako = await import("pako");
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
  const tarBytes = pako.inflate(compressed);

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

export function taskId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function offload<T extends OffloadTask>(
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
    case "extract":
      return mainThreadExtract(task);
    case "build":
      return mainThreadBuild(task);
    default:
      throw new Error(`Unknown task type: ${(task as any).type}`);
  }
}

export function cancelTask(id: string): boolean {
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
