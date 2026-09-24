import { describe, it, expect, beforeEach } from "vitest";
import { MemoryVolume } from "../memory-volume";
import type { ShellContext } from "../shell/shell-types";
import {
  npmPkg,
  npmConfig,
  npmPack,
  readPackageLock,
  packageJsonDepsMatchLock,
  writeNpmPackageLock,
  hasGlobalFlag,
  withoutGlobalFlags,
  globalContext,
  linkGlobalBins,
  unlinkGlobalBins,
  GLOBAL_BIN,
  GLOBAL_LIB,
} from "../packages/pm-cli";
import { packTarGz } from "../packages/tar-pack";
import pako from "pako";

function makeCtx(vol: MemoryVolume, cwd = "/app"): ShellContext {
  return {
    cwd,
    env: { HOME: "/home/user", PATH: "/usr/bin" },
    volume: vol,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
}

describe("pm-cli", () => {
  let vol: MemoryVolume;

  beforeEach(() => {
    vol = new MemoryVolume();
    vol.mkdirSync("/app", { recursive: true });
  });

  it("detects and strips the global flags", () => {
    expect(hasGlobalFlag(["-g", "lodash"])).toBe(true);
    expect(hasGlobalFlag(["--location=global", "x"])).toBe(true);
    expect(hasGlobalFlag(["lodash"])).toBe(false);
    expect(withoutGlobalFlags(["i", "-g", "x", "--global"])).toEqual(["i", "x"]);
  });

  it("links and unlinks a global package's commands on PATH", () => {
    const ctx = globalContext(vol, makeCtx(vol));
    expect(ctx.cwd).toBe(GLOBAL_LIB);
    expect(JSON.parse(vol.readFileSync(GLOBAL_LIB + "/package.json", "utf8") as string).dependencies).toEqual({});

    const pkgDir = GLOBAL_LIB + "/node_modules/@acme/tool";
    vol.mkdirSync(pkgDir + "/dist", { recursive: true });
    vol.writeFileSync(pkgDir + "/package.json", JSON.stringify({
      name: "@acme/tool",
      bin: { tool: "./dist/cli.js", "tool-dev": "dist/dev.js" },
    }));
    expect(linkGlobalBins(vol, "@acme/tool").sort()).toEqual(["tool", "tool-dev"]);
    expect(vol.readFileSync(GLOBAL_BIN + "/tool", "utf8")).toBe(`node "${pkgDir}/dist/cli.js" "$@"\n`);

    // a command another package owns is left alone
    vol.writeFileSync(GLOBAL_BIN + "/tool-dev", 'node "/usr/local/lib/node_modules/other/x.js" "$@"\n');
    unlinkGlobalBins(vol, "@acme/tool");
    expect(vol.existsSync(GLOBAL_BIN + "/tool")).toBe(false);
    expect(vol.existsSync(GLOBAL_BIN + "/tool-dev")).toBe(true);
  });

  it("names a string bin after the unscoped package name", () => {
    const pkgDir = GLOBAL_LIB + "/node_modules/@acme/single";
    vol.mkdirSync(pkgDir, { recursive: true });
    vol.writeFileSync(pkgDir + "/package.json", JSON.stringify({ name: "@acme/single", bin: "cli.js" }));
    expect(linkGlobalBins(vol, "@acme/single")).toEqual(["single"]);
  });

  it("npmPkg get/set/delete", () => {
    vol.writeFileSync(
      "/app/package.json",
      JSON.stringify({ name: "demo", version: "1.0.0", scripts: {} }, null, 2),
    );
    const ctx = makeCtx(vol);
    expect(npmPkg(vol, ["get", "name"], ctx).stdout).toBe("demo\n");
    expect(npmPkg(vol, ["set", "scripts.build=tsc"], ctx).exitCode).toBe(0);
    const pj = JSON.parse(vol.readFileSync("/app/package.json", "utf8") as string);
    expect(pj.scripts.build).toBe("tsc");
    expect(npmPkg(vol, ["delete", "scripts.build"], ctx).exitCode).toBe(0);
    const pj2 = JSON.parse(vol.readFileSync("/app/package.json", "utf8") as string);
    expect(pj2.scripts.build).toBeUndefined();
  });

  it("npmConfig set persists to .npmrc", () => {
    const ctx = makeCtx(vol);
    expect(npmConfig(vol, ["set", "registry", "https://example.com/"], ctx).exitCode).toBe(0);
    expect(vol.readFileSync("/app/.npmrc", "utf8") as string).toContain(
      "registry=https://example.com/",
    );
    expect(npmConfig(vol, ["get", "registry"], ctx).stdout).toContain("example.com");
  });

  it("npmPack writes a gzip tarball", () => {
    vol.writeFileSync(
      "/app/package.json",
      JSON.stringify({ name: "demo", version: "1.2.3" }),
    );
    vol.writeFileSync("/app/index.js", "module.exports = 1;\n");
    const ctx = makeCtx(vol);
    const result = npmPack(vol, ctx);
    expect(result.exitCode).toBe(0);
    expect(vol.existsSync("/app/demo-1.2.3.tgz")).toBe(true);
    const gz = vol.readFileSync("/app/demo-1.2.3.tgz") as Uint8Array;
    const tar = pako.ungzip(gz);
    expect(tar.byteLength).toBeGreaterThan(512);
  });

  it("writeNpmPackageLock + readPackageLock + match", () => {
    vol.writeFileSync(
      "/app/package.json",
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        dependencies: { leftpad: "^1.0.0" },
      }),
    );
    const tree = new Map([
      [
        "leftpad",
        {
          version: "1.0.1",
          tarballUrl: "https://registry.npmjs.org/leftpad/-/leftpad-1.0.1.tgz",
          dependencies: {},
        },
      ],
    ]);
    writeNpmPackageLock(vol, "/app", tree, { name: "demo", version: "1.0.0" });
    const lock = readPackageLock(vol, "/app");
    expect(lock).not.toBeNull();
    expect(lock!.packages.some((p) => p.name === "leftpad" && p.version === "1.0.1")).toBe(
      true,
    );
    expect(packageJsonDepsMatchLock(vol, "/app", lock!.packages).ok).toBe(true);
  });

  it("packTarGz round-trips with pako", () => {
    const gz = packTarGz([
      { path: "package/package.json", content: '{"name":"x"}' },
    ]);
    const tar = pako.ungzip(gz);
    const name = new TextDecoder().decode(tar.subarray(0, 20));
    expect(name.startsWith("package/package.json")).toBe(true);
  });
});
