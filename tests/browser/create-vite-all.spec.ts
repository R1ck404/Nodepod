import { expect, test } from "@playwright/test";

// Every `npm create vite` template, plus SvelteKit through sv, each in a pod
// of its own, in bounded batches (examples/create-vite-all): create,
// `npm install`, `npm run dev`, then the page, its entry modules and their
// pre-bundled dependencies are fetched through the dev server.
// Needs network access to the npm registry.

interface CaseResult {
  status: "PASS" | "FAIL" | "STUCK";
  step?: string;
  error?: string;
  tail?: string;
}

test("every create-vite template installs and serves its app", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  // WASM-backed tools reserve address space per realm, even for small heaps.
  // Cover all templates without retaining 21 live dev servers in one renderer.
  await page.goto("/examples/create-vite-all/index.html?concurrency=3&teardown=1");
  try {
    await page.waitForFunction(
      () => (window as unknown as { __createVite?: { done: boolean } }).__createVite?.done === true,
      undefined,
      { timeout: 540_000, polling: 1000 },
    );
  } finally {
    await testInfo.attach("create-vite-diagnostics.json", {
      body: JSON.stringify(await page.evaluate(() => ({
        state: (window as unknown as { __createVite: unknown }).__createVite,
        cards: Array.from(document.querySelectorAll(".card"), card => card.textContent),
      })), null, 2),
      contentType: "application/json",
    });
  }
  const results = await page.evaluate(
    () => (window as unknown as { __createVite: { results: Record<string, CaseResult> } }).__createVite.results,
  );
  const failed = Object.entries(results)
    .filter(([, r]) => r.status !== "PASS")
    .map(([name, r]) => `${name}: ${r.status} at ${r.step}: ${r.error}\n${r.tail ?? ""}`);
  expect(failed, failed.join("\n\n")).toEqual([]);
  expect(Object.keys(results)).toHaveLength(21);
});
