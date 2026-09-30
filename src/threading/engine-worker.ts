// Web Worker entry point for ScriptEngine.
// Receives execution requests via Comlink, runs them in an isolated thread.

import { expose } from 'comlink';
import { MemoryVolume } from '../memory-volume';
import { ScriptEngine } from '../script-engine';
import type { VolumeSnapshot, EngineConfig, ExecutionOutcome } from '../engine-types';

let engine: ScriptEngine | null = null;
let volume: MemoryVolume | null = null;
let consoleForwarder: ((method: string, args: unknown[]) => void) | null = null;

const workerInterface = {
  init(snapshot: VolumeSnapshot, config: EngineConfig): void {
    volume = MemoryVolume.fromSnapshot(snapshot);

    const engineConfig: EngineConfig = {
      ...config,
      onConsole: (method, args) => {
        if (consoleForwarder) consoleForwarder(method, args);
      },
    };

    engine = new ScriptEngine(volume, engineConfig);
  },

  setConsoleForwarder(cb: ((method: string, args: unknown[]) => void) | null): void {
    consoleForwarder = cb;
  },

  syncFile(filePath: string, content: string | Uint8Array | null): void {
    if (!volume) {
      return;
    }

    if (content === null) {
      try { volume.unlinkSync(filePath); } catch { /* may not exist */ }
    } else {
      volume.writeFileSync(filePath, content);
    }

    if (engine) engine.clearCache();
  },

  async execute(code: string, filename?: string): Promise<ExecutionOutcome> {
    if (!engine) throw new Error('Worker engine not initialized. Call init() first.');
    return engine.execute(code, filename);
  },

  async runFile(filename: string): Promise<ExecutionOutcome> {
    if (!engine) throw new Error('Worker engine not initialized. Call init() first.');
    return engine.runFile(filename);
  },

  clearCache(): void {
    if (engine) engine.clearCache();
  },

  getSnapshot(): VolumeSnapshot | null {
    return volume?.toSnapshot() ?? null;
  },
};

expose(workerInterface);
