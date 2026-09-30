import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { build as esbuild } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createNodeHost } from "../host/node/node-host";
import { resetRuntimeHost, setRuntimeHost } from "../host";
import { Nodepod } from "../sdk/nodepod";

const here = dirname(fileURLToPath(import.meta.url));
const workerEntry = resolve(here, "../threading/process-worker-entry.ts");

describe("node headless host", () => {
  let workerPath = "";
  let tempDir = "";

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "nodepod-headless-"));
    workerPath = join(tempDir, "__worker__.js");
    const result = await esbuild({
      entryPoints: [workerEntry],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "esnext",
      write: false,
      minify: false,
      legalComments: "none",
      sourcemap: false,
      // Match lib build: worker must not pull host/virtual modules.
      plugins: [
        {
          name: "stub-virtual-process-worker",
          setup(build) {
            build.onResolve({ filter: /^virtual:process-worker-bundle$/ }, () => ({
              path: "virtual:process-worker-bundle",
              namespace: "stub",
            }));
            build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
              contents:
                'export const PROCESS_WORKER_BUNDLE_GZIP_BASE64 = "";',
              loader: "js",
            }));
          },
        },
      ],
    });
    writeFileSync(workerPath, result.outputFiles[0].text, "utf8");
  }, 120_000);

  afterAll(() => {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  afterEach(() => {
    resetRuntimeHost();
  });

  it("boots, runs shell echo via spawn, and serves HTTP over local ingress", async () => {
    setRuntimeHost(
      createNodeHost({
        workerPath,
        httpHost: "127.0.0.1",
        httpPort: 0,
      }),
    );

    const pod = await Nodepod.boot({
      packageStore: "memory",
      enableSnapshotCache: false,
    });
    expect(pod.isHeadless).toBe(true);

    await pod.fs.writeFile("/hello.txt", "from-fs");
    expect(await pod.fs.readFile("/hello.txt", "utf8")).toBe("from-fs");

    const echo = await pod.spawn("echo", ["hello-headless"]);
    const echoResult = await echo.completion;
    expect(echoResult.exitCode).toBe(0);
    expect(echoResult.stdout).toContain("hello-headless");

    // Register a tiny in-process virtual server via spawn node -e style is heavy;
    // instead exercise request() 503 and local baseUrl from ingress.
    const base = pod.proxy.getBaseUrl();
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const miss = await pod.request(4242, { path: "/nope" });
    expect(miss.statusCode).toBe(503);

    // Fetch against the local ingress (same 503 path)
    const url = `${base}/__virtual__/${pod.instanceId}/4242/nope`;
    const res = await fetch(url);
    expect(res.status).toBe(503);

    await pod.teardown();
    await expect(fetch(url)).rejects.toThrow();
  }, 60_000);

  it("propagates cwd through nested pnpm run scripts", async () => {
    setRuntimeHost(
      createNodeHost({
        workerPath,
        httpHost: "127.0.0.1",
        httpPort: 0,
      }),
    );

    const pod = await Nodepod.boot({
      workdir: "/workspace",
      packageStore: "memory",
      enableSnapshotCache: false,
      files: {
        "/workspace/package.json": JSON.stringify({
          name: "cwd-probe",
          version: "1.0.0",
          scripts: {
            "print-cwd": 'node -e "console.log(process.cwd())"',
          },
        }),
      },
    });

    const child = await pod.spawn(
      "sh",
      ["-c", "pnpm run print-cwd"],
      { cwd: "/workspace" },
    );
    const result = await child.completion;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/(?:^|\n)\/workspace$/);
    await pod.teardown();
  }, 60_000);

  it("resolves a relative node script against the spawn's cwd", async () => {
    setRuntimeHost(
      createNodeHost({
        workerPath,
        httpHost: "127.0.0.1",
        httpPort: 0,
      }),
    );

    const pod = await Nodepod.boot({
      workdir: "/home",
      packageStore: "memory",
      enableSnapshotCache: false,
      files: {
        "/home/app/main.mjs": "console.log('cwd', process.cwd());\n",
        "/home/app/c.js": "console.log('cjs ran');\n",
      },
    });

    const esm = await (await pod.spawn("node", ["main.mjs"], { cwd: "/home/app" })).completion;
    expect(esm.stderr).toBe("");
    expect(esm.exitCode).toBe(0);
    expect(esm.stdout).toBe("cwd /home/app\n");
    const cjs = await (await pod.spawn("node", ["./c.js"], { cwd: "/home/app" })).completion;
    expect(cjs.exitCode).toBe(0);
    expect(cjs.stdout).toBe("cjs ran\n");
    await pod.teardown();
  }, 60_000);

  it("preserves compiled WASM memory requirements through workerData and return messages", async () => {
    setRuntimeHost(createNodeHost({ workerPath }));
    // env.memory: shared, 32-page minimum, 65536-page maximum.
    const bytes = [0,97,115,109,1,0,0,0,2,18,1,3,101,110,118,6,109,101,109,111,114,121,2,3,32,128,128,4];
    const receiver = `
      const {parentPort,workerData}=require('worker_threads');
      const memory=new WebAssembly.Memory({initial:4096,maximum:65536,shared:true});
      new WebAssembly.Instance(workerData.module,{env:{memory}});
      parentPort.postMessage({capacity:memory.buffer.byteLength,module:workerData.module});
    `;
    const pod = await Nodepod.boot({
      workdir: "/app", packageStore: "memory", enableSnapshotCache: false,
      files: { "/app/main.js": `
        const {Worker}=require('worker_threads');
        const module=new WebAssembly.Module(new Uint8Array(${JSON.stringify(bytes)}));
        const worker=new Worker(${JSON.stringify(receiver)},{eval:true,workerData:{module}});
        worker.on('message',result=>{
          const memory=new WebAssembly.Memory({initial:4096,maximum:65536,shared:true});
          new WebAssembly.Instance(result.module,{env:{memory}});
          console.log(JSON.stringify([result.capacity,memory.buffer.byteLength]));
          worker.terminate();
        });
      ` },
    });
    try {
      const result = await (await pod.spawn("node", ["main.js"], { cwd: "/app" })).completion;
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout.trim())).toEqual([2 * 1024 * 1024, 2 * 1024 * 1024]);
    } finally {
      await pod.teardown();
    }
  }, 60_000);

  it("round-trips fork IPC in JSON and advanced modes and forwards execArgv conditions", async () => {
    setRuntimeHost(createNodeHost({ workerPath }));
    const pod = await Nodepod.boot({
      workdir: "/app", packageStore: "memory", enableSnapshotCache: false,
      files: {
        "/app/node_modules/condition-probe/package.json": JSON.stringify({ exports: { custom: "./custom.js", default: "./default.js" } }),
        "/app/node_modules/condition-probe/custom.js": "module.exports='custom';",
        "/app/node_modules/condition-probe/default.js": "module.exports='default';",
        "/app/child.js": `
          process.on('message', message=>{
            process.send({message, callback:()=>{}, condition:require('condition-probe'), execArgv:process.execArgv});
          });
        `,
        "/app/advanced.js": `process.on('message',message=>process.send(message));`,
        "/app/main.js": `
          const {fork}=require('child_process');
          const json=fork('./child.js',[],{execArgv:['--conditions=custom']});
          json.on('message', result=>{
            console.log('json',JSON.stringify(result)); json.kill();
            const advanced=fork('./advanced.js',[],{serialization:'advanced'});
            advanced.on('message', result=>{
              console.log('advanced',result.self===result,result.map.get('answer')===42n,result.date instanceof Date);
              advanced.kill();
            });
            const rich={map:new Map([['answer',42n]]),date:new Date(123)};rich.self=rich;
            advanced.send(rich);
          });
          json.send({callback:()=>{},date:new Date(123),absent:undefined,list:[undefined,NaN]});
        `,
      },
    });
    try {
      const process = await pod.spawn("node", ["main.js"], { cwd: "/app" });
      const chunks: string[] = [];
      process.on("output", chunk=>chunks.push(chunk));
      process.on("error", chunk=>chunks.push(chunk));
      let timer: ReturnType<typeof setTimeout>;
      const result = await Promise.race([process.completion, new Promise<never>((_, reject)=>{timer=setTimeout(()=>reject(new Error(chunks.join(""))), 10_000);})]).finally(()=>clearTimeout(timer));
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const lines = result.stdout.trim().split("\n");
      expect(JSON.parse(lines[0].slice(5))).toEqual({
        message: { date: "1970-01-01T00:00:00.123Z", list: [null, null] },
        condition: "custom", execArgv: ["--conditions=custom"],
      });
      expect(lines[1]).toBe("advanced true true true");
    } finally {
      await pod.teardown();
    }
  }, 60_000);

  it("disconnects idle fork IPC on parent exit and preserves the child's subsequent work", async () => {
    setRuntimeHost(createNodeHost({ workerPath }));
    const pod = await Nodepod.boot({
      workdir: "/app", packageStore: "memory", enableSnapshotCache: false,
      files: {
        "/app/parent.js": `
          const child=require('child_process').fork('./child.js');
          child.on('message',()=>{ child.unref(); console.log('parent done'); });
        `,
        "/app/child.js": `
          process.on('message',()=>{});
          process.on('disconnect',()=>{
            console.log('disconnected',process.connected);
            setTimeout(()=>console.log('child work survived'),20);
          });
          process.send('ready');
        `,
      },
    });
    try {
      const child = await pod.spawn("node", ["parent.js"], { cwd: "/app" });
      const chunks: string[] = [];
      child.on("output", chunk=>chunks.push(chunk));
      let timer: ReturnType<typeof setTimeout>;
      const result = await Promise.race([child.completion, new Promise<never>((_, reject)=>{timer=setTimeout(()=>reject(new Error(chunks.join(""))), 5000);})]).finally(()=>clearTimeout(timer));
      expect(result.exitCode).toBe(0);
      expect(chunks.join("")).toContain("parent done\n");
      expect(chunks.join("")).toContain("disconnected false\n");
      expect(chunks.join("")).toContain("child work survived\n");
    } finally { await pod.teardown(); }
  }, 15_000);

  it("keeps active-server URLs byte-for-byte unchanged in spawn output", async () => {
    setRuntimeHost(
      createNodeHost({
        workerPath,
        httpHost: "127.0.0.1",
        httpPort: 0,
      }),
    );

    const stdout = "Local: http://localhost:5173/\n";
    const stderr = "HMR: ws://localhost:5173/socket\n";
    const pod = await Nodepod.boot({
      packageStore: "memory",
      enableSnapshotCache: false,
      files: {
        "/url-output.js": `
          const http = require("http");
          const server = http.createServer((_req, res) => res.end("ok"));
          server.listen(5173, "127.0.0.1", () => {
            setTimeout(() => {
              process.stdout.write(${JSON.stringify(stdout)});
              process.stderr.write(${JSON.stringify(stderr)});
              server.close();
            }, 20);
          });
        `,
      },
    });

    const child = await pod.spawn("node", ["/url-output.js"]);
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.on("output", (chunk) => stdoutChunks.push(chunk));
    child.on("error", (chunk) => stderrChunks.push(chunk));

    const result = await child.completion;
    expect(result).toEqual({ stdout, stderr, exitCode: 0 });
    expect(stdoutChunks.join("")).toBe(stdout);
    expect(stderrChunks.join("")).toBe(stderr);
    expect(pod.port(5173)).toBeNull();
    await pod.teardown();
  }, 60_000);
});
