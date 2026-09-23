import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { build as esbuild } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { createNodeHost } from "../host/node/node-host";
import { resetRuntimeHost, setRuntimeHost } from "../host";
import { Nodepod } from "../sdk/nodepod";
import { createMemoryWorkspaceStore } from "../persistence/workspace/memory-store";
import type { WorkspaceStore } from "../persistence/workspace/types";

const here = dirname(fileURLToPath(import.meta.url));
const workerEntry = resolve(here, "../threading/process-worker-entry.ts");

describe("workspace persistence across boots", () => {
  let workerPath = "";
  let tempDir = "";

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "nodepod-persist-"));
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

  // a failed assertion must not leave a pod holding the workspace lock
  const pods: Nodepod[] = [];
  afterEach(async () => {
    await Promise.all(pods.splice(0).map((pod) => pod.teardown()));
    resetRuntimeHost();
  });

  async function boot(store: WorkspaceStore | undefined, extra: Parameters<typeof Nodepod.boot>[0] = {}) {
    setRuntimeHost(
      createNodeHost({ workerPath, cacheDir: join(tempDir, "cache"), httpHost: "127.0.0.1", httpPort: 0 }),
    );
    const pod = await Nodepod.boot({
      workdir: "/proj",
      packageStore: "memory",
      enableSnapshotCache: false,
      ...extra,
      persistence: { id: "boot-test", store, ...extra.persistence },
    });
    pods.push(pod);
    return pod;
  }

  it("restores files written through the SDK and by worker processes", async () => {
    const store = createMemoryWorkspaceStore();

    const first = await boot(store, { files: { "/proj/seed.txt": "seed" } });
    expect(first.persistence).not.toBeNull();
    await first.fs.writeFile("/proj/sdk.txt", "from the sdk");
    const child = await first.spawn("sh", ["-c", "echo from-a-worker > /proj/worker.txt && chmod 700 /proj/worker.txt"], { cwd: "/proj" });
    expect((await child.completion).exitCode).toBe(0);
    await first.teardown();

    // seed defaults to "if-empty": the restored copy wins over `files`
    const second = await boot(store, { files: { "/proj/seed.txt": "changed seed" } });
    expect(await second.fs.readFile("/proj/seed.txt", "utf8")).toBe("seed");
    expect(await second.fs.readFile("/proj/sdk.txt", "utf8")).toBe("from the sdk");
    expect((await second.fs.readFile("/proj/worker.txt", "utf8")).trim()).toBe("from-a-worker");
    // metadata set inside a worker reaches the main volume, and so the store
    expect(second.volume.statSync("/proj/worker.txt").mode & 0o777).toBe(0o700);

    // restored files are visible to new worker processes too
    const cat = await second.spawn("cat", ["/proj/sdk.txt"]);
    expect((await cat.completion).stdout).toContain("from the sdk");
    await second.teardown();
  }, 60_000);

  it("a boot right after an un-awaited teardown waits for its final save", async () => {
    const store = createMemoryWorkspaceStore();
    const first = await boot(store);
    await first.fs.writeFile("/proj/last.txt", "written right before teardown");
    void first.teardown();

    const second = await boot(store);
    expect(await second.fs.readFile("/proj/last.txt", "utf8")).toBe("written right before teardown");
  }, 60_000);

  it("a second pod on the same workspace is refused while the first is open", async () => {
    const store = createMemoryWorkspaceStore();
    await boot(store);
    await expect(boot(store)).rejects.toMatchObject({ code: "EWORKSPACELOCKED" });
  }, 60_000);

  it("seed: always writes files over the restored state", async () => {
    const store = createMemoryWorkspaceStore();
    const first = await boot(store, { files: { "/proj/a.txt": "v1" } });
    await first.teardown();

    const second = await boot(store, {
      files: { "/proj/a.txt": "v2" },
      persistence: { id: "boot-test", seed: "always" },
    });
    expect(await second.fs.readFile("/proj/a.txt", "utf8")).toBe("v2");
    await second.teardown();
  }, 60_000);

  it("uses the host's filesystem store by default on Node", async () => {
    const first = await boot(undefined, { persistence: { id: "fs-default" } });
    await first.fs.writeFile("/proj/disk.txt", "on disk");
    await first.teardown();

    const second = await boot(undefined, { persistence: { id: "fs-default" } });
    expect(await second.fs.readFile("/proj/disk.txt", "utf8")).toBe("on disk");
    await second.persistence!.clear();
    await second.teardown();
  }, 60_000);

  it("restore() of a snapshot that can't load leaves the filesystem alone", async () => {
    const pod = await boot(createMemoryWorkspaceStore());
    await pod.fs.writeFile("/proj/keep.txt", "still here");
    await expect(
      pod.restore({ entries: [{ path: "/a", kind: "file" }, { path: "/a/b", kind: "file" }] }),
    ).rejects.toThrow();
    expect(await pod.fs.readFile("/proj/keep.txt", "utf8")).toBe("still here");
  }, 60_000);

  it("the default Node store keeps any workspace id inside its directory", async () => {
    const pod = await boot(undefined, { persistence: { id: ".." } });
    await pod.fs.writeFile("/proj/x.txt", "x");
    await pod.persistence!.flush();
    const { readdirSync } = await import("node:fs");
    const dirs = readdirSync(join(tempDir, "cache", "workspaces"));
    expect(dirs.every((d) => /^[0-9a-f]{32}$/.test(d))).toBe(true);
    await pod.persistence!.clear();
    expect(readdirSync(join(tempDir, "cache")).length).toBeGreaterThan(0);
  }, 60_000);

  it("restore() replaces the tree through normal events and keeps it saved", async () => {
    const store = createMemoryWorkspaceStore();
    const pod = await boot(store);
    await pod.fs.writeFile("/proj/before.txt", "before");
    const snapshot = pod.snapshot();
    await pod.fs.writeFile("/proj/after.txt", "after");

    await pod.restore(snapshot, { autoInstall: false });
    expect(await pod.fs.exists("/proj/after.txt")).toBe(false);
    expect(await pod.fs.readFile("/proj/before.txt", "utf8")).toBe("before");

    // a worker spawned now sees the restored tree
    const ls = await pod.spawn("ls", ["/proj"]);
    const out = (await ls.completion).stdout;
    expect(out).toContain("before.txt");
    expect(out).not.toContain("after.txt");
    await pod.teardown();

    const again = await boot(store);
    expect(await again.fs.exists("/proj/after.txt")).toBe(false);
    await again.teardown();
  }, 60_000);
});
