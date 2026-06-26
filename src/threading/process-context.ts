// ProcessContext — per-process execution state.
// Replaces module-level mutable state (the old `let _xxx` in child_process, fs, etc.).
// One active context on main thread; each worker gets its own.

import type { IVolume } from "../types/volume";
import { createHandleRegistry, type HandleRegistry } from "../helpers/event-loop";

// --- I/O interfaces ---

export interface ProcessWriter {
  write(data: string): void;
}

export interface ProcessReader {
  on(event: string, cb: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

// --- ProcessContext ---

export interface ProcessContext {
  pid: number;
  cwd: string;
  env: Record<string, string>;

  stdoutSink: ((text: string) => void) | null;
  stderrSink: ((text: string) => void) | null;
  liveStdin: { emit: (e: string, ...a: unknown[]) => void } | null;
  abortController: AbortController;

  volume: IVolume;

  /** typed Handle registry, tracks live async primitives for loop liveness */
  handles: HandleRegistry;

  termCols: (() => number) | null;
  termRows: (() => number) | null;

  fdCounter: number;
  openFiles: Map<number, OpenFileEntry>;
}

export interface OpenFileEntry {
  filePath: string;
  cursor: number;
  mode: string;
  data: Uint8Array;
}

// --- Factory ---

let _nextPid = 100;

export function createProcessContext(opts: {
  volume: IVolume;
  cwd?: string;
  env?: Record<string, string>;
  pid?: number;
}): ProcessContext {
  return {
    pid: opts.pid ?? _nextPid++,
    cwd: opts.cwd ?? "/",
    env: opts.env ?? {},

    stdoutSink: null,
    stderrSink: null,
    liveStdin: null,
    abortController: new AbortController(),

    volume: opts.volume,

    handles: createHandleRegistry(),

    termCols: null,
    termRows: null,

    fdCounter: 3,
    openFiles: new Map(),
  };
}

// --- Active context (main-thread inline mode) ---

let _activeContext: ProcessContext | null = null;

export function getActiveContext(): ProcessContext | null {
  return _activeContext;
}

export function setActiveContext(ctx: ProcessContext | null): void {
  _activeContext = ctx;
}
