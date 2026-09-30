import { afterAll, expect, it } from "vitest";

const NativePromise = Promise;
const originalThen = Promise.prototype.then;
const nativeTimeout = setTimeout;
afterAll(() => { Promise.prototype.then = originalThen; });

it("leaves host promises unchanged on import and installs only once when an engine is created", async () => {
  const { ScriptEngine } = await import("../script-engine");
  const { MemoryVolume } = await import("../memory-volume");
  expect(Promise.prototype.then).toBe(originalThen);
  new ScriptEngine(new MemoryVolume());
  const guardedThen = Promise.prototype.then;
  expect(guardedThen).not.toBe(originalThen);
  new ScriptEngine(new MemoryVolume());
  expect(Promise.prototype.then).toBe(guardedThen);
});

it("preserves adversarial rejection reasons without invoking accessors", async () => {
  let accessed = false;
  const brand = Symbol.for("nodepod.ProcessExitSentinel");
  const accessor = Object.defineProperty({}, brand, { get() { accessed = true; throw Error("getter"); } });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw Error("descriptor trap"); } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const reason of [accessor, proxy, revoked.proxy, undefined, "failure"]) {
    expect(await NativePromise.reject(reason).then().catch(error => error === reason)).toBe(true);
    expect(await NativePromise.resolve().then(() => { throw reason; }).catch(error => error === reason)).toBe(true);
  }
  expect(accessed).toBe(false);
});

it("restores nested async context after repeated exits, including bound callbacks", async () => {
  const { AsyncLocalStorage } = await import("../polyfills/async_hooks");
  const { ProcessExitSentinel } = await import("../helpers/event-loop");
  const { guardExitCallback } = await import("../helpers/promise-exit");
  for (let i = 0; i < 5; i++) {
    const outer = new AsyncLocalStorage<Uint8Array>();
    const inner = new AsyncLocalStorage<Uint8Array>();
    const exit = () => { throw new ProcessExitSentinel(0); };
    outer.run(new Uint8Array(1024 * 1024), () => inner.run(new Uint8Array(1024 * 1024), () => {
      if (i % 2) return AsyncLocalStorage.bind(guardExitCallback(exit))(undefined);
      return NativePromise.resolve().then(exit).catch(() => { throw Error("application exit handler ran"); });
    }));
    await new NativePromise<void>(resolve => nativeTimeout(resolve, 0));
    // Remove the intentional last-store fallback to inspect frame membership.
    (outer as { _stickyStore?: Uint8Array })._stickyStore = undefined;
    (inner as { _stickyStore?: Uint8Array })._stickyStore = undefined;
    expect(outer.getStore()).toBeUndefined();
    expect(inner.getStore()).toBeUndefined();
  }
});

it("runs cleanup for the exited process while preserving other processes", async () => {
  const { createProcessContext, getActiveContext, setActiveContext } = await import("../threading/process-context");
  const { MemoryVolume } = await import("../memory-volume");
  const { registerExitCleanup } = await import("../helpers/promise-exit");
  const { ProcessExitSentinel } = await import("../helpers/event-loop");
  const previous = getActiveContext();
  const volume = new MemoryVolume();
  const first = createProcessContext({ volume });
  const second = createProcessContext({ volume });
  const events: string[] = [];
  setActiveContext(first);
  const unregister = registerExitCleanup(() => events.push("first"));
  setActiveContext(second);
  registerExitCleanup(() => events.push("second"));
  try {
    void NativePromise.resolve().then(() => { throw new ProcessExitSentinel(0); });
    await new NativePromise<void>(resolve => nativeTimeout(resolve, 0));
    expect(events).toEqual(["second"]);
  } finally {
    unregister();
    setActiveContext(previous);
    volume.dispose();
  }
});
