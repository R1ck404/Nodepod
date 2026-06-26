// executes code in a dedicated Web Worker behind the IScriptEngine interface

import { wrap, proxy, Remote } from 'comlink';
import type { IVolume } from './types/volume';
import type { IScriptEngine, ExecutionOutcome, EngineConfig, VolumeSnapshot } from './engine-types';

interface WorkerEndpoint {
  init(snapshot: VolumeSnapshot, config: EngineConfig): void;
  setConsoleForwarder(cb: ((method: string, args: unknown[]) => void) | null): void;
  syncFile(path: string, content: string | null): void;
  execute(code: string, filename?: string): Promise<ExecutionOutcome>;
  runFile(filename: string): Promise<ExecutionOutcome>;
  clearCache(): void;
  getSnapshot(): VolumeSnapshot | null;
}

// URL is built at runtime so bundlers can't statically resolve it
function createWorker(): Worker {
  const base = import.meta.url;
  const path = './threading/engine-worker' + '.ts';
  const url = new (globalThis.URL)(path, base);
  return new (globalThis.Worker)(url, { type: 'module' });
}

export class WorkerSandbox implements IScriptEngine {
  private thread: Worker;
  private endpoint: Remote<WorkerEndpoint>;
  private vol: IVolume;
  private cfg: EngineConfig;
  private ready: Promise<void>;
  private onFileChange: ((path: string, content: string) => void) | null = null;
  private onFileDelete: ((path: string) => void) | null = null;

  constructor(vol: IVolume, cfg: EngineConfig = {}) {
    this.vol = vol;
    this.cfg = cfg;

    this.thread = createWorker();

    this.endpoint = wrap<WorkerEndpoint>(this.thread);
    this.ready = this.bootstrap();
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
    this.onFileChange = (path: string, content: string) => {
      this.endpoint.syncFile(path, content);
    };
    this.vol.on('change', this.onFileChange);

    this.onFileDelete = (path: string) => {
      this.endpoint.syncFile(path, null);
    };
    this.vol.on('delete', this.onFileDelete);
  }

  async execute(code: string, filename?: string): Promise<ExecutionOutcome> {
    await this.ready;
    return this.endpoint.execute(code, filename);
  }

  async runFile(filename: string): Promise<ExecutionOutcome> {
    await this.ready;
    return this.endpoint.runFile(filename);
  }

  clearCache(): void {
    this.endpoint.clearCache();
  }

  getVolume(): IVolume {
    return this.vol;
  }

  terminate(): void {
    if (this.onFileChange) this.vol.off('change', this.onFileChange);
    if (this.onFileDelete) this.vol.off('delete', this.onFileDelete);
    this.thread.terminate();
  }
}
