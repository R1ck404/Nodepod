// spawns a ScriptEngine in the requested execution mode:
// sandboxUrl → cross-origin iframe, useWorker → Worker thread, otherwise main thread

import { ScriptEngine } from './script-engine';
import { WorkerSandbox } from './worker-sandbox';
import { IframeSandbox } from './iframe-sandbox';
import type { IVolume } from './types/volume';
import type { IScriptEngine, ExecutionOutcome, SpawnEngineConfig, EngineConfig } from './engine-types';
import { ProcessManager } from './threading/process-manager';
import { VFSBridge } from './threading/vfs-bridge';

function canUseWorker(): boolean {
  return typeof Worker !== 'undefined';
}

// wraps the synchronous ScriptEngine behind the async IScriptEngine interface
class SyncEngineAdapter implements IScriptEngine {
  private engine: ScriptEngine;

  constructor(vol: IVolume, cfg: EngineConfig = {}) {
    this.engine = new ScriptEngine(vol, cfg);
  }

  async execute(code: string, filename?: string): Promise<ExecutionOutcome> {
    return Promise.resolve(this.engine.execute(code, filename));
  }

  async runFile(filename: string): Promise<ExecutionOutcome> {
    return Promise.resolve(this.engine.runFile(filename));
  }

  clearCache(): void { this.engine.clearCache(); }
  getVolume(): IVolume { return this.engine.getVolume(); }

  unwrap(): ScriptEngine { return this.engine; }
}

// create a script engine in the appropriate execution mode
// throws if neither sandboxUrl nor allowUnsafeEval is specified
export async function spawnEngine(
  vol: IVolume,
  config: SpawnEngineConfig = {},
): Promise<IScriptEngine> {
  const { sandboxUrl, allowUnsafeEval, useWorker = false, ...engineCfg } = config;

  if (sandboxUrl) {
    const sandbox = new IframeSandbox(sandboxUrl, vol, engineCfg);
    await sandbox.execute('/* sandbox ready check */', '/__sandbox_init__.js');
    return sandbox;
  }

  if (!allowUnsafeEval) {
    throw new Error(
      'nodepod: For security, you must either:\n' +
      '  1. Use sandbox mode: { sandboxUrl: "https://your-sandbox.example.com" }\n' +
      '  2. Explicitly opt-in to same-origin: { allowUnsafeEval: true }\n\n' +
      'Same-origin execution allows code to access cookies, localStorage, and IndexedDB.\n' +
      'Only use allowUnsafeEval for trusted code or demos.'
    );
  }

  let shouldUseWorker = false;
  if (useWorker === true) {
    shouldUseWorker = canUseWorker();
  } else if (useWorker === 'auto') {
    shouldUseWorker = canUseWorker();
  }

  if (shouldUseWorker) {
    const worker = new WorkerSandbox(vol, engineCfg);
    await worker.execute('/* worker ready check */', '/__worker_init__.js');
    return worker;
  }

  return new SyncEngineAdapter(vol, engineCfg);
}

// ---- Process-worker engine adapter ----

// wraps ProcessManager-based workers behind IScriptEngine.
// each execute()/runFile() spawns a new worker process.
class ProcessWorkerAdapter implements IScriptEngine {
  private _vol: IVolume;
  private _processManager: ProcessManager;
  private _vfsBridge: VFSBridge;
  private _cfg: EngineConfig;

  constructor(vol: IVolume, cfg: EngineConfig = {}) {
    this._vol = vol;
    this._cfg = cfg;
    this._processManager = new ProcessManager(vol);
    this._vfsBridge = new VFSBridge(vol);
    this._processManager.setVFSBridge(this._vfsBridge);

    this._vfsBridge.setBroadcaster((path, content, excludePid) => {
      const isDirectory = content !== null && content.byteLength === 0;
      this._processManager.broadcastVFSChange(path, content, isDirectory, excludePid);
    });
  }

  async execute(code: string, filename?: string): Promise<ExecutionOutcome> {
    const tmpFile = filename ?? '/__exec_tmp__.js';
    this._vol.writeFileSync(tmpFile, code as any);

    const result = await this._runInWorker(tmpFile);
    return result;
  }

  async runFile(filename: string): Promise<ExecutionOutcome> {
    return this._runInWorker(filename);
  }

  private async _runInWorker(filePath: string): Promise<ExecutionOutcome> {
    return new Promise<ExecutionOutcome>((resolve) => {
      const handle = this._processManager.spawn({
        command: 'node',
        args: [filePath],
        cwd: this._cfg.cwd ?? '/',
        env: (this._cfg as any).env ?? {},
      });

      let stdout = '';
      let stderr = '';

      handle.on('stdout', (data: string) => { stdout += data; });
      handle.on('stderr', (data: string) => { stderr += data; });

      handle.on('ready', () => {
        handle.exec({
          type: 'exec',
          filePath,
          args: [],
          cwd: this._cfg.cwd,
          env: (this._cfg as any).env,
        });
      });

      handle.on('exit', (_exitCode: number) => {
        resolve({
          exports: {},
          module: {
            id: filePath,
            filename: filePath,
            exports: {},
            loaded: true,
            children: [],
            paths: [],
          },
        });
      });
    });
  }

  clearCache(): void { }
  getVolume(): IVolume { return this._vol; }

  getProcessManager(): ProcessManager { return this._processManager; }

  teardown(): void {
    this._processManager.teardown();
  }
}

// create a process-worker engine where each execution runs in a dedicated Web Worker
export async function spawnProcessWorkerEngine(
  vol: IVolume,
  config: EngineConfig = {},
): Promise<ProcessWorkerAdapter> {
  return new ProcessWorkerAdapter(vol, config);
}

export { ScriptEngine } from './script-engine';
export { WorkerSandbox } from './worker-sandbox';
export { IframeSandbox } from './iframe-sandbox';
export { ProcessWorkerAdapter };
export type { IScriptEngine, ExecutionOutcome, EngineConfig, SpawnEngineConfig, VolumeSnapshot } from './engine-types';
