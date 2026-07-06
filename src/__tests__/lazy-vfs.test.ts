// Plan 011: lean spawn snapshots + lazy VFS hydration

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryVolume } from "../memory-volume";
import type { VolumeMissHandler } from "../memory-volume";
import { VFSBridge } from "../threading/vfs-bridge";

function makeMainVolume(): MemoryVolume {
  const vol = new MemoryVolume();
  vol.mkdirSync("/project/node_modules/lodash", { recursive: true });
  vol.writeFileSync("/project/node_modules/lodash/package.json", '{"name":"lodash","main":"index.js"}');
  vol.writeFileSync("/project/node_modules/lodash/index.js", "module.exports = 42;");
  vol.writeFileSync("/project/index.js", "require('lodash')");
  vol.writeFileSync("/project/package.json", '{"name":"app"}');
  return vol;
}

// miss handler backed by another volume, mimicking the main-thread proxy
function volumeBackedHandler(main: MemoryVolume): VolumeMissHandler & {
  calls: { stat: string[]; readFile: string[]; readdir: string[] };
} {
  const calls = { stat: [] as string[], readFile: [] as string[], readdir: [] as string[] };
  return {
    calls,
    stat(path) {
      calls.stat.push(path);
      try {
        const st = main.statSync(path);
        return { isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size };
      } catch {
        return null;
      }
    },
    readFile(path) {
      calls.readFile.push(path);
      try {
        return main.readFileSync(path);
      } catch {
        return null;
      }
    },
    readdir(path) {
      calls.readdir.push(path);
      try {
        return main.readdirSync(path).map((name) => {
          const st = main.statSync(path === "/" ? `/${name}` : `${path}/${name}`);
          return { name, isDirectory: st.isDirectory() };
        });
      } catch {
        return null;
      }
    },
  };
}

describe("VFSBridge.createSnapshot lean mode", () => {
  it("excludes contents of excluded dir names but keeps the dir entry", () => {
    const main = makeMainVolume();
    const bridge = new VFSBridge(main);
    const snap = bridge.createSnapshot({ excludeDirNames: ["node_modules"] });

    const paths = snap.manifest.map((e) => e.path);
    expect(paths).toContain("/project/index.js");
    expect(paths).toContain("/project/node_modules");
    expect(paths).not.toContain("/project/node_modules/lodash/index.js");
    expect(snap.lazyDirNames).toEqual(["node_modules"]);

    const nmEntry = snap.manifest.find((e) => e.path === "/project/node_modules")!;
    expect(nmEntry.isDirectory).toBe(true);
  });

  it("default createSnapshot() is unchanged (full, no lazyDirNames)", () => {
    const main = makeMainVolume();
    const bridge = new VFSBridge(main);
    const snap = bridge.createSnapshot();
    const paths = snap.manifest.map((e) => e.path);
    expect(paths).toContain("/project/node_modules/lodash/index.js");
    expect(snap.lazyDirNames).toBeUndefined();
  });

  it("lean snapshot restores in a worker volume with node_modules dir present but empty", () => {
    const main = makeMainVolume();
    const bridge = new VFSBridge(main);
    const snap = bridge.createSnapshot({ excludeDirNames: ["node_modules"] });
    const worker = MemoryVolume.fromBinarySnapshot(snap);

    expect(worker.existsSync("/project/index.js")).toBe(true);
    expect(worker.existsSync("/project/node_modules")).toBe(true);
    expect(worker.readdirSync("/project/node_modules")).toEqual([]);
  });
});

describe("MemoryVolume lazy hydration", () => {
  let main: MemoryVolume;
  let worker: MemoryVolume;
  let handler: ReturnType<typeof volumeBackedHandler>;

  beforeEach(() => {
    main = makeMainVolume();
    const snap = new VFSBridge(main).createSnapshot({ excludeDirNames: ["node_modules"] });
    worker = MemoryVolume.fromBinarySnapshot(snap);
    handler = volumeBackedHandler(main);
    worker.setMissHandler(handler, snap.lazyDirNames!);
  });

  it("readFileSync hydrates a missing file under node_modules", () => {
    const content = worker.readFileSync("/project/node_modules/lodash/index.js", "utf8");
    expect(content).toBe("module.exports = 42;");
    // second read is served locally
    const before = handler.calls.readFile.length;
    worker.readFileSync("/project/node_modules/lodash/index.js", "utf8");
    expect(handler.calls.readFile.length).toBe(before);
  });

  it("existsSync and statSync hydrate missing paths", () => {
    expect(worker.existsSync("/project/node_modules/lodash/package.json")).toBe(true);
    const st = worker.statSync("/project/node_modules/lodash/index.js");
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe("module.exports = 42;".length);
  });

  it("negative results are cached (one proxy call per missing path)", () => {
    expect(worker.existsSync("/project/node_modules/nope/index.js")).toBe(false);
    expect(worker.existsSync("/project/node_modules/nope/index.js")).toBe(false);
    const statCalls = handler.calls.stat.filter((p) => p.includes("nope"));
    expect(statCalls.length).toBe(1);
  });

  it("misses outside lazy dirs never consult the handler", () => {
    expect(worker.existsSync("/project/missing.txt")).toBe(false);
    expect(handler.calls.stat).toEqual([]);
    expect(() => worker.readFileSync("/project/missing.txt")).toThrow(/ENOENT/);
    expect(handler.calls.readFile).toEqual([]);
  });

  it("readdirSync lists lazily and stat on stubs fetches size without content", () => {
    expect(worker.readdirSync("/project/node_modules")).toEqual(["lodash"]);
    const names = worker.readdirSync("/project/node_modules/lodash").sort();
    expect(names).toEqual(["index.js", "package.json"]);

    // stat a stub: sizes come over the proxy, content is NOT fetched
    const st = worker.statSync("/project/node_modules/lodash/index.js");
    expect(st.size).toBe("module.exports = 42;".length);
    expect(handler.calls.readFile).toEqual([]);

    // reading then pulls content exactly once
    expect(worker.readFileSync("/project/node_modules/lodash/index.js", "utf8")).toBe(
      "module.exports = 42;",
    );
    expect(handler.calls.readFile).toEqual(["/project/node_modules/lodash/index.js"]);
  });

  it("readdir listing happens once per directory", () => {
    worker.readdirSync("/project/node_modules/lodash");
    worker.readdirSync("/project/node_modules/lodash");
    const listCalls = handler.calls.readdir.filter((p) => p.endsWith("lodash"));
    expect(listCalls.length).toBe(1);
  });

  it("local writes win over lazy listings", () => {
    worker.writeFileSync("/project/node_modules/lodash/local.js", "local");
    const names = worker.readdirSync("/project/node_modules/lodash");
    expect(names).toContain("local.js");
    expect(worker.readFileSync("/project/node_modules/lodash/local.js", "utf8")).toBe("local");
  });

  it("appendFileSync to a lazy stub hydrates before appending", () => {
    worker.readdirSync("/project/node_modules/lodash"); // create stubs
    worker.appendFileSync("/project/node_modules/lodash/index.js", "\n// more");
    expect(worker.readFileSync("/project/node_modules/lodash/index.js", "utf8")).toBe(
      "module.exports = 42;\n// more",
    );
  });

  it("renameSync hydrates the moved subtree so content survives the move", () => {
    worker.renameSync("/project/node_modules/lodash", "/project/lodash-moved");
    expect(worker.readFileSync("/project/lodash-moved/index.js", "utf8")).toBe(
      "module.exports = 42;",
    );
  });

  it("setMissHandler(null) removes the fallback", () => {
    worker.setMissHandler(null);
    expect(worker.existsSync("/project/node_modules/lodash/index.js")).toBe(false);
  });

  it("hydration does not fire watch events", () => {
    const cb = vi.fn();
    worker.watch("/", { recursive: true }, cb);
    worker.readFileSync("/project/node_modules/lodash/index.js");
    expect(cb).not.toHaveBeenCalled();
  });

  it("markLazyInvalidated drops the local copy and re-pulls fresh content, even outside lazy dirs", () => {
    // /project/index.js is outside node_modules and fully local
    expect(worker.readFileSync("/project/index.js", "utf8")).toBe("require('lodash')");

    // main updates the file and broadcasts an invalidation instead of bytes
    main.writeFileSync("/project/index.js", "updated content");
    worker.markLazyInvalidated("/project/index.js");

    expect(worker.readFileSync("/project/index.js", "utf8")).toBe("updated content");
  });

  it("markLazyInvalidated clears a previous negative cache entry", () => {
    expect(worker.existsSync("/project/node_modules/late-pkg")).toBe(false);
    // package appears on main afterwards
    main.mkdirSync("/project/node_modules/late-pkg", { recursive: true });
    main.writeFileSync("/project/node_modules/late-pkg/index.js", "hi");
    worker.markLazyInvalidated("/project/node_modules/late-pkg");
    expect(worker.existsSync("/project/node_modules/late-pkg")).toBe(true);
  });

  it("markLazyInvalidated is a no-op without a miss handler (keeps stale copy)", () => {
    const plain = MemoryVolume.fromSnapshot({ entries: [{ path: "/a.txt", kind: "file", data: "" }] });
    plain.writeFileSync("/a.txt", "stale");
    plain.markLazyInvalidated("/a.txt");
    expect(plain.readFileSync("/a.txt", "utf8")).toBe("stale");
  });
});
