import { test, expect } from "@playwright/test";

async function hostFrameResult(page: any) {
  await page.evaluate(() => {
    const f = document.querySelector("#hostframe") as HTMLIFrameElement;
    f.src = "/tmp-probe/host-frame.html?t=" + Date.now();
  });
  const frame = page.frameLocator("#hostframe");
  const heading = frame.locator("#hf");
  let text = "";
  try {
    await heading.waitFor({ state: "visible", timeout: 8000 });
    text = (await heading.textContent()) ?? "";
  } catch {
    text = "NO HEADING: " + ((await page.frames().find((f: any) => f.url().includes("host-frame"))?.content()) ?? "").slice(0, 200);
  }
  let fetched = "";
  try {
    await frame.locator("body[data-fetched]").waitFor({ timeout: 8000 });
    fetched = (await frame.locator("body").getAttribute("data-fetched")) ?? "";
  } catch {
    fetched = "NO FETCH RESULT";
  }
  return { text, fetched };
}

test("host iframe survives a released pod's stale claim", async ({ page }) => {
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto("/tmp-probe/probe8.html");
  await expect(page.locator("#status")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  const frame = page.frameLocator("#preview");
  await expect(frame.getByRole("heading", { name: "pod app" })).toBeVisible({ timeout: 30_000 });

  await page.evaluate(() => (window as any).disposeFirst());
  const r = await hostFrameResult(page);
  console.log("after dispose:", JSON.stringify(r));
  expect(r.text).toBe("host frame ok");
  expect(r.fetched).toBe("host file");

  // a second live runtime can boot and preview afterwards
  const url2 = await page.evaluate(() => (window as any).bootSecond());
  await page.evaluate((u) => { (document.querySelector("#preview") as HTMLIFrameElement).src = u; }, url2);
  await expect(frame.getByRole("heading", { name: "pod app" })).toBeVisible({ timeout: 30_000 });
});

test("reserved host paths are never captured by a live pod's claim", async ({ page }) => {
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto("/tmp-probe/probe8.html?reserve=1");
  await expect(page.locator("#status")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  const frame = page.frameLocator("#preview");
  await expect(frame.getByRole("heading", { name: "pod app" })).toBeVisible({ timeout: 30_000 });

  const r = await hostFrameResult(page);
  console.log("live pod + reserved:", JSON.stringify(r));
  expect(r.text).toBe("host frame ok");
  expect(r.fetched).toBe("host file");
});

test("without reservation a live claim captures the host iframe (documents the need)", async ({ page }) => {
  await page.goto("/tmp-probe/probe8.html");
  await expect(page.locator("#status")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  const frame = page.frameLocator("#preview");
  await expect(frame.getByRole("heading", { name: "pod app" })).toBeVisible({ timeout: 30_000 });
  const r = await hostFrameResult(page);
  console.log("live pod, no reservation:", JSON.stringify(r));
});
