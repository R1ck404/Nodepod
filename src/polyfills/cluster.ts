// stub - not available in browser, always reports as primary

import { EventEmitter } from "./events.js";

/* ------------------------------------------------------------------ */
/*  Flags                                                              */
/* ------------------------------------------------------------------ */

export const isMaster = true;
export const isPrimary = true;
export const isWorker = false;

/* ------------------------------------------------------------------ */
/*  Worker                                                             */
/* ------------------------------------------------------------------ */

export interface Worker extends EventEmitter {
  id: number;
  process: null;
  send(_msg: unknown, _cb?: (err: Error | null) => void): boolean;
  kill(_sig?: string): void;
  disconnect(): void;
  isDead(): boolean;
  isConnected(): boolean;
}

export const Worker = function Worker(this: any) {
  if (!this) return;
  EventEmitter.call(this);
  this.id = 0;
  this.process = null;
} as unknown as { new(): Worker; prototype: any };

Object.setPrototypeOf(Worker.prototype, EventEmitter.prototype);

Worker.prototype.send = function send(_msg: unknown, _cb?: (err: Error | null) => void): boolean { return false; };
Worker.prototype.kill = function kill(_sig?: string): void {};
Worker.prototype.disconnect = function disconnect(): void {};
Worker.prototype.isDead = function isDead(): boolean { return false; };
Worker.prototype.isConnected = function isConnected(): boolean { return false; };

/* ------------------------------------------------------------------ */
/*  Singletons                                                         */
/* ------------------------------------------------------------------ */

export const worker: Worker | null = null;
export const workers: Record<number, Worker> = {};
export const settings: Record<string, unknown> = {};

/* ------------------------------------------------------------------ */
/*  Scheduling                                                         */
/* ------------------------------------------------------------------ */

export const SCHED_NONE = 1;
export const SCHED_RR = 2;
export let schedulingPolicy = SCHED_RR;

/* ------------------------------------------------------------------ */
/*  Functions                                                          */
/* ------------------------------------------------------------------ */

export function fork(_env?: object): Worker {
  return new Worker();
}

export function disconnect(done?: () => void): void {
  if (done) setTimeout(done, 0);
}

export function setupMaster(_cfg?: object): void {}
export function setupPrimary(_cfg?: object): void {}

/* ------------------------------------------------------------------ */
/*  Event emitter delegation                                           */
/* ------------------------------------------------------------------ */

const _bus = new EventEmitter();
export const on = _bus.on.bind(_bus);
export const once = _bus.once.bind(_bus);
export const emit = _bus.emit.bind(_bus);
export const removeListener = _bus.removeListener.bind(_bus);

/* ------------------------------------------------------------------ */
/*  Default export                                                     */
/* ------------------------------------------------------------------ */

export default {
  isMaster,
  isPrimary,
  isWorker,
  Worker,
  worker,
  workers,
  fork,
  disconnect,
  settings,
  SCHED_NONE,
  SCHED_RR,
  schedulingPolicy,
  setupMaster,
  setupPrimary,
  on,
  once,
  emit,
  removeListener,
};
