// stub - not available in browser


import { EventEmitter } from "./events.js";

/* ------------------------------------------------------------------ */
/*  Session                                                            */
/* ------------------------------------------------------------------ */

export interface Session extends EventEmitter {
  connect(): void;
  connectToMainThread(): void;
  disconnect(): void;
  post(
    _method: string,
    _params?: object,
    _cb?: (err: Error | null, result?: object) => void,
  ): void;
}

export const Session = function Session(this: any) {
  if (!this) return;
  EventEmitter.call(this);
} as unknown as { new(): Session; prototype: any };

Object.setPrototypeOf(Session.prototype, EventEmitter.prototype);

Session.prototype.connect = function connect(): void {};
Session.prototype.connectToMainThread = function connectToMainThread(): void {};
Session.prototype.disconnect = function disconnect(): void {};
Session.prototype.post = function post(
  _method: string,
  _params?: object,
  _cb?: (err: Error | null, result?: object) => void,
): void {
  if (_cb) setTimeout(() => _cb(null, {}), 0);
};

/* ------------------------------------------------------------------ */
/*  Module-level helpers                                               */
/* ------------------------------------------------------------------ */

export function open(_port?: number, _host?: string, _wait?: boolean): void {}
export function close(): void {}
export function url(): string | undefined {
  return undefined;
}
export function waitForDebugger(): void {}const nativeConsole: Console = globalThis.console;
export { nativeConsole as console };

/* ------------------------------------------------------------------ */
/*  Default export                                                     */
/* ------------------------------------------------------------------ */

export default {
  Session,
  open,
  close,
  url,
  waitForDebugger,
  console: nativeConsole,
};
