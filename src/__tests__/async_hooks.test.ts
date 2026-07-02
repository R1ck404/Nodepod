import { describe, it, expect } from "vitest";
import { AsyncLocalStorage } from "../polyfills/async_hooks";

describe("AsyncLocalStorage", () => {
  it("returns store inside run()", () => {
    const als = new AsyncLocalStorage<string>();
    als.run("hello", () => {
      expect(als.getStore()).toBe("hello");
    });
    expect(als.getStore()).toBeUndefined();
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

  it("matches Next.js createAsyncLocalStorage module-load capture", async () => {
    const maybeGlobal = (globalThis as any).AsyncLocalStorage;
    function createAsyncLocalStorage<T>() {
      return new maybeGlobal() as AsyncLocalStorage<T>;
    }
    const workUnitAsyncStorage = createAsyncLocalStorage<{ type: string }>();

    async function getRSCPayload() {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 5));
      return workUnitAsyncStorage.getStore();
    }

    const store = await workUnitAsyncStorage.run({ type: "request" }, getRSCPayload);
    expect(store).toEqual({ type: "request" });
  });

  it("keeps store for React work after sync run() like renderToFlightStream", async () => {
    const workAsync = new AsyncLocalStorage<{ w: number }>();
    const workUnit = new AsyncLocalStorage<{ u: number }>();
    const requestStore = { u: 1 };

    await workAsync.run({ w: 1 }, async () => {
      await workUnit.run(requestStore, async () => {
        await Promise.resolve();
      });

      // Next.js: sync workUnitAsyncStorage.run(..., renderToFlightStream, ...)
      workUnit.run(requestStore, () => ({ stream: true }));

      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          expect(workUnit.getStore()).toBe(requestStore);
          expect(workAsync.getStore()).toEqual({ w: 1 });
          resolve();
        });
      });
    });
  });
});
