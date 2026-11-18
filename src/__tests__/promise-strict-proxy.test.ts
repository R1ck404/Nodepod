import { describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { initShellExec, shellExec } from "../polyfills/child_process";

// Resolving a promise with a value reads only its `then`, as in node. Chai's
// assertion objects are Proxies that throw on any other unknown key, and a
// Vitest test such as `() => expect(x).toBe(y)` returns one.
function run(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    shellExec(command, {}, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: err ? ((err as { code?: number }).code ?? 1) : 0 });
    });
  });
}

const strictProxy = `function strict() {
  return new Proxy({ ok: true }, {
    get(target, key) {
      if (typeof key === "symbol" || key === "then" || key in target) return target[key];
      throw new Error("Invalid property: " + String(key));
    },
  });
}`;

describe("promises resolved with a strict Proxy", () => {
  it("resolve, await, Promise.all and an async return read only `then`", async () => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/app", { recursive: true });
    vol.writeFileSync(
      "/app/a.js",
      `${strictProxy}
(async () => {
  const out = [];
  out.push((await Promise.resolve(strict())).ok);
  out.push((await new Promise((r) => r(strict()))).ok);
  out.push((await (async () => strict())()).ok);
  out.push((await Promise.resolve().then(() => strict())).ok);
  out.push((await Promise.all([strict()]))[0].ok);
  console.log(out.join(","));
})().catch((e) => { console.log("error: " + e.message); process.exitCode = 1; });`,
    );
    initShellExec(vol, { cwd: "/app" });
    const r = await run("node /app/a.js");
    expect(r.stdout.trim()).toBe("true,true,true,true,true");
    expect(r.code).toBe(0);
  });

  it("works under top-level await", async () => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/app", { recursive: true });
    vol.writeFileSync(
      "/app/tla.mjs",
      `${strictProxy}
const a = await Promise.resolve(strict());
const b = await (async () => strict())();
console.log([a.ok, b.ok].join(","));`,
    );
    initShellExec(vol, { cwd: "/app" });
    const r = await run("node /app/tla.mjs");
    expect(r.stdout.trim()).toBe("true,true");
    expect(r.code).toBe(0);
  });
});
