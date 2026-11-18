// TCP / net polyfill -- all networking is simulated, no real kernel sockets

import { EventEmitter, type EventHandler } from "./events";
import { Duplex } from "./stream";
import { Buffer } from "./buffer";
import { PORT_RANGE } from "../constants/config";
import { getRegistry, type Handle } from "../helpers/event-loop";


export interface NetAddress {
  address: string;
  family: string;
  port: number;
}

export interface SocketConfig {
  allowHalfOpen?: boolean;
  readable?: boolean;
  writable?: boolean;
}

export interface ServerConfig {
  allowHalfOpen?: boolean;
  pauseOnConnect?: boolean;
}

export interface BindOptions {
  port?: number;
  host?: string;
  backlog?: number;
}


export interface TcpSocket extends Duplex {
  localAddress: string;
  localPort: number;
  remoteAddress?: string;
  remotePort?: number;
  remoteFamily?: string;
  connecting: boolean;
  pending: boolean;
  destroyed: boolean;
  encrypted: boolean;
  readyState: string;
  bytesRead: number;
  bytesWritten: number;
  connect(portOrOpts: any, hostOrCb?: any, cb?: any): this;
  address(): NetAddress | null;
  setEncoding(enc: BufferEncoding): this;
  setTimeout(ms: number, handler?: () => void): this;
  setNoDelay(v?: boolean): this;
  setKeepAlive(on?: boolean, delay?: number): this;
  ref(): this;
  unref(): this;
  destroy(err?: Error): this;
  _feedData(chunk: Buffer | string): void;
  _feedEnd(): void;
}

export interface TcpSocketConstructor {
  new (cfg?: SocketConfig): TcpSocket;
  (this: any, cfg?: SocketConfig): void;
  prototype: any;
}

export const TcpSocket = function TcpSocket(this: any, _cfg?: SocketConfig) {
  if (!this) return;
  Duplex.call(this);

  this._isConnecting = false;
  this._isConnected = false;
  this._isDestroyed = false;
  this._peerAddr = "";
  this._peerPort = 0;
  this._selfAddr = "127.0.0.1";
  this._selfPort = 0;

  this.localAddress = "127.0.0.1";
  this.localPort = 0;
  this.remoteAddress = undefined;
  this.remotePort = undefined;
  this.remoteFamily = undefined;
  this.connecting = false;
  this.pending = false;
  this.destroyed = false;
  this.encrypted = false;
  this.readyState = "closed";
  this.bytesRead = 0;
  this.bytesWritten = 0;
} as unknown as TcpSocketConstructor;

Object.setPrototypeOf(TcpSocket.prototype, Duplex.prototype);

TcpSocket.prototype.connect = function connect(
  portOrOpts: number | { port: number; host?: string },
  hostOrCb?: string | (() => void),
  cb?: () => void,
): any {
  let port: number;
  let host = "127.0.0.1";
  let done: (() => void) | undefined;

  if (typeof portOrOpts === "number") {
    port = portOrOpts;
    if (typeof hostOrCb === "string") {
      host = hostOrCb;
      done = cb;
    } else done = hostOrCb;
  } else {
    port = portOrOpts.port;
    host = portOrOpts.host ?? "127.0.0.1";
    done = typeof hostOrCb === "function" ? hostOrCb : cb;
  }

  this._isConnecting = true;
  this.connecting = true;
  this._peerAddr = host;
  this._peerPort = port;
  this.remoteAddress = host;
  this.remotePort = port;
  this.remoteFamily = "IPv4";
  this.readyState = "opening";

  // keep the loop alive while connected, released on destroy
  if (!this._elHandle) this._elHandle = getRegistry().register("TCPSocketWrap");

  const self = this;
  queueMicrotask(() => {
    self._isConnecting = false;
    self._isConnected = true;
    self.connecting = false;
    self.readyState = "open";
    self.emit("connect");
    if (done) done();
  });

  return this;
};

TcpSocket.prototype.address = function address(): NetAddress | null {
  if (!this._isConnected) return null;
  return { address: this._selfAddr, family: "IPv4", port: this._selfPort };
};

TcpSocket.prototype.setEncoding = function setEncoding(_enc: BufferEncoding): any {
  return this;
};

TcpSocket.prototype.setTimeout = function setTimeout(ms: number, handler?: () => void): any {
  if (handler) this.once("timeout", handler);
  return this;
};

TcpSocket.prototype.setNoDelay = function setNoDelay(_v?: boolean): any {
  return this;
};

TcpSocket.prototype.setKeepAlive = function setKeepAlive(_on?: boolean, _delay?: number): any {
  return this;
};

TcpSocket.prototype.ref = function ref(): any {
  (this._elHandle as Handle | null)?.ref();
  return this;
};

TcpSocket.prototype.unref = function unref(): any {
  (this._elHandle as Handle | null)?.unref();
  return this;
};

TcpSocket.prototype.destroy = function destroy(err?: Error): any {
  if (this._isDestroyed) return this;
  this._isDestroyed = true;
  this._isConnected = false;
  this.destroyed = true;
  this.readyState = "closed";
  (this._elHandle as Handle | null)?.close();
  this._elHandle = null;
  if (err) this.emit("error", err);
  const self = this;
  queueMicrotask(() => self.emit("close", !!err));
  return this;
};

TcpSocket.prototype._feedData = function _feedData(chunk: Buffer | string): void {
  const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  this.push(buf);
};

TcpSocket.prototype._feedEnd = function _feedEnd(): void {
  this.push(null);
};


export interface TcpServer extends EventEmitter {
  listening: boolean;
  maxConnections?: number;
  listen(portOrOpts?: any, hostOrCb?: any, backlogOrCb?: any, cb?: any): this;
  address(): (NetAddress & { host?: string }) | null;
  close(cb?: (err?: Error) => void): this;
  getConnections(cb?: (err: Error | null, n: number) => void): void;
  ref(): this;
  unref(): this;
  _acceptConnection(sock: TcpSocket): void;
}

export interface TcpServerConstructor {
  new (cfgOrHandler?: ServerConfig | ((sock: TcpSocket) => void), handler?: (sock: TcpSocket) => void): TcpServer;
  (this: any, cfgOrHandler?: ServerConfig | ((sock: TcpSocket) => void), handler?: (sock: TcpSocket) => void): void;
  prototype: any;
}

export const TcpServer = function TcpServer(
  this: any,
  cfgOrHandler?: ServerConfig | ((sock: TcpSocket) => void),
  handler?: (sock: TcpSocket) => void,
) {
  if (!this) return;
  EventEmitter.call(this);

  this._bound = false;
  this._addr = null;
  this._peers = new Set();
  this._cap = Infinity;
  this.listening = false;
  this.maxConnections = undefined;

  let fn: ((s: TcpSocket) => void) | undefined;
  if (typeof cfgOrHandler === "function") fn = cfgOrHandler;
  else fn = handler;
  if (fn) this.on("connection", fn as EventHandler);
} as unknown as TcpServerConstructor;

Object.setPrototypeOf(TcpServer.prototype, EventEmitter.prototype);

TcpServer.prototype.listen = function listen(
  portOrOpts?: number | BindOptions,
  hostOrCb?: string | number | (() => void),
  backlogOrCb?: number | (() => void),
  cb?: () => void,
): any {
  let port = 0;
  let host = "0.0.0.0";
  let done: (() => void) | undefined;

  if (typeof portOrOpts === "number") {
    port = portOrOpts;
    if (typeof hostOrCb === "string") {
      host = hostOrCb;
      done = typeof backlogOrCb === "function" ? backlogOrCb : cb;
    } else if (typeof hostOrCb === "function") {
      done = hostOrCb;
    } else {
      done = typeof backlogOrCb === "function" ? backlogOrCb : cb;
    }
  } else if (portOrOpts) {
    port = portOrOpts.port ?? 0;
    host = portOrOpts.host ?? "0.0.0.0";
    done = typeof hostOrCb === "function" ? hostOrCb : cb;
  }

  if (port === 0) port = PORT_RANGE.BASE + Math.floor(Math.random() * PORT_RANGE.RANGE);

  this._addr = { address: host, family: "IPv4", port };
  this._bound = true;
  this.listening = true;

  // keep the loop alive while listening, released on close
  if (!this._elHandle) this._elHandle = getRegistry().register("TCPServerWrap");

  const self = this;
  queueMicrotask(() => {
    self.emit("listening");
    if (done) done();
  });

  return this;
};

TcpServer.prototype.address = function address(): (NetAddress & { host?: string }) | null {
  if (!this._addr) return null;
  return { ...this._addr, host: this._addr.address };
};

TcpServer.prototype.close = function close(cb?: (err?: Error) => void): any {
  this._bound = false;
  this.listening = false;
  for (const s of this._peers) s.destroy();
  this._peers.clear();
  (this._elHandle as Handle | null)?.close();
  this._elHandle = null;
  const self = this;
  queueMicrotask(() => {
    self.emit("close");
    if (cb) cb();
  });
  return this;
};

TcpServer.prototype.getConnections = function getConnections(
  cb?: (err: Error | null, n: number) => void,
): void {
  if (typeof cb === "function") cb(null, this._peers.size);
};

TcpServer.prototype.ref = function ref(): any {
  (this._elHandle as Handle | null)?.ref();
  return this;
};

TcpServer.prototype.unref = function unref(): any {
  (this._elHandle as Handle | null)?.unref();
  return this;
};

TcpServer.prototype._acceptConnection = function _acceptConnection(sock: TcpSocket): void {
  if (!this._bound) {
    sock.destroy();
    return;
  }
  this._peers.add(sock);
  const self = this;
  sock.on("close", function onClose() { self._peers.delete(sock); });
  this.emit("connection", sock);
};


export function createServer(
  cfgOrHandler?: ServerConfig | ((sock: TcpSocket) => void),
  handler?: (sock: TcpSocket) => void,
): TcpServer {
  return new TcpServer(cfgOrHandler, handler);
}

export function createConnection(
  portOrOpts: number | { port: number; host?: string },
  hostOrCb?: string | (() => void),
  cb?: () => void,
): TcpSocket {
  return new TcpSocket().connect(portOrOpts, hostOrCb as string, cb);
}

export const connect = createConnection;

export function isIP(addr: string): number {
  if (typeof addr !== "string" || addr.length === 0) return 0;
  if (isIPv4Literal(addr)) return 4;
  if (isIPv6Literal(addr)) return 6;
  return 0;
}

function isIPv4Literal(addr: string): boolean {
  const parts = addr.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    // no leading zeros (except "0" itself)
    if (p.length > 1 && p[0] === "0") return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isIPv6Literal(addr: string): boolean {
  // Reject obvious non-IPv6
  if (addr.includes(":::")) return false;
  // IPv4-mapped / embedded
  const v4Tail = addr.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/);
  let core = addr;
  if (v4Tail) {
    if (!isIPv4Literal(v4Tail[1]!)) return false;
    core = addr.slice(0, -v4Tail[1]!.length) + "0:0";
  }
  if (core.includes(".")) return false;
  const sides = core.split("::");
  if (sides.length > 2) return false;
  const checkGroup = (g: string) => /^[0-9a-fA-F]{1,4}$/.test(g);
  if (sides.length === 1) {
    const groups = sides[0]!.split(":");
    return groups.length === 8 && groups.every(checkGroup);
  }
  const left = sides[0] === "" ? [] : sides[0]!.split(":");
  const right = sides[1] === "" ? [] : sides[1]!.split(":");
  if (left.some((g) => g !== "" && !checkGroup(g))) return false;
  if (right.some((g) => g !== "" && !checkGroup(g))) return false;
  if (left.length + right.length >= 8) return false;
  return true;
}

export function isIPv4(addr: string): boolean {
  return isIP(addr) === 4;
}
export function isIPv6(addr: string): boolean {
  return isIP(addr) === 6;
}

type IPFamily = 4 | 6;
interface ParsedIP {
  family: IPFamily;
  value: bigint;
}
interface SocketAddressLike {
  address: string;
  family?: string;
}
type BlockRule =
  | { kind: "address"; ip: ParsedIP; text: string }
  | { kind: "range"; start: ParsedIP; end: ParsedIP; text: string }
  | { kind: "subnet"; ip: ParsedIP; prefix: number; text: string };

function invalidArg(name: string, value: unknown): never {
  const e = new TypeError(
    `The argument '${name}' is invalid. Received ${JSON.stringify(value)}`,
  ) as TypeError & { code: string };
  e.code = "ERR_INVALID_ARG_VALUE";
  throw e;
}

function parseFamily(family: unknown): IPFamily {
  if (family === undefined || family === "ipv4" || family === "IPv4") return 4;
  if (family === "ipv6" || family === "IPv6") return 6;
  return invalidArg("family", family);
}

function parseIP(addr: string, family: IPFamily): ParsedIP | null {
  if (family === 4) {
    if (!isIPv4Literal(addr)) return null;
    let value = 0n;
    for (const part of addr.split(".")) value = (value << 8n) | BigInt(part);
    return { family: 4, value };
  }
  if (!isIPv6Literal(addr)) return null;
  let text = addr;
  const v4Tail = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Tail) {
    const v4 = parseIP(v4Tail[1]!, 4)!.value;
    text =
      text.slice(0, -v4Tail[1]!.length) +
      (v4 >> 16n).toString(16) +
      ":" +
      (v4 & 0xffffn).toString(16);
  }
  const sides = text.split("::");
  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides.length > 1 && sides[1] ? sides[1].split(":") : [];
  const fill = sides.length > 1 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...new Array<string>(fill).fill("0"), ...right];
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt("0x" + g);
  return { family: 6, value };
}

// ::ffff:a.b.c.d is the IPv6 spelling of an IPv4 address; Node matches it
// against IPv4 rules too.
function mappedV4(ip: ParsedIP): ParsedIP | null {
  if (ip.family === 6 && ip.value >> 32n === 0xffffn) {
    return { family: 4, value: ip.value & 0xffffffffn };
  }
  return null;
}

function ruleMatches(rule: BlockRule, ip: ParsedIP): boolean {
  const ruleFamily = rule.kind === "range" ? rule.start.family : rule.ip.family;
  if (ruleFamily !== ip.family) return false;
  if (rule.kind === "address") return rule.ip.value === ip.value;
  if (rule.kind === "range") return ip.value >= rule.start.value && ip.value <= rule.end.value;
  const shift = BigInt(ip.family === 4 ? 32 : 128) - BigInt(rule.prefix);
  return rule.ip.value >> shift === ip.value >> shift;
}

const familyLabel = (family: IPFamily): string => (family === 4 ? "IPv4" : "IPv6");

// net.BlockList: Vite's host check and several dev servers construct one.
export class BlockList {
  private _rules: BlockRule[] = [];

  static isBlockList(value: unknown): value is BlockList {
    return value instanceof BlockList;
  }

  get rules(): string[] {
    return this._rules.map((r) => r.text).reverse(); // Node lists the newest rule first
  }

  addAddress(address: string | SocketAddressLike, family?: string): void {
    const { addr, fam } = this._input("address", address, family);
    const ip = parseIP(addr, fam) ?? invalidArg("address", address);
    this._rules.push({ kind: "address", ip, text: `Address: ${familyLabel(fam)} ${addr}` });
  }

  addRange(
    start: string | SocketAddressLike,
    end: string | SocketAddressLike,
    family?: string,
  ): void {
    const a = this._input("start", start, family);
    const b = this._input("end", end, family);
    const s = parseIP(a.addr, a.fam) ?? invalidArg("start", start);
    const e = parseIP(b.addr, a.fam) ?? invalidArg("end", end);
    if (s.value > e.value) invalidArg("start", start);
    this._rules.push({
      kind: "range",
      start: s,
      end: e,
      text: `Range: ${familyLabel(a.fam)} ${a.addr}-${b.addr}`,
    });
  }

  addSubnet(net: string | SocketAddressLike, prefix: number, family?: string): void {
    const { addr, fam } = this._input("network", net, family);
    const ip = parseIP(addr, fam) ?? invalidArg("network", net);
    const max = fam === 4 ? 32 : 128;
    if (typeof prefix !== "number" || !Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      const e = new RangeError(
        `The value of "prefix" is out of range. It must be >= 0 && <= ${max}. Received ${String(prefix)}`,
      ) as RangeError & { code: string };
      e.code = "ERR_OUT_OF_RANGE";
      throw e;
    }
    this._rules.push({
      kind: "subnet",
      ip,
      prefix,
      text: `Subnet: ${familyLabel(fam)} ${addr}/${prefix}`,
    });
  }

  check(address: string | SocketAddressLike, family?: string): boolean {
    let input: { addr: string; fam: IPFamily };
    try {
      input = this._input("address", address, family);
    } catch {
      return false;
    }
    const ip = parseIP(input.addr, input.fam);
    if (!ip) return false;
    const mapped = mappedV4(ip);
    return this._rules.some(
      (r) => ruleMatches(r, ip) || (mapped !== null && ruleMatches(r, mapped)),
    );
  }

  private _input(
    name: string,
    value: string | SocketAddressLike,
    family?: string,
  ): { addr: string; fam: IPFamily } {
    if (value && typeof value === "object") {
      return { addr: String(value.address), fam: parseFamily(value.family) };
    }
    if (typeof value !== "string") invalidArg(name, value);
    return { addr: value, fam: parseFamily(family) };
  }
}

export default {
  Socket: TcpSocket,
  Server: TcpServer,
  BlockList,
  createServer,
  createConnection,
  connect,
  isIP,
  isIPv4,
  isIPv6,
};
