import { expect, test } from "@playwright/test";

interface FlowResult {
  done: boolean;
  error?: string;
  errors: string[];
  checks: Record<string, unknown>;
  proof?: { text: string; stage: string };
}

test("create-next-app scaffolds, refreshes and serves a hydrated webpack production app", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await page.goto("/tests/browser/create-next-app-flow.html");
  await page.waitForFunction(
    () => (window as unknown as { __createNextFlow?: FlowResult }).__createNextFlow?.done === true,
    undefined,
    { timeout: 270_000 },
  );
  const result = await page.evaluate(() => {
    const { done, error, errors, checks, proof } = (window as unknown as { __createNextFlow: FlowResult }).__createNextFlow;
    return { done, error, errors, checks, proof };
  });
  await testInfo.attach("create-next-app-results.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(result.error).toBeUndefined();
  expect(result.errors).toEqual([]);
  for (const command of ["scaffold + install", "npm scripts", "ESLint", "TypeScript", "edited ESLint", "production build"]) {
    expect(result.checks[command], command).toBe(0);
  }
  expect(result.checks.typegenCleanExit).toBe(true);
  expect(result.checks.refreshPreservedState).toBe(true);
  for (const route of ["dev/", "dev/api/health", "production/", "production/api/health"]) {
    expect(result.checks[route], route).toMatchObject({ status: 200, correct: true });
  }
  expect(result.proof?.stage).toBe("production");
  const preview = page.frameLocator("#preview");
  await expect(preview.getByRole("button", { name: "Flow count 1", exact: true })).toBeVisible();
  await expect(preview.getByRole("heading", { name: "Flow generation 1", exact: true })).toBeVisible();
  await expect.poll(() => preview.locator("img").evaluateAll(images =>
    images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0),
  )).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("next-production.png"), fullPage: true });
});
