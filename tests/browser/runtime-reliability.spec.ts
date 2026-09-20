import { expect, test, type Frame, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Regression coverage for the embedded-integration reliability fixes
// (fetch/Response bodies inside commands, kill() settling, `node -e`
// resolution, fetch()-response shim injection, anchor downloads through the
// service worker, and host-path routing claims). Each test boots a real pod
// in Chromium via the harness pages next to this spec.

interface RunRecord {
  stdout: string;
  stderr?: string;
  exitCode?: number;
  timedOut: boolean;
  kill: { settled: boolean; exitCode?: number; ms?: number } | null;
  ms: number;
}

async function runtimeResults(page: Page): Promise<Record<string, RunRecord>> {
  await page.goto("/tests/browser/runtime-reliability.html");
  await expect(page.locator("#status")).toHaveAttribute("data-done", "true", {
    timeout: 90_000,
  });
  return page.evaluate(() => (window as unknown as { __results: Record<string, RunRecord> }).__results);
}

function expectClean(rec: RunRecord): void {
  expect(rec.timedOut, JSON.stringify(rec)).toBe(false);
  expect(rec.exitCode, JSON.stringify(rec)).toBe(0);
  expect(rec.stderr ?? "").toBe("");
}

test.describe("runtime", () => {
  test("commands read fetch/Response bodies, exit cleanly, and kill() always settles", async ({
    page,
  }) => {
    const results = await runtimeResults(page);

    // A: body reads settle while a top-level await is the only thing pending.
    expectClean(results.bodies);
    expect(results.bodies.stdout).toBe(
      [
        'request {"a":1}',
        'response {"b":2}',
        "text hi",
        "blob blob-text",
        "reader false rd",
        "status 200",
        'body {"ok":true,"url":"/api/probe"}',
        "",
      ].join("\n"),
    );
    expectClean(results["fetch-then-chain"]);
    expect(results["fetch-then-chain"].stdout).toBe("got chain\n");
    expectClean(results["blob-then-chain"]);
    expect(results["blob-then-chain"].stdout).toBe("got b\n");

    // A: kill() terminates idle, busy and body-blocked workers.
    for (const name of ["kill-interval", "kill-busy-loop", "kill-pending-body"]) {
      const rec = results[name];
      expect(rec.timedOut, name).toBe(true);
      expect(rec.kill?.settled, `${name}: ${JSON.stringify(rec)}`).toBe(true);
      expect(rec.kill?.ms, name).toBeLessThan(3_000);
    }
    expect(results["kill-interval"].stdout).toBe("started\n");
    expect(results["kill-busy-loop"].stdout).toBe("busy\n");
    expect(results["kill-pending-body"].stdout).toBe("x\n");

    // macrotask-resolved top-level awaits do not hang the exit path.
    expectClean(results["tla-immediate"]);
    expect(results["tla-immediate"].stdout).toBe("got imm\n");
    expectClean(results["tla-messageport-close"]);
    expect(results["tla-messageport-close"].stdout).toBe("got x\n");

    // E: `node -e` resolves relative specifiers from the cwd.
    expectClean(results["eval-import-relative"]);
    expect(results["eval-import-relative"].stdout).toBe("lib-ok\n");
    expectClean(results["eval-require-relative"]);
    expect(results["eval-require-relative"].stdout).toBe("lib-ok\n");

    // shell: `node -e "console.log('...')"` keeps its single quotes.
    expectClean(results["shell-nested-quotes"]);
    expect(results["shell-nested-quotes"].stdout).toBe("quoted 2\n");

    // fatal errors exit 1 and stop the process; a listener keeps it alive.
    for (const [name, text] of [
      ["unhandled-rejection", "Unhandled rejection: boom"],
      ["uncaught-exception", "kaboom"],
    ] as const) {
      const rec = results[name];
      expect(rec.timedOut, name).toBe(false);
      expect(rec.exitCode, name).toBe(1);
      expect(rec.stderr, name).toContain(text);
      expect(rec.stdout, name).not.toContain("still alive");
    }
    expectClean(results["handled-rejection"]);
    expect(results["handled-rejection"].stdout).toBe("handled soft\n");
  });
});

async function previewFrame(page: Page): Promise<Frame> {
  await expect(page.locator("#status")).toHaveAttribute("data-ready", "true", {
    timeout: 30_000,
  });
  const frame = page.frameLocator("#preview");
  await expect(frame.getByRole("heading", { name: "index" })).toBeVisible({
    timeout: 30_000,
  });
  return page.frames().find((f) => f !== page.mainFrame())!;
}

async function downloadText(page: Page, trigger: () => Promise<void>): Promise<string> {
  const download = page.waitForEvent("download", { timeout: 15_000 });
  await trigger();
  const path = await (await download).path();
  return readFileSync(path!, "utf8");
}

for (const mode of ["hostname", "virtual"] as const) {
  test.describe(`preview (${mode} mode)`, () => {
    const url =
      mode === "virtual"
        ? "/tests/browser/preview-downloads.html?mode=virtual"
        : "/tests/browser/preview-downloads.html";

    test("fetch() responses are not decorated with the document shims", async ({ page }) => {
      await page.goto(url);
      const frame = await previewFrame(page);

      // C: the document itself is patched, an app fetch() hitting the SPA
      // fallback gets the raw server HTML.
      const info = await frame.evaluate(async () => {
        const r = await fetch("/api/unregistered");
        const body = await r.text();
        return {
          docPatched: !!(window as unknown as { __nodepodLocPatch?: unknown }).__nodepodLocPatch,
          status: r.status,
          hasShim: body.includes("__nodepodNavTiming") || body.includes("__nodepodLocPatch"),
          bodyStart: body.slice(0, 15),
        };
      });
      expect(info.docPatched).toBe(true);
      expect(info.status).toBe(200);
      expect(info.hasShim).toBe(false);
      expect(info.bodyStart).toBe("<!doctype html>");
    });

    test("anchor downloads carry the pod response; host downloads stay on the host", async ({
      page,
    }) => {
      await page.goto(url);
      await previewFrame(page);
      const frame = page.frameLocator("#preview");

      // D: Chrome skips service workers for anchor downloads, so the page
      // script streams same-origin downloads itself.
      expect(await downloadText(page, () => frame.locator("#dl").click())).toBe("a,b\n1,2\n");
      expect(await downloadText(page, () => frame.locator("#prog").click())).toBe("a,b\n1,2\n");
      expect(
        (await downloadText(page, () => page.locator("#host-download").click())).trim(),
      ).toBe("host file");
    });
  });
}

async function hostFrameResult(page: Page): Promise<{ text: string; fetched: string }> {
  await page.evaluate(() => {
    const f = document.querySelector("#hostframe") as HTMLIFrameElement;
    f.src = "/tests/browser/host-frame.html?t=" + Date.now();
  });
  const frame = page.frameLocator("#hostframe");
  const heading = frame.locator("#hf");
  let text = "";
  try {
    await heading.waitFor({ state: "visible", timeout: 8_000 });
    text = (await heading.textContent()) ?? "";
  } catch {
    const content = await page
      .frames()
      .find((f) => f.url().includes("host-frame"))
      ?.content();
    text = "NO HEADING: " + (content ?? "").slice(0, 200);
  }
  let fetched = "";
  try {
    await frame.locator("body[data-fetched]").waitFor({ timeout: 8_000 });
    fetched = (await frame.locator("body").getAttribute("data-fetched")) ?? "";
  } catch {
    fetched = "NO FETCH RESULT";
  }
  return { text, fetched };
}

test.describe("host routing", () => {
  test("a released pod's route claim no longer captures host pages", async ({ page }) => {
    await page.goto("/tests/browser/host-routing.html");
    await expect(page.locator("#status")).toHaveAttribute("data-ready", "true", {
      timeout: 30_000,
    });
    const frame = page.frameLocator("#preview");
    await expect(frame.getByRole("heading", { name: "pod app" })).toBeVisible({
      timeout: 30_000,
    });

    // G: teardown releases the instance; the SW forgets its claims.
    await page.evaluate(() => (window as unknown as { disposeFirst: () => Promise<void> }).disposeFirst());
    expect(await hostFrameResult(page)).toEqual({ text: "host frame ok", fetched: "host file" });

    // a second runtime can still boot and preview afterwards.
    const secondUrl = await page.evaluate(() =>
      (window as unknown as { bootSecond: () => Promise<string> }).bootSecond(),
    );
    await page.evaluate((u) => {
      (document.querySelector("#preview") as HTMLIFrameElement).src = u;
    }, secondUrl);
    await expect(frame.getByRole("heading", { name: "pod app" })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("reservedHostPaths keep host pages out of a live pod's claim", async ({ page }) => {
    await page.goto("/tests/browser/host-routing.html?reserve=1");
    await expect(page.locator("#status")).toHaveAttribute("data-ready", "true", {
      timeout: 30_000,
    });
    const frame = page.frameLocator("#preview");
    await expect(frame.getByRole("heading", { name: "pod app" })).toBeVisible({
      timeout: 30_000,
    });

    expect(await hostFrameResult(page)).toEqual({ text: "host frame ok", fetched: "host file" });
  });
});
