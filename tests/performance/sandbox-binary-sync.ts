import { MemoryVolume } from "../../src/memory-volume";
import { WorkerSandbox } from "../../src/worker-sandbox";

const status = document.querySelector("#status")!;
const NativeWorker = window.Worker;
let sandbox: WorkerSandbox | undefined;
try {
  // The runtime worker URL is dynamic. Supply the bundled test worker so
  // browser loading does not depend on Vite discovering CommonJS dependencies.
  window.Worker = class extends NativeWorker {
    constructor(_url: string | URL, options?: WorkerOptions) {
      super("/test-results/sandbox-engine-worker.js", options);
      this.addEventListener("error", (event) => {
        status.textContent = "FAIL: " + event.message;
      });
    }
  };
  const volume = new MemoryVolume();
  sandbox = new WorkerSandbox(volume);
  await sandbox.execute("module.exports = true;");
  volume.writeFileSync("/binary", new Uint8Array([0, 255, 128, 65]));
  const first = await sandbox.execute('module.exports = Array.from(require("fs").readFileSync("/binary"));');
  volume.writeFileSync("/text", "héllo");
  const second = await sandbox.execute('module.exports = require("fs").readFileSync("/text", "utf8");');
  volume.unlinkSync("/binary");
  const third = await sandbox.execute('module.exports = require("fs").existsSync("/binary");');
  (window as any).__sandboxBinarySync = { bytes: first.exports, text: second.exports, existsAfterDelete: third.exports };
  status.textContent = "PASS";
} catch (error) {
  status.textContent = "FAIL: " + (error instanceof Error ? error.stack : error);
} finally {
  sandbox?.terminate();
  window.Worker = NativeWorker;
}
