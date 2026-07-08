// HTTP polyfill -- IncomingMessage, ServerResponse, Server, ClientRequest (fetch-backed),
// createServer, request, get, Agent, STATUS_CODES, WebSocket upgrade bridging.
// Uses function constructors (not classes) for pre-ES6 inheritance compat.

import { EventEmitter, type EventHandler } from "./events";
import { Readable, Writable } from "./stream";
import { Buffer } from "./buffer";
import { TcpSocket, TcpServer, type NetAddress } from "./net";
import { createHash } from "./crypto";
import { resolveProxyUrl } from "../cross-origin";
import { fetchHeadersToNodeRecord } from "./fetch-response";
// no event-loop import, the net.Server under us already registers TCPServerWrap
import { TIMEOUTS } from "../constants/config";

// capture real browser WebSocket before any bundled lib can overwrite it
const _runningInBrowser =
  typeof window !== "undefined" && typeof window.document !== "undefined";
const _NativeWebSocket: typeof globalThis.WebSocket | null =
  _runningInBrowser && typeof globalThis.WebSocket === "function"
    ? globalThis.WebSocket
    : null;

// Types

export type HttpHandler = (
  incoming: IncomingMessage,
  outgoing: ServerResponse,
) => void | Promise<void>;

export interface ConnectionOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string | string[]>;
  hostname?: string;
  host?: string;
  port?: number;
}

export interface CompletedResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

// IncomingMessage

export interface IncomingMessage extends Readable {
  httpVersion: string;
  httpVersionMajor: number;
  httpVersionMinor: number;
  complete: boolean;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  trailers: Record<string, string | undefined>;
  rawTrailers: string[];
  method?: string;
  url?: string;
  statusCode?: number;
  statusMessage?: string;
  aborted: boolean;
  socket: TcpSocket;
  connection: TcpSocket;
  setTimeout(ms: number, handler?: () => void): this;
  destroy(err?: Error): this;
  _injectBody(raw: Buffer | string | null): void;
}

export interface IncomingMessageConstructor {
  new (sock?: TcpSocket): IncomingMessage;
  (this: any, sock?: TcpSocket): void;
  prototype: any;
  build(
    verb: string,
    target: string,
    hdrs: Record<string, string>,
  ): IncomingMessage;
}

export const IncomingMessage = function IncomingMessage(this: any, sock?: TcpSocket) {
  if (!this) return;
  Readable.call(this);

  this.httpVersion = "1.1";
  this.httpVersionMajor = 1;
  this.httpVersionMinor = 1;
  this.complete = false;
  this.headers = {};
  this.rawHeaders = [];
  this.trailers = {};
  this.rawTrailers = [];
  this.method = undefined;
  this.url = undefined;
  this.statusCode = undefined;
  this.statusMessage = undefined;
  this.aborted = false;
  this._payload = null;
  this.socket = sock ?? new TcpSocket();
  this.connection = this.socket;
} as unknown as IncomingMessageConstructor;

Object.setPrototypeOf(IncomingMessage.prototype, Readable.prototype);

IncomingMessage.prototype.setTimeout = function setTimeout(ms: number, handler?: () => void): any {
  if (handler) this.once("timeout", handler);
  return this;
};

IncomingMessage.prototype.destroy = function destroy(err?: Error): any {
  Readable.prototype.destroy.call(this, err);
  return this;
};

IncomingMessage.prototype._injectBody = function _injectBody(raw: Buffer | string | null): void {
  if (raw !== null && raw !== undefined) {
    this.push(typeof raw === "string" ? Buffer.from(raw) : raw);
  }
  this.push(null);
  this.complete = true;
};

function ensureContentLength(
  hdrs: Record<string, string | string[] | undefined>,
  payload?: Buffer | string | null,
): void {
  if (payload === undefined || payload === null) return;
  const hasLength = Object.keys(hdrs).some((k) => k.toLowerCase() === "content-length");
  const hasTe = Object.keys(hdrs).some((k) => k.toLowerCase() === "transfer-encoding");
  if (hasLength || hasTe) return;
  const bytes = typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
  hdrs["content-length"] = String(bytes);
}

IncomingMessage.build = function build(
  verb: string,
  target: string,
  hdrs: Record<string, string>,
): IncomingMessage {
  const sock = new TcpSocket();
  sock.remoteAddress = "127.0.0.1";
  sock.remotePort = 0;
  sock.remoteFamily = "IPv4";
  const msg = new IncomingMessage(sock);
  msg.method = verb;
  msg.url = target;
  // Node.js always lowercases header keys in req.headers
  const lowerHdrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(hdrs)) {
    lowerHdrs[k.toLowerCase()] = v;
    msg.rawHeaders.push(k, v);
  }
  msg.headers = lowerHdrs;
  return msg;
};

/** Populate IncomingMessage headers + rawHeaders with Node-correct set-cookie pairs. */
function applyHeadersToIncomingMessage(
  msg: IncomingMessage,
  headers: Record<string, string | string[] | undefined>,
): void {
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    msg.headers[lk] = v;
    if (lk === "set-cookie") {
      const cookies = Array.isArray(v) ? v : [v];
      for (const cookie of cookies) {
        msg.rawHeaders.push("set-cookie", cookie);
      }
    } else {
      msg.rawHeaders.push(k, Array.isArray(v) ? v.join(", ") : v);
    }
  }
}

// ServerResponse

export interface ServerResponse extends Writable {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  finished: boolean;
  sendDate: boolean;
  socket: TcpSocket | null;
  req: IncomingMessage;
  connection: TcpSocket | null;
  _onComplete(fn: (r: CompletedResponse) => void): void;
  assignSocket(socket: TcpSocket): void;
  detachSocket(socket: TcpSocket): void;
  setHeader(key: string, val: string | string[] | number): this;
  getHeader(key: string): string | string[] | undefined;
  getHeaders(): Record<string, string | string[]>;
  getHeaderNames(): string[];
  hasHeader(key: string): boolean;
  appendHeader(key: string, val: string | string[]): this;
  removeHeader(key: string): void;
  flushHeaders(): void;
  _implicitHeader(): void;
  writeContinue(): void;
  writeProcessing(): void;
  writeEarlyHints(hints: Record<string, string | string[]>, cb?: () => void): void;
  writeHead(code: number, msgOrHdrs?: any, extraHdrs?: any): this;
  write(data: any, encOrCb?: any, cb?: any): boolean;
  end(dataOrCb?: any, encOrCb?: any, cb?: any): this;
  send(payload: string | Buffer | object): this;
  setTimeout(ms: number, handler?: () => void): this;
  json(obj: unknown): this;
  status(c: number): this;
  redirect(target: string | number, loc?: string): void;
  addTrailers(headers: Record<string, string>): void;
  _collectedBody(): Buffer;
  _collectedBodyText(): string;
}

export interface ServerResponseConstructor {
  new (incoming: IncomingMessage): ServerResponse;
  (this: any, incoming: IncomingMessage): void;
  prototype: any;
}

export const ServerResponse = function ServerResponse(this: any, incoming: any) {
  if (!this) return;
  Writable.call(this);

  this.statusCode = 200;
  this.statusMessage = "OK";
  this.headersSent = false;
  this.finished = false;
  this.sendDate = true;
  this.socket = incoming.socket;
  this.connection = incoming.socket;
  this.req = incoming;
  this._hdrs = new Map();
  this._chunks = [];
  this._completionCallback = undefined;
} as unknown as ServerResponseConstructor;

Object.setPrototypeOf(ServerResponse.prototype, Writable.prototype);

ServerResponse.prototype._onComplete = function _onComplete(fn: (r: CompletedResponse) => void): void {
  this._completionCallback = fn;
};

ServerResponse.prototype.assignSocket = function assignSocket(socket: TcpSocket): void {
  this.socket = socket;
  this.connection = socket;
};

ServerResponse.prototype.detachSocket = function detachSocket(_socket: TcpSocket): void {
  this.socket = null;
  this.connection = null;
};

ServerResponse.prototype.setHeader = function setHeader(key: string, val: string | string[] | number): any {
  if (this.headersSent) throw new Error("Headers already dispatched");
  const lk = key.toLowerCase();
  if (Array.isArray(val)) {
    this._hdrs.set(lk, val.map(String));
  } else {
    this._hdrs.set(lk, String(val));
  }
  return this;
};

ServerResponse.prototype.getHeader = function getHeader(key: string): string | string[] | undefined {
  return this._hdrs.get(key.toLowerCase());
};

ServerResponse.prototype.getHeaders = function getHeaders(): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  this._hdrs.forEach((v: string | string[], k: string) => {
    out[k] = v;
  });
  return out;
};

ServerResponse.prototype.getHeaderNames = function getHeaderNames(): string[] {
  return [...this._hdrs.keys()];
};

ServerResponse.prototype.hasHeader = function hasHeader(key: string): boolean {
  return this._hdrs.has(key.toLowerCase());
};

ServerResponse.prototype.appendHeader = function appendHeader(key: string, val: string | string[]): any {
  const lk = key.toLowerCase();
  const incoming = Array.isArray(val) ? val.map(String) : [String(val)];
  const existing = this._hdrs.get(lk);
  if (existing === undefined) {
    this._hdrs.set(lk, lk === "set-cookie" ? incoming : incoming.join(", "));
  } else if (lk === "set-cookie") {
    const cur = Array.isArray(existing) ? existing : [existing];
    this._hdrs.set(lk, cur.concat(incoming));
  } else {
    const cur = Array.isArray(existing) ? existing.join(", ") : existing;
    this._hdrs.set(lk, cur + ", " + incoming.join(", "));
  }
  return this;
};

ServerResponse.prototype.removeHeader = function removeHeader(key: string): void {
  if (this.headersSent) throw new Error("Headers already dispatched");
  this._hdrs.delete(key.toLowerCase());
};

ServerResponse.prototype.flushHeaders = function flushHeaders(): void {
  this.headersSent = true;
};

// Node internal API: flush implicit headers if none were sent explicitly.
// Next.js's response proxy calls res._implicitHeader() from end().
ServerResponse.prototype._implicitHeader = function _implicitHeader(): void {
  if (!this.headersSent) {
    this.writeHead(this.statusCode);
  }
};

ServerResponse.prototype.writeContinue = function writeContinue(): void {
  // No-op in polyfill
};

ServerResponse.prototype.writeProcessing = function writeProcessing(): void {
  // No-op in polyfill
};

ServerResponse.prototype.writeEarlyHints = function writeEarlyHints(
  _hints: Record<string, string | string[]>,
  _cb?: () => void,
): void {
  if (_cb) queueMicrotask(_cb);
};

ServerResponse.prototype.writeHead = function writeHead(
  code: number,
  msgOrHdrs?: string | Record<string, string | string[] | number> | string[],
  extraHdrs?: Record<string, string | string[] | number> | string[],
): any {
  this.statusCode = code;
  if (typeof msgOrHdrs === "string") {
    this.statusMessage = msgOrHdrs;
    if (extraHdrs) {
      if (Array.isArray(extraHdrs)) {
        for (let i = 0; i < extraHdrs.length; i += 2) {
          this.setHeader(extraHdrs[i] as string, extraHdrs[i + 1] as string);
        }
      } else {
        for (const [k, v] of Object.entries(extraHdrs)) this.setHeader(k, v);
      }
    }
  } else if (Array.isArray(msgOrHdrs)) {
    for (let i = 0; i < msgOrHdrs.length; i += 2) {
      this.setHeader(msgOrHdrs[i] as string, msgOrHdrs[i + 1] as string);
    }
  } else if (msgOrHdrs) {
    for (const [k, v] of Object.entries(msgOrHdrs)) this.setHeader(k, v);
  }
  return this;
};

ServerResponse.prototype.write = function write(
  data: Uint8Array | string,
  encOrCb?: BufferEncoding | ((err?: Error | null) => void),
  cb?: (err?: Error | null) => void,
): boolean {
  this.headersSent = true;
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  this._chunks.push(buf);
  const fn = typeof encOrCb === "function" ? encOrCb : cb;
  if (fn) queueMicrotask(() => fn(null));
  return true;
};

ServerResponse.prototype.end = function end(
  dataOrCb?: Uint8Array | string | (() => void),
  encOrCb?: BufferEncoding | (() => void),
  cb?: () => void,
): any {
  if (typeof dataOrCb === "function") {
    cb = dataOrCb;
  } else if (dataOrCb !== undefined) {
    this.write(dataOrCb as Uint8Array | string);
  }
  if (typeof encOrCb === "function") cb = encOrCb;

  this.headersSent = true;
  this.finished = true;
  this.writableEnded = true;
  this.writableFinished = true;

  if (this._completionCallback) {
    const flatHdrs: Record<string, string | string[]> = {};
    this._hdrs.forEach((v: string | string[], k: string) => {
      if (k === "set-cookie" && Array.isArray(v)) {
        flatHdrs[k] = v;
      } else {
        flatHdrs[k] = Array.isArray(v) ? v.join(", ") : v;
      }
    });
    const finalBody = Buffer.concat(this._chunks);
    this._completionCallback({
      statusCode: this.statusCode,
      statusMessage: this.statusMessage,
      headers: flatHdrs,
      body: finalBody,
    });
  }

  const self = this;
  queueMicrotask(() => {
    self.emit("finish");
    if (cb) cb();
  });
  return this;
};

ServerResponse.prototype.send = function send(payload: string | Buffer | object): any {
  if (typeof payload === "object" && !Buffer.isBuffer(payload)) {
    this.setHeader("Content-Type", "application/json");
    payload = JSON.stringify(payload);
  }
  if (!this.hasHeader("Content-Type")) {
    this.setHeader("Content-Type", "text/html");
  }
  this.write(typeof payload === "string" ? payload : payload);
  return this.end();
};

ServerResponse.prototype.setTimeout = function setTimeout(ms: number, handler?: () => void): any {
  if (handler) this.once("timeout", handler);
  return this;
};

ServerResponse.prototype.json = function json(obj: unknown): any {
  this.setHeader("Content-Type", "application/json");
  return this.end(JSON.stringify(obj));
};

ServerResponse.prototype.status = function status(c: number): any {
  this.statusCode = c;
  return this;
};

ServerResponse.prototype.redirect = function redirect(target: string | number, loc?: string): void {
  if (typeof target === "number") {
    this.statusCode = target;
    this.setHeader("Location", loc!);
  } else {
    this.statusCode = 302;
    this.setHeader("Location", target);
  }
  this.end();
};

ServerResponse.prototype.addTrailers = function addTrailers(_headers: Record<string, string>): void {
  // No-op
};

ServerResponse.prototype._collectedBody = function _collectedBody(): Buffer {
  return Buffer.concat(this._chunks);
};

ServerResponse.prototype._collectedBodyText = function _collectedBodyText(): string {
  return this._collectedBody().toString("utf8");
};

// Server

export interface Server extends EventEmitter {
  listening: boolean;
  maxHeadersCount: number | null;
  timeout: number;
  keepAliveTimeout: number;
  headersTimeout: number;
  requestTimeout: number;
  maxRequestsPerSocket: number | null;
  listen(portOrOpts?: any, hostOrCb?: any, cb?: any): this;
  close(cb?: (err?: Error) => void): this;
  address(): NetAddress | null;
  setTimeout(ms?: number, handler?: () => void): this;
  ref(): this;
  unref(): this;
  closeAllConnections(): void;
  closeIdleConnections(): void;
  dispatchUpgrade(target: string, hdrs: Record<string, string>): { req: IncomingMessage; socket: TcpSocket };
  dispatchRequest(verb: string, target: string, hdrs: Record<string, string>, payload?: Buffer | string): Promise<CompletedResponse>;
}

export interface ServerConstructor {
  new (optsOrHandler?: Record<string, unknown> | HttpHandler, handler?: HttpHandler): Server;
  (this: any, optsOrHandler?: Record<string, unknown> | HttpHandler, handler?: HttpHandler): void;
  prototype: any;
}

export const Server = function Server(
  this: any,
  optsOrHandler?: Record<string, unknown> | HttpHandler,
  handler?: HttpHandler,
) {
  if (!this) return;
  EventEmitter.call(this);

  if (typeof optsOrHandler === "function") {
    this._handler = optsOrHandler;
  } else {
    this._handler = handler;
  }
  this._tcp = new TcpServer();

  this.listening = false;
  this.maxHeadersCount = null;
  this.timeout = 0;
  this.keepAliveTimeout = TIMEOUTS.HTTP_KEEP_ALIVE;
  this.headersTimeout = TIMEOUTS.HTTP_HEADERS;
  this.requestTimeout = 0;
  this.maxRequestsPerSocket = null;

  const self = this;
  this._tcp.on("listening", function onListening() {
    self.listening = true;
    self.emit("listening");
  });
  this._tcp.on("close", function onClose() {
    self.listening = false;
    self.emit("close");
  });
  this._tcp.on("error", function onError(e: unknown) { self.emit("error", e); });
} as unknown as ServerConstructor;

Object.setPrototypeOf(Server.prototype, EventEmitter.prototype);

Server.prototype.listen = function listen(
  portOrOpts?: number | { port?: number; host?: string },
  hostOrCb?: string | (() => void),
  cb?: () => void,
): any {
  let port: number | undefined;
  let host: string | undefined;
  let done: (() => void) | undefined;

  if (typeof portOrOpts === "number") {
    port = portOrOpts;
    if (typeof hostOrCb === "string") {
      host = hostOrCb;
      done = cb;
    } else done = hostOrCb;
  } else if (portOrOpts) {
    port = portOrOpts.port;
    host = portOrOpts.host;
    done = typeof hostOrCb === "function" ? hostOrCb : cb;
  }

  const self = this;
  const origDone = done;
  done = function onBound() {
    const addr = self._tcp.address();
    if (addr) _addServer(addr.port, self);
    if (origDone) origDone();
  };

  this._tcp.listen(port, host, done);
  return this;
};

Server.prototype.close = function close(cb?: (err?: Error) => void): any {
  const addr = this._tcp.address();
  if (addr) _removeServer(addr.port);
  this._tcp.close(cb);
  return this;
};

Server.prototype.address = function address(): NetAddress | null {
  return this._tcp.address();
};

Server.prototype.setTimeout = function setTimeout(ms?: number, handler?: () => void): any {
  this.timeout = ms || 0;
  if (handler) this.on("timeout", handler);
  return this;
};

Server.prototype.ref = function ref(): any {
  this._tcp.ref();
  return this;
};

Server.prototype.unref = function unref(): any {
  this._tcp.unref();
  return this;
};

Server.prototype.closeAllConnections = function closeAllConnections(): void {
  // No-op
};

Server.prototype.closeIdleConnections = function closeIdleConnections(): void {
  // No-op
};

Server.prototype.dispatchUpgrade = function dispatchUpgrade(
  target: string,
  hdrs: Record<string, string>,
): { req: IncomingMessage; socket: TcpSocket } {
  const socket = new TcpSocket();
  (socket as any).cork = () => {};
  (socket as any).uncork = () => {};
  (socket as any)._readableState = { endEmitted: false };
  (socket as any)._writableState = { finished: false, errorEmitted: false };

  const req = new IncomingMessage(socket);
  req.method = "GET";
  req.url = target;
  req.headers = {
    ...hdrs,
    upgrade: "websocket",
    connection: "Upgrade",
  };
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") req.rawHeaders.push(k, v);
  }
  req.push(null);
  req.complete = true;

  const self = this;
  queueMicrotask(() => {
    const listeners = self.listenerCount("upgrade");
    if (listeners === 0) {
      // no 'upgrade' handler means WS handshake never writes, silently breaks HMR, surface it instead of hanging
      console.warn(`[http.dispatchUpgrade] no 'upgrade' listener on server for ${target} — WS handshake will not complete`);
    }
    self.emit("upgrade", req, socket, Buffer.alloc(0));
  });

  return { req, socket };
};

Server.prototype.dispatchRequest = async function dispatchRequest(
  verb: string,
  target: string,
  hdrs: Record<string, string>,
  payload?: Buffer | string,
): Promise<CompletedResponse> {
  const self = this;
  return new Promise((resolve, reject) => {
    const req = IncomingMessage.build(verb, target, hdrs);
    const res = new ServerResponse(req);
    res._onComplete((completed) => {
      resolve(completed);
    });

    const timeoutMs = self.timeout || TIMEOUTS.HTTP_DISPATCH_SAFETY;
    const timer = setTimeout(() => {
      // tell the user which request stalled so they can correlate it with
      // whatever wasi/rolldown chatter was going on
      try {
        const stderr = (globalThis as any).process?.stderr;
        const line = `[nodepod] dispatchRequest TIMEOUT after ${timeoutMs}ms for ${verb} ${target}, middleware never responded\n`;
        if (stderr && typeof stderr.write === "function") stderr.write(line);
        else console.error(line);
      } catch {}
      reject(
        new Error(
          `dispatchRequest timed out after ${timeoutMs}ms for ${verb} ${target}`,
        ),
      );
    }, timeoutMs);

    res.on("finish", () => {
      clearTimeout(timer);
    });

    // surface middleware errors to both console.error AND stderr.write so they
    // reach the parent log even from inside a worker. without this a 500 on
    // /src/index.css is silent.
    const reportErr = (kind: "async" | "sync", err: unknown) => {
      const msg = (err as Error)?.message || String(err);
      const stack = (err as Error)?.stack?.split("\n").slice(0, 8).join("\n") ?? "";
      const line = `[nodepod] dispatchRequest ${kind} error on ${verb} ${target}: ${msg}\n${stack}\n`;
      try { console.error(line); } catch {}
      try {
        const stderr = (globalThis as any).process?.stderr;
        if (stderr && typeof stderr.write === "function") stderr.write(line);
      } catch {}
    };

    try {
      // Queue payload before handlers run so middleware/proxies can attach
      // listeners and read during the handler (matches socket chunk arrival).
      if (payload !== undefined && payload !== null) {
        ensureContentLength(req.headers, payload);
        const chunk = typeof payload === "string" ? Buffer.from(payload) : payload;
        req.push(chunk);
      }

      self.emit("request", req, res);
      if (typeof self._handler === "function") {
        const result = self._handler(req, res);
        if (result && typeof (result as any).then === "function") {
          (result as Promise<unknown>).catch((err) => {
            clearTimeout(timer);
            reportErr("async", err);
            if (!res.headersSent) {
              try {
                res.statusCode = 500;
                res.end("Internal Server Error");
              } catch { /* ignore */ }
            } else {
              try { res.end(); } catch { /* ignore */ }
            }
          });
        }
      }

      req.push(null);
      req.complete = true;
    } catch (err) {
      clearTimeout(timer);
      reportErr("sync", err);
      if (!res.headersSent) {
        try {
          res.statusCode = 500;
          res.end("Internal Server Error");
        } catch { /* ignore */ }
      }
      reject(err);
    }
  });
};

// createServer

export function createServer(
  optsOrHandler?: Record<string, unknown> | HttpHandler,
  handler?: HttpHandler,
): Server {
  return new Server(optsOrHandler, handler);
}

// STATUS_CODES & METHODS

export const STATUS_CODES: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export const METHODS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
  "CONNECT",
  "TRACE",
];

// CORS proxy helper — unified with cross-origin.ts allowlist

// ClientRequest  (fetch-backed)

export interface ClientRequest extends Writable {
  method: string;
  path: string;
  headers: Record<string, string>;
  finished: boolean;
  aborted: boolean;
  reusedSocket: boolean;
  maxHeadersCount: number | null;
  readonly socket: TcpSocket;
  readonly connection: TcpSocket;
  setHeader(k: string, v: string): void;
  getHeader(k: string): string | undefined;
  removeHeader(k: string): void;
  write(chunk: any, encOrCb?: any, cb?: any): boolean;
  end(dataOrCb?: any, encOrCb?: any, cb?: any): this;
  abort(): void;
  setTimeout(ms: number, handler?: () => void): this;
  flushHeaders(): void;
  setNoDelay(noDelay?: boolean): void;
  setSocketKeepAlive(enable?: boolean, initialDelay?: number): void;
}

export interface ClientRequestConstructor {
  new (opts: ConnectionOptions, proto?: "http" | "https"): ClientRequest;
  (this: any, opts: ConnectionOptions, proto?: "http" | "https"): void;
  prototype: any;
}

export const ClientRequest = function ClientRequest(
  this: any,
  opts: ConnectionOptions,
  proto?: "http" | "https",
) {
  if (!this) return;
  Writable.call(this);

  this._opts = opts;
  this._proto = proto || "http";
  this.method = opts.method ?? "GET";
  this.path = opts.path ?? "/";
  this.headers = {};
  this._pending = [];
  this._cancelled = false;
  this._waitMs = null;
  this._waitTimer = null;
  this._sealed = false;
  this._socket = new TcpSocket();
  this.finished = false;
  this.aborted = false;
  this.reusedSocket = false;
  this.maxHeadersCount = null;

  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      this.headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
    }
  }
  // Emit socket event async
  const self = this;
  queueMicrotask(() => self.emit("socket", self._socket));
} as unknown as ClientRequestConstructor;

Object.setPrototypeOf(ClientRequest.prototype, Writable.prototype);

// Getters for socket/connection
Object.defineProperty(ClientRequest.prototype, "socket", {
  get: function (this: any) { return this._socket; },
  configurable: true,
});

Object.defineProperty(ClientRequest.prototype, "connection", {
  get: function (this: any) { return this._socket; },
  configurable: true,
});

ClientRequest.prototype.setHeader = function setHeader(k: string, v: string): void {
  this.headers[k.toLowerCase()] = v;
};

ClientRequest.prototype.getHeader = function getHeader(k: string): string | undefined {
  return this.headers[k.toLowerCase()];
};

ClientRequest.prototype.removeHeader = function removeHeader(k: string): void {
  delete this.headers[k.toLowerCase()];
};

ClientRequest.prototype.write = function write(
  chunk: Uint8Array | string,
  encOrCb?: BufferEncoding | ((err?: Error | null) => void),
  cb?: (err?: Error | null) => void,
): boolean {
  const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  this._pending.push(buf);
  const fn = typeof encOrCb === "function" ? encOrCb : cb;
  if (fn) queueMicrotask(() => fn(null));
  return true;
};

ClientRequest.prototype.end = function end(
  dataOrCb?: Uint8Array | string | (() => void),
  encOrCb?: BufferEncoding | (() => void),
  cb?: () => void,
): any {
  if (this._sealed) return this;
  this._sealed = true;
  this.finished = true;

  let finalCb = cb;
  if (typeof dataOrCb === "function") {
    finalCb = dataOrCb;
  } else if (dataOrCb !== undefined) {
    this.write(dataOrCb as Uint8Array | string);
  }
  if (typeof encOrCb === "function") finalCb = encOrCb;

  const self = this;
  self._dispatch()
    .then(() => {
      if (finalCb) finalCb();
    })
    .catch((err: Error) => self.emit("error", err));

  return this;
};

ClientRequest.prototype.abort = function abort(): void {
  this._cancelled = true;
  this.aborted = true;
  if (this._waitTimer) clearTimeout(this._waitTimer);
  this.emit("abort");
};

ClientRequest.prototype.setTimeout = function setTimeout(ms: number, handler?: () => void): any {
  this._waitMs = ms;
  if (handler) this.once("timeout", handler);
  return this;
};

ClientRequest.prototype.flushHeaders = function flushHeaders(): void {
  // No-op
};

ClientRequest.prototype.setNoDelay = function setNoDelay(_noDelay?: boolean): void {
  // No-op
};

ClientRequest.prototype.setSocketKeepAlive = function setSocketKeepAlive(
  _enable?: boolean,
  _initialDelay?: number,
): void {
  // No-op
};

/* ---------- ClientRequest internal dispatch ---------- */

ClientRequest.prototype._dispatch = async function _dispatch(): Promise<void> {
  if (this._cancelled) return;

  try {
    const scheme = this._proto === "https" ? "https:" : "http:";
    let hostname = this._opts.hostname ?? "";
    let portSuffix = this._opts.port ? `:${this._opts.port}` : "";
    if (!hostname && this._opts.host) {
      const parts = this._opts.host.split(":");
      hostname = parts[0];
      if (!portSuffix && parts[1]) portSuffix = `:${parts[1]}`;
    }
    if (!hostname) hostname = "localhost";
    const endpoint = `${scheme}//${hostname}${portSuffix}${this._opts.path ?? "/"}`;

    // WebSocket upgrade -- delegate to native browser WS
    if (this.headers["upgrade"]?.toLowerCase() === "websocket") {
      this._bridgeWebSocket(endpoint);
      return;
    }

    // Route requests to virtual servers through the registry instead of fetch
    const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0";
    const port = Number(this._opts.port) || (this._proto === "https" ? 443 : 80);
    if (isLocal) {
      const body = this._pending.length > 0 ? Buffer.concat(this._pending) : undefined;
      if (body) ensureContentLength(this.headers, body);
      const vServer = _registry.get(port);
      if (vServer) {
        try {
          const result = await vServer.dispatchRequest(
            this.method,
            this._opts.path ?? "/",
            this.headers,
            body,
          );
          if (this._cancelled) return;
          const incoming = new IncomingMessage();
          incoming.statusCode = result.statusCode;
          incoming.statusMessage = result.statusMessage;
          applyHeadersToIncomingMessage(incoming, result.headers);
          incoming._injectBody(result.body);
          this.emit("response", incoming);
        } catch (err) {
          this.emit("error", err);
        }
        return;
      }
      if (_httpClientBridge) {
        try {
          const result = await _httpClientBridge(
            port,
            this.method,
            this._opts.path ?? "/",
            this.headers,
            body,
          );
          if (this._cancelled) return;
          const incoming = new IncomingMessage();
          incoming.statusCode = result.statusCode;
          incoming.statusMessage = result.statusMessage;
          applyHeadersToIncomingMessage(incoming, result.headers);
          incoming._injectBody(result.body);
          this.emit("response", incoming);
        } catch (err) {
          this.emit("error", err);
        }
        return;
      }
      // No virtual server on this port — emit ECONNREFUSED
      const err = new Error(`connect ECONNREFUSED ${hostname}:${port}`) as NodeJS.ErrnoException;
      err.code = "ECONNREFUSED";
      err.errno = -111;
      (err as any).syscall = "connect";
      (err as any).address = hostname;
      (err as any).port = port;
      this.emit("error", err);
      return;
    }

    let targetUrl: string;
    try {
      targetUrl = resolveProxyUrl(endpoint);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.emit("error", err);
      return;
    }

    const init: RequestInit = { method: this.method, headers: this.headers };
    if (
      this._pending.length > 0 &&
      this.method !== "GET" &&
      this.method !== "HEAD"
    ) {
      init.body = Buffer.concat(this._pending);
    }

    const ac = new AbortController();
    init.signal = ac.signal;

    if (this._waitMs) {
      this._waitTimer = setTimeout(() => {
        ac.abort();
        this.emit("timeout");
      }, this._waitMs);
    }

    const resp = await fetch(targetUrl, init);
    if (this._waitTimer) {
      clearTimeout(this._waitTimer);
      this._waitTimer = null;
    }
    if (this._cancelled) return;

    const incoming = await this._mapResponse(resp);
    this.emit("response", incoming);
  } catch (err) {
    if (this._waitTimer) clearTimeout(this._waitTimer);
    if (this._cancelled) return;
    if (err instanceof Error && err.name === "AbortError") return;
    this.emit("error", err);
  }
};

ClientRequest.prototype._mapResponse = async function _mapResponse(resp: Response): Promise<IncomingMessage> {
  const msg = new IncomingMessage();
  msg.statusCode = resp.status;
  msg.statusMessage = resp.statusText || STATUS_CODES[resp.status] || "";
  applyHeadersToIncomingMessage(msg, fetchHeadersToNodeRecord(resp.headers));
  const raw = await resp.arrayBuffer();
  msg._injectBody(Buffer.from(raw));
  return msg;
};

/* ---------- WebSocket upgrade bridge ---------- */

ClientRequest.prototype._bridgeWebSocket = function _bridgeWebSocket(url: string): void {
  const wsUrl = url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  const wsKey = this.headers["sec-websocket-key"] ?? "";
  const WS = _NativeWebSocket;

  if (!WS) {
    const self = this;
    setTimeout(
      () => self.emit("error", new TypeError("No WebSocket available")),
      0,
    );
    return;
  }

  const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  const acceptDigest = createHash("sha1")
    .update(wsKey + WS_GUID)
    .digest("base64") as string;

  let ws: globalThis.WebSocket;
  try {
    ws = new WS(wsUrl);
    ws.binaryType = "arraybuffer";
  } catch (e) {
    const self = this;
    setTimeout(
      () => self.emit("error", e instanceof Error ? e : new Error(String(e))),
      0,
    );
    return;
  }

  const pipe = new TcpSocket();
  (pipe as any).cork = () => {};
  (pipe as any).uncork = () => {};
  (pipe as any)._readableState = { endEmitted: false };
  (pipe as any)._writableState = { finished: false, errorEmitted: false };

  let outboundBuf = new Uint8Array(0);

  pipe.write = ((
    chunk: Uint8Array | string,
    encOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    const raw =
      typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    const fn = typeof encOrCb === "function" ? encOrCb : cb;

    const merged = new Uint8Array(outboundBuf.length + raw.length);
    merged.set(outboundBuf, 0);
    merged.set(raw, outboundBuf.length);
    outboundBuf = merged;

    while (outboundBuf.length >= 2) {
      const frame = decodeFrame(outboundBuf);
      if (!frame) break;
      outboundBuf = outboundBuf.slice(frame.consumed);

      if (ws.readyState !== WS.OPEN) continue;

      switch (frame.op) {
        case 0x08:
          ws.close();
          break;
        case 0x09:
          ws.send(frame.data);
          break;
        case 0x0a:
          break; // pong -- ignore
        case 0x01:
          ws.send(new TextDecoder().decode(frame.data));
          break;
        case 0x02:
          ws.send(frame.data);
          break;
      }
    }

    if (fn) queueMicrotask(() => fn(null));
    return true;
  }) as any;

  const self = this;

  ws.onopen = () => {
    const fakeResp = new IncomingMessage(pipe);
    fakeResp.statusCode = 101;
    fakeResp.statusMessage = "Switching Protocols";
    fakeResp.headers = {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-accept": acceptDigest,
    };
    fakeResp.complete = true;
    fakeResp.push(null);
    self.emit("upgrade", fakeResp, pipe, Buffer.alloc(0));
  };

  ws.onmessage = (ev: MessageEvent) => {
    let payload: Uint8Array;
    let op: number;
    if (typeof ev.data === "string") {
      payload = new TextEncoder().encode(ev.data);
      op = 0x01;
    } else if (ev.data instanceof ArrayBuffer) {
      payload = new Uint8Array(ev.data);
      op = 0x02;
    } else {
      return;
    }
    const frame = encodeFrame(op, payload, false);
    pipe._feedData(Buffer.from(frame));
  };

  ws.onclose = (ev: CloseEvent) => {
    const code = ev.code || 1000;
    const closeBuf = new Uint8Array(2);
    closeBuf[0] = (code >> 8) & 0xff;
    closeBuf[1] = code & 0xff;
    const frame = encodeFrame(0x08, closeBuf, false);
    pipe._feedData(Buffer.from(frame));
    setTimeout(() => {
      (pipe as any)._readableState.endEmitted = true;
      pipe._feedEnd();
      pipe.emit("close", false);
    }, 10);
  };

  ws.onerror = () => {
    pipe.emit("error", new Error("WebSocket transport error"));
    pipe.destroy();
  };

  const origDestroy = pipe.destroy.bind(pipe);
  pipe.destroy = ((e?: Error): TcpSocket => {
    if (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING)
      ws.close();
    return origDestroy(e);
  }) as any;
};

// Argument parsing helper

function dissectArgs(
  first: string | URL | ConnectionOptions,
  second?: ConnectionOptions | ((r: IncomingMessage) => void),
  third?: (r: IncomingMessage) => void,
): { opts: ConnectionOptions; cb?: (r: IncomingMessage) => void } {
  let opts: ConnectionOptions;
  let cb = third;

  if (typeof first === "string" || first instanceof URL) {
    const parsed = new URL(first.toString());
    opts = {
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : undefined,
      path: parsed.pathname + parsed.search,
      method: "GET",
    };
    if (typeof second === "function") cb = second;
    else if (second) opts = { ...opts, ...second };
  } else {
    opts = first;
    if (typeof second === "function") cb = second;
  }

  return { opts, cb };
}

// request / get

export function request(
  first: string | URL | ConnectionOptions,
  second?: ConnectionOptions | ((r: IncomingMessage) => void),
  third?: (r: IncomingMessage) => void,
): ClientRequest {
  const { opts, cb } = dissectArgs(first, second, third);
  const cr = new ClientRequest(opts, "http");
  if (cb) cr.once("response", cb as unknown as EventHandler);
  return cr;
}

export function get(
  first: string | URL | ConnectionOptions,
  second?: ConnectionOptions | ((r: IncomingMessage) => void),
  third?: (r: IncomingMessage) => void,
): ClientRequest {
  const { opts, cb } = dissectArgs(first, second, third);
  const cr = new ClientRequest({ ...opts, method: "GET" }, "http");
  if (cb) cr.once("response", cb as unknown as EventHandler);
  cr.end();
  return cr;
}

export function _buildClientRequest(
  first: string | URL | ConnectionOptions,
  second: ConnectionOptions | ((r: IncomingMessage) => void) | undefined,
  third: ((r: IncomingMessage) => void) | undefined,
  proto: "http" | "https",
): ClientRequest {
  const { opts, cb } = dissectArgs(first, second, third);
  const cr = new ClientRequest(opts, proto);
  if (cb) cr.once("response", cb as unknown as EventHandler);
  return cr;
}

// Server registry (global, for server bridge routing)

export type RegistryHook = (port: number, srv: Server) => void;

const _registry = new Map<number, Server>();
const _serverOwnership = new Map<number, number>(); // port → pid
let _onBind: RegistryHook | null = null;
let _onUnbind: ((port: number) => void) | null = null;

export type HttpClientBridge = (
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: Buffer,
) => Promise<CompletedResponse>;

let _httpClientBridge: HttpClientBridge | null = null;

function _addServer(port: number, srv: Server, ownerPid?: number): void {
  // loop liveness is held by the inner net.TcpServer's TCPServerWrap handle.
  // this registry is just the port -> Server map for internal routing.
  _registry.set(port, srv);
  if (ownerPid !== undefined) _serverOwnership.set(port, ownerPid);
  if (_onBind) _onBind(port, srv);
}

function _removeServer(port: number): void {
  _registry.delete(port);
  _serverOwnership.delete(port);
  if (_onUnbind) _onUnbind(port);
}

export function getServer(port: number): Server | undefined {
  return _registry.get(port);
}

export function getAllServers(): Map<number, Server> {
  return new Map(_registry);
}

export function closeAllServers(): void {
  for (const [, srv] of _registry) {
    try { srv.close(); } catch { /* best effort */ }
  }
  _registry.clear();
  _serverOwnership.clear();
}

export function closeServersByPid(pid: number): void {
  for (const [port, ownerPid] of _serverOwnership) {
    if (ownerPid === pid) {
      const srv = _registry.get(port);
      if (srv) {
        try { srv.close(); } catch { /* best effort */ }
      }
      _registry.delete(port);
      _serverOwnership.delete(port);
    }
  }
}

export function getServerOwner(port: number): number | undefined {
  return _serverOwnership.get(port);
}

export function setServerListenCallback(fn: RegistryHook | null): void {
  _onBind = fn;
}

export function setServerCloseCallback(
  fn: ((port: number) => void) | null,
): void {
  _onUnbind = fn;
}

export function setHttpClientBridge(fn: HttpClientBridge | null): void {
  _httpClientBridge = fn;
}

// Agent

export interface AgentConfig {
  keepAlive?: boolean;
  keepAliveMsecs?: number;
  maxSockets?: number;
  maxTotalSockets?: number;
  maxFreeSockets?: number;
  scheduling?: "fifo" | "lifo";
  timeout?: number;
}

export interface Agent extends EventEmitter {
  maxSockets: number;
  maxFreeSockets: number;
  maxTotalSockets: number;
  sockets: Record<string, TcpSocket[]>;
  freeSockets: Record<string, TcpSocket[]>;
  requests: Record<string, IncomingMessage[]>;
  options: AgentConfig;
  createConnection(cfg: Record<string, unknown>, done?: (err: Error | null, sock: TcpSocket) => void): TcpSocket;
  getName(o: { host?: string; port?: number; localAddress?: string }): string;
  addRequest(r: ClientRequest, o: Record<string, unknown>): void;
  destroy(): void;
}

export interface AgentConstructor {
  new (cfg?: AgentConfig): Agent;
  (this: any, cfg?: AgentConfig): void;
  prototype: any;
}

export const Agent = function Agent(this: any, cfg?: AgentConfig) {
  if (!this) return;
  EventEmitter.call(this);

  this.options = cfg ?? {};
  this.maxSockets = cfg?.maxSockets ?? Infinity;
  this.maxFreeSockets = cfg?.maxFreeSockets ?? 256;
  this.maxTotalSockets = cfg?.maxTotalSockets ?? Infinity;
  this.sockets = {};
  this.freeSockets = {};
  this.requests = {};
} as unknown as AgentConstructor;

Object.setPrototypeOf(Agent.prototype, EventEmitter.prototype);

Agent.prototype.createConnection = function createConnection(
  _cfg: Record<string, unknown>,
  done?: (err: Error | null, sock: TcpSocket) => void,
): TcpSocket {
  const sock = new TcpSocket();
  if (done) done(null, sock);
  return sock;
};

Agent.prototype.getName = function getName(
  o: { host?: string; port?: number; localAddress?: string },
): string {
  return `${o.host ?? "localhost"}:${o.port ?? 80}:${o.localAddress ?? ""}`;
};

Agent.prototype.addRequest = function addRequest(
  _r: ClientRequest,
  _o: Record<string, unknown>,
): void {};

Agent.prototype.destroy = function destroy(): void {
  this.sockets = {};
  this.freeSockets = {};
  this.requests = {};
};

export const globalAgent = new Agent();

// WebSocket frame codec

export function decodeFrame(raw: Uint8Array): {
  op: number;
  data: Uint8Array;
  consumed: number;
} | null {
  if (raw.length < 2) return null;

  const op = raw[0] & 0x0f;
  const isMasked = (raw[1] & 0x80) !== 0;
  let len = raw[1] & 0x7f;
  let cursor = 2;

  if (len === 126) {
    if (raw.length < 4) return null;
    len = (raw[2] << 8) | raw[3];
    cursor = 4;
  } else if (len === 127) {
    if (raw.length < 10) return null;
    len = (raw[6] << 24) | (raw[7] << 16) | (raw[8] << 8) | raw[9];
    cursor = 10;
  }

  if (isMasked) {
    if (raw.length < cursor + 4 + len) return null;
    const mask = raw.slice(cursor, cursor + 4);
    cursor += 4;
    const payload = new Uint8Array(len);
    for (let i = 0; i < len; i++) payload[i] = raw[cursor + i] ^ mask[i & 3];
    return { op, data: payload, consumed: cursor + len };
  }

  if (raw.length < cursor + len) return null;
  return { op, data: raw.slice(cursor, cursor + len), consumed: cursor + len };
}

export function encodeFrame(
  op: number,
  payload: Uint8Array,
  masked: boolean,
): Uint8Array {
  const pLen = payload.length;
  let headerLen = 2;
  if (pLen > 125 && pLen <= 0xffff) headerLen += 2;
  else if (pLen > 0xffff) headerLen += 8;
  if (masked) headerLen += 4;

  const frame = new Uint8Array(headerLen + pLen);
  frame[0] = 0x80 | op;

  let pos = 2;
  if (pLen <= 125) {
    frame[1] = (masked ? 0x80 : 0) | pLen;
  } else if (pLen <= 0xffff) {
    frame[1] = (masked ? 0x80 : 0) | 126;
    frame[2] = (pLen >> 8) & 0xff;
    frame[3] = pLen & 0xff;
    pos = 4;
  } else {
    frame[1] = (masked ? 0x80 : 0) | 127;
    frame[2] = 0;
    frame[3] = 0;
    frame[4] = 0;
    frame[5] = 0;
    frame[6] = (pLen >> 24) & 0xff;
    frame[7] = (pLen >> 16) & 0xff;
    frame[8] = (pLen >> 8) & 0xff;
    frame[9] = pLen & 0xff;
    pos = 10;
  }

  if (masked) {
    const maskKey = new Uint8Array(4);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(maskKey);
    } else {
      for (let i = 0; i < 4; i++) maskKey[i] = Math.floor(Math.random() * 256);
    }
    frame.set(maskKey, pos);
    pos += 4;
    for (let i = 0; i < pLen; i++) frame[pos + i] = payload[i] ^ maskKey[i & 3];
  } else {
    frame.set(payload, pos);
  }

  return frame;
}

// Default export

export default {
  Server,
  IncomingMessage,
  ServerResponse,
  ClientRequest,
  createServer,
  request,
  get,
  STATUS_CODES,
  METHODS,
  getServer,
  getAllServers,
  setServerListenCallback,
  setServerCloseCallback,
  setHttpClientBridge,
  _buildClientRequest,
  Agent,
  globalAgent,
  decodeFrame,
  encodeFrame,
};
