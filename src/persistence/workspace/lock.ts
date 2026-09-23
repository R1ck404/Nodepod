// Exclusive per-workspace lock across tabs (Web Locks API). Two tabs saving
// the same workspace would overwrite each other's changes, so only the lock
// holder persists. Without navigator.locks (old browsers) only pods in the
// same page are kept apart.

export interface WorkspaceLock {
  release(): void;
  /**
   * The holder is shutting down and will release once `done` settles. A boot
   * of the same workspace in this page waits for that instead of failing, so
   * `pod.teardown(); Nodepod.boot(...)` works and sees the final save.
   */
  releaseAfter(done: Promise<unknown>): void;
  /** Called once if another tab steals the lock. */
  onLost: (() => void) | null;
}

export interface WorkspaceLockError extends Error {
  code: "EWORKSPACELOCKED";
}

interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; steal?: boolean },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

interface Holder {
  // resolves once the lock is fully released (Web Lock included)
  released: Promise<void>;
  closing: boolean;
}

// holders in this page, by workspace id
const holders = new Map<string, Holder>();

function lockedError(id: string): WorkspaceLockError {
  const err = new Error(
    `Workspace "${id}" is open in another tab. Close it there, or boot with persistence.lock = "steal".`,
  ) as WorkspaceLockError;
  err.code = "EWORKSPACELOCKED";
  return err;
}

export async function acquireWorkspaceLock(
  id: string,
  mode: "error" | "steal" = "error",
): Promise<WorkspaceLock> {
  const previous = holders.get(id);
  if (previous?.closing) {
    await previous.released;
  } else if (previous && mode === "error") {
    throw lockedError(id);
  }

  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let markReleased!: () => void;
  const holder: Holder = {
    released: new Promise<void>((resolve) => { markReleased = resolve; }),
    closing: false,
  };
  let released = false;
  const lock: WorkspaceLock = {
    release() {
      if (released) return;
      released = true;
      releaseHeld();
    },
    releaseAfter(done) {
      holder.closing = true;
      void done.then(() => lock.release(), () => lock.release());
    },
    onLost: null,
  };

  if (!locks || typeof locks.request !== "function") {
    void held.then(() => {
      if (holders.get(id) === holder) holders.delete(id);
      markReleased();
    });
    holders.set(id, holder);
    return lock;
  }

  const acquired = await new Promise<boolean>((resolve) => {
    locks
      .request(
        `nodepod-workspace:${id}`,
        mode === "steal" ? { steal: true } : { ifAvailable: true },
        (granted) => {
          if (!granted) {
            resolve(false);
            return;
          }
          resolve(true);
          return held;
        },
      )
      .catch(() => {
        // rejects with AbortError when another tab steals the lock
        if (!released) lock.onLost?.();
        resolve(false);
      })
      .finally(() => {
        // the Web Lock is only free for the next request once this settles
        if (holders.get(id) === holder) holders.delete(id);
        markReleased();
      });
  });

  if (!acquired) throw lockedError(id);
  holders.set(id, holder);
  return lock;
}
