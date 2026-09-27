import { describe, it, expect } from "vitest";
import { ScriptEngine } from "../script-engine";
import { MemoryVolume } from "../memory-volume";

function createEngine(files: Record<string, string>) {
  const vol = new MemoryVolume();
  for (const [path, content] of Object.entries(files)) {
    vol.mkdirSync(path.substring(0, path.lastIndexOf("/")), { recursive: true });
    vol.writeFileSync(path, content);
  }
  return new ScriptEngine(vol, { cwd: "/app" });
}

// vue-tsc (@volar/typescript's runTsc) replaces fs.readFileSync, then
// require()s typescript/lib/tsc.js so it evaluates a rewritten source that
// knows about .vue files: Node's loader reads module source through it
describe("require() honours a replaced fs.readFileSync", () => {
  it("evaluates the source the replaced readFileSync returns", () => {
    const engine = createEngine({
      "/app/node_modules/typescript/package.json": '{"name":"typescript","version":"6.0.3"}',
      "/app/node_modules/typescript/lib/tsc.js": 'module.exports = require("./_tsc.js");',
      "/app/node_modules/typescript/lib/_tsc.js": "var supportedTSExtensions = ['ts'];\nmodule.exports = supportedTSExtensions;",
    });
    const { exports } = engine.execute(
      `const fs = require("fs");
       const tscPath = require.resolve("typescript/lib/tsc");
       const before = require(tscPath);
       delete require.cache[tscPath];
       const readFileSync = fs.readFileSync;
       fs.readFileSync = (...args) => {
         if (args[0] === tscPath) {
           const tsc = readFileSync(require.resolve("typescript/lib/_tsc.js"), "utf8");
           return tsc.replace("['ts']", "['ts', 'vue']");
         }
         return readFileSync(...args);
       };
       let patched;
       try { patched = require(tscPath); }
       finally { fs.readFileSync = readFileSync; delete require.cache[tscPath]; }
       module.exports = { before, patched, after: require(tscPath) };`,
      "/app/index.js",
    );
    expect(exports).toEqual({
      before: ["ts"],
      patched: ["ts", "vue"],
      after: ["ts"],
    });
  });

  it("also applies to .json modules", () => {
    const engine = createEngine({ "/app/data.json": '{"a":1}' });
    const { exports } = engine.execute(
      `const fs = require("node:fs");
       const readFileSync = fs.readFileSync;
       fs.readFileSync = (p, enc) => p === "/app/data.json" ? '{"a":2}' : readFileSync(p, enc);
       try { module.exports = require("./data.json"); }
       finally { fs.readFileSync = readFileSync; }`,
      "/app/index.js",
    );
    expect(exports).toEqual({ a: 2 });
  });
});
