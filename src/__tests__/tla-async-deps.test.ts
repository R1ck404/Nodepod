import { describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { initShellExec, shellExec } from "../polyfills/child_process";

// A module with top-level await, and everything it imports, is loaded with
// its awaits unwrapped synchronously. fs.promises work in there the way it
// does in node: a missing file throws at the await, inside the try.
function run(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    shellExec(command, {}, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: err ? ((err as { code?: number }).code ?? 1) : 0 });
    });
  });
}

describe("async code under a module with top-level await", () => {
  it("awaits fs.promises inside try/catch like node", async () => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/app", { recursive: true });
    vol.writeFileSync("/app/present.txt", "hi");
    vol.writeFileSync("/app/data.json", '{"x":"json"}');
    vol.writeFileSync(
      "/app/helper.mjs",
      `import fs from "node:fs/promises";
export async function probe(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile() ? "found" : "other";
  } catch {
    return "missing";
  }
}
export async function read(p) {
  return (await fs.readFile(p, "utf8")).trim();
}
export async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}
// callers of an async function may chain on the promise it returns
export function readJsonOr(p, fallback) {
  return readJson(p).catch(() => fallback);
}`,
    );
    vol.writeFileSync(
      "/app/tla.mjs",
      `import { probe, read, readJsonOr } from "./helper.mjs";
export const missing = await probe("/app/nope.txt");
export const present = await probe("/app/present.txt");
export const text = await read("/app/present.txt");
export const json = (await readJsonOr("/app/data.json", null)).x;
export const fallback = await readJsonOr("/app/nope.json", "fallback");`,
    );
    vol.writeFileSync(
      "/app/entry.cjs",
      `const m = require("./tla.mjs"); console.log([m.missing, m.present, m.text, m.json, m.fallback].join(","));`,
    );
    initShellExec(vol, { cwd: "/app" });
    const r = await run("node /app/entry.cjs");
    expect(r.stderr).not.toMatch(/Unhandled|ENOENT/);
    expect(r.stdout.trim()).toBe("missing,found,hi,json,fallback");
    expect(r.code).toBe(0);
  });

  it("awaits a CJS shim that forwards to its ESM build through import()", async () => {
    // vitefu's layout: `require` gets index.cjs, whose functions call into
    // index.js with import("./index.js").then((m) => m.fn(...))
    const vol = new MemoryVolume();
    const pkg = "/app/node_modules/shim";
    vol.mkdirSync(pkg, { recursive: true });
    vol.writeFileSync("/app/package.json", '{"name":"app"}');
    vol.writeFileSync(
      `${pkg}/package.json`,
      JSON.stringify({
        name: "shim",
        type: "module",
        exports: { ".": { import: "./index.js", require: "./index.cjs" } },
      }),
    );
    vol.writeFileSync(
      `${pkg}/index.js`,
      `import fs from "node:fs/promises";
export async function crawl(root) {
  const manifest = JSON.parse(await fs.readFile(root + "/package.json", "utf8"));
  return { optimizeDeps: { include: [manifest.name], exclude: [] } };
}`,
    );
    vol.writeFileSync(
      `${pkg}/index.cjs`,
      `exports.crawl = function () { return import("./index.js").then((mod) => mod.crawl.apply(this, arguments)); };`,
    );
    vol.writeFileSync(
      "/app/tla.mjs",
      `import { crawl } from "shim";
const config = await crawl("/app");
config.optimizeDeps.exclude = ["x"];
export const summary = config.optimizeDeps.include.join("") + ":" + config.optimizeDeps.exclude.join("");`,
    );
    vol.writeFileSync("/app/entry.cjs", `console.log(require("./tla.mjs").summary);`);
    initShellExec(vol, { cwd: "/app" });
    const r = await run("node /app/entry.cjs");
    expect(r.stdout.trim()).toBe("app:x");
    expect(r.code).toBe(0);
  });
});
