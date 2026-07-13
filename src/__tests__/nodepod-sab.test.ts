import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// the virtual module is provided by a vite plugin only in the lib build,
// tests run under vitest without that plugin so we stub it here
vi.mock("virtual:process-worker-bundle", () => ({
  PROCESS_WORKER_BUNDLE_GZIP_BASE64: "H4sIAAAAAAAAEwMAAAAAAAAAAAA=",
}));

import { Nodepod } from "../sdk/nodepod";

// Worker is not global in node, stub so boot can get past the worker check.
// SW is opted out via serviceWorker: false so no navigator bits are touched.

describe("Nodepod SAB opt-out", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let workerWasSet = false;
  let sabBackup: typeof SharedArrayBuffer | undefined;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    if (typeof (globalThis as any).Worker === "undefined") {
      (globalThis as any).Worker = function MockWorker() {} as any;
      workerWasSet = true;
    }
    sabBackup = (globalThis as any).SharedArrayBuffer;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (workerWasSet) {
      delete (globalThis as any).Worker;
      workerWasSet = false;
    }
    if (sabBackup) {
      (globalThis as any).SharedArrayBuffer = sabBackup;
    }
  });

  it("default boot keeps SAB on and does not warn", async () => {
    const pod = await Nodepod.boot({ serviceWorker: false });
    expect(pod.isSharedArrayBufferEnabled).toBe(true);
    const pm = (pod as any)._processManager;
    expect(pm._sharedBuffer).toBeUndefined();
    expect(pm._syncBuffer).not.toBeNull();
    expect(pod.memoryStats().runtime.sharedFSAllocated).toBe(false);
    expect(pod.sharedFSBuffer).toBeInstanceOf(SharedArrayBuffer);
    expect(pod.memoryStats().runtime.sharedFSAllocated).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    pod.teardown();
  });

  it("enableSharedArrayBuffer: false forces SAB off even when available", async () => {
    const pod = await Nodepod.boot({
      serviceWorker: false,
      enableSharedArrayBuffer: false,
    });
    expect(pod.isSharedArrayBufferEnabled).toBe(false);
    const pm = (pod as any)._processManager;
    expect(pm._sharedBuffer).toBeUndefined();
    expect(pm._syncBuffer).toBeNull();

    const msg = warnSpy.mock.calls.flat().join(" ");
    expect(msg).toContain("SharedArrayBuffer");
    expect(msg).toContain("disabled");
    pod.teardown();
  });

  it("missing SAB runtime does not throw, boot degrades and warns", async () => {
    delete (globalThis as any).SharedArrayBuffer;

    const pod = await Nodepod.boot({ serviceWorker: false });
    expect(pod.isSharedArrayBufferEnabled).toBe(false);
    const pm = (pod as any)._processManager;
    expect(pm._sharedBuffer).toBeUndefined();
    expect(pm._syncBuffer).toBeNull();

    const msg = warnSpy.mock.calls.flat().join(" ");
    expect(msg).toContain("SharedArrayBuffer");
    expect(msg).toContain("unavailable");
    pod.teardown();
  });

  it("teardown is idempotent and makes the filesystem terminal", async () => {
    const pod = await Nodepod.boot({ serviceWorker: false });
    await pod.fs.writeFile("/kept.txt", "data");
    pod.teardown();
    expect(() => pod.teardown()).not.toThrow();
    await expect(pod.fs.readFile("/kept.txt", "utf8")).rejects.toThrow(
      /disposed/,
    );
  });
});
