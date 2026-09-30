import { describe, it, expect, vi } from "vitest";
import {
  setInterval,
  setImmediate,
  disposeAllTimers,
} from "../polyfills/timers";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("disposeAllTimers", () => {
  it("does not retain completed immediates until process teardown", async () => {
    const immediate = setImmediate(() => {});
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    const close = vi.spyOn(immediate._handle, "close");
    expect(immediate._fired).toBe(true);
    disposeAllTimers();
    expect(close).not.toHaveBeenCalled();
  });
  it("stops tracked intervals on teardown", async () => {
    let ticks = 0;
    setInterval(() => {
      ticks++;
    }, 20);
    await sleep(60);
    expect(ticks).toBeGreaterThan(0);
    const snap = ticks;
    disposeAllTimers();
    await sleep(80);
    expect(ticks).toBe(snap);
  });
});
