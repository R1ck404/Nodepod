// stub - not available in browser

import { EventEmitter } from "./events.js";

export interface TLSSocket extends EventEmitter {
  authorized: boolean;
  encrypted: boolean;
  getPeerCertificate(_detailed?: boolean): object;
  getCipher(): { name: string; version: string } | null;
  getProtocol(): string | null;
  setServername(_name: string): void;
  renegotiate(_opts: unknown, _cb: (err: Error | null) => void): boolean;
}

export const TLSSocket = function TLSSocket(this: any, _sock?: unknown, _opts?: unknown) {
  if (!this) return;
  EventEmitter.call(this);
  this.authorized = false;
  this.encrypted = true;
} as unknown as { new(_sock?: unknown, _opts?: unknown): TLSSocket; prototype: any };

Object.setPrototypeOf(TLSSocket.prototype, EventEmitter.prototype);

TLSSocket.prototype.getPeerCertificate = function getPeerCertificate(_detailed?: boolean): object {
  return {};
};
TLSSocket.prototype.getCipher = function getCipher(): { name: string; version: string } | null {
  return null;
};
TLSSocket.prototype.getProtocol = function getProtocol(): string | null {
  return null;
};
TLSSocket.prototype.setServername = function setServername(_name: string): void {};
TLSSocket.prototype.renegotiate = function renegotiate(_opts: unknown, _cb: (err: Error | null) => void): boolean {
  return false;
};

export interface Server extends EventEmitter {
  listen(..._args: unknown[]): this;
  close(_cb?: (err?: Error) => void): this;
  address(): { port: number; family: string; address: string } | string | null;
  getTicketKeys(): Uint8Array;
  setTicketKeys(_keys: Uint8Array): void;
  setSecureContext(_opts: unknown): void;
}

export const Server = function Server(this: any, _opts?: unknown, _handler?: (sock: TLSSocket) => void) {
  if (!this) return;
  EventEmitter.call(this);
} as unknown as { new(_opts?: unknown, _handler?: (sock: TLSSocket) => void): Server; prototype: any };

Object.setPrototypeOf(Server.prototype, EventEmitter.prototype);

Server.prototype.listen = function listen(..._args: unknown[]) { return this; };
Server.prototype.close = function close(_cb?: (err?: Error) => void) { return this; };
Server.prototype.address = function address(): { port: number; family: string; address: string } | string | null {
  return null;
};
Server.prototype.getTicketKeys = function getTicketKeys(): Uint8Array {
  return new Uint8Array(0);
};
Server.prototype.setTicketKeys = function setTicketKeys(_keys: Uint8Array): void {};
Server.prototype.setSecureContext = function setSecureContext(_opts: unknown): void {};

export function createServer(
  _opts?: unknown,
  _handler?: (sock: TLSSocket) => void,
): Server {
  return new Server(_opts, _handler);
}

export function connect(_opts: unknown, _cb?: () => void): TLSSocket {
  const sock = new TLSSocket();
  if (_cb) setTimeout(_cb, 0);
  return sock;
}

export function createSecureContext(_opts?: unknown): object {
  return {};
}

export type SecureContext = object;

export const getCiphers = (): string[] => [
  "TLS_AES_256_GCM_SHA384",
  "TLS_AES_128_GCM_SHA256",
];

export const DEFAULT_ECDH_CURVE = "auto";
export const DEFAULT_MAX_VERSION = "TLSv1.3";
export const DEFAULT_MIN_VERSION = "TLSv1.2";
export const rootCertificates: string[] = [];

export default {
  TLSSocket,
  Server,
  createServer,
  connect,
  createSecureContext,
  getCiphers,
  DEFAULT_ECDH_CURVE,
  DEFAULT_MAX_VERSION,
  DEFAULT_MIN_VERSION,
  rootCertificates,
};
