import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { build as esbuild } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { createNodeHost } from "../host/node/node-host";
import { openFsSnapshotCache } from "../host/node/fs-snapshot-cache";
import { resetRuntimeHost, setRuntimeHost } from "../host";
import { Nodepod } from "../sdk/nodepod";
import { manifestSnapshotKey } from "../packages/installer";
import type { VFSBinarySnapshot } from "../threading/worker-protocol";

const here = dirname(fileURLToPath(import.meta.url));
const workerEntry = resolve(here, "../threading/process-worker-entry.ts");

// a cached node_modules pack for /proj with one dependency
function packFor(files: Record<string, string>, dirs: string[]): VFSBinarySnapshot {
  const enc = new TextEncoder();
  const manifest: VFSBinarySnapshot["manifest"] = dirs.map((path) => ({
    path,
    offset: 0,
    length: 0,
    isDirectory: true,
  }));
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const bytes = enc.encode(text);
    manifest.push({ path, offset, length: bytes.byteLength, isDirectory: false });
    chunks.push(bytes);
    offset += bytes.byteLength;
  }
  const data = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    data.set(chunk, at);
    at += chunk.byteLength;
  }
  return { manifest, data: data.buffer };
}

describe("package content eviction in a booted pod", () => {
  let workerPath = "";
  let tempDir = "";
  const pods: Nodepod[] = [];

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "nodepod-evict-"));
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
      plugins: [
        {
          name: "stub-virtual-process-worker",
          setup(build) {
            build.onResolve({ filter: /^virtual:process-worker-bundle$/ }, () => ({
              path: "virtual:process-worker-bundle",
              namespace: "stub",
            }));
            build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
              contents: 'export const PROCESS_WORKER_BUNDLE_GZIP_BASE64 = "";',
              loader: "js",
            }));
          },
        },
      ],
    });
    writeFileSync(workerPath, result.outputFiles[0].text, "utf8");
  }, 120_000);

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await Promise.all(pods.splice(0).map((pod) => pod.teardown()));
    resetRuntimeHost();
  });

  it("mounts cached packages paged out and pages them in for workers and the SDK", async () => {
    const cacheDir = join(tempDir, "cache");
    const manifestRaw = JSON.stringify({ name: "app", dependencies: { dep: "1.0.0" } });
    const cache = await openFsSnapshotCache(cacheDir);
    await cache!.set(
      manifestSnapshotKey(manifestRaw),
      packFor(
        {
          "/proj/node_modules/dep/package.json": JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js" }),
          "/proj/node_modules/dep/index.js": "module.exports = { value: 'paged in from the pack' };",
          "/proj/node_modules/dep/lib/extra.js": "module.exports = 42;",
        },
        ["/proj/node_modules", "/proj/node_modules/dep", "/proj/node_modules/dep/lib"],
      ),
    );

    setRuntimeHost(createNodeHost({ workerPath, cacheDir, httpHost: "127.0.0.1", httpPort: 0 }));
    const pod = await Nodepod.boot({
      workdir: "/proj",
      files: { "/proj/package.json": manifestRaw },
      memory: { evictPackageContent: true },
    });
    pods.push(pod);
    if (!pod.volume.evictionEnabled) {
      // no SharedArrayBuffer in this runtime: nothing to test
      return;
    }

    await pod.packages.installFromManifest();
    const stats = pod.memoryStats().vfs;
    expect(stats.pagedOutFiles).toBe(2);
    expect(pod.volume.isPagedOut("/proj/node_modules/dep/index.js")).toBe(true);
    // pinned: read synchronously by the installer
    expect(pod.volume.isPagedOut("/proj/node_modules/dep/package.json")).toBe(false);

    const child = await pod.spawn("node", ["-e", "console.log(require('dep').value)"], { cwd: "/proj" });
    const result = await child.completion;
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("paged in from the pack");

    expect(await pod.fs.readFile("/proj/node_modules/dep/lib/extra.js", "utf8")).toBe("module.exports = 42;");
    expect(pod.memoryStats().vfs.pagedOutSyncMisses).toBe(0);
    expect(() => pod.snapshot({ shallow: false })).toThrow(/paged-out/);
  }, 60_000);
});
