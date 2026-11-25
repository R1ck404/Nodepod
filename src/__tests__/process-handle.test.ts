import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessHandle } from "../threading/process-handle";

class FakeWorker {
  sent: unknown[] = [];
  terminated = false;
  private listeners = new Map<string, Array<(event: any) => void>>();

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("ProcessHandle worker handshake", () => {
  afterEach(() => vi.useRealTimers());

  it("retries with the embedded worker when the direct worker does not respond", () => {
    vi.useFakeTimers();
    const direct = new FakeWorker();
    const embedded = new FakeWorker();
    const config = {
      command: "node",
      args: [],
      cwd: "/",
      env: {},
      snapshot: { manifest: [], data: new ArrayBuffer(0) },
    };
    const handle = new ProcessHandle(
      direct as unknown as Worker,
      config,
      () => embedded as unknown as Worker,
    );

    handle.init({ type: "init", pid: 100, cwd: "/", env: {}, snapshot: config.snapshot });
    expect(direct.sent).toEqual([{ type: "probe" }]);
    vi.advanceTimersByTime(2_000);

    expect(direct.terminated).toBe(true);
    expect(embedded.sent).toEqual([
      { type: "init", pid: 100, cwd: "/", env: {}, snapshot: config.snapshot },
    ]);
  });

  it("initializes the direct worker after its handshake", () => {
    const direct = new FakeWorker();
    const config = {
      command: "node",
      args: [],
      cwd: "/",
      env: {},
      snapshot: { manifest: [], data: new ArrayBuffer(0) },
    };
    const handle = new ProcessHandle(
      direct as unknown as Worker,
      config,
      () => new FakeWorker() as unknown as Worker,
    );

    handle.init({ type: "init", pid: 100, cwd: "/", env: {}, snapshot: config.snapshot });
    direct.emit("message", { data: { type: "probe-ready" } });

    expect(direct.sent).toEqual([
      { type: "probe" },
      { type: "init", pid: 100, cwd: "/", env: {}, snapshot: config.snapshot },
    ]);
  });

  it("sends messages posted during the handshake after init, in order", () => {
    const direct = new FakeWorker();
    const config = {
      command: "node",
      args: [],
      cwd: "/",
      env: {},
      snapshot: { manifest: [], data: new ArrayBuffer(0) },
    };
    const handle = new ProcessHandle(
      direct as unknown as Worker,
      config,
      () => new FakeWorker() as unknown as Worker,
    );
    const init = { type: "init" as const, pid: 100, cwd: "/", env: {}, snapshot: config.snapshot };

    handle.init(init);
    // a file written on the main thread while the worker starts
    handle.postMessage({ type: "vfs-sync", path: "/a.js", content: null, isDirectory: false });
    handle.postMessage({ type: "vfs-sync", path: "/b.js", content: null, isDirectory: false });
    expect(direct.sent).toEqual([{ type: "probe" }]);

    direct.emit("message", { data: { type: "probe-ready" } });

    expect(direct.sent).toEqual([
      { type: "probe" },
      init,
      { type: "vfs-sync", path: "/a.js", content: null, isDirectory: false },
      { type: "vfs-sync", path: "/b.js", content: null, isDirectory: false },
    ]);
  });

  it("sends messages posted during the handshake to the fallback worker after init", () => {
    vi.useFakeTimers();
    const direct = new FakeWorker();
    const embedded = new FakeWorker();
    const config = {
      command: "node",
      args: [],
      cwd: "/",
      env: {},
      snapshot: { manifest: [], data: new ArrayBuffer(0) },
    };
    const handle = new ProcessHandle(
      direct as unknown as Worker,
      config,
      () => embedded as unknown as Worker,
    );
    const init = { type: "init" as const, pid: 100, cwd: "/", env: {}, snapshot: config.snapshot };

    handle.init(init);
    handle.postMessage({ type: "vfs-sync", path: "/a.js", content: null, isDirectory: false });
    vi.advanceTimersByTime(2_000);

    expect(direct.sent).toEqual([{ type: "probe" }]);
    expect(embedded.sent).toEqual([
      init,
      { type: "vfs-sync", path: "/a.js", content: null, isDirectory: false },
    ]);
  });

  it("terminates a worker that never becomes ready", () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const config = {
      command: "node",
      args: [],
      cwd: "/",
      env: {},
      snapshot: { manifest: [], data: new ArrayBuffer(0) },
    };
    const handle = new ProcessHandle(worker as unknown as Worker, config);
    const exited = vi.fn();
    handle.on("exit", exited);

    handle.init({ type: "init", pid: 100, cwd: "/", env: {}, snapshot: config.snapshot });
    vi.advanceTimersByTime(30_000);

    expect(worker.terminated).toBe(true);
    expect(handle.state).toBe("exited");
    expect(exited).toHaveBeenCalledWith(1, "", "");
  });
});
