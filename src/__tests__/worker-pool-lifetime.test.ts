import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn<() => Promise<void>>(),
  terminate: vi.fn(),
}));

vi.mock("comlink", () => ({
  wrap: () => ({ init: mocks.init }),
}));
vi.mock("../threading/inline-worker", () => ({
  createInlineWorker: () => ({ terminate: mocks.terminate }),
  revokeInlineWorkerUrl: vi.fn(),
}));

import { WorkerPool } from "../threading/worker-pool";

describe("worker pool initialization lifetime", () => {
  let pool: WorkerPool;
  let finishInit: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.terminate.mockClear();
    mocks.init.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishInit = resolve;
        }),
    );
    pool = new WorkerPool({ maxWorkers: 1, warmUpOnCreate: true });
  });

  afterEach(() => {
    pool.dispose();
    vi.useRealTimers();
  });

  it("clears the warm-up deadline after initialization succeeds", async () => {
    const acquiring = pool.acquire();
    expect(vi.getTimerCount()).toBe(2);
    finishInit();
    const { release } = await acquiring;
    expect(vi.getTimerCount()).toBe(1);
    release();
    pool.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels initialization and clears deadlines when disposed", async () => {
    const acquiring = pool.acquire();
    const rejected = expect(acquiring).rejects.toThrow("terminated during initialization");
    pool.dispose();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });
});
