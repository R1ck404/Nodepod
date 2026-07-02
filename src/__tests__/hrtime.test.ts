import { describe, it, expect } from "vitest";
import { buildProcessEnv } from "../polyfills/process";

describe("process.hrtime", () => {
  it("borrows a second when nanoseconds underflow", () => {
    const proc = buildProcessEnv();
    const hrtime = proc.hrtime as (prev?: [number, number]) => [number, number];
    const prev: [number, number] = [100, 900_000_000];
    const [ds, dn] = hrtime(prev);
    expect(dn).toBeGreaterThanOrEqual(0);
    expect(dn).toBeLessThan(1e9);
  });
});
