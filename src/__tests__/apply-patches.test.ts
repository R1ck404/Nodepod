import { describe, expect, it } from "vitest";
import { applyPatches } from "../syntax-transforms";

// The loop applyPatches replaced: sort by descending start/end (stable), then
// splice back to front.
function applyPatchesQuadratic(
  source: string,
  patches: Array<[number, number, string]>,
): string {
  let output = source;
  const sorted = [...patches].sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (const [s, e, r] of sorted) output = output.slice(0, s) + r + output.slice(e);
  return output;
}

function rng(seed: number) {
  return () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x9e3779b9) | 0;
    return (seed >>> 0) / 4294967296;
  };
}

describe("applyPatches", () => {
  it("matches the back-to-front splice for non-overlapping patches", () => {
    const rand = rng(42);
    for (let iter = 0; iter < 2000; iter++) {
      const len = Math.floor(rand() * 60);
      const source = Array.from({ length: len }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
      const patches: Array<[number, number, string]> = [];
      let pos = 0;
      while (pos <= len && patches.length < 12) {
        const start = pos + Math.floor(rand() * 5);
        if (start > len) break;
        // zero-width insertions (possibly several at one point) and ranges
        const width = rand() < 0.4 ? 0 : Math.min(len - start, Math.floor(rand() * 6));
        patches.push([start, start + width, `<${patches.length}>`]);
        if (width === 0 && rand() < 0.5) patches.push([start, start, `[${patches.length}]`]);
        pos = start + width;
      }
      // shuffle push order
      for (let i = patches.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [patches[i], patches[j]] = [patches[j], patches[i]];
      }
      expect(applyPatches(source, patches)).toBe(applyPatchesQuadratic(source, patches));
    }
  });

  it("returns the source untouched without patches", () => {
    expect(applyPatches("abc", [])).toBe("abc");
  });
});
