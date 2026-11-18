// stub - deprecated in Node.js, minimal pass-through implementation


import { EventEmitter } from "./events.js";

/* ------------------------------------------------------------------ */
/*  Domain                                                             */
/* ------------------------------------------------------------------ */

export interface Domain extends EventEmitter {
  members: unknown[];
  add(emitter: EventEmitter): void;
  remove(emitter: EventEmitter): void;
  bind<F extends (...args: unknown[]) => unknown>(fn: F): F;
  intercept<F extends (...args: unknown[]) => unknown>(fn: F): F;
  run<T>(fn: () => T): T;
  dispose(): void;
  enter(): void;
  exit(): void;
}

export const Domain = function Domain(this: any) {
  if (!this) return;
  EventEmitter.call(this);
  this.members = [];
} as unknown as { new(): Domain; prototype: any };

Object.setPrototypeOf(Domain.prototype, EventEmitter.prototype);

Domain.prototype.add = function add(emitter: EventEmitter): void {
  this.members.push(emitter);
};
Domain.prototype.remove = function remove(emitter: EventEmitter): void {
  const idx = this.members.indexOf(emitter);
  if (idx >= 0) this.members.splice(idx, 1);
};
Domain.prototype.bind = function bind<F extends (...args: unknown[]) => unknown>(fn: F): F {
  return fn;
};
Domain.prototype.intercept = function intercept<F extends (...args: unknown[]) => unknown>(fn: F): F {
  return fn;
};
Domain.prototype.run = function run<T>(fn: () => T): T {
  return fn();
};
Domain.prototype.dispose = function dispose(): void {
  this.members.length = 0;
};
Domain.prototype.enter = function enter(): void {};
Domain.prototype.exit = function exit(): void {};

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

export function create(): Domain {
  return new Domain();
}export let active: Domain | null = null;

/* ------------------------------------------------------------------ */
/*  Default export                                                     */
/* ------------------------------------------------------------------ */

export default {
  Domain,
  create,
  active,
};
