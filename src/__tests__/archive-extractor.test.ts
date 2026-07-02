import { describe, it, expect } from "vitest";
import { safeJoin } from "../packages/archive-extractor";

describe("safeJoin", () => {
  it("joins a normal relative path", () => {
    expect(safeJoin("/node_modules/pkg", "index.js")).toBe("/node_modules/pkg/index.js");
  });

  it("joins a nested path", () => {
    expect(safeJoin("/node_modules/pkg", "lib/a.js")).toBe("/node_modules/pkg/lib/a.js");
  });

  it("rejects path traversal to parent", () => {
    expect(safeJoin("/node_modules/pkg", "../../package.json")).toBeNull();
  });

  it("rejects sibling escape", () => {
    expect(safeJoin("/node_modules/pkg", "../pkg-evil/x.js")).toBeNull();
  });

  it("allows empty relative (base dir)", () => {
    expect(safeJoin("/node_modules/pkg", "")).toBe("/node_modules/pkg");
  });

  it("allows benign .. that normalizes inside", () => {
    expect(safeJoin("/node_modules/pkg", "sub/../ok.js")).toBe("/node_modules/pkg/ok.js");
  });
});
