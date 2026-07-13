import { expect, test, type Page } from "@playwright/test";

interface PerfResult {
  phases: Record<string, number>;
  runtime: {
    timings: Record<string, { count: number; totalMs: number; lastMs: number }>;
    counters: Record<string, number>;
  };
  memory: { heap: { usedMB: number } | null };
  previewLoaded: boolean;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function runScelar(page: Page): Promise<PerfResult> {
  await page.goto("/examples/scelar-auth-template/");
  await page.getByRole("button", { name: "Boot + install + start" }).click();
  await expect(page.locator("#status")).toContainText(/Live|Error/, { timeout: 210_000 });
  const status = await page.locator("#status").textContent();
  if (status?.includes("Error")) {
    const detail = await page.evaluate(() => ({
      error: (window as any).__nodepodPerfError,
      output: document.querySelector("#output")?.textContent,
    }));
    throw new Error(`Scelar startup failed: ${detail.error ?? "unknown error"}\n${detail.output ?? ""}`);
  }
  await page.waitForFunction(() => Boolean((window as any).__nodepodPerfResult));
  return page.evaluate(() => (window as any).__nodepodPerfResult);
}

test("records cold and warm Scelar startup phases", async ({ browser }, testInfo) => {
  const runs: Array<{ cold: PerfResult; warm: PerfResult }> = [];
  const runCount = Number(process.env.NODEPOD_PERF_RUNS ?? 5);
  for (let index = 0; index < runCount; index++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cold = await runScelar(page);
    expect(cold.phases.bootMs).toBeGreaterThanOrEqual(0);
    expect(cold.phases.installMs).toBeGreaterThan(0);
    expect(cold.phases.viteReadyMs).toBeGreaterThan(0);
    expect(cold.runtime.timings["boot.total"]?.lastMs).toBeGreaterThanOrEqual(0);

    await page.reload();
    const warm = await runScelar(page);
    expect(warm.phases.installMs).toBeGreaterThan(0);
    expect(warm.memory.heap?.usedMB ?? 0).toBeLessThan(450);
    runs.push({ cold, warm });
    await context.close();
  }

  await testInfo.attach("scelar-performance.json", {
    body: JSON.stringify({
      browser: testInfo.project.name,
      fixture: "scelar-auth-template",
      runs,
    }, null, 2),
    contentType: "application/json",
  });
  const summary = {
    coldInstall: {
      medianMs: percentile(runs.map((run) => run.cold.phases.installMs), 0.5),
      p95Ms: percentile(runs.map((run) => run.cold.phases.installMs), 0.95),
    },
    warmInstall: {
      medianMs: percentile(runs.map((run) => run.warm.phases.installMs), 0.5),
      p95Ms: percentile(runs.map((run) => run.warm.phases.installMs), 0.95),
    },
    viteReady: {
      medianMs: percentile(runs.map((run) => run.warm.phases.viteReadyMs), 0.5),
      p95Ms: percentile(runs.map((run) => run.warm.phases.viteReadyMs), 0.95),
    },
    processReady: {
      coldMedianMs: percentile(runs.map((run) => run.cold.runtime.timings["process.ready"]?.totalMs ?? 0), 0.5),
      warmMedianMs: percentile(runs.map((run) => run.warm.runtime.timings["process.ready"]?.totalMs ?? 0), 0.5),
    },
  };
  console.log(`Scelar performance: ${JSON.stringify(summary)}`);
});
