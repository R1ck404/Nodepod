// shared types for the script engine and its execution modes

import type { IVolume } from './types/volume';

export interface EngineConfig {
  cwd?: string;
  env?: Record<string, string>;
  onConsole?: (method: string, args: unknown[]) => void;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface LoadedModule {
  id: string;
  filename: string;
  exports: unknown;
  loaded: boolean;
  children: LoadedModule[];
  paths: string[];
}

export interface ExecutionOutcome {
  exports: unknown;
  module: LoadedModule;
}

// async interface implemented by all execution modes (main thread, worker, iframe)
export interface IScriptEngine {
  execute(code: string, filename?: string): Promise<ExecutionOutcome>;
  runFile(filename: string): Promise<ExecutionOutcome>;
  clearCache(): void;
  getVolume?(): IVolume;
  terminate?(): void;
}

export interface SpawnEngineConfig extends EngineConfig {
  // cross-origin sandbox URL for maximum isolation (prevents cookie/storage access)
  sandboxUrl?: string;

  // explicitly permit same-origin eval (required when sandboxUrl is not set)
  allowUnsafeEval?: boolean;

  // false (default) = main thread, true = Worker, 'auto' = Worker if available
  useWorker?: boolean | 'auto';
}

// serialized MemoryVolume for transfer across boundaries
export interface VolumeSnapshot {
  entries: VolumeEntry[];
}

export interface VolumeEntry {
  path: string;
  kind: 'file' | 'directory';
  data?: string; // base64-encoded
}
