import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { ProcessManager } from "../threading/process-manager";
import { createBrowserHost, resetRuntimeHost, setRuntimeHost } from "../host";

// stands in for a process worker: records what the main thread sends it
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: any[] = [];
  listeners: Array<(event: MessageEvent) => void> = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {}
  addEventListener(type: string, fn: (event: MessageEvent) => void): void {
    if (type === "message") this.listeners.push(fn);
  }
  removeEventListener(): void {}

  // a message from the worker to the main thread
  send(data: unknown): void {
    for (const fn of this.listeners) fn({ data } as MessageEvent);
  }
}

const resizes = (worker: FakeWorker) =>
  worker.messages.filter((m) => m?.type === "resize").map((m) => [m.cols, m.rows]);

beforeEach(() => {
  resetRuntimeHost();
  setRuntimeHost({ ...createBrowserHost(), createWorker: () => new FakeWorker() });
});

afterEach(() => {
  resetRuntimeHost();
  FakeWorker.instances = [];
});

describe("terminal size for child processes", () => {
  it("starts a child that shares the terminal at its size and relays resizes", () => {
    const manager = new ProcessManager(new MemoryVolume());
    const shell = manager.spawn({ command: "sh", args: [], cwd: "/", env: {} });
    const shellWorker = FakeWorker.instances.at(-1)!;
    shell.resize(120, 40);

    const spawnChild = (requestId: number, stdio: unknown) => {
      shell.emit("spawn-request", {
        type: "spawn-request",
        requestId,
        command: "node",
        args: ["tui.js"],
        cwd: "/",
        env: {},
        stdio,
      });
      return FakeWorker.instances.at(-1)!;
    };
    const tty = spawnChild(1, "inherit");
    const piped = spawnChild(2, "pipe");
    const stdoutOnly = spawnChild(3, ["pipe", "inherit", "pipe"]);
    expect(new Set([shellWorker, tty, piped, stdoutOnly]).size).toBe(4);

    // the child's first size is the terminal's, not the 80x24 default
    expect(resizes(tty)).toEqual([[120, 40]]);
    expect(resizes(stdoutOnly)).toEqual([[120, 40]]);
    expect(resizes(piped)).toEqual([]);

    shell.resize(150, 50);
    expect(resizes(tty)).toEqual([[120, 40], [150, 50]]);
    expect(resizes(stdoutOnly)).toEqual([[120, 40], [150, 50]]);
    expect(resizes(piped)).toEqual([]);
  });
});

describe("child process environment", () => {
  it("drops undefined values and stringifies the rest, like node", () => {
    const manager = new ProcessManager(new MemoryVolume());
    const env = { KEPT: "yes", GONE: undefined, COUNT: 3 } as unknown as Record<string, string>;
    manager.spawn({ command: "sh", args: [], cwd: "/", env });
    const init = FakeWorker.instances.at(-1)!.messages.find((m) => m?.type === "init");
    expect(init.env).toEqual({ KEPT: "yes", COUNT: "3" });
    expect("GONE" in init.env).toBe(false);
  });
});

describe("worker_threads children", () => {
  it("ends a thread's workers when the thread exits, so its exit is not held forever", () => {
    const manager = new ProcessManager(new MemoryVolume());
    const owner = manager.spawn({ command: "node", args: ["build.js"], cwd: "/", env: {} });
    const ownerWorker = FakeWorker.instances.at(-1)!;
    const exits: number[] = [];
    owner.on("exit", (code: number) => exits.push(code));

    // new Worker(...) that the owner unref()s while it still listens on parentPort
    owner.emit("workerthread-request", {
      type: "workerthread-request",
      requestId: 1,
      modulePath: "/analyse.js",
      args: [],
      cwd: "/",
      env: {},
      workerData: null,
      threadId: 1,
    });
    const threadWorker = FakeWorker.instances.at(-1)!;
    expect(threadWorker).not.toBe(ownerWorker);

    ownerWorker.send({ type: "exit", exitCode: 0 });
    expect(exits).toEqual([]);
    expect(threadWorker.messages).toContainEqual({ type: "signal", signal: "SIGTERM" });

    threadWorker.send({ type: "exit", exitCode: 130 });
    expect(exits).toEqual([0]);
  });
});

describe("fork IPC lifecycle", () => {
  it("closes IPC when the parent finishes without killing the child's own work", () => {
    const manager = new ProcessManager(new MemoryVolume());
    const owner = manager.spawn({ command: "node", args: ["parent.js"], cwd: "/", env: {} });
    const ownerWorker = FakeWorker.instances.at(-1)!;
    const exits: number[] = [];
    owner.on("exit", code => exits.push(code));
    owner.emit("fork-request", { type: "fork-request", requestId: 1, modulePath: "/child.js", args: [], cwd: "/", env: {} });
    const childWorker = FakeWorker.instances.at(-1)!;
    childWorker.send({ type: "ready", pid: 2 });
    ownerWorker.send({ type: "exit", exitCode: 0 });
    expect(childWorker.messages).toContainEqual({ type: "ipc-disconnect" });
    expect(childWorker.messages.some(message => message.type === "signal")).toBe(false);
    expect(exits).toEqual([]);
    childWorker.send({ type: "exit", exitCode: 0 });
    expect(exits).toEqual([0]);
  });

  it("relays explicit disconnects in both directions", () => {
    const manager = new ProcessManager(new MemoryVolume());
    const owner = manager.spawn({ command: "node", args: ["parent.js"], cwd: "/", env: {} });
    const ownerWorker = FakeWorker.instances.at(-1)!;
    owner.emit("fork-request", { type: "fork-request", requestId: 5, modulePath: "/child.js", args: [], cwd: "/", env: {} });
    const childWorker = FakeWorker.instances.at(-1)!;
    childWorker.send({ type: "ready", pid: 2 });
    ownerWorker.send({ type: "ipc-disconnect", targetRequestId: 5 });
    expect(childWorker.messages).toContainEqual({ type: "ipc-disconnect" });
    childWorker.send({ type: "ipc-disconnect" });
    expect(ownerWorker.messages).toContainEqual({ type: "ipc-disconnect", targetRequestId: 5 });
  });

  it("delivers EOF after exec when the child only becomes ready after its parent exits", () => {
    const manager = new ProcessManager(new MemoryVolume());
    const owner = manager.spawn({ command: "node", args: ["parent.js"], cwd: "/", env: {} });
    const ownerWorker = FakeWorker.instances.at(-1)!;
    owner.emit("fork-request", { type: "fork-request", requestId: 6, modulePath: "/child.js", args: [], cwd: "/", env: {} });
    const childWorker = FakeWorker.instances.at(-1)!;
    ownerWorker.send({ type: "exit", exitCode: 0 });
    expect(childWorker.messages.some(message => message.type === "ipc-disconnect")).toBe(false);
    childWorker.send({ type: "ready", pid: 2 });
    expect(childWorker.messages.slice(-2).map(message => message.type)).toEqual(["exec", "ipc-disconnect"]);
  });
});
