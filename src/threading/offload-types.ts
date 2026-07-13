// types for the worker offloading system — all must be structured-clone safe (postMessage)

export enum TaskPriority {
  HIGH = 0,    // runtime transforms (user waiting)
  NORMAL = 1,  // install-time bulk transforms
  LOW = 2,     // background pre-bundling
}

export interface TransformTask {
  type: "transform";
  id: string;
  source: string;
  filePath: string;
  options?: {
    loader?: "js" | "jsx" | "ts" | "tsx";
    format?: "cjs" | "esm";
    target?: string;
    platform?: string;
    define?: Record<string, string>;
  };
  priority: TaskPriority;
}

export interface TransformResult {
  type: "transform";
  id: string;
  code: string;
  warnings: string[];
}

export interface ExtractTask {
  type: "extract";
  id: string;
  tarballUrl: string;
  stripComponents: number;
  priority: TaskPriority;
  expectedShasum?: string;
  // cached compressed tarball bytes — worker skips its fetch when provided
  tarballBytes?: ArrayBuffer;
  // ask the worker to return the compressed bytes so main can cache them
  wantTarball?: boolean;
  streamPort?: MessagePort;
}

export interface ExtractedFile {
  path: string;
  // UTF-8 text, base64-encoded binary, or raw Uint8Array for large binaries
  data: string | Uint8Array;
  isBinary: boolean;
}

export interface ExtractResult {
  type: "extract";
  id: string;
  files: ExtractedFile[];
  // compressed tarball bytes, present when the task set wantTarball
  tarballBytes?: ArrayBuffer;
  streamed?: boolean;
}

export interface BuildTask {
  type: "build";
  id: string;
  files: Record<string, string>;
  entryPoints?: string[];
  stdin?: { contents: string; resolveDir?: string; loader?: string };
  bundle?: boolean;
  format?: "iife" | "cjs" | "esm";
  platform?: "browser" | "node" | "neutral";
  target?: string | string[];
  minify?: boolean;
  external?: string[];
  absWorkingDir?: string;
  priority: TaskPriority;
}

export interface BuildOutputFile {
  path: string;
  text: string;
}

export interface BuildResult {
  type: "build";
  id: string;
  outputFiles: BuildOutputFile[];
  errors: string[];
  warnings: string[];
}

export type OffloadTask = TransformTask | ExtractTask | BuildTask;
export type OffloadResult = TransformResult | ExtractResult | BuildResult;

// exposed via Comlink
export interface OffloadWorkerEndpoint {
  init(): Promise<void>;
  transform(task: TransformTask): Promise<TransformResult>;
  extract(task: ExtractTask): Promise<ExtractResult>;
  build(task: BuildTask): Promise<BuildResult>;
  ping(): boolean;
}

export interface PoolConfig {
  minWorkers?: number;
  maxWorkers?: number;
  idleTimeoutMs?: number;
  warmUpOnCreate?: boolean;
}
