import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("refs the host check channel only while immediate callbacks are queued", async () => {
  const port = { onmessage: null as (() => void) | null, ref: vi.fn(), unref: vi.fn() };
  const postMessage = vi.fn();
  vi.stubGlobal(
    "MessageChannel",
    class {
      port1 = port;
      port2 = { postMessage };
    },
  );
  vi.resetModules();
  const { setImmediate, disposeAllTimers } = await import("../polyfills/timers");
  try {
    expect(port.unref).toHaveBeenCalledOnce();
    const callback = vi.fn();
    setImmediate(callback);
    expect(port.ref).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith(0);
    port.onmessage!();
    expect(callback).toHaveBeenCalledOnce();
    expect(port.unref).toHaveBeenCalledTimes(2);
  } finally {
    disposeAllTimers();
  }
});
