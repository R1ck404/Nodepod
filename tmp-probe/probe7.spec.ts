import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("downloads and fetch injection", async ({ page }) => {
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto("/tmp-probe/probe7.html");
  await expect(page.locator("#status")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  const url = (await page.locator("#status").textContent())!;
  console.log("preview url", url);
  const frame = page.frameLocator("#preview");
  await expect(frame.getByRole("heading", { name: "index" })).toBeVisible({ timeout: 30_000 });
  const iframe = page.frames().find((f) => f !== page.mainFrame())!;
  const info = await iframe.evaluate(async () => {
    const r = await fetch("/api/unregistered");
    const body = await r.text();
    return {
      docPatched: !!(window as any).__nodepodLocPatch,
      status: r.status,
      hasShim: body.includes("__nodepodNavTiming") || body.includes("__nodepodLocPatch"),
      bodyStart: body.slice(0, 60),
      href: location.href,
    };
  });
  console.log(JSON.stringify(info));
  expect(info.docPatched).toBe(true);
  expect(info.hasShim).toBe(false);

  const dl1 = page.waitForEvent("download", { timeout: 15_000 });
  await frame.locator("#dl").click();
  const d1 = await dl1;
  const p1 = await d1.path();
  const c1 = readFileSync(p1!, "utf8");
  console.log("anchor download:", d1.url(), JSON.stringify(c1));
  expect(c1).toBe("a,b\n1,2\n");

  const dl2 = page.waitForEvent("download", { timeout: 15_000 });
  await frame.locator("#prog").click();
  const d2 = await dl2;
  const c2 = readFileSync((await d2.path())!, "utf8");
  console.log("programmatic download:", d2.url(), JSON.stringify(c2));
  expect(c2).toBe("a,b\n1,2\n");

  const dl3 = page.waitForEvent("download", { timeout: 15_000 });
  await page.locator("#hostdl").click();
  const d3 = await dl3;
  const c3 = readFileSync((await d3.path())!, "utf8");
  console.log("host download:", d3.url(), JSON.stringify(c3));
  expect(c3.trim()).toBe("host file");
});
