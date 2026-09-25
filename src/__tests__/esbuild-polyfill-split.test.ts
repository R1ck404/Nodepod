import { describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { mergeGroupResults, planDependencyGroups, withEsbuildCompat } from "../polyfills/esbuild";

const supported = (cfg: { target?: string | string[]; supported?: Record<string, boolean> }) =>
  withEsbuildCompat(cfg).supported;

describe("esbuild compat defaults", () => {
  it("keeps destructuring for Safari/iOS targets esbuild 0.27 moved past", () => {
    expect(supported({ target: ["es2020", "edge88", "firefox78", "chrome87", "safari14"] }))
      .toEqual({ destructuring: true });
    expect(supported({ target: "es2020,ios14.4" })).toEqual({ destructuring: true });
    expect(supported({ target: "safari10" })).toEqual({ destructuring: true });
  });

  it("leaves other targets and explicit choices alone", () => {
    expect(supported({ target: "safari14.1" })).toBeUndefined();
    expect(supported({ target: "ios14.5" })).toBeUndefined();
    expect(supported({ target: "safari9" })).toBeUndefined();
    expect(supported({ target: "esnext" })).toBeUndefined();
    expect(supported({})).toBeUndefined();
    expect(withEsbuildCompat(undefined)).toBeUndefined();
    expect(supported({ target: "safari14", supported: { destructuring: false } }))
      .toEqual({ destructuring: false });
    expect(supported({ target: "safari14", supported: { "dynamic-import": true } }))
      .toEqual({ "dynamic-import": true, destructuring: true });
  });
});

function pkg(vol: MemoryVolume, dir: string, manifest: Record<string, unknown>): void {
  vol.writeFileSync(`${dir}/package.json`, JSON.stringify(manifest));
  vol.writeFileSync(`${dir}/index.js`, "module.exports = {};");
}

function project(): MemoryVolume {
  const vol = new MemoryVolume();
  const nm = "/app/node_modules";
  pkg(vol, `${nm}/react`, { name: "react" });
  pkg(vol, `${nm}/react-dom`, { name: "react-dom", dependencies: { scheduler: "*" }, peerDependencies: { react: "*" } });
  pkg(vol, `${nm}/scheduler`, { name: "scheduler" });
  pkg(vol, `${nm}/@mui/material`, { name: "@mui/material", dependencies: { "@emotion/react": "*", "clsx": "*" }, peerDependencies: { react: "*" } });
  pkg(vol, `${nm}/@emotion/react`, { name: "@emotion/react", peerDependencies: { react: "*" } });
  pkg(vol, `${nm}/clsx`, { name: "clsx" });
  pkg(vol, `${nm}/three`, { name: "three" });
  pkg(vol, `${nm}/rxjs`, { name: "rxjs", dependencies: { tslib: "*" } });
  pkg(vol, `${nm}/tslib`, { name: "tslib" });
  pkg(vol, `${nm}/lodash`, { name: "lodash" });
  // a nested copy is its own package
  pkg(vol, `${nm}/date-fns`, { name: "date-fns", dependencies: { tslib: "*" } });
  pkg(vol, `${nm}/date-fns/node_modules/tslib`, { name: "tslib" });
  return vol;
}

const prebundle = (entryPoints: string[]) => ({
  entryPoints,
  absWorkingDir: "/app",
  bundle: true,
  format: "esm" as const,
  outdir: "/app/node_modules/.vite/deps_temp_1",
});

describe("dependency pre-bundle groups", () => {
  it("groups entries whose package closures overlap", () => {
    const groups = planDependencyGroups(
      project(),
      prebundle(["react", "react-dom_client", "react_jsx-dev-runtime", "@mui_material", "three", "rxjs", "lodash_debounce", "date-fns"]),
    )!;
    const sets = groups.map((g) => [...g.entries].sort());
    expect(sets[0]).toEqual(["@mui_material", "react", "react-dom_client", "react_jsx-dev-runtime"]);
    expect(sets.slice(1)).toEqual(expect.arrayContaining([["three"], ["rxjs"], ["lodash_debounce"], ["date-fns"]]));
    expect(groups).toHaveLength(5);
  });

  it("puts packages sharing a dependency together", () => {
    const vol = project();
    // date-fns now uses the hoisted tslib, like rxjs
    vol.removeTreeSync("/app/node_modules/date-fns/node_modules");
    const groups = planDependencyGroups(vol, prebundle(["rxjs", "date-fns", "three"]))!;
    expect(groups.map((g) => [...g.entries].sort())).toEqual(
      expect.arrayContaining([["date-fns", "rxjs"], ["three"]]),
    );
  });

  it("gives up on entries it can't place", () => {
    expect(planDependencyGroups(project(), prebundle(["react", "not-installed"]))).toBeNull();
    expect(planDependencyGroups(project(), prebundle(["react", "a___b"]))).toBeNull();
  });
});

const out = (path: string, text: string) => ({ path, text, contents: new TextEncoder().encode(text) });

describe("merging group builds", () => {
  it("merges builds of disjoint module sets", () => {
    const merged = mergeGroupResults([
      {
        errors: [],
        warnings: [{ text: "w1" }],
        outputFiles: [out("/o/react.js", "r"), out("/o/chunk-H.js", "helpers")],
        metafile: { inputs: { "node_modules/react/index.js": {} }, outputs: { "o/react.js": { a: 1 }, "o/chunk-H.js": { h: 1 } } },
      },
      {
        errors: [],
        warnings: [{ text: "w2" }],
        outputFiles: [out("/o/three.js", "t"), out("/o/chunk-H.js", "helpers")],
        metafile: { inputs: { "node_modules/three/index.js": {} }, outputs: { "o/three.js": { b: 1 }, "o/chunk-H.js": { h: 1 } } },
      },
    ])!;
    expect(merged.errors).toEqual([]);
    expect(merged.warnings).toHaveLength(2);
    expect(merged.outputFiles!.map((f) => f.path).sort()).toEqual(["/o/chunk-H.js", "/o/react.js", "/o/three.js"]);
    expect(Object.keys(merged.metafile!.inputs!).sort()).toEqual(["node_modules/react/index.js", "node_modules/three/index.js"]);
    expect(Object.keys(merged.metafile!.outputs!).sort()).toEqual(["o/chunk-H.js", "o/react.js", "o/three.js"]);
  });

  it("refuses builds that share a module", () => {
    expect(
      mergeGroupResults([
        { errors: [], warnings: [], outputFiles: [out("/o/a.js", "a")], metafile: { inputs: { "node_modules/tslib/tslib.js": {} }, outputs: { "o/a.js": {} } } },
        { errors: [], warnings: [], outputFiles: [out("/o/b.js", "b")], metafile: { inputs: { "node_modules/tslib/tslib.js": {} }, outputs: { "o/b.js": {} } } },
      ]),
    ).toBeNull();
  });

  it("refuses two different files at one output path", () => {
    expect(
      mergeGroupResults([
        { errors: [], warnings: [], outputFiles: [out("/o/chunk-X.js", "one")], metafile: { inputs: { a: {} }, outputs: { "o/chunk-X.js": {} } } },
        { errors: [], warnings: [], outputFiles: [out("/o/chunk-X.js", "two")], metafile: { inputs: { b: {} }, outputs: { "o/chunk-X.js": {} } } },
      ]),
    ).toBeNull();
  });
});
