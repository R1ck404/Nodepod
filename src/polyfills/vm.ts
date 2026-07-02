// VM polyfill using eval/Function since no V8 isolate API in browser


/* ------------------------------------------------------------------ */
/*  Script                                                             */
/* ------------------------------------------------------------------ */

export interface Script {
  runInThisContext(_opts?: object): unknown;
  runInNewContext(ctx?: object, _opts?: object): unknown;
  runInContext(ctx: object, _opts?: object): unknown;
  createCachedData(): Uint8Array;
}

export const Script = function Script(this: any, src: string, _opts?: object) {
  if (!this) return;
  this._src = src;
} as unknown as { new(src: string, _opts?: object): Script; prototype: any };

Script.prototype.runInThisContext = function runInThisContext(_opts?: object): unknown {
  return (0, eval)(this._src);
};

Script.prototype.runInNewContext = function runInNewContext(ctx?: object, _opts?: object): unknown {
  const sandbox = (ctx ?? {}) as Record<string, unknown>;
  // In Node's vm, the sandbox IS the context's global object: writes to
  // `globalThis.foo` / `this.foo` inside the script must land on the sandbox.
  // Next.js relies on this (evalManifest reads ctx.__RSC_MANIFEST back out).
  // We emulate it by shadowing `globalThis` with the sandbox and binding
  // `this` to it; sandbox keys are also exposed as local bindings.
  const names = Object.keys(sandbox).filter(
    (n) => n !== "globalThis" && n !== "self" && n !== "this",
  );
  const vals = names.map((n) => sandbox[n]);
  const wrapper = new Function("globalThis", "self", ...names, `return eval(${JSON.stringify(this._src)})`);
  return wrapper.call(sandbox, sandbox, sandbox, ...vals);
};

Script.prototype.runInContext = function runInContext(ctx: object, _opts?: object): unknown {
  return this.runInNewContext(ctx, _opts);
};

Script.prototype.createCachedData = function createCachedData(): Uint8Array {
  return new Uint8Array(0);
};

/* ------------------------------------------------------------------ */
/*  Standalone helpers                                                 */
/* ------------------------------------------------------------------ */

export function createContext(sandbox?: object, _opts?: object): object {
  return sandbox ?? {};
}

export function isContext(_box: object): boolean {
  return true;
}

export function runInThisContext(code: string, _opts?: object): unknown {
  return (0, eval)(code);
}

export function runInNewContext(code: string, ctx?: object, _opts?: object): unknown {
  return new Script(code).runInNewContext(ctx);
}

export function runInContext(code: string, ctx: object, _opts?: object): unknown {
  return runInNewContext(code, ctx);
}

export function compileFunction(
  body: string,
  params?: string[],
  _opts?: object
): Function {
  return new Function(...(params ?? []), body);
}

/* ------------------------------------------------------------------ */
/*  ESM Module stubs                                                   */
/* ------------------------------------------------------------------ */

export interface Module {
  link(_linker: unknown): Promise<void>;
  evaluate(_opts?: object): Promise<unknown>;
  readonly status: string;
  readonly identifier: string;
  readonly context: object;
  readonly namespace: object;
}

export const Module = function Module(this: any, _code: string, _opts?: object) {
  if (!this) return;
} as unknown as { new(_code: string, _opts?: object): Module; prototype: any };

Module.prototype.link = function link(_linker: unknown): Promise<void> { return Promise.resolve(); };
Module.prototype.evaluate = function evaluate(_opts?: object): Promise<unknown> { return Promise.resolve(); };
Object.defineProperty(Module.prototype, 'status', { get() { return 'unlinked'; }, configurable: true });
Object.defineProperty(Module.prototype, 'identifier', { get() { return ''; }, configurable: true });
Object.defineProperty(Module.prototype, 'context', { get() { return {}; }, configurable: true });
Object.defineProperty(Module.prototype, 'namespace', { get() { return {}; }, configurable: true });

export interface SourceTextModule extends Module {}

export const SourceTextModule = function SourceTextModule(this: any, _code: string, _opts?: object) {
  if (!this) return;
  (Module as any).call(this, _code, _opts);
} as unknown as { new(_code: string, _opts?: object): SourceTextModule; prototype: any };

Object.setPrototypeOf(SourceTextModule.prototype, Module.prototype);

export interface SyntheticModule extends Module {
  setExport(_name: string, _value: unknown): void;
}

export const SyntheticModule = function SyntheticModule(this: any, _code: string, _opts?: object) {
  if (!this) return;
  (Module as any).call(this, _code, _opts);
} as unknown as { new(_code: string, _opts?: object): SyntheticModule; prototype: any };

Object.setPrototypeOf(SyntheticModule.prototype, Module.prototype);

SyntheticModule.prototype.setExport = function setExport(_name: string, _value: unknown): void {};

/* ------------------------------------------------------------------ */
/*  Default export                                                     */
/* ------------------------------------------------------------------ */

export default {
  Script,
  createContext,
  isContext,
  runInThisContext,
  runInNewContext,
  runInContext,
  compileFunction,
  Module,
  SourceTextModule,
  SyntheticModule,
};
