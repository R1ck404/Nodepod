interface EsbuildTransformConfig {
  loader?: string;
  jsx?: string;
  jsxFactory?: string;
  jsxFragment?: string;
  jsxImportSource?: string;
  sourcemap?: boolean | 'inline' | 'external' | 'both';
  sourcefile?: string;
  target?: string | string[];
  format?: 'iife' | 'cjs' | 'esm';
  minify?: boolean;
  tsconfigRaw?: string | object;
  platform?: 'browser' | 'node' | 'neutral';
  define?: Record<string, string>;
}

interface EsbuildTransformOutput {
  code: string;
  map: string;
  warnings: unknown[];
}

declare module 'esbuild-wasm' {
  export function initialize(options?: { wasmURL?: string; worker?: boolean }): Promise<void>;
  export function transform(input: string, options?: EsbuildTransformConfig): Promise<EsbuildTransformOutput>;
  export function build(options: unknown): Promise<unknown>;
  export function formatMessages(messages: unknown[], options: unknown): Promise<string[]>;
  export const version: string;
}

declare module 'virtual:process-worker-bundle' {
  export const PROCESS_WORKER_BUNDLE: string;
}

declare module 'wa-sqlite/src/sqlite-api.js' {
  export const Factory: (module: unknown) => unknown;
  export class SQLiteError extends Error {
    constructor(message: string, code?: number);
  }
}

declare module 'wa-sqlite/src/sqlite-constants.js' {
  export const SQLITE_OK: number;
  export const SQLITE_ROW: number;
  export const SQLITE_DONE: number;
  export const SQLITE_UTF8: number;
  export const SQLITE_OPEN_READWRITE: number;
  export const SQLITE_OPEN_CREATE: number;
  export const SQLITE_NULL: number;
  export const SQLITE_INTEGER: number;
  export const SQLITE_FLOAT: number;
  export const SQLITE_TEXT: number;
  export const SQLITE_BLOB: number;
  export const SQLITE_MISUSE: number;
}

declare module 'wa-sqlite/dist/wa-sqlite.mjs' {
  const factory: (opts: {
    wasmBinary: Uint8Array;
    wasmModule?: WebAssembly.Module;
    noInitialRun?: boolean;
  }) => Promise<Record<string, unknown>>;
  export default factory;
}
