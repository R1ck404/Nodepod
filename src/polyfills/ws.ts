// ws-compatible WebSocket polyfill wrapping browser native WebSocket


import { encodeFrame, decodeFrame, WS_GUID } from "./http.js";
import { Buffer } from "./buffer.js";
import { createHash } from "./crypto.js";
import type { TcpSocket } from "./net.js";
import { getRegistry, type Handle } from "../helpers/event-loop.js";

// polyfill for environments missing CloseEvent / MessageEvent
const SafeCloseEvent: typeof CloseEvent =
  typeof CloseEvent !== 'undefined'
    ? CloseEvent
    : (class SyntheticClose extends Event {
        code: number;
        reason: string;
        wasClean: boolean;
        constructor(kind: string, init?: { code?: number; reason?: string; wasClean?: boolean }) {
          super(kind);
          this.code = init?.code ?? 1000;
          this.reason = init?.reason ?? '';
          this.wasClean = init?.wasClean ?? true;
        }
      } as unknown as typeof CloseEvent);

const SafeMessageEvent: typeof MessageEvent =
  typeof MessageEvent !== 'undefined'
    ? MessageEvent
    : (class SyntheticMessage extends Event {
        data: unknown;
        constructor(kind: string, init?: { data?: unknown }) {
          super(kind);
          this.data = init?.data;
        }
      } as unknown as typeof MessageEvent);

// in-process server <-> client messaging via BroadcastChannel.
// Each participant needs its OWN channel instance: BC does not deliver
// postMessage back to the same BroadcastChannel object that sent it.
const WS_BC_NAME = "nodepod-ws-bridge";
let _bcAvailable: boolean | null = null;

function bcAvailable(): boolean {
  if (_bcAvailable !== null) return _bcAvailable;
  try {
    const probe = new BroadcastChannel(WS_BC_NAME);
    probe.close();
    _bcAvailable = true;
  } catch {
    _bcAvailable = false;
  }
  return _bcAvailable;
}

function openBridgeChannel(): BroadcastChannel | null {
  if (!bcAvailable()) return null;
  try {
    return new BroadcastChannel(WS_BC_NAME);
  } catch {
    return null;
  }
}

const activeServers = new Map<string, WebSocketServer>();
let nextClientId = 0;

type Handler = (...args: unknown[]) => void;

interface TinyEmitter {
  _listeners: Map<string, Set<Handler>>;
  on(evt: string, fn: Handler): this;
  off(evt: string, fn: Handler): this;
  emit(evt: string, ...args: unknown[]): void;
}

interface TinyEmitterConstructor {
  new (): TinyEmitter;
  (this: any): void;
  prototype: any;
}

const TinyEmitter = function TinyEmitter(this: any) {
  if (!this) return;
  this._listeners = new Map<string, Set<Handler>>();
} as unknown as TinyEmitterConstructor;

TinyEmitter.prototype.on = function on(this: any, evt: string, fn: Handler): any {
  if (!this._listeners.has(evt)) this._listeners.set(evt, new Set());
  this._listeners.get(evt)!.add(fn);
  return this;
};

TinyEmitter.prototype.off = function off(this: any, evt: string, fn: Handler): any {
  this._listeners.get(evt)?.delete(fn);
  return this;
};

TinyEmitter.prototype.emit = function emit(this: any, evt: string, ...args: unknown[]): void {
  const s = this._listeners.get(evt);
  if (!s) return;
  for (const fn of s) {
    try { fn(...args); } catch { /* swallow handler errors */ }
  }
};

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

export interface WebSocket extends TinyEmitter {
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
  readyState: number;
  url: string;
  protocol: string;
  extensions: string;
  bufferedAmount: number;
  binaryType: 'blob' | 'arraybuffer';
  _uid: string;
  _boundServer: WebSocketServer | null;
  _native: globalThis.WebSocket | null;
  _tcpSocket: TcpSocket | null;
  _tcpInboundBuf: Uint8Array;
  _elHandle: Handle | null;
  _bc: BroadcastChannel | null;
  _bcMsgHandler: ((ev: MessageEvent) => void) | null;
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  _open(): void;
  _openNative(): void;
  _failOpen(reason: string): void;
  send(payload: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  pong(): void;
  terminate(): void;
  ref(): this;
  unref(): this;
  _bindServer(srv: WebSocketServer): void;
  _deliverMessage(data: unknown): void;
}

interface WebSocketConstructor {
  new (address: string, protocols?: string | string[]): WebSocket;
  (this: any, address: string, protocols?: string | string[]): void;
  prototype: any;
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
  /** Node `ws` package attaches Server on the default export. */
  Server: any;
  WebSocket: any;
  createWebSocketStream: (...args: never[]) => never;
}

export const WebSocket = function WebSocket(this: any, address: string, protocols?: string | string[]) {
  if (!this) return;
  TinyEmitter.call(this);
  this.CONNECTING = CONNECTING;
  this.OPEN = OPEN;
  this.CLOSING = CLOSING;
  this.CLOSED = CLOSED;
  this.readyState = CONNECTING;
  this.url = address;
  this.protocol = '';
  this.extensions = '';
  this.bufferedAmount = 0;
  this.binaryType = 'blob';
  this._uid = `ws-${++nextClientId}`;
  this._boundServer = null;
  this._native = null;
  this._tcpSocket = null;
  this._tcpInboundBuf = new Uint8Array(0);
  this._bc = null;
  this._bcMsgHandler = null;
  this.onopen = null;
  this.onclose = null;
  this.onerror = null;
  this.onmessage = null;
  // keeps the loop alive while the socket is open. released in close/terminate.
  this._elHandle = getRegistry().register("WebSocket");
  if (protocols) this.protocol = Array.isArray(protocols) ? protocols[0] : protocols;
  const self = this;
  // Server-side loopback sockets must be OPEN before handleUpgrade/BC emit
  // 'connection', so callers can send immediately (matches `ws` package).
  if (address.startsWith("internal://")) {
    this._open();
  } else {
    setTimeout(() => self._open(), 0);
  }
} as unknown as WebSocketConstructor;

Object.setPrototypeOf(WebSocket.prototype, TinyEmitter.prototype);

(WebSocket as any).CONNECTING = CONNECTING;
(WebSocket as any).OPEN = OPEN;
(WebSocket as any).CLOSING = CLOSING;
(WebSocket as any).CLOSED = CLOSED;

WebSocket.prototype._closeBridge = function _closeBridge(this: any): void {
  if (this._bc && this._bcMsgHandler) {
    try {
      this._bc.removeEventListener("message", this._bcMsgHandler);
    } catch {
      /* */
    }
  }
  if (this._bc) {
    try {
      this._bc.close();
    } catch {
      /* */
    }
  }
  this._bc = null;
  this._bcMsgHandler = null;
};

WebSocket.prototype._failOpen = function _failOpen(this: any, reason: string): void {
  this._closeBridge();
  this.readyState = CLOSED;
  const ee = new Event('error');
  (ee as any).message = reason;
  this.emit('error', ee);
  this.onerror?.(ee);
  const ce = new SafeCloseEvent('close', { code: 1006, reason, wasClean: false });
  this.emit('close', ce);
  this.onclose?.(ce);
  (this._elHandle as Handle | null)?.close();
  this._elHandle = null;
};

WebSocket.prototype._open = function _open(this: any): void {
  // Internal loopback connection (server-side socket)
  if (this.url.startsWith('internal://')) {
    this.readyState = OPEN;
    this.emit('open');
    this.onopen?.(new Event('open'));
    return;
  }

  // Real remote connection -- delegate to browser's native WebSocket
  if (this.url.startsWith('ws://') || this.url.startsWith('wss://')) {
    this._openNative();
    return;
  }

  // BroadcastChannel-based in-process connection (own channel instance)
  const chan = openBridgeChannel();
  if (!chan) {
    this._failOpen('No BroadcastChannel available for in-process WebSocket');
    return;
  }
  this._bc = chan;

  const self = this;
  let settled = false;
  const onMsg = (ev: MessageEvent) => {
    const d = ev.data;
    if (d.targetUid !== self._uid) return;

    if (d.kind === 'connected') {
      settled = true;
      self.readyState = OPEN;
      self.emit('open');
      self.onopen?.(new Event('open'));
    } else if (d.kind === 'payload') {
      const me = new SafeMessageEvent('message', { data: d.body });
      self.emit('message', me);
      self.onmessage?.(me);
    } else if (d.kind === 'closed') {
      self.readyState = CLOSED;
      const ce = new SafeCloseEvent('close', { code: d.code || 1000, reason: d.reason || '', wasClean: true });
      self.emit('close', ce);
      self.onclose?.(ce);
      (self._elHandle as Handle | null)?.close();
      self._elHandle = null;
      self._closeBridge();
    } else if (d.kind === 'fault') {
      settled = true;
      const ee = new Event('error');
      self.emit('error', ee);
      self.onerror?.(ee);
    }
  };
  this._bcMsgHandler = onMsg;
  chan.addEventListener('message', onMsg);
  chan.postMessage({ kind: 'connect', uid: this._uid, url: this.url });

  // No ack → fail closed (do not force-OPEN)
  setTimeout(() => {
    if (!settled && self.readyState === CONNECTING) {
      self._failOpen('WebSocket connection timed out waiting for server ack');
    }
  }, 100);
};

WebSocket.prototype._openNative = function _openNative(this: any): void {
  const inBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';
  const NativeImpl = inBrowser && typeof globalThis.WebSocket === 'function' && globalThis.WebSocket !== (WebSocket as unknown)
    ? globalThis.WebSocket
    : null;

  if (!NativeImpl) {
    this._failOpen('No native WebSocket available');
    return;
  }

  try {
    this._native = new NativeImpl(this.url);
    this._native.binaryType = this.binaryType === 'arraybuffer' ? 'arraybuffer' : 'blob';
  } catch {
    this.readyState = CLOSED;
    const errEvt = new Event('error');
    this.emit('error', errEvt);
    this.onerror?.(errEvt);
    return;
  }

  const self = this;
  this._native.onopen = () => {
    self.readyState = OPEN;
    self.emit('open');
    self.onopen?.(new Event('open'));
  };

  this._native.onmessage = (raw: globalThis.MessageEvent) => {
    const me = new SafeMessageEvent('message', { data: raw.data });
    self.emit('message', me);
    self.onmessage?.(me);
  };

  this._native.onclose = (raw: globalThis.CloseEvent) => {
    self.readyState = CLOSED;
    self._native = null;
    const ce = new SafeCloseEvent('close', { code: raw.code, reason: raw.reason, wasClean: raw.wasClean });
    self.emit('close', ce);
    self.onclose?.(ce);
    (self._elHandle as Handle | null)?.close();
    self._elHandle = null;
  };

  this._native.onerror = () => {
    const errEvt = new Event('error');
    self.emit('error', errEvt);
    self.onerror?.(errEvt);
  };
};

WebSocket.prototype.send = function send(this: any, payload: string | ArrayBuffer | Uint8Array): void {
  if (this.readyState !== OPEN) throw new Error('WebSocket is not open');

  if (this._native) { this._native.send(payload); return; }

  // TcpSocket-backed (from handleUpgrade) — write real WS frames
  if (this._tcpSocket) {
    let data: Uint8Array;
    let op: number;
    if (typeof payload === 'string') {
      data = new TextEncoder().encode(payload);
      op = 0x01; // text frame
    } else if (payload instanceof ArrayBuffer) {
      data = new Uint8Array(payload);
      op = 0x02; // binary frame
    } else {
      data = payload;
      op = 0x02; // binary frame
    }
    // Server frames are NOT masked
    const frame = encodeFrame(op, data, false);
    this._tcpSocket.write(Buffer.from(frame));
    return;
  }

  if (this._boundServer) { this._boundServer._injectClientPayload(this, payload); return; }

  if (this._bc) {
    this._bc.postMessage({ kind: 'payload', uid: this._uid, url: this.url, body: payload });
  }
};

WebSocket.prototype.close = function close(this: any, code?: number, reason?: string): void {
  if (this.readyState === CLOSED || this.readyState === CLOSING) return;
  this.readyState = CLOSING;

  const releaseHandle = () => {
    (this._elHandle as Handle | null)?.close();
    this._elHandle = null;
  };

  if (this._native) { this._native.close(code, reason); releaseHandle(); return; }

  // TcpSocket-backed — send close frame
  if (this._tcpSocket) {
    const c = code ?? 1000;
    const closeBuf = new Uint8Array(2);
    closeBuf[0] = (c >> 8) & 0xff;
    closeBuf[1] = c & 0xff;
    const frame = encodeFrame(0x08, closeBuf, false);
    try { this._tcpSocket.write(Buffer.from(frame)); } catch { /* socket may be dead */ }
    const self = this;
    setTimeout(() => {
      self.readyState = CLOSED;
      const ce = new SafeCloseEvent('close', { code: c, reason: reason || '', wasClean: true });
      self.emit('close', ce);
      self.onclose?.(ce);
      self._tcpSocket = null;
      releaseHandle();
    }, 0);
    return;
  }

  if (this._bc) {
    this._bc.postMessage({ kind: 'disconnect', uid: this._uid, url: this.url, code, reason });
  }

  const self = this;
  setTimeout(() => {
    self.readyState = CLOSED;
    const ce = new SafeCloseEvent('close', { code: code || 1000, reason: reason || '', wasClean: true });
    self.emit('close', ce);
    self.onclose?.(ce);
    self._closeBridge();
    releaseHandle();
  }, 0);
};

WebSocket.prototype.ping = function ping(): void { /* no-op in browser */ };
WebSocket.prototype.pong = function pong(): void { /* no-op in browser */ };

WebSocket.prototype.terminate = function terminate(this: any): void {
  if (this._native) { this._native.close(); this._native = null; }
  if (this._tcpSocket) { try { this._tcpSocket.destroy(); } catch { /* */ } this._tcpSocket = null; }
  this._closeBridge();
  this.readyState = CLOSED;
  (this._elHandle as Handle | null)?.close();
  this._elHandle = null;
  const ce = new SafeCloseEvent('close', { code: 1006, reason: 'Terminated', wasClean: false });
  this.emit('close', ce);
  this.onclose?.(ce);
};

WebSocket.prototype.ref = function ref(this: any): any {
  (this._elHandle as Handle | null)?.ref();
  return this;
};

WebSocket.prototype.unref = function unref(this: any): any {
  (this._elHandle as Handle | null)?.unref();
  return this;
};

WebSocket.prototype._bindServer = function _bindServer(this: any, srv: WebSocketServer): void { this._boundServer = srv; };

WebSocket.prototype._deliverMessage = function _deliverMessage(this: any, data: unknown): void {
  const me = new SafeMessageEvent('message', { data });
  this.emit('message', me);
  this.onmessage?.(me);
};

// Sec-WebSocket-Accept key computation (RFC 6455)
function _computeAcceptKey(wsKey: string): string {
  try {
    const hash = createHash('sha1');
    hash.update(wsKey + WS_GUID);
    return hash.digest('base64') as string;
  } catch {
    // bridge only checks for "HTTP/1.1 101", so a placeholder works
    return btoa(wsKey + WS_GUID).slice(0, 28);
  }
}

export interface ServerConfig {
  host?: string;
  port?: number;
  server?: unknown;
  noServer?: boolean;
  path?: string;
  clientTracking?: boolean;
  perMessageDeflate?: boolean | object;
  maxPayload?: number;
}

export interface WebSocketServer extends TinyEmitter {
  clients: Set<WebSocket>;
  options: ServerConfig;
  _route: string;
  _bc: BroadcastChannel | null;
  _channelCb: ((ev: MessageEvent) => void) | null;
  _listen(): void;
  _injectClientPayload(source: WebSocket, data: unknown): void;
  handleUpgrade(req: unknown, socket: unknown, head: unknown, done: (ws: WebSocket, req: unknown) => void): void;
  close(done?: () => void): void;
  address(): { port: number; family: string; address: string } | null;
}

interface WebSocketServerConstructor {
  new (opts?: ServerConfig): WebSocketServer;
  (this: any, opts?: ServerConfig): void;
  prototype: any;
}

export const WebSocketServer = function WebSocketServer(this: any, opts: ServerConfig = {}) {
  if (!this) return;
  TinyEmitter.call(this);
  this.clients = new Set<WebSocket>();
  this.options = opts;
  this._route = opts.path || '/';
  this._bc = null;
  this._channelCb = null;

  if (!opts.noServer) this._listen();
  activeServers.set(this._route, this);
} as unknown as WebSocketServerConstructor;

Object.setPrototypeOf(WebSocketServer.prototype, TinyEmitter.prototype);

function _pathFromUrl(url: string): string {
  try {
    // Absolute or path-only
    if (url.startsWith('/')) {
      const q = url.indexOf('?');
      return q === -1 ? url : url.slice(0, q);
    }
    const u = new URL(url, 'http://localhost');
    return u.pathname || '/';
  } catch {
    return '/';
  }
}

WebSocketServer.prototype._listen = function _listen(this: any): void {
  const chan = openBridgeChannel();
  if (!chan) return;
  this._bc = chan;
  const self = this;

  this._channelCb = (ev: MessageEvent) => {
    const d = ev.data;

    if (d.kind === 'connect') {
      const connectPath = _pathFromUrl(d.url || '/');
      if (connectPath !== self._route) return;

      const sock = new WebSocket('internal://' + self._route);
      sock._bindServer(self);
      (sock as unknown as { _uid: string })._uid = d.uid;
      self.clients.add(sock);
      chan.postMessage({ kind: 'connected', targetUid: d.uid });
      self.emit('connection', sock, { url: d.url });
    }

    if (d.kind === 'payload') {
      // Client → server: match by uid
      if (d.uid) {
        for (const c of self.clients) {
          if ((c as unknown as { _uid: string })._uid === d.uid) {
            c._deliverMessage(d.body);
            break;
          }
        }
      }
    }

    if (d.kind === 'disconnect') {
      for (const c of self.clients) {
        if ((c as unknown as { _uid: string })._uid === d.uid) {
          c.close(d.code, d.reason);
          self.clients.delete(c);
          break;
        }
      }
    }
  };
  chan.addEventListener('message', this._channelCb);
};

WebSocketServer.prototype._injectClientPayload = function _injectClientPayload(this: any, source: WebSocket, data: unknown): void {
  // Server → client: deliver to the peer via BC (never echo to source)
  if (this._bc) {
    const uid = (source as unknown as { _uid: string })._uid;
    this._bc.postMessage({ kind: 'payload', targetUid: uid, body: data });
  }
};

WebSocketServer.prototype.handleUpgrade = function handleUpgrade(
  this: any,
  req: unknown,
  socket: unknown,
  head: unknown,
  done: (ws: WebSocket, req: unknown) => void,
): void {
  const sock = new WebSocket('internal://' + this._route);
  sock._bindServer(this);
  if (this.options.clientTracking !== false) this.clients.add(sock);

  // Check if socket is a real TcpSocket (from http.Server.dispatchUpgrade)
  const tcp = socket as TcpSocket | null;
  const isTcp = tcp && typeof tcp.write === 'function' && typeof tcp._feedData === 'function';
  if (isTcp) {
    // Wire the ws.WebSocket to the TcpSocket for frame-level I/O
    sock._tcpSocket = tcp;

    // Compute Sec-WebSocket-Accept
    const reqHeaders = (req as { headers?: Record<string, string> })?.headers || {};
    const wsKey = reqHeaders['sec-websocket-key'] || '';
    const acceptKey = _computeAcceptKey(wsKey);

    // Write HTTP 101 Switching Protocols response to the TcpSocket
    // This triggers handshakeDone in the request-proxy bridge
    const handshake = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`;
    tcp.write(Buffer.from(handshake));

    // Listen for incoming data from the TcpSocket (client→server frames)
    tcp.on('data', (chunk: unknown) => {
      const raw = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
      const merged = new Uint8Array(sock._tcpInboundBuf.length + raw.length);
      merged.set(sock._tcpInboundBuf, 0);
      merged.set(raw, sock._tcpInboundBuf.length);
      sock._tcpInboundBuf = merged;

      while (sock._tcpInboundBuf.length >= 2) {
        const frame = decodeFrame(sock._tcpInboundBuf);
        if (!frame) break;
        sock._tcpInboundBuf = sock._tcpInboundBuf.slice(frame.consumed);

        switch (frame.op) {
          case 0x01: { // text
            const text = new TextDecoder().decode(frame.data);
            const me = new SafeMessageEvent('message', { data: text });
            sock.emit('message', me);
            sock.onmessage?.(me);
            break;
          }
          case 0x02: { // binary
            const me = new SafeMessageEvent('message', { data: frame.data.buffer });
            sock.emit('message', me);
            sock.onmessage?.(me);
            break;
          }
          case 0x08: { // close
            const code = frame.data.length >= 2
              ? (frame.data[0] << 8) | frame.data[1]
              : 1000;
            sock.readyState = CLOSED;
            const ce = new SafeCloseEvent('close', { code, reason: '', wasClean: true });
            sock.emit('close', ce);
            sock.onclose?.(ce);
            sock._tcpSocket = null;
            break;
          }
          case 0x09: { // ping — respond with pong
            const pong = encodeFrame(0x0a, frame.data, false);
            tcp.write(Buffer.from(pong));
            break;
          }
          case 0x0a: { // pong
            sock.emit('pong', frame.data);
            break;
          }
        }
      }
    });

    tcp.on('close', () => {
      if (sock.readyState !== CLOSED) {
        sock.readyState = CLOSED;
        const ce = new SafeCloseEvent('close', { code: 1006, reason: 'Connection lost', wasClean: false });
        sock.emit('close', ce);
        sock.onclose?.(ce);
      }
      sock._tcpSocket = null;
    });
  }

  // Match `ws` package: only invoke the callback. Callers emit 'connection' themselves.
  setTimeout(() => {
    done(sock, req);
  }, 0);
};

WebSocketServer.prototype.close = function close(this: any, done?: (err?: Error) => void): void {
  for (const c of this.clients) c.close(1001, 'Server closing');
  this.clients.clear();
  activeServers.delete(this._route);
  if (this._channelCb && this._bc) {
    try {
      this._bc.removeEventListener('message', this._channelCb);
    } catch {
      /* */
    }
    this._channelCb = null;
  }
  if (this._bc) {
    try {
      this._bc.close();
    } catch {
      /* */
    }
    this._bc = null;
  }
  this.emit('close');
  if (done) setTimeout(done, 0);
};

WebSocketServer.prototype.address = function address(this: any): { port: number; family: string; address: string } | null {
  return { port: this.options.port || 0, family: 'IPv4', address: this.options.host || '0.0.0.0' };
};

export const Server = WebSocketServer;

export const createWebSocketStream = (): never => {
  throw new Error('createWebSocketStream is not available in the browser');
};

// Match the real `ws` package: default export is WebSocket, with Server (and
// helpers) hung off it. Expo/Metro do `require("ws").default.Server` /
// `new (require("ws"))().Server` via interop — without this, Metro's listen
// callback throws after onReady and never attaches Expo HTML middleware.
(WebSocket as WebSocketConstructor).Server = WebSocketServer;
(WebSocket as WebSocketConstructor).WebSocket = WebSocket as WebSocketConstructor;
(WebSocket as WebSocketConstructor).createWebSocketStream = createWebSocketStream;

export default WebSocket;
