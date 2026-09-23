import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsWorkspaceStore } from "../host/node/fs-workspace-store";
import type { WorkspaceBatch } from "../persistence/workspace/types";

function batch(partial: Partial<WorkspaceBatch>): WorkspaceBatch {
  return { deletePrefixes: [], deletePaths: [], putEntries: [], putBlobs: [], deleteBlobs: [], ...partial };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nodepod-ws-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("filesystem workspace store", () => {
  it("round-trips across store instances", async () => {
    const store = createFsWorkspaceStore(dir);
    expect(await store.load()).toBeNull();
    await store.commit(batch({
      putEntries: [
        { path: "/p", kind: "directory", mode: 0o755, mtimeMs: 1 },
        { path: "/p/a", kind: "file", mode: 0o644, mtimeMs: 2, size: 2, blob: "b/1" },
      ],
      putBlobs: [{ id: "b/1", data: new Uint8Array([4, 2]) }],
    }));

    const reopened = createFsWorkspaceStore(dir);
    const manifest = await reopened.load();
    expect(manifest!.entries.map((e) => e.path).sort()).toEqual(["/p", "/p/a"]);
    expect(Array.from((await reopened.readBlobs(["b/1"])).get("b/1")!)).toEqual([4, 2]);
  });

  it("applies prefix deletes and sweeps orphaned blobs", async () => {
    const store = createFsWorkspaceStore(dir);
    await store.commit(batch({
      putEntries: [
        { path: "/a", kind: "directory", mode: 0o755, mtimeMs: 1 },
        { path: "/a/f", kind: "file", mode: 0o644, mtimeMs: 1, blob: "x" },
        { path: "/ab", kind: "file", mode: 0o644, mtimeMs: 1, blob: "y" },
      ],
      putBlobs: [
        { id: "x", data: new Uint8Array([1]) },
        { id: "y", data: new Uint8Array([2]) },
      ],
    }));
    await store.commit(batch({ deletePrefixes: ["/a"] }));
    await store.sweep!();

    const manifest = await createFsWorkspaceStore(dir).load();
    expect(manifest!.entries.map((e) => e.path)).toEqual(["/ab"]);
    expect(await readdir(join(dir, "blobs"))).toEqual(["y"]);
  });

  it("cleans up temp files left by a crash mid-commit", async () => {
    const store = createFsWorkspaceStore(dir);
    await store.commit(batch({ putEntries: [{ path: "/d", kind: "directory", mode: 0o755, mtimeMs: 1 }] }));
    await writeFile(join(dir, "blobs", "half-written.123.tmp"), "junk");

    const manifest = await createFsWorkspaceStore(dir).load();
    expect(manifest!.entries.map((e) => e.path)).toEqual(["/d"]);
    expect(await readdir(join(dir, "blobs"))).toEqual([]);
  });

  it("reports a corrupt manifest with a clear error", async () => {
    await writeFile(join(dir, "manifest.json"), '{"version":1,"entr');
    await expect(createFsWorkspaceStore(dir).load()).rejects.toMatchObject({ code: "EWORKSPACECORRUPT" });
  });

  it("content sent ahead of the tree doesn't make a workspace exist", async () => {
    const store = createFsWorkspaceStore(dir);
    await store.commit(batch({ putBlobs: [{ id: "b", data: new Uint8Array([1]) }] }));
    expect(await createFsWorkspaceStore(dir).load()).toBeNull();
  });

  it("clear() removes everything", async () => {
    const store = createFsWorkspaceStore(dir);
    await store.commit(batch({ putEntries: [{ path: "/d", kind: "directory", mode: 0o755, mtimeMs: 1 }] }));
    await store.clear();
    expect(await createFsWorkspaceStore(dir).load()).toBeNull();
  });
});
