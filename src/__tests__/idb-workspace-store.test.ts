import { describe, expect, it } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  createIndexedDBWorkspaceStore,
  deleteIndexedDBWorkspace,
  listIndexedDBWorkspaces,
} from "../persistence/workspace/idb-store";
import type { WorkspaceBatch, WorkspaceEntry } from "../persistence/workspace/types";

function env() {
  return { indexedDB: new IDBFactory(), IDBKeyRange };
}

function batch(partial: Partial<WorkspaceBatch>): WorkspaceBatch {
  return { deletePrefixes: [], deletePaths: [], putEntries: [], putBlobs: [], deleteBlobs: [], ...partial };
}

function file(path: string, blob: string): WorkspaceEntry {
  return { path, kind: "file", mode: 0o644, mtimeMs: 1, size: 1, blob };
}

function dir(path: string): WorkspaceEntry {
  return { path, kind: "directory", mode: 0o755, mtimeMs: 1 };
}

const paths = (entries: WorkspaceEntry[]) => entries.map((e) => e.path).sort();

describe("IndexedDB workspace store", () => {
  it("returns null for a workspace that was never saved", async () => {
    const store = createIndexedDBWorkspaceStore("ws", env())!;
    expect(await store.load()).toBeNull();
  });

  it("round-trips entries and blobs", async () => {
    const store = createIndexedDBWorkspaceStore("ws", env())!;
    await store.commit(batch({
      putEntries: [dir("/p"), file("/p/a.txt", "b1")],
      putBlobs: [{ id: "b1", data: new Uint8Array([1, 2, 3]) }],
    }));

    const manifest = await store.load();
    expect(paths(manifest!.entries)).toEqual(["/p", "/p/a.txt"]);
    const blobs = await store.readBlobs(["b1", "missing"]);
    expect(Array.from(blobs.get("b1")!)).toEqual([1, 2, 3]);
    expect(blobs.has("missing")).toBe(false);
  });

  it("deletes a prefix and everything below it, but not siblings sharing its name", async () => {
    const store = createIndexedDBWorkspaceStore("ws", env())!;
    await store.commit(batch({
      putEntries: [dir("/a"), dir("/a/b"), file("/a/b/c", "x"), file("/ab", "y"), file("/a.txt", "z"), dir("/b")],
    }));
    await store.commit(batch({ deletePrefixes: ["/a"] }));

    expect(paths((await store.load())!.entries)).toEqual(["/a.txt", "/ab", "/b"]);
  });

  it("applies deletes before puts within one batch", async () => {
    const store = createIndexedDBWorkspaceStore("ws", env())!;
    await store.commit(batch({ putEntries: [dir("/d"), file("/d/old", "1")] }));
    await store.commit(batch({ deletePrefixes: ["/d"], putEntries: [dir("/d"), file("/d/new", "2")] }));

    expect(paths((await store.load())!.entries)).toEqual(["/d", "/d/new"]);
  });

  it("keeps workspaces apart", async () => {
    const e = env();
    const one = createIndexedDBWorkspaceStore("one", e)!;
    const two = createIndexedDBWorkspaceStore("two", e)!;
    await one.commit(batch({ putEntries: [file("/f", "b")], putBlobs: [{ id: "b", data: new Uint8Array([1]) }] }));
    await two.commit(batch({ putEntries: [file("/g", "b")], putBlobs: [{ id: "b", data: new Uint8Array([2]) }] }));
    await one.commit(batch({ deletePrefixes: ["/"] }));

    expect((await one.load())!.entries).toEqual([]);
    expect(paths((await two.load())!.entries)).toEqual(["/g"]);
    expect(Array.from((await two.readBlobs(["b"])).get("b")!)).toEqual([2]);
  });

  it("commits nothing when any part of a batch fails", async () => {
    const store = createIndexedDBWorkspaceStore("ws", env())!;
    await store.commit(batch({ putEntries: [file("/kept", "k")] }));

    const bad = batch({
      putEntries: [file("/new", "n")],
      // functions can't be structured-cloned
      putBlobs: [{ id: "n", data: (() => {}) as unknown as Uint8Array }],
    });
    await expect(store.commit(bad)).rejects.toThrow();

    expect(paths((await store.load())!.entries)).toEqual(["/kept"]);
  });

  it("sweeps blobs no entry references", async () => {
    const store = createIndexedDBWorkspaceStore("ws", env())!;
    await store.commit(batch({
      putEntries: [file("/a", "used"), file("/b", "used")],
      putBlobs: [
        { id: "used", data: new Uint8Array([1]) },
        { id: "orphan", data: new Uint8Array([2]) },
      ],
    }));
    await store.sweep!();

    const blobs = await store.readBlobs(["used", "orphan"]);
    expect(blobs.has("used")).toBe(true);
    expect(blobs.has("orphan")).toBe(false);
  });

  it("lists, clears and deletes workspaces", async () => {
    const e = env();
    const one = createIndexedDBWorkspaceStore("one", e)!;
    const two = createIndexedDBWorkspaceStore("two", e)!;
    await one.commit(batch({ putEntries: [dir("/x")] }));
    await two.commit(batch({ putEntries: [dir("/y")] }));
    expect((await listIndexedDBWorkspaces(e)).map((w) => w.id).sort()).toEqual(["one", "two"]);

    await one.clear();
    expect(await one.load()).toBeNull();
    one.close?.();
    two.close?.();
    await deleteIndexedDBWorkspace("two", e);
    expect(await listIndexedDBWorkspaces(e)).toEqual([]);
  });

  it("is unavailable without IndexedDB", () => {
    expect(createIndexedDBWorkspaceStore("ws")).toBeNull();
  });
});
