// executes code in a dedicated Web Worker behind the IScriptEngine interface

import { wrap, proxy, Remote } from 'comlink';
import type { MemoryVolume } from './memory-volume.js';
import type { IScriptEngine, ExecutionOutcome, EngineConfig, VolumeSnapshot } from './engine-types.js';

interface WorkerEndpoint {
  init(snapshot: VolumeSnapshot, config: EngineConfig): void;
  setConsoleForwarder(cb: ((method: string, args: unknown[]) => void) | null): void;
  syncFile(path: string, content: string | Uint8Array | null): void;
  execute(code: string, filename?: string): Promise<ExecutionOutcome>;
  runFile(filename: string): Promise<ExecutionOutcome>;
  clearCache(): void;
  getSnapshot(): VolumeSnapshot | null;
}

export interface WorkerSandboxOptions extends EngineConfig {
  /** module worker to run; defaults to the bundled __engine_worker__.js */
  workerUrl?: string | URL;
}

// set by the library build (vite.lib.config.js), which emits the bundled
// engine worker into dist/ next to the chunk holding this module
declare const __NODEPOD_ENGINE_WORKER_FILE__: string | undefined;

function defaultWorkerUrl(): URL {
  const base = import.meta.url;
  // built package: the emitted bundle. From source (tests, dev servers that
  // compile TypeScript on request): the entry itself. The path is built at
  // runtime so bundlers don't try to resolve the .ts file.
  const path =
    typeof __NODEPOD_ENGINE_WORKER_FILE__ === 'string'
      ? __NODEPOD_ENGINE_WORKER_FILE__
      : './threading/engine-worker' + '.ts';
  return new (globalThis.URL)(path, base);
}

function createWorker(workerUrl?: string | URL): Worker {
  return new (globalThis.Worker)(workerUrl ?? defaultWorkerUrl(), { type: 'module' });
}

export class WorkerSandbox implements IScriptEngine {
  private thread: Worker;
  private endpoint: Remote<WorkerEndpoint>;
  private vol: MemoryVolume;
  private cfg: WorkerSandboxOptions;
  private ready: Promise<void>;
  /** rejects when the worker fails to load or throws at top level, so calls
   *  fail instead of waiting forever on a worker that will never answer */
  private failed: Promise<never>;
  private onFileChange: ((path: string, content: Uint8Array) => void) | null = null;
  private onFileDelete: ((path: string) => void) | null = null;

  constructor(vol: MemoryVolume, cfg: WorkerSandboxOptions = {}) {
    this.vol = vol;
    this.cfg = cfg;

    this.thread = createWorker(cfg.workerUrl);
    this.failed = new Promise<never>((_, reject) => {
      this.thread.addEventListener('error', (event: ErrorEvent) => {
        event.preventDefault?.();
        reject(new Error(
          `[Nodepod] WorkerSandbox worker failed to start${event.message ? `: ${event.message}` : ''}. ` +
          'Serve dist/__engine_worker__.js and pass its URL as workerUrl, or use the main-thread engine.',
        ));
      });
    });
    // callers observe the failure through ready/execute; don't also report
    // it as an unhandled rejection
    this.failed.catch(() => {});

    this.endpoint = wrap<WorkerEndpoint>(this.thread);
    this.ready = Promise.race([this.bootstrap(), this.failed]);
    this.ready.catch(() => {});
    this.attachVolumeSync();
  }

  private async bootstrap(): Promise<void> {
    const snapshot = this.vol.toSnapshot();
    const workerCfg: EngineConfig = { cwd: this.cfg.cwd, env: this.cfg.env };
    await this.endpoint.init(snapshot, workerCfg);

    if (this.cfg.onConsole) {
      await this.endpoint.setConsoleForwarder(proxy(this.cfg.onConsole));
    }
  }

  private attachVolumeSync(): void {
    this.onFileChange = (path: string, content: Uint8Array) => {
      this.endpoint.syncFile(path, content);
    };
    this.vol.on('write', this.onFileChange);

    this.onFileDelete = (path: string) => {
      this.endpoint.syncFile(path, null);
    };
    this.vol.on('delete', this.onFileDelete);
  }

  async execute(code: string, filename?: string): Promise<ExecutionOutcome> {
    await this.ready;
    return Promise.race([this.endpoint.execute(code, filename), this.failed]);
  }

  async runFile(filename: string): Promise<ExecutionOutcome> {
    await this.ready;
    return Promise.race([this.endpoint.runFile(filename), this.failed]);
  }

  clearCache(): void {
    this.endpoint.clearCache();
  }

  getVolume(): MemoryVolume {
    return this.vol;
  }

  terminate(): void {
    if (this.onFileChange) this.vol.off('write', this.onFileChange);
    if (this.onFileDelete) this.vol.off('delete', this.onFileDelete);
    this.thread.terminate();
  }
}
