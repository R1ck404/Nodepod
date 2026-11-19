// VM polyfill using eval/Function since no V8 isolate API in browser

import * as acorn from "acorn";
import { applyPatches, collectEsmCjsPatches } from "../syntax-transforms.js";


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
  const context = sandbox ?? {};
  // code run in the context (a SourceTextModule's `with` scope) reads
  // `globalThis` as the context, like the global object of a Node context
  if (!Object.prototype.hasOwnProperty.call(context, "globalThis")) {
    Object.defineProperty(context, "globalThis", {
      value: contextGlobal(context),
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  return context;
}

// `globalThis` inside a context: its own properties first, then the worker's
// global, as bare names already resolve through the `with` scope. Vitest
// fills a context with the global's own properties, but a Web Worker keeps
// `performance`, `fetch` and its timers on the global's prototype, so
// `globalThis.performance` would otherwise be undefined in the context.
function contextGlobal(context: object): object {
  const host = globalThis as Record<PropertyKey, unknown>;
  const bound = new Map<PropertyKey, { fn: unknown; bound: unknown }>();
  return new Proxy(context, {
    get(target, key) {
      if (Reflect.has(target, key)) return Reflect.get(target, key);
      const value = host[key];
      // methods on the global's prototype need the real global as `this`
      if (typeof value === "function" && !Object.prototype.hasOwnProperty.call(host, key)) {
        const cached = bound.get(key);
        if (cached?.fn === value) return cached.bound;
        const fn = (value as (...args: unknown[]) => unknown).bind(host);
        bound.set(key, { fn: value, bound: fn });
        return fn;
      }
      return value;
    },
    has(target, key) {
      return Reflect.has(target, key) || key in host;
    },
  });
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
/*  ESM modules: SourceTextModule and SyntheticModule                  */
/* ------------------------------------------------------------------ */

// Node's vm modules (--experimental-vm-modules), which Vitest's vmForks and
// vmThreads pools run every test and dependency through. A SourceTextModule
// is converted to a function with Nodepod's ESM-to-CJS patcher: static
// imports read the linked modules' namespaces, `import()` and `import.meta`
// go through the module's callbacks, and a module with top-level await
// becomes an async function. Code runs against `context` with a `with`
// scope, so the context's properties are its globals. Graphs without
// top-level await evaluate synchronously, as in Node.

type ModuleStatus = "unlinked" | "linking" | "linked" | "evaluating" | "evaluated" | "errored";
type ModuleRequest = { specifier: string; attributes: Record<string, string> };
type Linker = (
  specifier: string,
  referencingModule: Module,
  extra: { attributes: Record<string, string>; assert: Record<string, string> },
) => Module | Promise<Module>;

function vmError(code: string, message: string, Ctor: ErrorConstructor = Error): Error {
  const err = new Ctor(message) as Error & { code: string };
  err.code = code;
  return err;
}

function isThenable(v: unknown): v is Promise<unknown> {
  return !!v && typeof (v as { then?: unknown }).then === "function";
}

function createNamespace(): Record<string, unknown> {
  const ns = Object.create(null);
  // Nodepod's import code takes `default` from an __esModule object
  Object.defineProperty(ns, "__esModule", { value: true });
  Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" });
  return ns;
}

let nextModuleId = 0;

export class Module {
  /** @internal */ _status: ModuleStatus = "unlinked";
  /** @internal */ _error: unknown = undefined;
  /** @internal */ _identifier: string;
  /** @internal */ _context: object | undefined;
  /** @internal */ _namespace: Record<string, unknown> = createNamespace();
  /** @internal */ _deps: Array<Module | undefined> = [];
  /** @internal */ _linkPromise: Promise<void> | null = null;
  /** @internal */ _evalPromise: Promise<void> | null = null;
  /** @internal */ _onEvaluated: Array<() => void> = [];

  constructor(options?: { identifier?: string; context?: object }) {
    if (new.target === Module) {
      throw new TypeError("Module is not a constructor");
    }
    this._identifier = options?.identifier ?? `vm:module(${nextModuleId++})`;
    this._context = options?.context;
  }

  get status(): ModuleStatus {
    return this._status;
  }
  get identifier(): string {
    return this._identifier;
  }
  get context(): object | undefined {
    return this._context;
  }
  get namespace(): Record<string, unknown> {
    if (this._status === "unlinked" || this._status === "linking") {
      throw vmError("ERR_VM_MODULE_STATUS", "Module status must not be unlinked or linking");
    }
    return this._namespace;
  }
  get error(): unknown {
    if (this._status !== "errored") {
      throw vmError("ERR_VM_MODULE_STATUS", "Module status must be errored");
    }
    return this._error;
  }
  get moduleRequests(): ReadonlyArray<ModuleRequest> {
    return Object.freeze(this._requests().map((r) => Object.freeze({ ...r })));
  }
  get dependencySpecifiers(): ReadonlyArray<string> {
    return Object.freeze(this._requests().map((r) => r.specifier));
  }

  /** @internal */ _requests(): ModuleRequest[] {
    return [];
  }
  /** @internal */ _execute(): void | Promise<unknown> {}

  link(linker: Linker): Promise<void> {
    if (typeof linker !== "function") {
      return Promise.reject(vmError("ERR_INVALID_ARG_TYPE", 'The "linker" argument must be of type function', TypeError as ErrorConstructor));
    }
    if (this._status !== "unlinked") {
      return Promise.reject(vmError("ERR_VM_MODULE_ALREADY_LINKED", "Module has already been linked"));
    }
    this._status = "linking";
    const requests = this._requests();
    this._linkPromise = Promise.all(
      requests.map(async (req, i) => {
        const dep = await linker(req.specifier, this, { attributes: req.attributes, assert: req.attributes });
        if (!(dep instanceof Module)) {
          throw vmError("ERR_VM_MODULE_NOT_MODULE", "Provided module is not an instance of Module");
        }
        // a cycle hands back a module that is still linking: it finishes on its own
        if (dep._status === "unlinked") await dep.link(linker);
        this._deps[i] = dep;
      }),
    ).then(
      () => {
        this._status = "linked";
        this._linkPromise = null;
      },
      (err) => {
        this._status = "unlinked";
        this._deps = [];
        this._linkPromise = null;
        throw err;
      },
    );
    return this._linkPromise;
  }

  evaluate(_options?: { timeout?: number; breakOnSigint?: boolean }): Promise<void> {
    if (this._status === "unlinked" || this._status === "linking") {
      return Promise.reject(vmError("ERR_VM_MODULE_STATUS", "Module status must be one of linked, evaluating, evaluated, or errored"));
    }
    // a dependency another link() call is still working on
    const pending = this._pendingLinks(new Set());
    if (pending.length > 0) {
      return Promise.all(pending).then(() => this.evaluate());
    }
    try {
      const r = this._run(new Set());
      return isThenable(r) ? r : Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** @internal */ _pendingLinks(seen: Set<Module>, out: Promise<void>[] = []): Promise<void>[] {
    if (seen.has(this)) return out;
    seen.add(this);
    if (this._linkPromise) out.push(this._linkPromise);
    for (const dep of this._deps) dep?._pendingLinks(seen, out);
    return out;
  }

  /** @internal */ _dependency(specifier: string): Module {
    const index = this._requests().findIndex((r) => r.specifier === specifier);
    const dep = index === -1 ? undefined : this._deps[index];
    if (!dep) {
      throw vmError("ERR_VM_MODULE_LINK_FAILURE", `request for '${specifier}' is not linked`);
    }
    return dep;
  }

  // Evaluates dependencies, then this module. Returns a promise only when
  // something in the graph awaits at top level. `ancestors` are the modules
  // whose evaluation led here: reaching one again is an import cycle, which
  // goes on with that module's partial namespace, as in Node.
  /** @internal */ _run(ancestors: Set<Module>): void | Promise<void> {
    switch (this._status) {
      case "evaluated":
        return;
      case "errored":
        throw this._error;
      case "evaluating":
        return ancestors.has(this) ? undefined : (this._evalPromise ?? undefined);
    }
    this._status = "evaluating";
    const path = new Set(ancestors).add(this);
    let result: void | Promise<unknown>;
    try {
      result = this._runFrom(0, path);
    } catch (err) {
      this._fail(err);
      throw err;
    }
    if (!isThenable(result)) {
      this._finish();
      return;
    }
    this._evalPromise = result.then(
      () => this._finish(),
      (err) => {
        this._fail(err);
        throw err;
      },
    );
    return this._evalPromise;
  }

  /** @internal */ _runFrom(index: number, path: Set<Module>): void | Promise<unknown> {
    for (let i = index; i < this._deps.length; i++) {
      const r = this._deps[i]!._run(path);
      if (isThenable(r)) return r.then(() => this._runFrom(i + 1, path));
    }
    return this._execute();
  }

  /** @internal */ _finish(): void {
    this._status = "evaluated";
    this._evalPromise = null;
    for (const fn of this._onEvaluated.splice(0)) fn();
  }

  /** @internal */ _fail(err: unknown): void {
    this._status = "errored";
    this._error = err;
    this._evalPromise = null;
    this._onEvaluated.length = 0;
  }
}

export interface SourceTextModuleOptions {
  identifier?: string;
  context?: object;
  lineOffset?: number;
  columnOffset?: number;
  cachedData?: unknown;
  initializeImportMeta?: (meta: Record<string, unknown>, module: SourceTextModule) => void;
  importModuleDynamically?: (
    specifier: string,
    referrer: SourceTextModule,
    extra: { attributes: Record<string, string>; assert: Record<string, string> },
  ) => Module | Record<string, unknown> | Promise<Module | Record<string, unknown>>;
}

type CompiledModule = (
  moduleRecord: { exports: unknown },
  importBinding: (specifier: string) => unknown,
  importMeta: () => Record<string, unknown>,
  dynamicImport: (specifier: unknown, options?: { with?: Record<string, string> }) => Promise<unknown>,
  liveImport: (specifier: string, update: (ns: unknown) => void) => void,
) => unknown;

const MODULE_PARAMS = "__vmModule, __vmImport, __vmImportMeta, __vmDynamicImport, __liveImport";

// import.meta and import() anywhere in the module; top-level await outside functions
function scanModule(ast: any, patches: Array<[number, number, string]>): boolean {
  let hasTopLevelAwait = false;
  const walk = (node: any, inFunction: boolean): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, inFunction);
      return;
    }
    if (typeof node.type !== "string") return;
    switch (node.type) {
      case "MetaProperty":
        if (node.meta?.name === "import" && node.property?.name === "meta") {
          patches.push([node.start, node.end, "__vmImportMeta()"]);
        }
        return;
      case "ImportExpression":
        patches.push([node.start, node.start + 6, "__vmDynamicImport"]);
        break;
      case "AwaitExpression":
        if (!inFunction) hasTopLevelAwait = true;
        break;
      case "ForOfStatement":
        if (node.await && !inFunction) hasTopLevelAwait = true;
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        inFunction = true;
        break;
    }
    for (const key in node) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      const value = node[key];
      if (value && typeof value === "object") walk(value, inFunction);
    }
  };
  walk(ast, false);
  return hasTopLevelAwait;
}

function attributesOf(node: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of node.attributes ?? []) {
    const key = attr.key?.name ?? attr.key?.value;
    if (typeof key === "string") out[key] = String(attr.value?.value);
  }
  return out;
}

export class SourceTextModule extends Module {
  /** @internal */ _moduleRequests: ModuleRequest[];
  /** @internal */ _fn: CompiledModule;
  /** @internal */ _isAsync: boolean;
  /** @internal */ _options: SourceTextModuleOptions;
  /** @internal */ _meta: Record<string, unknown> | null = null;

  constructor(code: string, options: SourceTextModuleOptions = {}) {
    super(options);
    if (typeof code !== "string") {
      throw vmError("ERR_INVALID_ARG_TYPE", 'The "code" argument must be of type string', TypeError as ErrorConstructor);
    }
    this._options = options;
    const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" }) as any;

    const requests: ModuleRequest[] = [];
    for (const node of ast.body) {
      const isRequest =
        node.type === "ImportDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        (node.type === "ExportNamedDeclaration" && node.source);
      if (!isRequest) continue;
      const specifier = String(node.source.value);
      if (!requests.some((r) => r.specifier === specifier)) {
        requests.push({ specifier, attributes: attributesOf(node) });
      }
    }
    this._moduleRequests = requests;

    const patches: Array<[number, number, string]> = [];
    this._isAsync = scanModule(ast, patches);
    collectEsmCjsPatches(ast, code, patches, {
      exportTarget: "__vmModule.exports",
      importCall: "__vmImport",
      liveImports: true,
    });
    const body = applyPatches(code, patches);
    const fn = `return ${this._isAsync ? "async " : ""}function (${MODULE_PARAMS}) {"use strict";\n${body}\n};`;
    const src = this._context ? `with (__vmContext) { ${fn} }` : fn;
    const sourceUrl = this._identifier.replace(/[\r\n]/g, "");
    const factory = new Function("__vmContext", `${src}\n//# sourceURL=${sourceUrl}`);
    this._fn = factory(this._context) as CompiledModule;
  }

  /** @internal */ override _requests(): ModuleRequest[] {
    return this._moduleRequests;
  }

  /** @internal */ override _execute(): void | Promise<unknown> {
    const ns = this._namespace;
    const record = {
      get exports(): unknown {
        return ns;
      },
      // a module whose only export is its default assigns it here
      set exports(value: unknown) {
        ns.default = value;
      },
    };
    const result = this._fn.call(
      undefined,
      record,
      (specifier) => this._dependency(specifier)._namespace,
      () => this._importMeta(),
      (specifier, options) => this._dynamicImport(specifier, options),
      (specifier, update) => {
        const dep = this._dependency(specifier);
        if (dep._status === "evaluating") dep._onEvaluated.push(() => update(dep._namespace));
      },
    );
    return this._isAsync ? (result as Promise<unknown>) : undefined;
  }

  /** @internal */ _importMeta(): Record<string, unknown> {
    if (!this._meta) {
      this._meta = Object.create(null) as Record<string, unknown>;
      this._options.initializeImportMeta?.(this._meta, this);
    }
    return this._meta;
  }

  /** @internal */ async _dynamicImport(
    specifier: unknown,
    options?: { with?: Record<string, string> },
  ): Promise<unknown> {
    const callback = this._options.importModuleDynamically;
    if (typeof callback !== "function") {
      throw vmError("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING", "A dynamic import callback was not specified.", TypeError as ErrorConstructor);
    }
    const attributes = options?.with ?? {};
    const result = await callback(String(specifier), this, { attributes, assert: attributes });
    if (!(result instanceof Module)) return result;
    if (result._status === "unlinked") {
      throw vmError("ERR_VM_MODULE_STATUS", "Module returned by importModuleDynamically must be linked");
    }
    if (result._status !== "evaluated") await result.evaluate();
    return result._namespace;
  }

  createCachedData(): Uint8Array {
    return new Uint8Array(0);
  }
}

export class SyntheticModule extends Module {
  /** @internal */ _exportNames: Set<string>;
  /** @internal */ _evaluateCallback: (this: SyntheticModule) => unknown;

  constructor(
    exportNames: string[],
    evaluateCallback: (this: SyntheticModule) => unknown,
    options: { identifier?: string; context?: object } = {},
  ) {
    super(options);
    if (!Array.isArray(exportNames) || exportNames.some((n) => typeof n !== "string")) {
      throw vmError("ERR_INVALID_ARG_TYPE", 'The "exportNames" argument must be an array of strings', TypeError as ErrorConstructor);
    }
    if (typeof evaluateCallback !== "function") {
      throw vmError("ERR_INVALID_ARG_TYPE", 'The "evaluateCallback" argument must be of type function', TypeError as ErrorConstructor);
    }
    this._exportNames = new Set(exportNames);
    this._evaluateCallback = evaluateCallback;
    for (const name of exportNames) this._namespace[name] = undefined;
  }

  setExport(name: string, value: unknown): void {
    if (this._status === "unlinked" || this._status === "linking") {
      throw vmError("ERR_VM_MODULE_STATUS", "Module status must not be unlinked or linking");
    }
    if (!this._exportNames.has(name)) {
      throw vmError("ERR_VM_MODULE_EXPORT_NOT_FOUND", `Export '${name}' is not defined in module`, ReferenceError as ErrorConstructor);
    }
    this._namespace[name] = value;
  }

  /** @internal */ override _execute(): void | Promise<unknown> {
    const result = this._evaluateCallback.call(this);
    return isThenable(result) ? result : undefined;
  }
}

export const constants = Object.freeze({
  USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol("vm_dynamic_import_main_context_default"),
  DONT_CONTEXTIFY: Symbol("vm_context_no_contextify"),
});

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
  constants,
};
