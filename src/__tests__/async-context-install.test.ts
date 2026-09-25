import { afterAll, describe, expect, it } from "vitest";

// module state: this file checks what importing async_hooks does, and what
// the first AsyncLocalStorage changes, so it needs a fresh module
const NativePromise = globalThis.Promise;
const nativeSetTimeout = globalThis.setTimeout;
const nativeQueueMicrotask = globalThis.queueMicrotask;

afterAll(() => {
  globalThis.Promise = NativePromise;
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.queueMicrotask = nativeQueueMicrotask;
});

describe("async context installation", () => {
  it("tracks nothing until a storage exists, then keeps promises promises", async () => {
    // a process's own timers, like the script engine installs them
    const ownSetTimeout = Object.assign(
      (handler: () => void, ms?: number) => nativeSetTimeout(handler, ms),
      { __nodepodPatched: true },
    ) as unknown as typeof setTimeout;
    globalThis.setTimeout = ownSetTimeout;

    const { AsyncLocalStorage } = await import("../polyfills/async_hooks");
    expect(globalThis.Promise).toBe(NativePromise);
    const early = new Promise<number>((resolve) => resolve(1));

    const als = new AsyncLocalStorage<string>();
    expect(globalThis.Promise).not.toBe(NativePromise);
    expect(globalThis.setTimeout).toBe(ownSetTimeout);
    expect(globalThis.queueMicrotask).not.toBe(nativeQueueMicrotask);

    // made before, or by an async function: still `instanceof Promise`
    expect(early instanceof Promise).toBe(true);
    expect((async () => 2)() instanceof Promise).toBe(true);
    const tracked = Promise.resolve(3);
    expect(Promise.resolve(tracked)).toBe(tracked);
    // a library's own promise class still tells its promises apart
    class Cancelable<T> extends Promise<T> {}
    expect(Promise.resolve(1) instanceof Cancelable).toBe(false);
    expect(new Cancelable<number>((resolve) => resolve(1)) instanceof Cancelable).toBe(true);
    expect(new Cancelable<number>((resolve) => resolve(1)) instanceof Promise).toBe(true);
    expect(await Promise.resolve(early)).toBe(1);

    const seen = await als.run("request", async () => {
      await Promise.resolve();
      return new Promise<string | undefined>((resolve) => {
        Promise.resolve().then(() => resolve(als.getStore()));
      });
    });
    expect(seen).toBe("request");
  });
});
