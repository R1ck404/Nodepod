import { describe, it, expect } from "vitest";
import {
  setInterval,
  disposeAllTimers,
} from "../polyfills/timers";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("disposeAllTimers", () => {
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
