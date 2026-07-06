import { describe, it, expect } from "vitest";
import { AsyncLocalStorage } from "../polyfills/async_hooks";

describe("AsyncLocalStorage", () => {
  it("returns store inside run()", () => {
    const als = new AsyncLocalStorage<string>();
    als.run("hello", () => {
      expect(als.getStore()).toBe("hello");
    });
    // Deliberate divergence from Node: the last run's store stays visible
    // (sticky fallback) so late continuations spawned inside run() — which a
    // polyfill can't track across native await resumptions — still see it.
    expect(als.getStore()).toBe("hello");
  });

  it("propagates store across await", async () => {
    const als = new AsyncLocalStorage<string>();
    await als.run("ctx", async () => {
      expect(als.getStore()).toBe("ctx");
      await Promise.resolve();
      expect(als.getStore()).toBe("ctx");
      await new Promise((r) => setTimeout(r, 5));
      expect(als.getStore()).toBe("ctx");
    });
  });

  it("isolates back-to-back async runs", async () => {
    const als = new AsyncLocalStorage<string>();
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const a = await als.run("a", async () => {
      await delay(5);
      return als.getStore();
    });
    const b = await als.run("b", async () => {
      await delay(5);
      return als.getStore();
    });
    expect(a).toBe("a");
    expect(b).toBe("b");
  });

  it("supports nested run()", () => {
    const als = new AsyncLocalStorage<string>();
    als.run("outer", () => {
      expect(als.getStore()).toBe("outer");
      als.run("inner", () => {
        expect(als.getStore()).toBe("inner");
      });
      expect(als.getStore()).toBe("outer");
    });
  });

  it("enterWith makes store visible until exit/run overrides", () => {
    const als = new AsyncLocalStorage<string>();
    als.enterWith("persistent");
    expect(als.getStore()).toBe("persistent");
    als.run("scoped", () => {
      expect(als.getStore()).toBe("scoped");
    });
    expect(als.getStore()).toBe("persistent");
  });

  it("AsyncLocalStorage.bind preserves captured store", async () => {
    const als = new AsyncLocalStorage<number>();
    await als.run(42, async () => {
      const bound = AsyncLocalStorage.bind(() => als.getStore());
      await Promise.resolve();
      expect(bound()).toBe(42);
    });
  });

  it("late continuations spawned inside run() still see the store after run settles", async () => {
    const als = new AsyncLocalStorage<string>();
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let lateResult: string | undefined = "unset";
    let lateDone: () => void;
    const latePromise = new Promise<void>((r) => (lateDone = r));

    await als.run("request", async () => {
      // Streaming-style work that outlives the awaited response promise.
      void (async () => {
        await delay(20);
        lateResult = als.getStore();
        lateDone();
      })();
      await delay(1);
    });

    await latePromise;
    expect(lateResult).toBe("request");
  });

  it("exit() hides the store even with a sticky last run", () => {
    const als = new AsyncLocalStorage<string>();
    als.run("outer", () => {
      als.exit(() => {
        expect(als.getStore()).toBeUndefined();
      });
      expect(als.getStore()).toBe("outer");
    });
  });

  it("disable() clears current and sticky stores", () => {
    const als = new AsyncLocalStorage<string>();
    als.run("x", () => {});
    expect(als.getStore()).toBe("x");
    als.disable();
    expect(als.getStore()).toBeUndefined();
  });
});
