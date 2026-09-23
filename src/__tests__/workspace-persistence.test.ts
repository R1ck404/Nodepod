import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { WorkspacePersistence } from "../persistence/workspace/controller";
import { createMemoryWorkspaceStore } from "../persistence/workspace/memory-store";
import type { WorkspaceBatch, WorkspaceStore } from "../persistence/workspace/types";
import type { WorkspacePersistenceOptions } from "../persistence/workspace/controller";

// wraps a store and records every committed batch
function recording(inner: WorkspaceStore = createMemoryWorkspaceStore()) {
  const batches: WorkspaceBatch[] = [];
  const store: WorkspaceStore = {
    load: () => inner.load(),
    readBlobs: (ids) => inner.readBlobs(ids),
    commit: async (batch) => {
      batches.push(batch);
      await inner.commit(batch);
    },
    sweep: () => inner.sweep!(),
    clear: () => inner.clear(),
  };
  return { store, batches, inner };
}

async function open(
  store: WorkspaceStore,
  opts: WorkspacePersistenceOptions = {},
  volume = new MemoryVolume(),
) {
  // long debounce: tests flush explicitly unless they are about timing
  const persistence = new WorkspacePersistence("ws", volume, store, { debounceMs: 60_000, ...opts });
  const restored = await persistence.load();
  persistence.attach();
  return { persistence, volume, restored };
}

const text = (vol: MemoryVolume, path: string) => vol.readFileSync(path, "utf8");

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspacePersistence", () => {
  it("round-trips files, directories, symlinks and metadata", async () => {
    const { store } = recording();
    const first = await open(store);
    expect(first.restored).toBe(false);

    const vol = first.volume;
    vol.mkdirSync("/proj/src", { recursive: true, mode: 0o700 });
    vol.writeFileSync("/proj/src/index.js", "console.log(1)");
    vol.writeFileSync("/proj/bin.dat", new Uint8Array([0, 1, 2, 255]));
    vol.chmodSync("/proj/bin.dat", 0o600);
    vol.utimesSync("/proj/bin.dat", 1_000, 2_000);
    vol.symlinkSync("src/index.js", "/proj/main.js");
    await first.persistence.flush();

    const second = await open(store);
    expect(second.restored).toBe(true);
    const restored = second.volume;
    expect(text(restored, "/proj/src/index.js")).toBe("console.log(1)");
    expect(Array.from(restored.readFileSync("/proj/bin.dat"))).toEqual([0, 1, 2, 255]);
    expect(restored.statSync("/proj/bin.dat").mode).toBe(0o600);
    expect(restored.statSync("/proj/bin.dat").mtimeMs).toBe(2_000_000);
    expect(restored.statSync("/proj/src").mode).toBe(0o700);
    expect(restored.readlinkSync("/proj/main.js")).toBe("src/index.js");
  });

  it("persists removals", async () => {
    const { store } = recording();
    const first = await open(store);
    first.volume.writeFileSync("/a/keep.txt", "k");
    first.volume.writeFileSync("/a/b/gone.txt", "g");
    first.volume.writeFileSync("/ab.txt", "sibling with a shared prefix");
    await first.persistence.flush();
    first.volume.removeTreeSync("/a/b");
    await first.persistence.flush();

    const second = await open(store);
    expect(second.volume.existsSync("/a/keep.txt")).toBe(true);
    expect(second.volume.existsSync("/a/b")).toBe(false);
    expect(second.volume.existsSync("/ab.txt")).toBe(true);
  });

  it("renames a directory without re-sending file content", async () => {
    const { store, batches } = recording();
    const { volume, persistence } = await open(store);
    volume.writeFileSync("/src/a.txt", "a");
    volume.writeFileSync("/src/deep/b.txt", "b");
    await persistence.flush();
    batches.length = 0;

    volume.renameSync("/src", "/dst");
    await persistence.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0].putBlobs).toEqual([]);
    expect(batches[0].deletePrefixes).toEqual(expect.arrayContaining(["/src", "/dst"]));

    const again = await open(store);
    expect(text(again.volume, "/dst/a.txt")).toBe("a");
    expect(text(again.volume, "/dst/deep/b.txt")).toBe("b");
    expect(again.volume.existsSync("/src")).toBe(false);
  });

  it("keeps new content that was renamed before it was saved", async () => {
    const { store } = recording();
    const { volume, persistence } = await open(store);
    volume.writeFileSync("/f.txt", "old");
    await persistence.flush();

    volume.writeFileSync("/f.txt", "new");
    volume.renameSync("/f.txt", "/g.txt");
    await persistence.flush();

    const again = await open(store);
    expect(again.volume.existsSync("/f.txt")).toBe(false);
    expect(text(again.volume, "/g.txt")).toBe("new");
  });

  it("stores hardlinks as one blob and restores them as one inode", async () => {
    const { store, batches, inner } = recording();
    const { volume, persistence } = await open(store);
    volume.writeFileSync("/a", "shared");
    volume.linkSync("/a", "/b");
    await persistence.flush();

    const blobs = batches.flatMap((b) => b.putBlobs);
    expect(blobs).toHaveLength(1);

    const again = await open(store);
    expect(again.volume.inspectNode("/a")!.inode).toBe(again.volume.inspectNode("/b")!.inode);

    // once no entry references it any more, the blob is swept
    volume.unlinkSync("/a");
    volume.unlinkSync("/b");
    await persistence.flush();
    await inner.sweep!();
    expect((await inner.readBlobs([blobs[0].id])).size).toBe(0);
  });

  it("never stores excluded paths", async () => {
    const { store, batches } = recording();
    const { volume, persistence } = await open(store, { exclude: (p) => p.endsWith(".log") });
    volume.writeFileSync("/proj/node_modules/dep/index.js", "x");
    volume.writeFileSync("/proj/.cache/c", "x");
    volume.writeFileSync("/tmp/scratch", "x");
    volume.writeFileSync("/.nodepod/wa-sqlite.wasm", "x");
    volume.writeFileSync("/proj/debug.log", "x");
    volume.writeFileSync("/proj/app.js", "x");
    await persistence.flush();

    const stored = batches.flatMap((b) => b.putEntries.map((e) => e.path)).sort();
    expect(stored).toEqual(["/.nodepod", "/proj", "/proj/app.js"].filter((p) => p !== "/.nodepod"));
  });

  it("never hands the store a view into a larger buffer", async () => {
    const { store, batches } = recording();
    const { volume, persistence } = await open(store);
    const big = new Uint8Array(1024).fill(7);
    volume.writeFileSync("/slice.bin", big.subarray(100, 110));
    await persistence.flush();

    const [blob] = batches[0].putBlobs;
    expect(blob.data.byteLength).toBe(10);
    expect(blob.data.buffer.byteLength).toBe(10);
  });

  it("splits large saves into bounded commits", async () => {
    const { store, batches } = recording();
    const { volume, persistence } = await open(store, { maxBatchBytes: 100 });
    for (let i = 0; i < 5; i++) volume.writeFileSync(`/f${i}`, new Uint8Array(60).fill(i));
    await persistence.flush();

    expect(batches.length).toBe(5);
    for (const batch of batches) {
      const bytes = batch.putBlobs.reduce((n, b) => n + b.data.byteLength, 0);
      expect(bytes).toBeLessThanOrEqual(100);
    }
    // content first, the whole tree in the last batch
    for (const batch of batches.slice(0, -1)) expect(batch.putEntries).toEqual([]);
    const last = batches[batches.length - 1];
    expect(last.putEntries.filter((e) => e.kind === "file")).toHaveLength(5);
    const again = await open(store);
    expect(Array.from(again.volume.readFileSync("/f3"))).toEqual(new Array(60).fill(3));
  });

  it("a save cut off between batches leaves the stored tree as it was", async () => {
    const inner = createMemoryWorkspaceStore();
    let commits = 0;
    let failAfter = Infinity;
    const store: WorkspaceStore = {
      ...inner,
      commit: async (batch) => {
        if (commits++ >= failAfter) throw new Error("tab closed");
        await inner.commit(batch);
      },
    };
    const { volume, persistence } = await open(store, { maxBatchBytes: 100 });
    volume.writeFileSync("/src/keep.txt", "untouched");
    await persistence.flush();

    volume.writeFileSync("/big1", new Uint8Array(90));
    volume.writeFileSync("/big2", new Uint8Array(90));
    volume.renameSync("/src", "/dst");
    commits = 0;
    failAfter = 1;
    await expect(persistence.flush()).rejects.toThrow("tab closed");

    const copy = await open(inner);
    expect(text(copy.volume, "/src/keep.txt")).toBe("untouched");
    await persistence.close();
  });

  it("a first save cut off before its tree landed counts as never saved", async () => {
    const inner = createMemoryWorkspaceStore();
    let commits = 0;
    const store: WorkspaceStore = {
      ...inner,
      commit: async (batch) => {
        if (commits++ >= 1) throw new Error("tab closed");
        await inner.commit(batch);
      },
    };
    const { volume, persistence } = await open(store, { maxBatchBytes: 100 });
    volume.writeFileSync("/a", new Uint8Array(90));
    volume.writeFileSync("/b", new Uint8Array(90));
    await expect(persistence.flush()).rejects.toThrow("tab closed");

    const copy = await open(inner);
    expect(copy.restored).toBe(false);
    await persistence.close();
  });

  it("re-sends content whose first save failed", async () => {
    const inner = createMemoryWorkspaceStore();
    let failNext = false;
    const store: WorkspaceStore = {
      ...inner,
      commit: async (batch) => {
        if (failNext) {
          failNext = false;
          throw new Error("transient");
        }
        await inner.commit(batch);
      },
    };
    const { volume, persistence } = await open(store);
    volume.writeFileSync("/tmp/out.js", "built");
    volume.mkdirSync("/app");
    volume.renameSync("/tmp/out.js", "/app/out.js");
    failNext = true;
    await expect(persistence.flush()).rejects.toThrow("transient");
    await persistence.flush();

    const copy = await open(inner);
    expect(text(copy.volume, "/app/out.js")).toBe("built");
    await persistence.close();
  });

  it("a file that visits an excluded path comes back with its current content", async () => {
    const { store, inner } = recording();
    const { volume, persistence } = await open(store);
    volume.writeFileSync("/app/f", "v1");
    await persistence.flush();

    volume.renameSync("/app/f", "/tmp/f");
    await persistence.flush();
    await inner.sweep!();
    volume.writeFileSync("/tmp/f", "v2");
    volume.renameSync("/tmp/f", "/app/f");
    await persistence.flush();

    const copy = await open(inner);
    expect(text(copy.volume, "/app/f")).toBe("v2");
    await persistence.close();
  });

  it("excluding a directory excludes what is in it", async () => {
    const { store, batches } = recording();
    const { volume, persistence } = await open(store, { exclude: (p) => p === "/app/secret" });
    volume.writeFileSync("/app/secret/key.pem", "k");
    volume.writeFileSync("/app/ok.txt", "o");
    await persistence.flush();

    const stored = batches.flatMap((b) => b.putEntries.map((e) => e.path));
    expect(stored).toContain("/app/ok.txt");
    expect(stored.some((p) => p.startsWith("/app/secret"))).toBe(false);
  });

  it("re-queues a failed save, reports it, and succeeds on retry", async () => {
    const inner = createMemoryWorkspaceStore();
    let failNext = true;
    const store: WorkspaceStore = {
      ...inner,
      commit: async (batch) => {
        if (failNext) {
          failNext = false;
          const err = new Error("quota") as Error & { name: string };
          err.name = "QuotaExceededError";
          throw err;
        }
        await inner.commit(batch);
      },
    };
    const { volume, persistence } = await open(store);
    const errors: unknown[] = [];
    persistence.on("error", (e: unknown) => errors.push(e));

    volume.writeFileSync("/f.txt", "data");
    await expect(persistence.flush()).rejects.toThrow("quota");
    expect(errors).toHaveLength(1);
    expect(persistence.status).toBe("error");
    expect(persistence.pendingChanges).toBeGreaterThan(0);

    await persistence.flush();
    expect(persistence.status).toBe("idle");
    const again = await open(inner);
    expect(text(again.volume, "/f.txt")).toBe("data");
    await persistence.close();
  });

  it("saves after the debounce, and at least every 2s under constant writes", async () => {
    vi.useFakeTimers();
    const { store, batches } = recording();
    const { volume, persistence } = await open(store, { debounceMs: 250 });

    volume.writeFileSync("/a", "1");
    await vi.advanceTimersByTimeAsync(200);
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(batches).toHaveLength(1);

    // a write every 200ms never leaves 250ms of quiet
    for (let i = 0; i < 12; i++) {
      volume.writeFileSync("/b", String(i));
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(batches.length).toBeGreaterThanOrEqual(2);
    await persistence.close();
  });

  it("captures pending changes synchronously on close", async () => {
    const { store } = recording();
    const { volume, persistence } = await open(store);
    volume.writeFileSync("/last.txt", "written just before teardown");

    const closed = persistence.close();
    volume.dispose();
    await closed;

    expect(persistence.status).toBe("closed");
    const again = await open(store);
    expect(text(again.volume, "/last.txt")).toBe("written just before teardown");
  });

  it("persists metadata-only changes", async () => {
    const { store } = recording();
    const { volume, persistence } = await open(store);
    volume.writeFileSync("/run.sh", "echo hi");
    await persistence.flush();
    volume.chmodSync("/run.sh", 0o755);
    await persistence.flush();

    const again = await open(store);
    expect(again.volume.statSync("/run.sh").mode).toBe(0o755);
  });

  it("persists bulk mounts of included paths", async () => {
    const { store } = recording();
    const { volume, persistence } = await open(store);
    const data = new TextEncoder().encode("mounted");
    volume.mountBinarySnapshot({
      manifest: [
        { path: "/proj", offset: 0, length: 0, isDirectory: true },
        { path: "/proj/m.txt", offset: 0, length: data.byteLength, isDirectory: false },
      ],
      data: data.buffer,
    }, false);
    await persistence.flush();

    const again = await open(store);
    expect(text(again.volume, "/proj/m.txt")).toBe("mounted");
  });

  it("clear() deletes the saved workspace and stops saving", async () => {
    const { store } = recording();
    const { volume, persistence } = await open(store);
    volume.writeFileSync("/f", "x");
    await persistence.flush();

    await persistence.clear();
    volume.writeFileSync("/g", "y");

    expect(persistence.status).toBe("closed");
    expect(await store.load()).toBeNull();
  });
});

describe("final review regressions", () => {
  it("saves a paged-out package file that is moved into the saved tree", async () => {
    const bytes = new TextEncoder().encode("template from a package");
    const vol = new MemoryVolume();
    vol.enableEviction({ read: async (_p, o, l) => bytes.slice(o, o + l) }, 1 << 20);
    vol.mountEntries([
      { path: "/app/node_modules/pkg/tpl.js", kind: "file", src: { pack: 0, offset: 0, length: bytes.byteLength } },
    ]);
    const { store } = recording();
    const { persistence } = await open(store, {}, vol);

    vol.renameSync("/app/node_modules/pkg/tpl.js", "/app/tpl.js");
    await persistence.flush();

    const copy = await open(store);
    expect(text(copy.volume, "/app/tpl.js")).toBe("template from a package");
  });

  it("boots unsaved when the default store can't be opened, but not for a caller's store", async () => {
    const { openWorkspacePersistence } = await import("../persistence/workspace");
    const broken: WorkspaceStore = {
      ...createMemoryWorkspaceStore(),
      load: async () => { throw new Error("SecurityError: storage blocked"); },
    };
    expect(await openWorkspacePersistence(new MemoryVolume(), { id: "blocked-1" }, async () => broken)).toBeNull();
    await expect(
      openWorkspacePersistence(new MemoryVolume(), { id: "blocked-2", store: broken }, undefined),
    ).rejects.toThrow("storage blocked");
  });
});
