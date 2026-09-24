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

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
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
