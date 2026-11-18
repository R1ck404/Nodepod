// stub - not available in browser


import { EventEmitter } from "./events.js";
import { getRegistry, type Handle } from "../helpers/event-loop.js";

/* ------------------------------------------------------------------ */
/*  Sessions                                                           */
/* ------------------------------------------------------------------ */

export interface Http2Session extends EventEmitter {
  close(done?: () => void): void;
  destroy(_err?: Error, _code?: number): void;
  readonly destroyed: boolean;
  readonly encrypted: boolean;
  readonly closed: boolean;
  ping(_cb: (err: Error | null, dur: number, buf: Uint8Array) => void): boolean;
  ref(): void;
  unref(): void;
  setTimeout(_ms: number, _cb?: () => void): void;
}

export const Http2Session = function Http2Session(this: any) {
  if (!this) return;
  EventEmitter.call(this);
  this._elHandle = getRegistry().register("HTTP2Session");
  this._closed = false;
  this._destroyed = false;
} as unknown as { new(): Http2Session; prototype: any };

Object.setPrototypeOf(Http2Session.prototype, EventEmitter.prototype);

Http2Session.prototype.close = function close(done?: () => void): void {
  this._closed = true;
  (this._elHandle as Handle | null)?.close();
  this._elHandle = null;
  if (done) setTimeout(done, 0);
};
Http2Session.prototype.destroy = function destroy(_err?: Error, _code?: number): void {
  this._destroyed = true;
  this._closed = true;
  (this._elHandle as Handle | null)?.close();
  this._elHandle = null;
};
Object.defineProperty(Http2Session.prototype, 'destroyed', {
  get() { return !!this._destroyed; },
  configurable: true,
});
Object.defineProperty(Http2Session.prototype, 'encrypted', { get() { return false; }, configurable: true });
Object.defineProperty(Http2Session.prototype, 'closed', {
  get() { return !!this._closed; },
  configurable: true,
});
Http2Session.prototype.ping = function ping(
  _cb: (err: Error | null, dur: number, buf: Uint8Array) => void,
): boolean { return false; };
Http2Session.prototype.ref = function ref(): void { (this._elHandle as Handle | null)?.ref(); };
Http2Session.prototype.unref = function unref(): void { (this._elHandle as Handle | null)?.unref(); };
Http2Session.prototype.setTimeout = function setTimeout(_ms: number, _cb?: () => void): void {};

export interface ClientHttp2Session extends Http2Session {}

export const ClientHttp2Session = function ClientHttp2Session(this: any) {
  if (!this) return;
  (Http2Session as any).call(this);
} as unknown as { new(): ClientHttp2Session; prototype: any };

Object.setPrototypeOf(ClientHttp2Session.prototype, Http2Session.prototype);

export interface ServerHttp2Session extends Http2Session {}

export const ServerHttp2Session = function ServerHttp2Session(this: any) {
  if (!this) return;
  (Http2Session as any).call(this);
} as unknown as { new(): ServerHttp2Session; prototype: any };

Object.setPrototypeOf(ServerHttp2Session.prototype, Http2Session.prototype);

/* ------------------------------------------------------------------ */
/*  Streams                                                            */
/* ------------------------------------------------------------------ */

export interface Http2Stream extends EventEmitter {
  close(_code?: number, _cb?: () => void): void;
  readonly id: number;
  readonly pending: boolean;
  readonly destroyed: boolean;
  readonly closed: boolean;
  priority(_opts: unknown): void;
  setTimeout(_ms: number, _cb?: () => void): void;
  end(_data?: unknown, _enc?: string, _cb?: () => void): void;
}

export const Http2Stream = function Http2Stream(this: any) {
  if (!this) return;
  EventEmitter.call(this);
  this._closed = false;
  this._destroyed = false;
} as unknown as { new(): Http2Stream; prototype: any };

Object.setPrototypeOf(Http2Stream.prototype, EventEmitter.prototype);

Http2Stream.prototype.close = function close(_code?: number, _cb?: () => void): void {
  this._closed = true;
  if (_cb) setTimeout(_cb, 0);
};
Object.defineProperty(Http2Stream.prototype, 'id', { get() { return 0; }, configurable: true });
Object.defineProperty(Http2Stream.prototype, 'pending', { get() { return false; }, configurable: true });
Object.defineProperty(Http2Stream.prototype, 'destroyed', {
  get() { return !!this._destroyed; },
  configurable: true,
});
Object.defineProperty(Http2Stream.prototype, 'closed', {
  get() { return !!this._closed; },
  configurable: true,
});
Http2Stream.prototype.priority = function priority(_opts: unknown): void {};
Http2Stream.prototype.setTimeout = function setTimeout(_ms: number, _cb?: () => void): void {};
Http2Stream.prototype.end = function end(_data?: unknown, _enc?: string, _cb?: () => void): void {
  this._closed = true;
  if (typeof _cb === "function") setTimeout(_cb, 0);
  else if (typeof _enc === "function") setTimeout(_enc as () => void, 0);
};

/* ------------------------------------------------------------------ */
/*  Request / Response                                                 */
/* ------------------------------------------------------------------ */

export interface Http2ServerRequest extends EventEmitter {}

export const Http2ServerRequest = function Http2ServerRequest(this: any) {
  if (!this) return;
  EventEmitter.call(this);
} as unknown as { new(): Http2ServerRequest; prototype: any };

Object.setPrototypeOf(Http2ServerRequest.prototype, EventEmitter.prototype);

export interface Http2ServerResponse extends EventEmitter {
  writeHead(_code: number, _hdrs?: object): this;
  end(_data?: unknown): void;
}

export const Http2ServerResponse = function Http2ServerResponse(this: any) {
  if (!this) return;
  EventEmitter.call(this);
} as unknown as { new(): Http2ServerResponse; prototype: any };

Object.setPrototypeOf(Http2ServerResponse.prototype, EventEmitter.prototype);

Http2ServerResponse.prototype.writeHead = function writeHead(_code: number, _hdrs?: object) { return this; };
Http2ServerResponse.prototype.end = function end(_data?: unknown): void {};

/* ------------------------------------------------------------------ */
/*  Factories                                                          */
/* ------------------------------------------------------------------ */

export function createServer(
  _opts?: unknown,
  _handler?: unknown,
): EventEmitter {
  return new EventEmitter();
}

export function createSecureServer(
  _opts?: unknown,
  _handler?: unknown,
): EventEmitter {
  return new EventEmitter();
}

export function connect(
  _authority: string,
  _opts?: unknown,
  _cb?: () => void,
): ClientHttp2Session {
  return new ClientHttp2Session();
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const constants = {
  NGHTTP2_SESSION_SERVER: 0,
  NGHTTP2_SESSION_CLIENT: 1,
  HTTP2_HEADER_STATUS: ":status",
  HTTP2_HEADER_METHOD: ":method",
  HTTP2_HEADER_AUTHORITY: ":authority",
  HTTP2_HEADER_SCHEME: ":scheme",
  HTTP2_HEADER_PATH: ":path",
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_NOT_FOUND: 404,
};

/* ------------------------------------------------------------------ */
/*  Settings helpers                                                   */
/* ------------------------------------------------------------------ */

export function getDefaultSettings(): object {
  return {};
}

export function getPackedSettings(_settings?: object): Uint8Array {
  return new Uint8Array(0);
}

export function getUnpackedSettings(_buf: Uint8Array): object {
  return {};
}

export const sensitiveHeaders = Symbol("sensitiveHeaders");

/* ------------------------------------------------------------------ */
/*  Default export                                                     */
/* ------------------------------------------------------------------ */

export default {
  Http2Session,
  ClientHttp2Session,
  ServerHttp2Session,
  Http2Stream,
  Http2ServerRequest,
  Http2ServerResponse,
  createServer,
  createSecureServer,
  connect,
  constants,
  getDefaultSettings,
  getPackedSettings,
  getUnpackedSettings,
  sensitiveHeaders,
};
