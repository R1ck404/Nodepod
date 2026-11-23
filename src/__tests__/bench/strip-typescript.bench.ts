import { bench, describe } from "vitest";
import { stripTypeScript } from "../../strip-typescript";

const API_ROUTE = `
import type { ApiContext } from "./http";
export async function PATCH(ctx: ApiContext) {
  const body = await ctx.readJson<{ value?: string | null }>();
  return body.value ?? null;
}
`.repeat(20);

// Timed here rather than in the unit suite, where a busy machine made a fixed
// threshold flaky. Sucrase takes about 0.8 ms on a source of this size.
describe("stripTypeScript", () => {
  bench("typical API route (~3 KB)", () => {
    stripTypeScript(API_ROUTE, "cells.ts");
  });
});
