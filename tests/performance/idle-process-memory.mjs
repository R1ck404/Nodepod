// Windows: compare private committed bytes, so shared Node executable pages
// aren't counted repeatedly. Nodepod uses its headless worker_threads host.
// node --expose-gc tests/performance/idle-process-memory.mjs native 5
// node --expose-gc tests/performance/idle-process-memory.mjs dist/headless.mjs 5
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve, dirname, join } from "node:path";

const mode = process.argv[2];
const count = Number(process.argv[3] ?? 5);
const workload = process.argv[4] ?? "idle";
if (!["idle", "wasm", "wasm-reset", "wasm-worker"].includes(workload)) throw new Error("Choose idle, wasm, wasm-reset or wasm-worker");
// The same module and application run in both environments. It imports a
// growable shared memory with a 2 MiB minimum; the loader reserves 256 MiB
// locally or 512 MiB in the nested worker. The worker resets its whole heap.
// Export checksum(): load the first and last bytes of the 2 MiB working range.
const wasmBytes = [
  0,97,115,109,1,0,0,0,
  1,5,1,96,0,1,127,
  2,18,1,3,101,110,118,6,109,101,109,111,114,121,2,3,32,128,128,4,
  3,2,1,0,
  7,12,1,8,99,104,101,99,107,115,117,109,0,0,
  10,18,1,16,0,65,0,45,0,0,65,255,255,255,0,45,0,0,106,11,
];
const receiver = `
  const {parentPort,workerData}=require('worker_threads');
  const memory=new WebAssembly.Memory({initial:8192,maximum:65536,shared:true});
  const instance=new WebAssembly.Instance(workerData.module,{env:{memory}});
  new Uint8Array(memory.buffer).fill(0);
  const view=new Uint8Array(memory.buffer,0,2*1024*1024);
  view.fill(7);
  parentPort.postMessage({checksum:instance.exports.checksum(),capacity:memory.buffer.byteLength});
  setInterval(()=>{},1000);
`;
const application = workload === "wasm-worker" ? `
  const {Worker}=require('worker_threads');
  const bytes=new Uint8Array(${JSON.stringify(wasmBytes)});
  const compiled=new WebAssembly.Module(bytes);
  const worker=new Worker(${JSON.stringify(receiver)},{eval:true,workerData:{module:compiled}});
  worker.on('message',result=>console.log('ready',JSON.stringify(result)));
  setInterval(()=>{},1000);
` : workload.startsWith("wasm") ? `
  const bytes = new Uint8Array(${JSON.stringify(wasmBytes)});
  const module = new WebAssembly.Module(bytes);
  const memory = new WebAssembly.Memory({initial:4096,maximum:65536,shared:true});
  const instance = new WebAssembly.Instance(module,{env:{memory}});
  ${workload === "wasm-reset" ? "new Uint8Array(memory.buffer).fill(0);" : ""}
  const view = new Uint8Array(memory.buffer,0,2*1024*1024);
  view.fill(7);
  const checksum = instance.exports.checksum();
  setInterval(()=>{},1000);
  console.log('ready',JSON.stringify({checksum,capacity:memory.buffer.byteLength}));
` : "setInterval(()=>{},1000);console.log('ready')";
if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("Choose 1–20 processes");
if (process.platform !== "win32") throw new Error("This probe uses Windows private-memory counters");
function measure(pids) {
  const command = `Get-Process -Id ${pids.join(",")} | Select-Object Id,PrivateMemorySize64,WorkingSet64 | ConvertTo-Json -Compress`;
  const raw = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8", windowsHide: true,
  }));
  const processes = Array.isArray(raw) ? raw : [raw];
  return {
    processes,
    privateBytes: processes.reduce((n, p) => n + p.PrivateMemorySize64, 0),
    workingSetBytes: processes.reduce((n, p) => n + p.WorkingSet64, 0),
  };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanup = [];
const outputs = [];
let pod;
try {
  if (mode === "native") {
    const children = [];
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      const readyBridge = `const nativeLog=console.log;console.log=(...args)=>{nativeLog(...args);if(args[0]==='ready')process.send({result:args[1]?JSON.parse(args[1]):null});};`;
      const child = spawn(process.execPath, ["-e", readyBridge + application], {
        stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
      });
      cleanup.push(() => child.kill());
      children.push(child);
      await new Promise((resolve, reject) => {
        child.once("message", (message) => { outputs.push(message.result); resolve(); });
        child.once("error", reject);
        child.once("exit", () => reject(new Error("child exited before ready")));
      });
    }
    const startupMs = performance.now() - start;
    await sleep(1000);
    if (workload !== "idle" && outputs.some((result) => result?.checksum !== 14)) throw new Error("Native checksum mismatch");
    console.log(JSON.stringify({ mode, count, workload, outputs, startupMs, ...measure(children.map((p) => p.pid)) }));
  } else {
    const { Nodepod, createNodeHost, setRuntimeHost } = await import(pathToFileURL(resolve(mode)).href);
    // Pin the matching worker build; default resolution can find cwd/dist.
    setRuntimeHost(createNodeHost({ workerPath: join(dirname(resolve(mode)), "__worker__.js") }));
    pod = await Nodepod.boot({
      workdir: "/app", watermark: false, serviceWorker: false,
      files: { "/app/idle.js": application },
    });
    globalThis.gc?.();
    const before = measure([process.pid]);
    const start = performance.now();
    const procs = [];
    for (let i = 0; i < count; i++) {
      const child = await pod.spawn("node", ["idle.js"], { cwd: "/app" });
      procs.push(child);
      await new Promise((resolve, reject) => {
        let output = "";
        let done = false;
        child.on("output", (text) => {
          if (done) return;
          output += text;
          if (workload === "idle" && output.includes("ready")) { done = true; outputs.push(null); resolve(); }
          const match = output.match(/ready\s+(\{[^\n]+\})/);
          if (match) { done = true; outputs.push(JSON.parse(match[1])); resolve(); }
        });
        child.on("error", (text) => { output += text; });
        child.completion.then((result) => reject(new Error(`early exit ${result.exitCode}: ${output}`)));
      });
    }
    const startupMs = performance.now() - start;
    await sleep(1000);
    globalThis.gc?.();
    const after = measure([process.pid]);
    if (workload !== "idle" && outputs.some((result) => result?.checksum !== 14)) throw new Error("Nodepod checksum mismatch");
    console.log(JSON.stringify({
      mode, count, workload, outputs, startupMs, before, after,
      incrementalPrivateBytes: after.privateBytes - before.privateBytes,
      pod: pod.memoryStats(),
    }));
    for (const proc of procs) proc.kill("SIGKILL");
  }
} finally {
  for (const stop of cleanup) stop();
  await pod?.teardown();
}
// Each sample owns this process. The host may retain message ports after
// teardown; end the sample explicitly rather than let those ports hang it.
process.exit(0);
