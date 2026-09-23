import { expect, test, type Page } from "@playwright/test";

// End-to-end: a real Vite project in a persisted workspace with package
// eviction on. Installs from the terminal (network), runs the dev server,
// edits a file, reloads the page, and checks the edit, the dependencies and
// the dev server all come back. Needs network access to the npm registry.

type SDK = typeof import("../../src/index");

test.setTimeout(300_000);

async function openHarness(page: Page): Promise<void> {
  await page.goto("/tests/browser/persistence.html");
  await expect(page.locator("#status")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
}

const files = {
  "/app/package.json": JSON.stringify({
    name: "persist-vite",
    private: true,
    type: "module",
    scripts: { dev: "vite --port 5173 --strictPort" },
    devDependencies: { vite: "8.0.10" },
  }),
  "/app/index.html": '<!doctype html><html><body><h1 id="t"></h1><script type="module" src="/src/main.js"></script></body></html>',
  "/app/src/main.js": 'document.querySelector("#t").textContent = "original heading";\n',
};

test("a Vite workspace survives reloads with package eviction on", async ({ page }) => {
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  const id = `vite-${Date.now()}`;
  await openHarness(page);
  // Vite 8 (rolldown) and package eviction both need cross-origin isolation
  test.skip(!(await page.evaluate(() => crossOriginIsolated)), "needs cross-origin isolation");

  const first = await page.evaluate(async ({ id, files }) => {
    const { Nodepod } = (window as unknown as { __nodepod: SDK }).__nodepod;
    const pod = await Nodepod.boot({
      serviceWorker: false,
      watermark: false,
      workdir: "/app",
      allowedFetchDomains: null,
      persistence: { id },
      memory: { evictPackageContent: true },
      files,
    });
    const run = async (cmd: string, args: string[]) => {
      const p = await pod.spawn(cmd, args, { cwd: "/app" });
      return p.completion;
    };
    const install = await run("npm", ["install"]);

    const dev = await pod.spawn("npm", ["run", "dev"], { cwd: "/app" });
    let devOut = "";
    dev.on("output", (t: string) => { devOut += t; });
    dev.on("error", (t: string) => { devOut += t; });
    let index = { statusCode: 0, body: "" };
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const res = await pod.request(5173, { path: "/" });
        if (res.statusCode === 200) {
          index = { statusCode: res.statusCode, body: String(res.body) };
          break;
        }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    const main = await pod.request(5173, { path: "/src/main.js" });

    // edit through the SDK and from a worker, then check vite serves it
    await pod.fs.writeFile("/app/src/main.js", 'document.querySelector("#t").textContent = "edited heading";\n');
    await run("sh", ["-c", "echo 'export const fromShell = 1;' > /app/src/shell.js && chmod 600 /app/src/shell.js"]);
    await new Promise((r) => setTimeout(r, 500));
    const edited = await pod.request(5173, { path: "/src/main.js" });

    dev.kill();
    await pod.persistence!.flush();
    const stats = pod.memoryStats().vfs;
    await pod.teardown();
    return {
      installExit: install.exitCode,
      installErr: install.stderr.slice(-500),
      indexStatus: index.statusCode,
      mainStatus: main.statusCode,
      editedBody: String(edited.body),
      syncMisses: stats.pagedOutSyncMisses,
      devTail: devOut.slice(-300),
    };
  }, { id, files });

  expect(first.installExit, first.installErr).toBe(0);
  expect(first.indexStatus, first.devTail).toBe(200);
  expect(first.mainStatus).toBe(200);
  expect(first.editedBody).toContain("edited heading");
  expect(first.syncMisses).toBe(0);

  // reload twice: node_modules comes back from the pack the terminal
  // install cached, paged out, both times
  for (const round of [1, 2]) {
    await page.reload();
    await expect(page.locator("#status")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });

    const again = await page.evaluate(async ({ id, files }) => {
      const { Nodepod } = (window as unknown as { __nodepod: SDK }).__nodepod;
      const pod = await Nodepod.boot({
        serviceWorker: false,
        watermark: false,
        workdir: "/app",
        allowedFetchDomains: null,
        persistence: { id },
        memory: { evictPackageContent: true },
        files, // must not overwrite the restored edit
      });
      const afterBoot = pod.memoryStats().vfs;
      const dev = await pod.spawn("npm", ["run", "dev"], { cwd: "/app" });
      let devOut = "";
      dev.on("output", (t: string) => { devOut += t; });
      dev.on("error", (t: string) => { devOut += t; });
      let status = 0;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        try {
          const res = await pod.request(5173, { path: "/" });
          status = res.statusCode;
          if (status === 200) break;
        } catch { /* not listening yet */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      const main = await pod.request(5173, { path: "/src/main.js" });
      const shellMode = pod.volume.statSync("/app/src/shell.js").mode & 0o777;
      dev.kill();
      const stats = pod.memoryStats().vfs;
      const result = {
        pagedOutAfterBoot: afterBoot.pagedOutFiles,
        residentPackMB: Math.round(stats.residentPackBytes / 1024 / 1024),
        devStatus: status,
        mainBody: String(main.body),
        shellMode,
        syncMisses: stats.pagedOutSyncMisses,
        devTail: devOut.slice(-300),
        viteInstalled: await pod.fs.exists("/app/node_modules/vite/package.json"),
      };
      await pod.teardown();
      return result;
    }, { id, files });

    console.log(`round ${round}: ${JSON.stringify({ ...again, mainBody: undefined, devTail: undefined })}`);
    expect(again.viteInstalled).toBe(true);
    expect(again.devStatus, again.devTail).toBe(200);
    expect(again.mainBody).toContain("edited heading");
    expect(again.shellMode, `mode ${again.shellMode.toString(8)}`).toBe(0o600);
    expect(again.syncMisses).toBe(0);
    expect(again.pagedOutAfterBoot).toBeGreaterThan(100);
  }

  await page.evaluate(async (id) => {
    const { deleteIndexedDBWorkspace } = (window as unknown as { __nodepod: SDK }).__nodepod;
    await deleteIndexedDBWorkspace(id);
  }, id);
});

test("a git repository survives a reload", async ({ page }) => {
  const id = `git-${Date.now()}`;
  await openHarness(page);

  const boot = async () =>
    page.evaluate(async (id) => {
      const { Nodepod } = (window as unknown as { __nodepod: SDK }).__nodepod;
      const w = window as unknown as { __pod: Awaited<ReturnType<typeof Nodepod.boot>> };
      w.__pod = await Nodepod.boot({ serviceWorker: false, watermark: false, workdir: "/repo", persistence: { id } });
    }, id);
  const sh = (script: string) =>
    page.evaluate(async (script) => {
      const pod = (window as unknown as { __pod: { spawn: Function } }).__pod;
      const p = await pod.spawn("sh", ["-c", script], { cwd: "/repo" });
      return p.completion as Promise<{ stdout: string; stderr: string; exitCode: number }>;
    }, script);

  await boot();
  const init = await sh(
    // one commit: `git -c ...` and a second commit currently kill the page in
    // browsers (a separate, pre-existing git bug)
    "git init && git config user.name t && git config user.email t@t && " +
      "echo hello > a.txt && git add a.txt && git commit -m first && echo more >> a.txt",
  );
  expect(init.exitCode, init.stderr).toBe(0);
  await page.evaluate(async () => {
    const pod = (window as unknown as { __pod: { teardown(): Promise<void> } }).__pod;
    await pod.teardown();
  });

  await page.reload();
  await expect(page.locator("#status")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await boot();
  const log = await sh("git log --oneline && git status --porcelain && cat a.txt");
  expect(log.exitCode, log.stderr).toBe(0);
  expect(log.stdout).toContain("first");
  // the uncommitted edit is still an edit
  expect(log.stdout).toMatch(/M a\.txt/);
  expect(log.stdout).toContain("hello\nmore");
  await page.evaluate(async () => {
    const pod = (window as unknown as { __pod: { persistence: { clear(): Promise<void> }; teardown(): Promise<void> } }).__pod;
    await pod.persistence.clear();
    await pod.teardown();
  });
});
