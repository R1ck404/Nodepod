import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "../polyfills/events";
import { MemoryVolume } from "../memory-volume";
import { ProcessManager } from "../threading/process-manager";
import { buildFileSystemBridge } from "../polyfills/fs";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: unknown[] = [];
  terminated = false;

  constructor(_url: string, _options?: WorkerOptions) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

class FakeProcessHandle extends EventEmitter {
  pid = 123;
  workerExited = false;
  sent: unknown[] = [];

  postMessage(message: unknown): void {
    this.sent.push(message);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});

describe("tab-realm WASI worker broker", () => {
  it("recovers a missing installed WASM file before completing a sync read", async () => {
    const volume = new MemoryVolume();
    const packageDir = "/project/node_modules/lightningcss-wasm";
    const wasmPath = `${packageDir}/lightningcss_node.wasm`;
    volume.mkdirSync(packageDir, { recursive: true });
    volume.writeFileSync(`${packageDir}/package.json`, JSON.stringify({
      name: "lightningcss-wasm",
      version: "1.30.2",
    }));
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(wasm, {
      status: 200,
      headers: { "content-type": "application/wasm" },
    })));
    const manager = new ProcessManager(volume);
    const sab = new SharedArrayBuffer(256);
    const control = new Int32Array(sab, 0, 4);
    Atomics.store(control, 0, -1);
    Atomics.store(control, 3, 1);

    (manager as any)._handleFsProxyWithRecovery(
      { sab: control, type: "readFileSync", payload: [wasmPath], requestId: 1 },
      buildFileSystemBridge(volume, () => "/project"),
    );

    await vi.waitFor(() => expect(Atomics.load(control, 0)).toBe(0));
    expect(Array.from(volume.readFileSync(wasmPath))).toEqual(Array.from(wasm));
    expect(fetch).toHaveBeenCalledWith(
      "https://cdn.jsdelivr.net/npm/lightningcss-wasm@1.30.2/lightningcss_node.wasm",
    );
  });

  it("queues early messages, rejects duplicates, and cleans up exactly once", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const volume = new MemoryVolume();
    const manager = new ProcessManager(volume);
    const handle = new FakeProcessHandle();
    (manager as any)._wireHandleEvents(handle);

    handle.emit("wasiworker-request", {
      type: "wasiworker-request",
      requestId: 7,
      source: "self.ready = true",
      name: "test-wasi",
      workerData: { value: 1 },
    });
    expect(FakeWorker.instances).toHaveLength(1);
    expect(manager.resourceStats().workers).toBe(1);
    expect(handle.sent).toContainEqual({ type: "spawn-result", requestId: 7, pid: 0 });

    const worker = FakeWorker.instances[0];
    handle.emit("ipc-message", { targetRequestId: 7, data: "early" });
    expect(worker.messages).toHaveLength(1);
    worker.emitMessage({ __nodepod_broker_ready__: true });
    expect(worker.messages).toContain("early");
    expect(handle.sent).toContainEqual({
      type: "ipc-message",
      targetRequestId: 7,
      data: { __nodepod_broker_ready__: true },
    });

    handle.emit("wasiworker-request", {
      type: "wasiworker-request",
      requestId: 7,
      source: "",
      name: "duplicate",
      workerData: null,
    });
    expect(FakeWorker.instances).toHaveLength(1);
    expect(handle.sent).toContainEqual(expect.objectContaining({
      type: "spawn-result",
      requestId: 7,
      pid: -1,
      error: expect.stringContaining("duplicate"),
    }));

    handle.emit("wasiworker-terminate", { type: "wasiworker-terminate", requestId: 7 });
    handle.emit("wasiworker-terminate", { type: "wasiworker-terminate", requestId: 7 });
    expect(worker.terminated).toBe(true);
    expect(manager.resourceStats().workers).toBe(0);
    expect(handle.sent.filter((message: any) => message.type === "child-exit")).toHaveLength(1);
  });

  it("runs more than sixteen sequential workers without retaining broker state", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const manager = new ProcessManager(new MemoryVolume());
    const handle = new FakeProcessHandle();
    (manager as any)._wireHandleEvents(handle);

    for (let requestId = 1; requestId <= 20; requestId++) {
      handle.emit("wasiworker-request", {
        type: "wasiworker-request",
        requestId,
        source: "",
        name: `worker-${requestId}`,
        workerData: null,
      });
      FakeWorker.instances.at(-1)!.emitMessage({ __nodepod_broker_ready__: true });
      FakeWorker.instances.at(-1)!.emitMessage({ __nodepod_worker_exit__: 0 });
      expect(manager.resourceStats().workers).toBe(0);
    }

    expect(FakeWorker.instances).toHaveLength(20);
    expect(FakeWorker.instances.every(worker => worker.terminated)).toBe(true);
    expect(handle.sent.filter((message: any) => message.type === "child-exit")).toHaveLength(20);
  });

  it("isolates concurrent workers with identical request ids across pods", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const firstManager = new ProcessManager(new MemoryVolume());
    const secondManager = new ProcessManager(new MemoryVolume());
    const first = new FakeProcessHandle();
    const second = new FakeProcessHandle();
    (firstManager as any)._processes.set(first.pid, first);
    (secondManager as any)._processes.set(second.pid, second);
    (firstManager as any)._wireHandleEvents(first);
    (secondManager as any)._wireHandleEvents(second);

    for (let requestId = 1; requestId <= 4; requestId++) {
      first.emit("wasiworker-request", { type: "wasiworker-request", requestId, source: "", name: "first", workerData: null });
      second.emit("wasiworker-request", { type: "wasiworker-request", requestId, source: "", name: "second", workerData: null });
    }
    expect(firstManager.resourceStats().workers).toBe(5);
    expect(secondManager.resourceStats().workers).toBe(5);
    FakeWorker.instances[0].emitMessage("first-only");
    FakeWorker.instances[1].emitMessage("second-only");
    expect(first.sent).toContainEqual({ type: "ipc-message", targetRequestId: 1, data: "first-only" });
    expect(first.sent).not.toContainEqual(expect.objectContaining({ data: "second-only" }));
    expect(second.sent).toContainEqual({ type: "ipc-message", targetRequestId: 1, data: "second-only" });
    expect(second.sent).not.toContainEqual(expect.objectContaining({ data: "first-only" }));
    firstManager.teardown();
    secondManager.teardown();
    expect(FakeWorker.instances.every(worker => worker.terminated)).toBe(true);
  });

  it("times out a worker that never completes its ready handshake", () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const manager = new ProcessManager(new MemoryVolume());
    const handle = new FakeProcessHandle();
    (manager as any)._wireHandleEvents(handle);
    handle.emit("wasiworker-request", {
      type: "wasiworker-request",
      requestId: 9,
      source: "",
      name: "stalled",
      workerData: null,
    });

    vi.advanceTimersByTime(30_000);
    expect(manager.resourceStats().workers).toBe(0);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(handle.sent).toContainEqual(expect.objectContaining({
      type: "ipc-message",
      targetRequestId: 9,
      data: { __nodepod_worker_error__: "WASI worker ready handshake timed out" },
    }));
  });

  it("spawns delegated emnapi threads without waiting on the process worker", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const manager = new ProcessManager(new MemoryVolume());
    const handle = new FakeProcessHandle();
    (manager as any)._wireHandleEvents(handle);
    handle.emit("wasiworker-request", {
      type: "wasiworker-request",
      requestId: 11,
      source: "worker source",
      name: "root",
      workerData: null,
    });
    const root = FakeWorker.instances[0];
    root.emitMessage({ __nodepod_broker_ready__: true });
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const load = { __emnapi__: { type: "load", payload: { wasmMemory: memory } } };
    handle.emit("ipc-message", { targetRequestId: 11, data: load });
    root.emitMessage({
      __emnapi__: { type: "spawn-thread", payload: { startArg: 77, errorOrTid: 16 } },
    });

    expect(FakeWorker.instances).toHaveLength(2);
    const child = FakeWorker.instances[1];
    child.emitMessage({ __nodepod_broker_ready__: true });
    expect(child.messages).toContain(load);
    child.emitMessage({ __emnapi__: { type: "loaded", payload: {} } });
    const result = new Int32Array(memory.buffer, 16, 2);
    expect(Atomics.load(result, 0)).toBe(0);
    expect(Atomics.load(result, 1)).toBeGreaterThan(0);
    expect(child.messages).toContainEqual({
      __emnapi__: {
        type: "start",
        payload: { tid: Atomics.load(result, 1), arg: 77 },
      },
    });
    expect(manager.resourceStats().workers).toBe(2);
    child.emitMessage({ __emnapi__: { type: "cleanup-thread", payload: { tid: Atomics.load(result, 1) } } });
    expect(child.terminated).toBe(true);
    expect(manager.resourceStats().workers).toBe(1);
    handle.emit("wasiworker-terminate", { type: "wasiworker-terminate", requestId: 11 });
  });
});
