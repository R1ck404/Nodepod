// stub - not available in browser

import { EventEmitter } from "./events.js";
import { getRegistry, type Handle } from "../helpers/event-loop.js";

export interface Socket extends EventEmitter {
  bind(_port?: number, _addr?: string, _cb?: () => void): this;
  close(_cb?: () => void): void;
  send(
    _msg: Uint8Array | string,
    _offset?: number,
    _length?: number,
    _port?: number,
    _addr?: string,
    _cb?: (err: Error | null, bytes: number) => void,
  ): void;
  address(): { address: string; family: string; port: number };
  setBroadcast(_flag: boolean): void;
  setTTL(_ttl: number): number;
  setMulticastTTL(_ttl: number): number;
  setMulticastLoopback(_flag: boolean): boolean;
  setMulticastInterface(_iface: string): void;
  addMembership(_group: string, _iface?: string): void;
  dropMembership(_group: string, _iface?: string): void;
  ref(): this;
  unref(): this;
  setRecvBufferSize(_sz: number): void;
  setSendBufferSize(_sz: number): void;
  getRecvBufferSize(): number;
  getSendBufferSize(): number;
}

export const Socket = function Socket(this: any) {
  if (!this) return;
  EventEmitter.call(this);
  this._elHandle = null;
} as unknown as { new(): Socket; prototype: any };

Object.setPrototypeOf(Socket.prototype, EventEmitter.prototype);

Socket.prototype.bind = function bind(_port?: number, _addr?: string, _cb?: () => void) {
  if (!this._elHandle) this._elHandle = getRegistry().register("UDPWrap");
  if (_cb) setTimeout(_cb, 0);
  return this;
};

Socket.prototype.close = function close(_cb?: () => void): void {
  (this._elHandle as Handle | null)?.close();
  this._elHandle = null;
  if (_cb) setTimeout(_cb, 0);
};

Socket.prototype.send = function send(
  _msg: Uint8Array | string,
  _offset?: number,
  _length?: number,
  _port?: number,
  _addr?: string,
  _cb?: (err: Error | null, bytes: number) => void,
): void {
  if (_cb) setTimeout(() => _cb(null, 0), 0);
};

Socket.prototype.address = function address(): { address: string; family: string; port: number } {
  return { address: "0.0.0.0", family: "IPv4", port: 0 };
};

Socket.prototype.setBroadcast = function setBroadcast(_flag: boolean): void {};
Socket.prototype.setTTL = function setTTL(_ttl: number): number { return _ttl; };
Socket.prototype.setMulticastTTL = function setMulticastTTL(_ttl: number): number { return _ttl; };
Socket.prototype.setMulticastLoopback = function setMulticastLoopback(_flag: boolean): boolean { return _flag; };
Socket.prototype.setMulticastInterface = function setMulticastInterface(_iface: string): void {};
Socket.prototype.addMembership = function addMembership(_group: string, _iface?: string): void {};
Socket.prototype.dropMembership = function dropMembership(_group: string, _iface?: string): void {};
Socket.prototype.ref = function ref() { (this._elHandle as Handle | null)?.ref(); return this; };
Socket.prototype.unref = function unref() { (this._elHandle as Handle | null)?.unref(); return this; };
Socket.prototype.setRecvBufferSize = function setRecvBufferSize(_sz: number): void {};
Socket.prototype.setSendBufferSize = function setSendBufferSize(_sz: number): void {};
Socket.prototype.getRecvBufferSize = function getRecvBufferSize(): number { return 0; };
Socket.prototype.getSendBufferSize = function getSendBufferSize(): number { return 0; };

export function createSocket(
  _type: string | object,
  _cb?: (msg: Uint8Array, rinfo: object) => void,
): Socket {
  return new Socket();
}

export default {
  Socket,
  createSocket,
};
