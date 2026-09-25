import { expect, test } from "@playwright/test";

// Every `npm create vite` template, plus SvelteKit through sv, each in a pod
// of its own and all at once in one tab (examples/create-vite-all): create,
// `npm install`, `npm run dev`, then the page, its entry modules and their
// pre-bundled dependencies are fetched through the dev server.
// Needs network access to the npm registry.

interface CaseResult {
  status: "PASS" | "FAIL" | "STUCK";
  step?: string;
  error?: string;
  tail?: string;
}

test("every create-vite template installs and serves its app", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/examples/create-vite-all/index.html");
  await page.waitForFunction(
    () => (window as unknown as { __createVite?: { done: boolean } }).__createVite?.done === true,
    undefined,
    { timeout: 540_000, polling: 1000 },
  );
  const results = await page.evaluate(
    () => (window as unknown as { __createVite: { results: Record<string, CaseResult> } }).__createVite.results,
  );
  const failed = Object.entries(results)
    .filter(([, r]) => r.status !== "PASS")
    .map(([name, r]) => `${name}: ${r.status} at ${r.step}: ${r.error}\n${r.tail ?? ""}`);
  expect(failed, failed.join("\n\n")).toEqual([]);
  expect(Object.keys(results)).toHaveLength(21);
});
