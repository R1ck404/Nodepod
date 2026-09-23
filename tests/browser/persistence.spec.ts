import { expect, test, type Page } from "@playwright/test";

// Workspace persistence in a real browser: IndexedDB store, restore across
// a page reload, and the cross-tab Web Lock.

type SDK = typeof import("../../src/index");

async function openHarness(page: Page): Promise<void> {
  await page.goto("/tests/browser/persistence.html");
  await expect(page.locator("#status")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
}

function uniqueId(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test.describe("workspace persistence", () => {
  test("restores the workspace after a reload", async ({ page }) => {
    const id = uniqueId("reload");
    await openHarness(page);

    await page.evaluate(async (id) => {
      const { Nodepod } = (window as unknown as { __nodepod: SDK }).__nodepod;
      const pod = await Nodepod.boot({
        serviceWorker: false,
        watermark: false,
        workdir: "/app",
        persistence: { id },
        files: { "/app/seed.txt": "seed" },
      });
      await pod.fs.writeFile("/app/sdk.txt", "from the sdk");
      await pod.fs.writeFile("/app/node_modules/dep/index.js", "not saved");
      const child = await pod.spawn("sh", ["-c", "echo from-a-worker > /app/worker.txt && chmod 600 /app/worker.txt"], {
        cwd: "/app",
      });
      await child.completion;
      await pod.persistence!.flush();
    }, id);

    await page.reload();
    await expect(page.locator("#status")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });

    const restored = await page.evaluate(async (id) => {
      const { Nodepod, listIndexedDBWorkspaces } = (window as unknown as { __nodepod: SDK }).__nodepod;
      const pod = await Nodepod.boot({
        serviceWorker: false,
        watermark: false,
        workdir: "/app",
        persistence: { id },
        files: { "/app/seed.txt": "a different seed" },
      });
      const cat = await pod.spawn("cat", ["/app/worker.txt"]);
      const result = {
        seed: await pod.fs.readFile("/app/seed.txt", "utf8"),
        sdk: await pod.fs.readFile("/app/sdk.txt", "utf8"),
        worker: (await cat.completion).stdout.trim(),
        workerMode: pod.volume.statSync("/app/worker.txt").mode & 0o777,
        nodeModules: await pod.fs.exists("/app/node_modules"),
        listed: (await listIndexedDBWorkspaces()).some((w) => w.id === id),
      };
      await pod.persistence!.clear();
      await pod.teardown();
      return result;
    }, id);

    expect(restored).toEqual({
      seed: "seed",
      sdk: "from the sdk",
      worker: "from-a-worker",
      workerMode: 0o600,
      nodeModules: false,
      listed: true,
    });
  });

  test("only one tab holds a workspace", async ({ context }) => {
    const id = uniqueId("lock");
    const first = await context.newPage();
    const second = await context.newPage();
    await openHarness(first);
    await openHarness(second);

    await first.evaluate(async (id) => {
      const { Nodepod } = (window as unknown as { __nodepod: SDK }).__nodepod;
      const pod = await Nodepod.boot({ serviceWorker: false, watermark: false, persistence: { id } });
      const win = window as unknown as { __errors: string[] };
      win.__errors = [];
      pod.persistence!.on("error", (e: { code?: string }) => win.__errors.push(e.code ?? "?"));
    }, id);

    const refused = await second.evaluate(async (id) => {
      const { Nodepod } = (window as unknown as { __nodepod: SDK }).__nodepod;
      try {
        await Nodepod.boot({ serviceWorker: false, watermark: false, persistence: { id } });
        return "booted";
      } catch (e) {
        return (e as { code?: string }).code;
      }
    }, id);
    expect(refused).toBe("EWORKSPACELOCKED");

    const stolen = await second.evaluate(async (id) => {
      const { Nodepod } = (window as unknown as { __nodepod: SDK }).__nodepod;
      const pod = await Nodepod.boot({
        serviceWorker: false,
        watermark: false,
        persistence: { id, lock: "steal" },
      });
      const status = pod.persistence!.status;
      await pod.persistence!.clear();
      return status;
    }, id);
    expect(stolen).not.toBe("closed");

    await expect
      .poll(() => first.evaluate(() => (window as unknown as { __errors: string[] }).__errors))
      .toEqual(["EWORKSPACELOCKLOST"]);
  });
});
