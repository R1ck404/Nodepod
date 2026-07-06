// Process handle returned by nodepod.spawn().
// Emits 'output', 'error', 'exit'. Has write() for stdin and kill() to abort.

import { EventEmitter } from "../polyfills/events";

export class NodepodProcess extends EventEmitter {
  private _abortController = new AbortController();
  private _resolve!: (r: {
    stdout: string;
    stderr: string;
    exitCode: number;
  }) => void;
  private _stdout = "";
  private _stderr = "";
  private _exitCode: number | null = null;
  private _sendStdinFn: ((data: string) => void) | null = null;
  private _killFn: (() => void) | null = null;
  private _maxOutputBytes: number;

  // Resolves when the process exits -- use `await proc.completion`
  readonly completion: Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;

  constructor(maxOutputBytes = 4_194_304) {
    super();
    this._maxOutputBytes = maxOutputBytes;
    this.completion = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  _setSendStdin(fn: (data: string) => void): void {
    this._sendStdinFn = fn;
  }

  _setKillFn(fn: () => void): void {
    this._killFn = fn;
  }

  _pushStdout(chunk: string): void {
    this._stdout += chunk;
    if (this._stdout.length > this._maxOutputBytes) {
      this._stdout = this._stdout.slice(-Math.floor(this._maxOutputBytes * 0.75));
    }
    this.emit("output", chunk);
  }

  _pushStderr(chunk: string): void {
    this._stderr += chunk;
    if (this._stderr.length > this._maxOutputBytes) {
      this._stderr = this._stderr.slice(-Math.floor(this._maxOutputBytes * 0.75));
    }
    this.emit("error", chunk);
  }

  // Worker exit messages carry the full buffered stdout/stderr. Streaming chunks
  // may be missing (e.g. output only flushed at process end), so merge any tail.
  _mergeExitOutput(stdout?: string, stderr?: string): void {
    if (stdout && stdout.length > this._stdout.length) {
      this._pushStdout(stdout.slice(this._stdout.length));
    }
    if (stderr && stderr.length > this._stderr.length) {
      this._pushStderr(stderr.slice(this._stderr.length));
    }
  }

  // Idempotent -- safe to call twice
  _finish(exitCode: number): void {
    if (this._exitCode !== null) return;
    this._exitCode = exitCode;
    this.emit("exit", exitCode);
    this._resolve({
      stdout: this._stdout,
      stderr: this._stderr,
      exitCode,
    });
  }

  get signal(): AbortSignal {
    return this._abortController.signal;
  }

  get exited(): boolean {
    return this._exitCode !== null;
  }

  write(data: string): void {
    if (this._sendStdinFn) this._sendStdinFn(data);
  }

  kill(): void {
    this._abortController.abort();
    if (this._killFn) this._killFn();
  }

  on(event: "output", handler: (chunk: string) => void): this;
  on(event: "error", handler: (chunk: string) => void): this;
  on(event: "exit", handler: (code: number) => void): this;
  on(event: string, handler: (...args: any[]) => void): this {
    return super.on(event, handler) as this;
  }
}
