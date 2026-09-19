// unit tests for HandleRegistry + Handle in src/helpers/event-loop.ts.
// covers the libuv-parity invariants: typed handles, O(1) refed count,
// idempotent close, drain-promise re-arming, beforeExit emission.

import { describe, it, expect } from "vitest";
import {
  createHandleRegistry,
  getRegistry,
  getGlobalRegistry,
  withHandle,
} from "../helpers/event-loop";

describe("HandleRegistry - basics", () => {
  it("register bumps the refed count when refed=true (default)", () => {
    const r = createHandleRegistry();
    const h = r.register("Timeout");
    expect(r.activeRefedCount()).toBe(1);
    expect(h.refed).toBe(true);
    expect(h.type).toBe("Timeout");
    h.close();
  });

  it("register with refed=false does not bump the count", () => {
    const r = createHandleRegistry();
    const h = r.register("Timeout", { refed: false });
    expect(r.activeRefedCount()).toBe(0);
    expect(h.refed).toBe(false);
    // but it's still listed
    expect(r.list().length).toBe(1);
    h.close();
  });

  it("ref() / unref() flip the flag and the counter", () => {
    const r = createHandleRegistry();
    const h = r.register("Timeout", { refed: false });
    expect(r.activeRefedCount()).toBe(0);
    h.ref();
    expect(h.refed).toBe(true);
    expect(r.activeRefedCount()).toBe(1);
    h.unref();
    expect(h.refed).toBe(false);
    expect(r.activeRefedCount()).toBe(0);
    h.close();
  });

  it("ref() is idempotent, second call does not double-count", () => {
    const r = createHandleRegistry();
    const h = r.register("Timeout");
    h.ref();
    h.ref();
    expect(r.activeRefedCount()).toBe(1);
    h.close();
  });

  it("unref() on an unref'd handle is idempotent", () => {
    const r = createHandleRegistry();
    const h = r.register("Timeout");
    h.unref();
    h.unref();
    expect(r.activeRefedCount()).toBe(0);
    h.close();
  });

  it("close() is idempotent, second call is a no-op", () => {
    const r = createHandleRegistry();
    const h = r.register("Timeout");
    h.close();
    h.close(); // should not go negative or remove something already gone
    expect(r.activeRefedCount()).toBe(0);
    expect(r.list().length).toBe(0);
  });

  it("close() on a refed handle auto-unrefs", () => {
    const r = createHandleRegistry();
    const h = r.register("Timeout");
    expect(r.activeRefedCount()).toBe(1);
    h.close();
    expect(r.activeRefedCount()).toBe(0);
    expect(h.closed).toBe(true);
  });

  it("ref()/unref() on a closed handle are no-ops", () => {
    const r = createHandleRegistry();
    const h = r.register("Timeout");
    h.close();
    h.ref();
    expect(r.activeRefedCount()).toBe(0);
    h.unref();
    expect(r.activeRefedCount()).toBe(0);
  });
});

describe("HandleRegistry - list + groupedByType", () => {
  it("list() returns all registered handles (refed or not)", () => {
    const r = createHandleRegistry();
    const a = r.register("Timeout");
    const b = r.register("HTTPServer", { refed: false });
    expect(r.list().length).toBe(2);
    a.close();
    b.close();
    expect(r.list().length).toBe(0);
  });

  it("groupedByType() counts only refed handles, keyed by type string", () => {
    const r = createHandleRegistry();
    r.register("Timeout");
    r.register("Timeout");
    r.register("HTTPServer");
    const h = r.register("FetchRequest");
    h.unref();
    const grouped = r.groupedByType();
    expect(grouped.Timeout).toBe(2);
    expect(grouped.HTTPServer).toBe(1);
    expect(grouped.FetchRequest).toBeUndefined(); // unref'd
  });
});

describe("HandleRegistry - drainPromise", () => {
  it("resolves immediately when count is already 0", async () => {
    const r = createHandleRegistry();
    await expect(r.drainPromise()).resolves.toBeUndefined();
  });

  it("resolves on 1 -> 0 transition", async () => {
    const r = createHandleRegistry();
    const h = r.register("Timeout");
    const p = r.drainPromise();
    let resolved = false;
    p.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    h.close();
    // microtask turn for .then to fire
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("re-arms: a fresh promise is returned after drain", async () => {
    const r = createHandleRegistry();
    const h1 = r.register("Timeout");
    const p1 = r.drainPromise();
    h1.close();
    await p1;

    const h2 = r.register("Timeout");
    const p2 = r.drainPromise();
    expect(p1).not.toBe(p2);
    let resolved = false;
    p2.then(() => {
      resolved = true;
    });
    h2.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("does not resolve on unref-then-re-ref staying above zero", async () => {
    const r = createHandleRegistry();
    const a = r.register("Timeout");
    const b = r.register("Timeout");
    const p = r.drainPromise();
    let resolved = false;
    p.then(() => {
      resolved = true;
    });
    a.close(); // count 2 -> 1, no transition to 0
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    b.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);
  });
});

describe("HandleRegistry - onDrain callbacks", () => {
  it("fires registered onDrain callbacks on transition to 0", () => {
    const r = createHandleRegistry();
    const h = r.register("Timeout");
    let calls = 0;
    r.onDrain(() => {
      calls++;
    });
    h.close();
    expect(calls).toBe(1);
  });

  it("disposer removes the callback", () => {
    const r = createHandleRegistry();
    const h = r.register("Timeout");
    let calls = 0;
    const dispose = r.onDrain(() => {
      calls++;
    });
    dispose();
    h.close();
    expect(calls).toBe(0);
  });
});

describe("HandleRegistry - beforeExit", () => {
  it("emitBeforeExit awaits sequential handlers", async () => {
    const r = createHandleRegistry();
    const order: number[] = [];
    r.onBeforeExit(async (code) => {
      await new Promise((res) => setTimeout(res, 5));
      order.push(1);
      expect(code).toBe(0);
    });
    r.onBeforeExit(async () => {
      order.push(2);
    });
    await r.emitBeforeExit(0);
    expect(order).toEqual([1, 2]);
  });

  it("swallows handler errors (matches node exit-time semantics)", async () => {
    const r = createHandleRegistry();
    r.onBeforeExit(() => {
      throw new Error("boom");
    });
    let reached = false;
    r.onBeforeExit(() => {
      reached = true;
    });
    await r.emitBeforeExit(0);
    expect(reached).toBe(true);
  });

  it("disposer removes the beforeExit handler", async () => {
    const r = createHandleRegistry();
    let calls = 0;
    const dispose = r.onBeforeExit(() => {
      calls++;
    });
    dispose();
    await r.emitBeforeExit(0);
    expect(calls).toBe(0);
  });
});

describe("HandleRegistry - closeAll", () => {
  it("closes every outstanding handle and zeroes the counter", () => {
    const r = createHandleRegistry();
    r.register("Timeout");
    r.register("HTTPServer");
    r.register("FetchRequest", { refed: false });
    expect(r.list().length).toBe(3);
    r.closeAll();
    expect(r.list().length).toBe(0);
    expect(r.activeRefedCount()).toBe(0);
  });
});

describe("event-loop module - global registry", () => {
  it("getGlobalRegistry returns a stable registry", () => {
    const a = getGlobalRegistry();
    const b = getGlobalRegistry();
    expect(a).toBe(b);
  });

  it("getRegistry falls back to the global registry with no active context", () => {
    expect(getRegistry()).toBe(getGlobalRegistry());
  });
});

describe("withHandle", () => {
  it("keeps a refed handle for the duration of the work, then closes it", async () => {
    const registry = getGlobalRegistry();
    const before = registry.activeRefedCount();
    let during = -1;
    const result = await withHandle("DynamicImport", async () => {
      during = registry.activeRefedCount();
      await new Promise((r) => setTimeout(r, 5));
      return "loaded";
    });
    expect(result).toBe("loaded");
    expect(during).toBe(before + 1);
    expect(registry.activeRefedCount()).toBe(before);
  });

  it("closes the handle when the work rejects", async () => {
    const registry = getGlobalRegistry();
    const before = registry.activeRefedCount();
    await expect(
      withHandle("WASMWork", async () => {
        throw new Error("cdn unreachable");
      }),
    ).rejects.toThrow("cdn unreachable");
    expect(registry.activeRefedCount()).toBe(before);
  });
});
