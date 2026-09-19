// Installer robustness: one failed tarball must not abort the rest of the
// tree, a re-extracted parent must not swallow the nested packages that were
// already installed under it, and the final validation must check versions.

import { describe, expect, it, vi } from "vitest";
import { MemoryVolume } from "../memory-volume";

const extractCalls = vi.hoisted(() => [] as string[]);
const failuresLeft = vi.hoisted(() => new Map<string, number>());
const archiveVersions = vi.hoisted(() => new Map<string, string>());

vi.mock("../packages/archive-extractor", () => ({
  downloadAndExtract: async (url: string, volume: MemoryVolume, targetDir: string) => {
    extractCalls.push(url);
    const remaining = failuresLeft.get(url) ?? 0;
    if (remaining > 0) {
      failuresLeft.set(url, remaining - 1);
      throw new TypeError("Failed to fetch");
    }
    // mirror the real extractor: the archive replaces the target directory
    if (volume.existsSync(targetDir)) volume.removeTreeSync(targetDir);
    volume.mkdirSync(targetDir, { recursive: true });
    const name = targetDir.slice(targetDir.lastIndexOf("/node_modules/") + "/node_modules/".length);
    const version = archiveVersions.get(url) ?? url.slice(url.lastIndexOf("@") + 1).replace(/\.tgz$/, "");
    volume.writeFileSync(`${targetDir}/package.json`, JSON.stringify({ name, version }));
  },
}));

import { DependencyInstaller } from "../packages/installer";
import type { ResolvedDependency } from "../packages/version-resolver";

const dependency = (name: string, version: string): ResolvedDependency => ({
  name,
  fetchName: name,
  version,
  tarballUrl: `https://example.invalid/${name}@${version}.tgz`,
  dependencies: {},
});

function reset() {
  extractCalls.length = 0;
  failuresLeft.clear();
  archiveVersions.clear();
}

describe("installer resilience", () => {
  it("keeps installed nested packages when the parent is re-extracted", async () => {
    reset();
    const volume = new MemoryVolume();
    const installer = new DependencyInstaller(volume);

    const first = new Map<string, ResolvedDependency>([
      ["parent", dependency("parent", "1.0.0")],
      ["parent/node_modules/child", dependency("child", "1.0.0")],
    ]);
    await (installer as any).materializePackages(first, { transformModules: false });
    expect(volume.existsSync("/node_modules/parent/node_modules/child/package.json")).toBe(true);

    // parent bumps, child stays the same: the child must survive the
    // parent's replacement without being downloaded again
    const second = new Map<string, ResolvedDependency>([
      ["parent", dependency("parent", "2.0.0")],
      ["parent/node_modules/child", dependency("child", "1.0.0")],
    ]);
    extractCalls.length = 0;
    await (installer as any).materializePackages(second, { transformModules: false });

    expect(extractCalls).toEqual(["https://example.invalid/parent@2.0.0.tgz"]);
    expect(JSON.parse(volume.readFileSync("/node_modules/parent/package.json", "utf8")).version).toBe("2.0.0");
    expect(volume.existsSync("/node_modules/parent/node_modules/child/package.json")).toBe(true);
  });

  it("re-installs a nested package the parent's replacement removed when it is not parked", async () => {
    reset();
    const volume = new MemoryVolume();
    const installer = new DependencyInstaller(volume);
    // simulate a tree where the parent exists at the wrong version and the
    // nested child's directory is missing entirely
    volume.mkdirSync("/node_modules/parent", { recursive: true });
    volume.writeFileSync("/node_modules/parent/package.json", JSON.stringify({ name: "parent", version: "0.9.0" }));

    const tree = new Map<string, ResolvedDependency>([
      ["parent", dependency("parent", "1.0.0")],
      ["parent/node_modules/child", dependency("child", "1.0.0")],
    ]);
    await (installer as any).materializePackages(tree, { transformModules: false });
    expect(volume.existsSync("/node_modules/parent/node_modules/child/package.json")).toBe(true);
  });

  it("retries a failed tarball before giving up", async () => {
    reset();
    const volume = new MemoryVolume();
    const installer = new DependencyInstaller(volume);
    failuresLeft.set("https://example.invalid/flaky@1.0.0.tgz", 2);

    const tree = new Map<string, ResolvedDependency>([
      ["flaky", dependency("flaky", "1.0.0")],
    ]);
    const progress: string[] = [];
    await (installer as any).materializePackages(tree, {
      transformModules: false,
      onProgress: (m: string) => progress.push(m),
    });
    expect(extractCalls.filter((u) => u.includes("flaky")).length).toBe(3);
    expect(volume.existsSync("/node_modules/flaky/package.json")).toBe(true);
    expect(progress.some((m) => m.includes("Retrying flaky@1.0.0"))).toBe(true);
  }, 15_000);

  it("materializes every other package when one keeps failing, then reports it", async () => {
    reset();
    const volume = new MemoryVolume();
    const installer = new DependencyInstaller(volume);
    failuresLeft.set("https://example.invalid/broken@1.0.0.tgz", 99);

    const tree = new Map<string, ResolvedDependency>([
      ["alpha", dependency("alpha", "1.0.0")],
      ["broken", dependency("broken", "1.0.0")],
      ["omega", dependency("omega", "1.0.0")],
      ["omega/node_modules/nested", dependency("nested", "2.0.0")],
    ]);
    await expect(
      (installer as any).materializePackages(tree, { transformModules: false }),
    ).rejects.toThrow(/Installation incomplete \(failed: broken@1\.0\.0: Failed to fetch/);

    expect(volume.existsSync("/node_modules/alpha/package.json")).toBe(true);
    expect(volume.existsSync("/node_modules/omega/package.json")).toBe(true);
    expect(volume.existsSync("/node_modules/omega/node_modules/nested/package.json")).toBe(true);
    expect(volume.existsSync("/node_modules/broken")).toBe(false);
  }, 15_000);

  it("does not remove the previous good copy when the new download fails", async () => {
    reset();
    const volume = new MemoryVolume();
    const installer = new DependencyInstaller(volume);
    volume.mkdirSync("/node_modules/keep", { recursive: true });
    volume.writeFileSync("/node_modules/keep/package.json", JSON.stringify({ name: "keep", version: "1.0.0" }));
    volume.writeFileSync("/node_modules/keep/index.js", "module.exports = 1;");
    failuresLeft.set("https://example.invalid/keep@2.0.0.tgz", 99);

    const tree = new Map<string, ResolvedDependency>([
      ["keep", dependency("keep", "2.0.0")],
    ]);
    await expect(
      (installer as any).materializePackages(tree, { transformModules: false }),
    ).rejects.toThrow(/Installation incomplete/);
    expect(JSON.parse(volume.readFileSync("/node_modules/keep/package.json", "utf8")).version).toBe("1.0.0");
    expect(volume.existsSync("/node_modules/keep/index.js")).toBe(true);
  }, 15_000);

  it("rejects an archive whose package.json version differs from the resolved one", async () => {
    reset();
    const volume = new MemoryVolume();
    const installer = new DependencyInstaller(volume);
    archiveVersions.set("https://example.invalid/mismatch@1.0.0.tgz", "9.9.9");

    const tree = new Map<string, ResolvedDependency>([
      ["mismatch", dependency("mismatch", "1.0.0")],
    ]);
    await expect(
      (installer as any).materializePackages(tree, { transformModules: false }),
    ).rejects.toThrow(/contained mismatch@9\.9\.9, expected 1\.0\.0/);
  }, 15_000);
});
