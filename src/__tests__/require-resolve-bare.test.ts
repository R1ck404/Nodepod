import { describe, it, expect } from "vitest";
import { ScriptEngine } from "../script-engine";
import { MemoryVolume } from "../memory-volume";

describe("require.resolve bare package names", () => {
  it("resolves installed packages to filesystem paths, not bare specifiers", () => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/project/node_modules/rollup/dist", { recursive: true });
    vol.writeFileSync(
      "/project/node_modules/rollup/package.json",
      JSON.stringify({
        name: "rollup",
        version: "4.0.0",
        main: "dist/rollup.js",
      }),
    );
    vol.writeFileSync(
      "/project/node_modules/rollup/dist/rollup.js",
      "module.exports = {};",
    );

    const engine = new ScriptEngine(vol, { cwd: "/project" });
    const result = engine.execute(
      `
      const bare = require.resolve('rollup');
      const subpath = require.resolve('rollup/dist/rollup.js');
      const path = require('path');
      const brokenPkg = path.resolve(bare, '../../package.json');
      module.exports = { bare, subpath, brokenPkg };
    `,
      "/project/test.js",
    );

    const { bare, subpath, brokenPkg } = result.exports as {
      bare: string;
      subpath: string;
      brokenPkg: string;
    };

    expect(bare).toBe("/project/node_modules/rollup/dist/rollup.js");
    expect(subpath).toBe("/project/node_modules/rollup/dist/rollup.js");
    expect(brokenPkg).toBe("/project/node_modules/rollup/package.json");
  });
});
