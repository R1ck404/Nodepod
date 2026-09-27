import { describe, it, expect } from "vitest";
import { MemoryVolume } from "../memory-volume";
import {
  executeNodeBinary,
  handleIPCFromParent,
  initShellExec,
  setIPCReceiveHandler,
  setIPCSend,
} from "../polyfills/child_process";
import { MessagePort } from "../polyfills/worker_threads";
import type { ShellContext } from "../shell/shell-types";

// the wiring process-worker-entry does for a worker_threads Worker (the main
// thread starts those as forks flagged isWorkerThread): parent messages are
// routed to the worker's parentPort before the script runs
function runWorkerThread(code: string, onParentMessage: (data: unknown) => void) {
  const vol = new MemoryVolume();
  vol.writeFileSync("/worker.js", code);
  initShellExec(vol, { cwd: "/" });
  const pp = new MessagePort();
  pp.postMessage = onParentMessage;
  setIPCSend(onParentMessage);
  setIPCReceiveHandler((data: unknown) => pp.emit("message", data));
  const ctx: ShellContext = {
    cwd: "/",
    env: { HOME: "/home", PATH: "/usr/bin", PWD: "/" },
    volume: vol,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
  return executeNodeBinary("/worker.js", [], ctx, {
    isFork: true,
    workerThreadsOverride: { isMainThread: false, parentPort: pp, workerData: null, threadId: 1 },
  });
}

describe("worker thread parentPort", () => {
  // SvelteKit's build analysis (utils/fork.js) posts its arguments only after
  // the worker reports 'ready'. those messages used to reach process.on('message')
  // instead of parentPort, so the worker waited forever and `vite build` hung.
  it("receives messages the parent posts after the worker started", async () => {
    const received: unknown[] = [];
    const r = await runWorkerThread(
      [
        "const { parentPort } = require('worker_threads');",
        "parentPort.on('message', function onMessage(m) {",
        "  parentPort.postMessage('echo:' + m);",
        "  parentPort.off('message', onMessage);",
        "});",
        "parentPort.postMessage('ready');",
      ].join("\n"),
      (data) => {
        received.push(data);
        if (data === "ready") setTimeout(() => handleIPCFromParent("args"), 0);
      },
    );
    expect(r.exitCode).toBe(0);
    expect(received).toEqual(["ready", "echo:args"]);
  }, 10_000);
});
