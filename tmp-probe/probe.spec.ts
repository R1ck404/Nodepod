import { test, expect } from "@playwright/test";

test("probe", async ({ page }) => {
  page.on("console", (m) => console.log("[page]", m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto("/tmp-probe/probe9.html");
  await page.waitForFunction(() => (window as any).__done === true, null, { timeout: 80_000 });
  const results = await page.evaluate(() => (window as any).__results);
  console.log(JSON.stringify(results, null, 2));
});
