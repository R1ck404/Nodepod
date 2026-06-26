// executes code in a cross-origin iframe for maximum browser isolation

import type { IVolume } from './types/volume';
import type { IScriptEngine, ExecutionOutcome, EngineConfig, VolumeSnapshot } from './engine-types';

interface CrossOriginMessage {
  type: 'init' | 'execute' | 'runFile' | 'clearCache' | 'syncFile' | 'ready' | 'result' | 'error' | 'console';
  id?: string;
  code?: string;
  filename?: string;
  snapshot?: VolumeSnapshot;
  config?: EngineConfig;
  result?: ExecutionOutcome;
  error?: string;
  path?: string;
  content?: string | null;
  consoleMethod?: string;
  consoleArgs?: unknown[];
}

export class IframeSandbox implements IScriptEngine {
  private frame: HTMLIFrameElement;
  private targetOrigin: string;
  private vol: IVolume;
  private cfg: EngineConfig;
  private ready: Promise<void>;
  private pendingCalls = new Map<string, { resolve: (r: ExecutionOutcome) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private onFileChange: ((p: string, c: string) => void) | null = null;
  private onFileDelete: ((p: string) => void) | null = null;
  private onMessage: ((e: MessageEvent) => void) | null = null;

  constructor(sandboxUrl: string, vol: IVolume, cfg: EngineConfig = {}) {
    this.targetOrigin = new URL(sandboxUrl).origin;
    this.vol = vol;
    this.cfg = cfg;

    this.frame = document.createElement('iframe');
    this.frame.src = sandboxUrl;
    this.frame.style.display = 'none';
    // @ts-expect-error - credentialless attribute may not exist in types
    this.frame.credentialless = true;
    this.frame.setAttribute('credentialless', '');
    this.frame.setAttribute('sandbox', 'allow-scripts');
    document.body.appendChild(this.frame);

    this.bindMessageHandler();
    this.ready = this.awaitReady().then(() => this.sendInit());
    this.attachVolumeSync();
  }

  private bindMessageHandler(): void {
    this.onMessage = (event: MessageEvent) => {
      // sandbox="allow-scripts" without allow-same-origin makes the origin "null"
      if (event.origin !== 'null' && event.origin !== this.targetOrigin) return;
      const msg = event.data as CrossOriginMessage;

      if (msg.type === 'result' && msg.id) {
        const pending = this.pendingCalls.get(msg.id);
        if (pending && msg.result) { pending.resolve(msg.result); this.pendingCalls.delete(msg.id); }
      } else if (msg.type === 'error' && msg.id) {
        const pending = this.pendingCalls.get(msg.id);
        if (pending) { pending.reject(new Error(msg.error || 'Sandbox error')); this.pendingCalls.delete(msg.id); }
      } else if (msg.type === 'console' && this.cfg.onConsole) {
        this.cfg.onConsole(msg.consoleMethod || 'log', msg.consoleArgs || []);
      }
    };
    window.addEventListener('message', this.onMessage);
  }

  private awaitReady(): Promise<void> {
    return new Promise(resolve => {
      const handler = (event: MessageEvent) => {
        if (event.origin !== 'null' && event.origin !== this.targetOrigin) return;
        if ((event.data as CrossOriginMessage).type === 'ready') {
          window.removeEventListener('message', handler);
          resolve();
        }
      };
      window.addEventListener('message', handler);
    });
  }

  private async sendInit(): Promise<void> {
    const msg: CrossOriginMessage = {
      type: 'init',
      snapshot: this.vol.toSnapshot(),
      config: { cwd: this.cfg.cwd, env: this.cfg.env },
    };
    // '*' is fine here — we're posting to this.frame.contentWindow directly,
    // and sandboxed iframes have a "null" origin so we cant target them specifically
    this.frame.contentWindow?.postMessage(msg, '*');
  }

  private attachVolumeSync(): void {
    this.onFileChange = (path, content) => {
      this.frame.contentWindow?.postMessage({ type: 'syncFile', path, content } as CrossOriginMessage, '*');
    };
    this.vol.on('change', this.onFileChange);

    this.onFileDelete = (path) => {
      this.frame.contentWindow?.postMessage({ type: 'syncFile', path, content: null } as CrossOriginMessage, '*');
    };
    this.vol.on('delete', this.onFileDelete);
  }

  private dispatch(msg: CrossOriginMessage): Promise<ExecutionOutcome> {
    return new Promise((resolve, reject) => {
      const id = String(this.nextId++);
      this.pendingCalls.set(id, { resolve, reject });
      this.frame.contentWindow?.postMessage({ ...msg, id }, '*');
      setTimeout(() => {
        if (this.pendingCalls.has(id)) {
          this.pendingCalls.delete(id);
          reject(new Error('Sandbox execution timeout'));
        }
      }, 60000);
    });
  }

  async execute(code: string, filename?: string): Promise<ExecutionOutcome> {
    await this.ready;
    return this.dispatch({ type: 'execute', code, filename });
  }

  async runFile(filename: string): Promise<ExecutionOutcome> {
    await this.ready;
    return this.dispatch({ type: 'runFile', filename });
  }

  clearCache(): void {
    this.frame.contentWindow?.postMessage({ type: 'clearCache' } as CrossOriginMessage, '*');
  }

  getVolume(): IVolume { return this.vol; }

  terminate(): void {
    if (this.onFileChange) this.vol.off('change', this.onFileChange);
    if (this.onFileDelete) this.vol.off('delete', this.onFileDelete);
    if (this.onMessage) window.removeEventListener('message', this.onMessage);
    this.frame.remove();
    for (const [, { reject }] of this.pendingCalls) reject(new Error('Sandbox terminated'));
    this.pendingCalls.clear();
  }
}
