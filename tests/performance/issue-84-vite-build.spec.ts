import { expect, test } from "@playwright/test";

// https://github.com/R1ck404/Nodepod/issues/84 — `vite build` exited 0 after
// the banner without writing dist/: the rollup polyfill's CDN import and wasm
// work held no event-loop handle, so the process drained mid-build.
test("vite build writes dist/ instead of exiting early (issue #84)", async ({ page }, testInfo) => {
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

  await page.goto("/examples/issue-84-vite-build/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await expect(page.locator("#status")).toHaveText(/^(PASS|FAIL)/, { timeout: 180_000 });

  const result = await page.evaluate(() => (window as Window & {
    __issue84?: {
      pass: boolean;
      reason: string;
      results: Record<string, { exitCode: number; stdout: string } | string[]>;
    };
  }).__issue84);

  await testInfo.attach("issue-84-result.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });

  expect(result?.reason).toBeDefined();
  expect(result?.pass, result?.reason).toBe(true);
  const build = result!.results.build as { exitCode: number; stdout: string };
  expect(build.exitCode).toBe(0);
  // stdout carries vite's ANSI colours, so match the text only
  expect(build.stdout).toMatch(/\d+ modules transformed/);
  expect(build.stdout).toMatch(/built in/);
  expect(result!.results.distAfterNpm).toContain("/home/dist/index.html");
  expect(result!.results.distAfterProgrammatic).toContain("/home/dist/index.html");
});
