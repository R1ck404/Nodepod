import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireWorkspaceLock } from "../persistence/workspace/lock";
import { MemoryVolume } from "../memory-volume";
import { WorkspacePersistence } from "../persistence/workspace/controller";
import { createMemoryWorkspaceStore } from "../persistence/workspace/memory-store";

// just enough of the Web Locks API: exclusive locks, ifAvailable and steal
class FakeLockManager {
  private held = new Map<string, (err: Error) => void>();

  request(
    name: string,
    opts: { ifAvailable?: boolean; steal?: boolean },
    cb: (lock: unknown) => unknown,
  ): Promise<unknown> {
    if (this.held.has(name)) {
      if (opts.steal) {
        const abort = this.held.get(name)!;
        this.held.delete(name);
        abort(Object.assign(new Error("stolen"), { name: "AbortError" }));
      } else if (opts.ifAvailable) {
        return Promise.resolve(cb(null));
      }
    }
    return new Promise((resolve, reject) => {
      this.held.set(name, reject);
      Promise.resolve(cb({ name })).then((value) => {
        if (this.held.get(name) === reject) this.held.delete(name);
        resolve(value);
      });
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace lock", () => {
  it("keeps pods in one page apart even without navigator.locks", async () => {
    vi.stubGlobal("navigator", {});
    const a = await acquireWorkspaceLock("nolocks");
    await expect(acquireWorkspaceLock("nolocks")).rejects.toMatchObject({ code: "EWORKSPACELOCKED" });
    a.release();
    await new Promise((r) => setTimeout(r, 0));
    (await acquireWorkspaceLock("nolocks")).release();
  });

  it("waits for a holder that is shutting down instead of failing", async () => {
    vi.stubGlobal("navigator", { locks: new FakeLockManager() });
    const first = await acquireWorkspaceLock("closing");
    let finishSave!: () => void;
    first.releaseAfter(new Promise<void>((resolve) => { finishSave = resolve; }));

    let acquired = false;
    const second = acquireWorkspaceLock("closing").then((lock) => { acquired = true; return lock; });
    await new Promise((r) => setTimeout(r, 10));
    expect(acquired).toBe(false);
    finishSave();
    (await second).release();
    expect(acquired).toBe(true);
  });

  it("refuses a second holder until the first releases", async () => {
    vi.stubGlobal("navigator", { locks: new FakeLockManager() });
    const first = await acquireWorkspaceLock("refuse");
    await expect(acquireWorkspaceLock("refuse")).rejects.toMatchObject({ code: "EWORKSPACELOCKED" });
    // other workspaces are independent
    (await acquireWorkspaceLock("other")).release();

    first.release();
    await new Promise((r) => setTimeout(r, 0));
    (await acquireWorkspaceLock("refuse")).release();
  });

  it("steal takes the lock and the previous holder stops saving", async () => {
    vi.stubGlobal("navigator", { locks: new FakeLockManager() });
    const lock = await acquireWorkspaceLock("steal");
    const volume = new MemoryVolume();
    const persistence = new WorkspacePersistence("ws", volume, createMemoryWorkspaceStore(), {}, lock);
    persistence.attach();
    const errors: Array<{ code?: string }> = [];
    persistence.on("error", (e: { code?: string }) => errors.push(e));

    const thief = await acquireWorkspaceLock("steal", "steal");
    await Promise.resolve();

    expect(errors.map((e) => e.code)).toEqual(["EWORKSPACELOCKLOST"]);
    expect(persistence.status).toBe("closed");
    volume.writeFileSync("/after.txt", "not saved by the old tab");
    expect(persistence.pendingChanges).toBe(0);
    thief.release();
  });
});
