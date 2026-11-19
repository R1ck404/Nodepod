// node:test — a runner compatible with Node's built-in test module.
//
// Tests and suites declared while a file loads are queued, then run in order once the module has
// finished loading. Output follows Node's "spec" reporter, ending with the same summary lines
// (ℹ tests, ℹ pass, ℹ fail, ...), and process.exitCode is set to 1 when anything fails.

type HookFn = (ctx?: unknown) => unknown;
type TestFn = (t: TestContext, done?: (err?: unknown) => void) => unknown;
type SuiteFn = (s?: SuiteContext) => unknown;

interface TestOpts {
  name?: string;
  skip?: boolean | string;
  todo?: boolean | string;
  only?: boolean;
  timeout?: number;
  concurrency?: number | boolean;
}

interface Hooks {
  before: HookFn[];
  after: HookFn[];
  beforeEach: HookFn[];
  afterEach: HookFn[];
}

interface Node {
  kind: "suite" | "test";
  name: string;
  fn?: TestFn | SuiteFn;
  opts: TestOpts;
  parent: Node | null;
  children: Node[];
  hooks: Hooks;
  /** Promise for an async describe body, awaited before the suite runs. */
  collecting?: Promise<unknown>;
}

const newHooks = (): Hooks => ({ before: [], after: [], beforeEach: [], afterEach: [] });
const root: Node = { kind: "suite", name: "<root>", opts: {}, parent: null, children: [], hooks: newHooks() };
let current: Node = root;
let scheduled = false;
let running = false;

const stats = { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
const failures: Array<{ name: string; error: unknown }> = [];

const out = (line: string) => globalThis.console.log(line);
const indent = (depth: number) => "  ".repeat(depth);
const ms = (start: number) => `${(performance.now() - start).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}ms`;
const label = (v: boolean | string | undefined) => (typeof v === "string" && v ? ` ${v}` : "");

function parseArgs(a: unknown, b: unknown, c: unknown): { name: string; opts: TestOpts; fn?: Function } {
  let name = "<anonymous>";
  let opts: TestOpts = {};
  let fn: Function | undefined;
  for (const arg of [a, b, c]) {
    if (typeof arg === "string") name = arg;
    else if (typeof arg === "function") fn = arg;
    else if (arg && typeof arg === "object") opts = arg as TestOpts;
  }
  if (name === "<anonymous>" && opts.name) name = opts.name;
  if (name === "<anonymous>" && fn && fn.name) name = fn.name;
  return { name, opts, fn };
}

function formatError(err: unknown, depth: number): string {
  let text: string;
  if (err instanceof Error) {
    const e = err as Error & { code?: string; expected?: unknown; actual?: unknown; operator?: string };
    const heading = `${e.name}${e.code ? ` [${e.code}]` : ""}: ${e.message}`;
    const stack = e.stack ?? "";
    // Some engine errors omit the message from the stack; lead with it so the reason is always shown.
    const firstLine = stack.split("\n")[0] ?? "";
    text = e.message && !firstLine.includes(e.message) ? `${heading}\n${stack.split("\n").slice(1).join("\n")}` : stack || heading;
    if ("expected" in e || "actual" in e) {
      const show = (v: unknown) => {
        try {
          return typeof v === "string" ? JSON.stringify(v) : String(JSON.stringify(v) ?? v);
        } catch {
          return String(v);
        }
      };
      text += `\n  expected: ${show(e.expected)}\n  actual: ${show(e.actual)}${e.operator ? `\n  operator: ${e.operator}` : ""}`;
    }
  } else {
    text = String(err);
  }
  return text
    .split("\n")
    .map((l) => `${indent(depth)}  ${l}`)
    .join("\n");
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  // Run after the file (and any top-level awaits) has finished registering tests.
  setTimeout(() => {
    void runRoot();
  }, 0);
}

/** A test that ran past its timeout; Node counts it as cancelled rather than failed. */
class TestTimeoutError extends Error {
  readonly code = "ERR_TEST_FAILURE";
  readonly failureType = "testTimeoutFailure";
}

function withTimeout<T>(p: Promise<T>, timeout: number | undefined, what: string): Promise<T> {
  if (!timeout || !isFinite(timeout)) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TestTimeoutError(`${what} timed out after ${timeout}ms`)), timeout);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Calls a test or hook function, supporting both promises and the (t, done) callback style. */
function invoke(fn: Function, thisArg: unknown, args: unknown[]): Promise<unknown> {
  if (fn.length > args.length) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: unknown) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(undefined);
      };
      try {
        const r = fn.apply(thisArg, [...args, done]);
        if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).catch(done);
      } catch (err) {
        done(err);
      }
    });
  }
  try {
    return Promise.resolve(fn.apply(thisArg, args));
  } catch (err) {
    return Promise.reject(err);
  }
}

function ancestors(node: Node): Node[] {
  const list: Node[] = [];
  for (let n: Node | null = node.parent; n; n = n.parent) list.unshift(n);
  return list;
}

async function runHooks(fns: HookFn[], ctx: unknown, what: string): Promise<void> {
  for (const fn of fns) await withTimeout(invoke(fn, undefined, [ctx]), undefined, what);
}

export class TestContext {
  readonly name: string;
  readonly signal: AbortSignal;
  readonly fullName: string;
  /** Set by t.skip() / t.todo() while the test runs. */
  _skip: string | boolean = false;
  _todo: string | boolean = false;
  readonly _depth: number;
  readonly _controller = new AbortController();
  readonly _subtests: Promise<unknown>[] = [];
  /** Suites whose beforeEach/afterEach hooks also wrap this test's subtests. */
  readonly _eachChain: Node[];
  readonly mock = mock;
  readonly assert = assertProxy();

  constructor(name: string, depth = 0, fullName = name, eachChain: Node[] = []) {
    this.name = name;
    this.fullName = fullName;
    this._depth = depth;
    this._eachChain = eachChain;
    this.signal = this._controller.signal;
  }
  diagnostic(msg: string): void {
    out(`${indent(this._depth + 1)}ℹ ${msg}`);
  }
  plan(_count: number): void {
    /* planning is accepted but not enforced */
  }
  skip(msg?: string): void {
    this._skip = msg ?? true;
  }
  todo(msg?: string): void {
    this._todo = msg ?? true;
  }
  runOnly(_on: boolean): void {
    /* only-filtering is not applied */
  }
  before(fn: HookFn): void {
    void fn;
  }
  after(fn: HookFn): void {
    void fn;
  }
  beforeEach(fn: HookFn): void {
    void fn;
  }
  afterEach(fn: HookFn): void {
    void fn;
  }
  /** Runs a subtest immediately and returns a promise for its completion. */
  test(a?: unknown, b?: unknown, c?: unknown): Promise<void> {
    const { name, opts, fn } = parseArgs(a, b, c);
    const node: Node = { kind: "test", name, fn: fn as TestFn, opts, parent: null, children: [], hooks: newHooks() };
    const p = runTest(node, this._depth + 1, `${this.fullName} > ${name}`, this._eachChain);
    this._subtests.push(p);
    return p;
  }
}

export class SuiteContext {
  constructor(
    readonly name: string,
    readonly signal: AbortSignal = new AbortController().signal,
  ) {}
}

function assertProxy(): unknown {
  // t.assert mirrors node:assert where the engine provides it.
  try {
    const req = (globalThis as { require?: (id: string) => unknown }).require;
    if (req) return req("assert");
  } catch {
    /* fall through */
  }
  return {};
}

async function runTest(node: Node, depth: number, fullName: string, eachChain: Node[]): Promise<void> {
  const start = performance.now();
  const { opts } = node;
  if (opts.skip) {
    stats.tests++;
    stats.skipped++;
    out(`${indent(depth)}﹣ ${node.name} (${ms(start)}) # SKIP${label(opts.skip)}`);
    return;
  }
  const ctx = new TestContext(node.name, depth, fullName, eachChain);
  let error: unknown = null;
  try {
    for (const suite of eachChain) await runHooks(suite.hooks.beforeEach, ctx, "beforeEach hook");
    // As in Node, a test without a function is an empty test that passes.
    if (node.fn) await withTimeout(invoke(node.fn as Function, ctx, [ctx]), opts.timeout, `test "${node.name}"`);
    await Promise.all(ctx._subtests);
  } catch (err) {
    error = err;
  }
  try {
    for (const suite of [...eachChain].reverse()) await runHooks(suite.hooks.afterEach, ctx, "afterEach hook");
  } catch (err) {
    error = error ?? err;
  }
  stats.tests++;
  const todo = opts.todo || ctx._todo;
  const skip = ctx._skip;
  if (skip) {
    stats.skipped++;
    out(`${indent(depth)}﹣ ${node.name} (${ms(start)}) # SKIP${label(skip)}`);
  } else if (todo) {
    stats.todo++;
    out(`${indent(depth)}✔ ${node.name} (${ms(start)}) # TODO${label(todo)}`);
  } else if (error) {
    if (error instanceof TestTimeoutError) stats.cancelled++;
    else stats.fail++;
    failures.push({ name: fullName, error });
    out(`${indent(depth)}✖ ${node.name} (${ms(start)})`);
    out(formatError(error, depth));
  } else {
    stats.pass++;
    out(`${indent(depth)}✔ ${node.name} (${ms(start)})`);
  }
}

async function runSuite(node: Node, depth: number, fullName: string): Promise<void> {
  const start = performance.now();
  const failedBefore = failures.length;
  if (node.collecting) {
    try {
      await node.collecting;
    } catch (err) {
      stats.suites++;
      stats.fail++;
      failures.push({ name: fullName, error: err });
      out(`${indent(depth)}✖ ${node.name} (${ms(start)})`);
      out(formatError(err, depth));
      return;
    }
  }
  if (node !== root) {
    stats.suites++;
    if (node.opts.skip || node.opts.todo) {
      out(`${indent(depth)}﹣ ${node.name} (${ms(start)}) # ${node.opts.skip ? "SKIP" : "TODO"}`);
      return;
    }
    out(`${indent(depth)}▶ ${node.name}`);
  }
  const childDepth = node === root ? depth : depth + 1;
  const chain = [...ancestors(node), node];
  let hookError: unknown = null;
  try {
    await runHooks(node.hooks.before, new SuiteContext(node.name), "before hook");
  } catch (err) {
    hookError = err;
  }
  if (!hookError) {
    for (const child of node.children) {
      const childName = node === root ? child.name : `${fullName} > ${child.name}`;
      if (child.kind === "suite") await runSuite(child, childDepth, childName);
      else await runTest(child, childDepth, childName, chain);
    }
  }
  try {
    await runHooks(node.hooks.after, new SuiteContext(node.name), "after hook");
  } catch (err) {
    hookError = hookError ?? err;
  }
  if (hookError) {
    stats.fail++;
    failures.push({ name: `${fullName} (hook)`, error: hookError });
    out(formatError(hookError, childDepth));
  }
  // A suite closes with ✖ when anything inside it failed, as in Node's spec reporter.
  if (node !== root) out(`${indent(depth)}${failures.length > failedBefore ? "✖" : "✔"} ${node.name} (${ms(start)})`);
}

async function runRoot(): Promise<void> {
  if (running) return;
  running = true;
  const start = performance.now();
  await runSuite(root, 0, "");
  if (failures.length) {
    out("");
    out("✖ failing tests:");
    out("");
    for (const f of failures) {
      out(`test at ${f.name}`);
      out(formatError(f.error, 0));
      out("");
    }
  }
  out(`ℹ tests ${stats.tests}`);
  out(`ℹ suites ${stats.suites}`);
  out(`ℹ pass ${stats.pass}`);
  out(`ℹ fail ${stats.fail}`);
  out(`ℹ cancelled ${stats.cancelled}`);
  out(`ℹ skipped ${stats.skipped}`);
  out(`ℹ todo ${stats.todo}`);
  out(`ℹ duration_ms ${(performance.now() - start).toFixed(3)}`);
  const proc = (globalThis as { process?: { exitCode?: number } }).process;
  if (proc && failures.length > 0) proc.exitCode = 1;
  reset();
}

/**
 * Clears the finished run. Each Node process loads node:test afresh; scripts that share one
 * JavaScript realm (a host without process workers, or `node --test` over several files) share
 * this module, so the next script must start from an empty tree.
 */
function reset(): void {
  root.children.length = 0;
  root.hooks = newHooks();
  current = root;
  for (const key of Object.keys(stats) as Array<keyof typeof stats>) stats[key] = 0;
  failures.length = 0;
  scheduled = false;
  running = false;
}

function register(kind: "suite" | "test", a: unknown, b: unknown, c: unknown, extra: TestOpts = {}): void {
  const { name, opts, fn } = parseArgs(a, b, c);
  const node: Node = {
    kind,
    name,
    fn: fn as TestFn | SuiteFn,
    opts: { ...opts, ...extra },
    parent: current,
    children: [],
    hooks: newHooks(),
  };
  current.children.push(node);
  if (kind === "suite" && fn && !node.opts.skip && !node.opts.todo) {
    const previous = current;
    current = node;
    try {
      const r = (fn as SuiteFn)(new SuiteContext(name));
      if (r && typeof (r as Promise<unknown>).then === "function") node.collecting = r as Promise<unknown>;
    } catch (err) {
      node.collecting = Promise.reject(err);
      node.collecting.catch(() => undefined);
    } finally {
      current = previous;
    }
  }
  schedule();
}

type Registrar = ((a?: unknown, b?: unknown, c?: unknown) => void) & {
  skip: (a?: unknown, b?: unknown, c?: unknown) => void;
  todo: (a?: unknown, b?: unknown, c?: unknown) => void;
  only: (a?: unknown, b?: unknown, c?: unknown) => void;
};

function registrar(kind: "suite" | "test"): Registrar {
  const fn = ((a?: unknown, b?: unknown, c?: unknown) => register(kind, a, b, c)) as Registrar;
  fn.skip = (a, b, c) => register(kind, a, b, c, { skip: true });
  fn.todo = (a, b, c) => register(kind, a, b, c, { todo: true });
  fn.only = (a, b, c) => register(kind, a, b, c, { only: true });
  return fn;
}

export const describe = registrar("suite");
export const suite = describe;
export const it = registrar("test");

function addHook(kind: keyof Hooks) {
  return (fn: HookFn): void => {
    current.hooks[kind].push(fn);
    schedule();
  };
}

export const before = addHook("before");
export const after = addHook("after");
export const beforeEach = addHook("beforeEach");
export const afterEach = addHook("afterEach");

export function skip(a?: unknown, b?: unknown, c?: unknown): void {
  register("test", a, b, c, { skip: true });
}
export function todo(a?: unknown, b?: unknown, c?: unknown): void {
  register("test", a, b, c, { todo: true });
}
export function only(a?: unknown, b?: unknown, c?: unknown): void {
  register("test", a, b, c, { only: true });
}

interface MockCall {
  arguments: unknown[];
  result?: unknown;
  error?: unknown;
  this: unknown;
}

function createMockFn(original?: Function, impl?: Function, restore?: () => void): Function {
  const calls: MockCall[] = [];
  let implementation = impl ?? original;
  const fn = function (this: unknown, ...args: unknown[]) {
    const call: MockCall = { arguments: args, this: this };
    calls.push(call);
    try {
      call.result = implementation ? implementation.apply(this, args) : undefined;
      return call.result;
    } catch (err) {
      call.error = err;
      throw err;
    }
  };
  (fn as unknown as { mock: unknown }).mock = {
    calls,
    callCount: () => calls.length,
    mockImplementation: (next: Function) => {
      implementation = next;
    },
    resetCalls: () => {
      calls.length = 0;
    },
    restore: () => restore?.(),
  };
  return fn;
}

const restorers: Array<() => void> = [];

export const mock = {
  fn(original?: Function, impl?: Function): Function {
    return createMockFn(original, impl);
  },
  method(obj: Record<string, unknown>, methodName: string, impl?: Function): Function {
    const original = obj[methodName] as Function | undefined;
    const restore = () => {
      obj[methodName] = original;
    };
    const mocked = createMockFn(original, impl, restore);
    obj[methodName] = mocked;
    restorers.push(restore);
    return mocked;
  },
  reset(): void {
    mock.restoreAll();
  },
  restoreAll(): void {
    while (restorers.length) restorers.pop()!();
  },
};

/** `require('node:test')` returns the test function itself, carrying the rest as properties. */
const test = registrar("test") as Registrar & Record<string, unknown>;
Object.assign(test, {
  test,
  it,
  describe,
  suite,
  before,
  after,
  beforeEach,
  afterEach,
  mock,
  TestContext,
  SuiteContext,
});
(test as Record<string, unknown>).default = test;

export { test };
export default test;
