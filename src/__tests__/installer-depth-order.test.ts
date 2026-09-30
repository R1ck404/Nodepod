import { describe, expect, it, vi } from "vitest";
import { MemoryVolume } from "../memory-volume";

const extractionOrder = vi.hoisted(() => [] as string[]);
vi.mock("../packages/archive-extractor", () => ({
  downloadAndExtract: async (_url: string, volume: MemoryVolume, targetDir: string) => {
    extractionOrder.push(`start:${targetDir}`);
    if (targetDir === "/node_modules/parent") {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (volume.existsSync(targetDir)) volume.removeTreeSync(targetDir);
    }
    volume.writeFileSync(`${targetDir}/package.json`, JSON.stringify({
      name: targetDir.endsWith("/child") ? "child" : "parent",
      version: "1.0.0",
    }));
    extractionOrder.push(`done:${targetDir}`);
  },
}));

import {
  DependencyInstaller,
  findWasiPackageReferences,
} from "../packages/installer";
import type { ResolvedDependency } from "../packages/version-resolver";

describe("dependency extraction ordering", () => {
  it("materializes parents before nested dependencies", async () => {
    extractionOrder.length = 0;
    const volume = new MemoryVolume();
    const dependency = (name: string): ResolvedDependency => ({
      name,
      fetchName: name,
      version: "1.0.0",
      tarballUrl: `https://example.invalid/${name}.tgz`,
      dependencies: {},
    });
    const tree = new Map<string, ResolvedDependency>([
      ["parent/node_modules/child", dependency("child")],
      ["parent", dependency("parent")],
    ]);
    const installer = new DependencyInstaller(volume);

    await (installer as any).materializePackages(tree, { transformModules: false });

    expect(extractionOrder.indexOf("done:/node_modules/parent")).toBeLessThan(
      extractionOrder.indexOf("start:/node_modules/parent/node_modules/child"),
    );
    expect(volume.existsSync("/node_modules/parent/package.json")).toBe(true);
    expect(volume.existsSync("/node_modules/parent/node_modules/child/package.json")).toBe(true);
  });
});

describe("WASI companion discovery", () => {
  it("discovers wasm-bindgen companions from arbitrary loader references", () => {
    expect(findWasiPackageReferences(`
      const variants = ['@scope/compiler-wasm-nodejs', '@scope/compiler-wasm-web'];
      require('other-wasm32-wasi/loader.cjs');
      const ordinary = 'file.wasm';
    `)).toEqual(["@scope/compiler-wasm-nodejs", "@scope/compiler-wasm-web", "other-wasm32-wasi"]);
  });
  it("finds scoped wasm32-wasi package references without package-specific names", () => {
    const source = [
      'const first = "@scope/native-wasm32-wasi";',
      "const second = '@scope/native-wasm32-wasi/entry.cjs';",
      'const duplicate = "@scope/native-wasm32-wasi";',
      'const ordinary = "@scope/native";',
    ].join("\n");

    expect(findWasiPackageReferences(source)).toEqual([
      "@scope/native-wasm32-wasi",
    ]);
  });
});
