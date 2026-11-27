import { describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { DependencyInstaller } from "../packages/installer";
import { linkGlobalBins, GLOBAL_BIN, GLOBAL_LIB } from "../packages/pm-cli";

const modeOf = (vol: MemoryVolume, p: string) => vol.statSync(p).mode & 0o7777;

describe("mkdirSync masks the mode with the umask, as Node does", () => {
  // Node 22 under umask 022 prints 755, 755, 700, 755, 755, 750, 750 for these
  it("folders get 0o777 & ~022 by default, and a given mode is masked", () => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/a");
    vol.mkdirSync("/b", { mode: 0o777 });
    vol.mkdirSync("/c", { mode: 0o700 });
    vol.mkdirSync("/d/e/f", { recursive: true });
    vol.mkdirSync("/g/h", { recursive: true, mode: 0o750 });
    expect(["/a", "/b", "/c", "/d", "/d/e/f", "/g", "/g/h"].map((p) => modeOf(vol, p).toString(8)))
      .toEqual(["755", "755", "700", "755", "755", "750", "750"]);
  });
});

describe("package bins are executable, as npm makes them", () => {
  it("node_modules/.bin stubs and their targets are 0o755", () => {
    const vol = new MemoryVolume();
    const pkgDir = "/app/node_modules/tool";
    vol.mkdirSync(pkgDir + "/bin", { recursive: true });
    vol.writeFileSync(pkgDir + "/package.json", JSON.stringify({ name: "tool", bin: { tool: "bin/cli.js" } }));
    vol.writeFileSync(pkgDir + "/bin/cli.js", "console.log('hi')\n");
    const installer = new DependencyInstaller(vol, { cwd: "/app" });
    (installer as unknown as { createBinStubs(nm: string, name: string, dir: string): void })
      .createBinStubs("/app/node_modules", "tool", pkgDir);
    expect(modeOf(vol, "/app/node_modules/.bin/tool")).toBe(0o755);
    expect(modeOf(vol, pkgDir + "/bin/cli.js")).toBe(0o755);
  });

  it("global bins are 0o755", () => {
    const vol = new MemoryVolume();
    const pkgDir = GLOBAL_LIB + "/node_modules/tool";
    vol.mkdirSync(pkgDir, { recursive: true });
    vol.writeFileSync(pkgDir + "/package.json", JSON.stringify({ name: "tool", bin: "cli.js" }));
    expect(linkGlobalBins(vol, "tool")).toEqual(["tool"]);
    expect(modeOf(vol, GLOBAL_BIN + "/tool")).toBe(0o755);
  });
});
