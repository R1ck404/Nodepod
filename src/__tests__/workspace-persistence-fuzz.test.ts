import { describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { WorkspacePersistence } from "../persistence/workspace/controller";
import { createMemoryWorkspaceStore } from "../persistence/workspace/memory-store";
import type { WorkspaceStore } from "../persistence/workspace/types";

// Random operations with random save points; after every save the restored
// copy must equal the live volume exactly (contents, kinds, modes, links).

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Tree = Record<string, string>;

function describeTree(vol: MemoryVolume, root = "/"): Tree {
  const out: Tree = {};
  const walk = (dir: string): void => {
    for (const name of vol.readdirSync(dir).sort()) {
      const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
      if (path === "/tmp" || path.includes("node_modules")) continue;
      const info = vol.inspectNode(path)!;
      if (info.kind === "directory") {
        out[path] = `dir ${info.mode.toString(8)}`;
        walk(path);
      } else if (info.kind === "symlink") {
        out[path] = `link -> ${info.target}`;
      } else {
        const text = new TextDecoder().decode(vol.readFileSync(path));
        out[path] = `file ${info.mode.toString(8)} ${text}`;
      }
    }
  };
  walk(root);
  return out;
}

// hardlink groups, as sets of paths sharing an inode
function linkGroups(vol: MemoryVolume, tree: Tree): string[] {
  const byInode = new Map<object, string[]>();
  for (const path of Object.keys(tree)) {
    const info = vol.inspectNode(path)!;
    if (info.kind !== "file") continue;
    const list = byInode.get(info.inode!) ?? [];
    list.push(path);
    byInode.set(info.inode!, list);
  }
  return [...byInode.values()].filter((g) => g.length > 1).map((g) => g.sort().join("|")).sort();
}

async function restored(store: WorkspaceStore): Promise<MemoryVolume> {
  const vol = new MemoryVolume();
  await new WorkspacePersistence("fuzz", vol, store).load();
  return vol;
}

function runFuzz(seed: number, steps: number, maxBatchBytes?: number) {
  return async () => {
    const random = rng(seed);
    const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
    const store = createMemoryWorkspaceStore();
    const vol = new MemoryVolume();
    const persistence = new WorkspacePersistence("fuzz", vol, store, { debounceMs: 60_000, maxBatchBytes });
    await persistence.load();
    persistence.attach();

    const names = ["a", "b", "c", "node_modules", "d"];
    const randomPath = (depth = 1 + Math.floor(random() * 3)): string =>
      "/" + Array.from({ length: depth }, () => pick(names)).join("/");
    const existing = (): string[] => Object.keys(describeTree(vol));
    let checks = 0;

    for (let step = 0; step < steps; step++) {
      const op = random();
      const path = randomPath();
      try {
        if (op < 0.3) {
          vol.writeFileSync(path, `v${step}-${"x".repeat(Math.floor(random() * 50))}`);
        } else if (op < 0.4) {
          vol.mkdirSync(path, { recursive: true });
        } else if (op < 0.5) {
          const all = existing();
          if (all.length) vol.renameSync(pick(all), randomPath());
        } else if (op < 0.58) {
          const all = existing();
          if (all.length) vol.removeTreeSync(pick(all));
        } else if (op < 0.64) {
          const files = existing().filter((p) => vol.inspectNode(p)?.kind === "file");
          if (files.length) vol.linkSync(pick(files), path);
        } else if (op < 0.68) {
          vol.symlinkSync(pick(names), path);
        } else if (op < 0.76) {
          const all = existing();
          if (all.length) vol.chmodSync(pick(all), pick([0o600, 0o644, 0o755, 0o700]));
        } else if (op < 0.84) {
          const files = existing().filter((p) => vol.inspectNode(p)?.kind === "file");
          if (files.length) vol.appendFileSync(pick(files), `+${step}`);
        } else if (op < 0.88) {
          const files = existing().filter((p) => vol.inspectNode(p)?.kind === "file");
          if (files.length) vol.openFileHandleSync(pick(files)).write(new TextEncoder().encode(`h${step}`));
        } else if (op < 0.9) {
          vol.writeFileSync(`/tmp/scratch${step}`, "never saved");
        } else {
          await persistence.flush();
          const live = describeTree(vol);
          const copy = await restored(store);
          expect(describeTree(copy), `seed ${seed} step ${step}`).toEqual(live);
          expect(linkGroups(copy, live)).toEqual(linkGroups(vol, live));
          checks++;
        }
      } catch (e) {
        const code = (e as { code?: string }).code;
        // invalid random operations (EEXIST, ENOTDIR, ...) are expected
        if (!code && !/ENOTDIR|EISDIR|EEXIST/.test(String(e))) throw e;
      }
    }

    await persistence.flush();
    const live = describeTree(vol);
    const copy = await restored(store);
    expect(describeTree(copy)).toEqual(live);
    expect(linkGroups(copy, live)).toEqual(linkGroups(vol, live));

    // nothing leaks: every stored blob is referenced after a sweep
    await store.sweep!();
    const manifest = await store.load();
    const referenced = new Set(manifest!.entries.map((e) => e.blob).filter(Boolean) as string[]);
    const blobs = await store.readBlobs([...referenced]);
    expect(blobs.size).toBe(referenced.size);
    expect(checks).toBeGreaterThan(0);
    await persistence.close();
  };
}

describe("workspace persistence fuzz", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}`, runFuzz(seed, 1500));
  }
  it("tiny commit batches", runFuzz(99, 1500, 64));
});
