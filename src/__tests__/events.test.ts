import { describe, it, expect, vi } from "vitest";
import eventModule, { EventEmitter } from "../polyfills/events";

describe("EventEmitter", () => {
  describe("newListener / removeListener", () => {
    it("announces a listener before it is added, with the original for once()", () => {
      const ee = new EventEmitter();
      const seen: Array<[string, unknown, number]> = [];
      ee.on("newListener", (name: string, fn: unknown) => {
        seen.push([name, fn, ee.listenerCount(name)]);
      });
      const a = () => {};
      const b = () => {};
      const c = () => {};
      ee.on("data", a);
      ee.once("data", b);
      ee.prependListener("end", c);
      expect(seen).toEqual([["data", a, 0], ["data", b, 1], ["end", c, 0]]);
    });

    it("announces removals, including once() listeners that fire", () => {
      const ee = new EventEmitter();
      const removed: Array<[string, unknown]> = [];
      ee.on("removeListener", (name: string, fn: unknown) => removed.push([name, fn]));
      const a = () => {};
      const b = () => {};
      ee.on("x", a);
      ee.once("y", b);
      ee.removeListener("x", a);
      ee.removeListener("x", a); // not registered anymore: no event
      ee.emit("y");
      expect(removed).toEqual([["x", a], ["y", b]]);
    });

    it("announces every listener removeAllListeners drops", () => {
      const ee = new EventEmitter();
      const removed: string[] = [];
      const a = () => {};
      ee.on("x", a);
      ee.on("y", a);
      ee.on("removeListener", (name: string) => removed.push(name));
      ee.removeAllListeners();
      // like node: the last removeListener listener is gone before it could hear about itself
      expect(removed).toEqual(["x", "y"]);
      expect(ee.eventNames()).toEqual([]);
    });
  });

  describe("on/emit", () => {
    it("emits event and calls listener", () => {
      const ee = new EventEmitter();
      const fn = vi.fn();
      ee.on("test", fn);
      ee.emit("test");
      expect(fn).toHaveBeenCalledOnce();
    });

    it("passes arguments to listener", () => {
      const ee = new EventEmitter();
      const fn = vi.fn();
      ee.on("data", fn);
      ee.emit("data", 1, "two", { three: 3 });
      expect(fn).toHaveBeenCalledWith(1, "two", { three: 3 });
    });

    it("handles multiple listeners on same event", () => {
      const ee = new EventEmitter();
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      ee.on("x", fn1);
      ee.on("x", fn2);
      ee.emit("x");
      expect(fn1).toHaveBeenCalled();
      expect(fn2).toHaveBeenCalled();
    });

    it("returns true when listeners exist, false otherwise", () => {
      const ee = new EventEmitter();
      expect(ee.emit("nope")).toBe(false);
      ee.on("yep", () => {});
      expect(ee.emit("yep")).toBe(true);
    });
  });

  describe("once", () => {
    it("listener fires only once", () => {
      const ee = new EventEmitter();
      const fn = vi.fn();
      ee.once("one", fn);
      ee.emit("one");
      ee.emit("one");
      expect(fn).toHaveBeenCalledOnce();
    });

    it("is removed after first emit", () => {
      const ee = new EventEmitter();
      ee.once("x", () => {});
      expect(ee.listenerCount("x")).toBe(1);
      ee.emit("x");
      expect(ee.listenerCount("x")).toBe(0);
    });

    it("removeListener(original) removes once wrapper via .listener", () => {
      const ee = new EventEmitter();
      const fn = vi.fn();
      ee.once("x", fn);
      expect(ee.listenerCount("x")).toBe(1);
      ee.removeListener("x", fn);
      expect(ee.listenerCount("x")).toBe(0);
      ee.emit("x");
      expect(fn).not.toHaveBeenCalled();
    });

    it("prependOnceListener also supports removeListener(original)", () => {
      const ee = new EventEmitter();
      const fn = vi.fn();
      ee.prependOnceListener("x", fn);
      ee.removeListener("x", fn);
      ee.emit("x");
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("removeListener / off", () => {
    it("removes specific listener", () => {
      const ee = new EventEmitter();
      const fn = vi.fn();
      ee.on("x", fn);
      ee.removeListener("x", fn);
      ee.emit("x");
      expect(fn).not.toHaveBeenCalled();
    });

    it("does not remove other listeners on same event", () => {
      const ee = new EventEmitter();
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      ee.on("x", fn1);
      ee.on("x", fn2);
      ee.off("x", fn1);
      ee.emit("x");
      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).toHaveBeenCalled();
    });
  });

  describe("removeAllListeners", () => {
    it("removes all listeners for a specific event", () => {
      const ee = new EventEmitter();
      ee.on("a", () => {});
      ee.on("a", () => {});
      ee.on("b", () => {});
      ee.removeAllListeners("a");
      expect(ee.listenerCount("a")).toBe(0);
      expect(ee.listenerCount("b")).toBe(1);
    });

    it("removes all listeners for all events when no arg", () => {
      const ee = new EventEmitter();
      ee.on("a", () => {});
      ee.on("b", () => {});
      ee.removeAllListeners();
      expect(ee.eventNames()).toEqual([]);
    });
  });

  describe("error event", () => {
    it("throws Error when emitting 'error' with no listeners", () => {
      const ee = new EventEmitter();
      expect(() => ee.emit("error", new Error("boom"))).toThrow("boom");
    });

    it("throws generic error when payload is not an Error", () => {
      const ee = new EventEmitter();
      expect(() => ee.emit("error", "string")).toThrow("Unhandled error event");
    });

    it("does not throw when error listener is registered", () => {
      const ee = new EventEmitter();
      ee.on("error", () => {});
      expect(() => ee.emit("error", new Error("handled"))).not.toThrow();
    });
  });

  describe("Object.create pattern", () => {
    it("works when created via Object.create(EventEmitter.prototype)", () => {
      const obj = Object.create(EventEmitter.prototype);
      const fn = vi.fn();
      obj.on("test", fn);
      obj.emit("test", 42);
      expect(fn).toHaveBeenCalledWith(42);
    });
  });

  describe("listenerCount", () => {
    it("returns 0 for event with no listeners", () => {
      const ee = new EventEmitter();
      expect(ee.listenerCount("nope")).toBe(0);
    });

    it("returns correct count", () => {
      const ee = new EventEmitter();
      ee.on("x", () => {});
      ee.on("x", () => {});
      expect(ee.listenerCount("x")).toBe(2);
    });
  });

  describe("eventNames", () => {
    it("returns empty array initially", () => {
      const ee = new EventEmitter();
      expect(ee.eventNames()).toEqual([]);
    });

    it("returns array of event names with listeners", () => {
      const ee = new EventEmitter();
      ee.on("a", () => {});
      ee.on("b", () => {});
      expect(ee.eventNames().sort()).toEqual(["a", "b"]);
    });
  });

  describe("prependListener", () => {
    it("adds listener to beginning of list", () => {
      const order: number[] = [];
      const ee = new EventEmitter();
      ee.on("x", () => order.push(1));
      ee.prependListener("x", () => order.push(2));
      ee.emit("x");
      expect(order).toEqual([2, 1]);
    });
  });

  describe("prependOnceListener", () => {
    it("fires once and was prepended", () => {
      const order: number[] = [];
      const ee = new EventEmitter();
      ee.on("x", () => order.push(1));
      ee.prependOnceListener("x", () => order.push(2));
      ee.emit("x");
      ee.emit("x");
      expect(order).toEqual([2, 1, 1]);
    });
  });

  describe("setMaxListeners / getMaxListeners", () => {
    it("defaults to 10", () => {
      const ee = new EventEmitter();
      expect(ee.getMaxListeners()).toBe(10);
    });

    it("can be changed", () => {
      const ee = new EventEmitter();
      ee.setMaxListeners(50);
      expect(ee.getMaxListeners()).toBe(50);
    });
  });

  describe("listeners / rawListeners", () => {
    it("returns copy of listener array", () => {
      const ee = new EventEmitter();
      const fn = () => {};
      ee.on("x", fn);
      const list = ee.listeners("x");
      expect(list).toEqual([fn]);
      list.pop();
      expect(ee.listenerCount("x")).toBe(1);
    });
  });

  describe("static EventEmitter.once()", () => {
    it("returns a Promise that resolves on event", async () => {
      const ee = new EventEmitter();
      const p = eventModule.once(ee, "data");
      ee.emit("data", 42, "extra");
      const result = await p;
      expect(result).toEqual([42, "extra"]);
    });

    it("rejects on error event", async () => {
      const ee = new EventEmitter();
      const p = eventModule.once(ee, "data");
      ee.emit("error", new Error("fail"));
      await expect(p).rejects.toThrow("fail");
    });
  });

  describe("static EventEmitter.listenerCount()", () => {
    it("returns count from target", () => {
      const ee = new EventEmitter();
      ee.on("x", () => {});
      ee.on("x", () => {});
      expect(eventModule.listenerCount(ee, "x")).toBe(2);
    });
  });

  describe("module export shape", () => {
    it("has EventEmitter as both default.EventEmitter and named export", () => {
      expect(eventModule.EventEmitter).toBe(EventEmitter);
    });

    it("has static once, on, getEventListeners, listenerCount", () => {
      expect(typeof eventModule.once).toBe("function");
      expect(typeof eventModule.on).toBe("function");
      expect(typeof eventModule.getEventListeners).toBe("function");
      expect(typeof eventModule.listenerCount).toBe("function");
    });
  });
});
