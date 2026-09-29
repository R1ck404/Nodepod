import { expect, test } from "@playwright/test";

test("landing page presents the product and copies the install command", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("./");

  await expect(page.getByText("Browser-native Node.js runtime", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Node.js, inside the browser.");
  await expect(page.getByText("Filesystem, shell, npm packages, and HTTP servers. No backend required.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/Nodepod/docs/");

  await page.getByRole("button", { name: "Copy install command" }).click();
  await expect(page.getByRole("button", { name: "Copy install command" })).toHaveText("Copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("npm install @r1ck404/nodepod");
});

test("landing page supports system light, dark, and reduced-motion modes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.goto("./");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light dark");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(11, 11, 12)");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const duration = await page.locator(".wordmark span").first().evaluate((element) => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.001);
});

test("primary navigation reaches critical documentation routes", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("link", { name: "Docs", exact: true }).click();
  await expect(page).toHaveURL(/\/Nodepod\/docs\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Nodepod documentation");

  for (const route of [
    "docs/getting-started/first-program/",
    "docs/concepts/security/",
    "docs/reference/sdk/",
    "docs/reference/api/",
    "docs/troubleshooting/",
  ]) {
    const response = await page.goto(route);
    expect(response?.ok(), route).toBeTruthy();
    await expect(page.locator("main")).toBeVisible();
  }
});

test("documentation search opens in the production build", async ({ page }) => {
  await page.goto("./docs/");
  const search = page.getByRole("button", { name: /search/i }).first();
  await expect(search).toBeVisible();
  await search.click();
  await expect(page.locator("dialog, [role=dialog]").first()).toBeVisible();
});

test("sponsor page links to GitHub Sponsors and lists the tiers", async ({ page }) => {
  await page.goto("./sponsors/");
  await expect(page.getByText(/profile is under review/i)).toHaveCount(0);
  await expect(page.getByText("$5", { exact: true })).toBeVisible();
  await expect(page.getByText("$25", { exact: true })).toBeVisible();
  await expect(page.getByText("$100", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /sponsor on github/i })).toHaveAttribute(
    "href",
    "https://github.com/sponsors/R1ck404",
  );
});
