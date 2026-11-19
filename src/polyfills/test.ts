// lightweight node:test polyfill with describe/it/test, hooks, and basic mocks

export interface TestContext {
  name: string;
  signal: AbortSignal;
  _controller: AbortController;
  diagnostic(msg: string): void;
  plan(_count: number): void;
  todo(msg?: string): void;
  skip(msg?: string): void;
  abort(): void;
}

interface TestContextConstructor {
  new (name: string): TestContext;
  (this: any, name: string): void;
  prototype: any;
}

export const TestContext = function TestContext(this: any, name: string) {
  if (!this) return;
  this.name = name;
  this._controller = new AbortController();
  this.signal = this._controller.signal;
} as unknown as TestContextConstructor;

TestContext.prototype.diagnostic = function diagnostic(this: any, msg: string): void {
  globalThis.console.log(`# ${msg}`);
};

TestContext.prototype.plan = function plan(_count: number): void {
};

TestContext.prototype.todo = function todo(msg?: string): void {
  globalThis.console.log(`# TODO${msg ? ": " + msg : ""}`);
};

TestContext.prototype.skip = function skip(msg?: string): void {
  globalThis.console.log(`# SKIP${msg ? ": " + msg : ""}`);
};

TestContext.prototype.abort = function abort(this: any): void {
  this._controller.abort();
};

type TestFn = (t: TestContext) => void | Promise<void>;
type HookFn = () => void | Promise<void>;

interface TestOpts {
  name: string;
  skip?: boolean;
  todo?: boolean;
  only?: boolean;
}

function markFailed(): void {
  const proc = (globalThis as any).process;
  if (proc) proc.exitCode = 1;
}

export function describe(name: string, fn: () => void | Promise<void>): void;
export function describe(
  options: TestOpts,
  fn: () => void | Promise<void>,
): void;
export function describe(
  nameOrOpts: string | TestOpts,
  fn?: () => void | Promise<void>,
): void {
  const name = typeof nameOrOpts === "string" ? nameOrOpts : nameOrOpts.name;
  const opts: TestOpts = typeof nameOrOpts === "object" ? nameOrOpts : { name };
  const body = fn!;

  if (opts.skip) {
    globalThis.console.log(`# SKIP - ${name}`);
    return;
  }
  if (opts.todo) {
    globalThis.console.log(`# TODO - ${name}`);
    return;
  }

  try {
    const result = body();
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch((err) => {
        markFailed();
        globalThis.console.error(`Suite "${name}" failed:`, err);
      });
    }
  } catch (err) {
    markFailed();
    globalThis.console.error(`Suite "${name}" failed:`, err);
  }
}

export function it(name: string, fn?: TestFn): void;
export function it(options: TestOpts, fn?: TestFn): void;
export function it(nameOrOpts: string | TestOpts, fn?: TestFn): void {
  const name = typeof nameOrOpts === "string" ? nameOrOpts : nameOrOpts.name;
  const opts: TestOpts = typeof nameOrOpts === "object" ? nameOrOpts : { name };

  if (opts.skip || !fn) {
    globalThis.console.log(`# SKIP - ${name}`);
    return;
  }
  if (opts.todo) {
    globalThis.console.log(`# TODO - ${name}`);
    return;
  }

  const ctx = new TestContext(name);
  try {
    const result = fn(ctx);
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch((err) => {
        markFailed();
        globalThis.console.error(`Test "${name}" failed:`, err);
      });
    }
  } catch (err) {
    markFailed();
    globalThis.console.error(`Test "${name}" failed:`, err);
  }
}

export { it as test };

export function before(fn: HookFn): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch((err) => {
        markFailed();
        globalThis.console.error("before hook failed:", err);
      });
    }
  } catch (err) {
    markFailed();
    globalThis.console.error("before hook failed:", err);
  }
}

export function after(fn: HookFn): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch((err) => {
        markFailed();
        globalThis.console.error("after hook failed:", err);
      });
    }
  } catch (err) {
    markFailed();
    globalThis.console.error("after hook failed:", err);
  }
}

export function beforeEach(fn: HookFn): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch((err) => {
        markFailed();
        globalThis.console.error("beforeEach hook failed:", err);
      });
    }
  } catch (err) {
    markFailed();
    globalThis.console.error("beforeEach hook failed:", err);
  }
}

export function afterEach(fn: HookFn): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch((err) => {
        markFailed();
        globalThis.console.error("afterEach hook failed:", err);
      });
    }
  } catch (err) {
    markFailed();
    globalThis.console.error("afterEach hook failed:", err);
  }
}

export function skip(name?: string, _fn?: TestFn): void {
  if (name) globalThis.console.log(`# SKIP - ${name}`);
}

export function todo(name?: string, _fn?: TestFn): void {
  if (name) globalThis.console.log(`# TODO - ${name}`);
}

export const mock = {
  fn(impl?: Function): Function {
    const calls: unknown[][] = [];
    const mockFn = (...args: unknown[]) => {
      calls.push(args);
      return impl ? impl(...args) : undefined;
    };
    (mockFn as any).mock = { calls, callCount: () => calls.length };
    return mockFn;
  },

  method(
    obj: Record<string, unknown>,
    methodName: string,
    impl?: Function,
  ): Function {
    const original = obj[methodName];
    const mocked = mock.fn(impl || (original as Function));
    obj[methodName] = mocked;
    return mocked;
  },

  reset(): void {
  },

  restoreAll(): void {
  },
};

export default Object.assign(it, {
  describe,
  it,
  test: it,
  before,
  after,
  beforeEach,
  afterEach,
  skip,
  todo,
  mock,
  TestContext,
});
