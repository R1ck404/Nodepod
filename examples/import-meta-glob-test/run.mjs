// Headless runner for examples/import-meta-glob-test
import { chromium } from "@playwright/test";

const url = process.env.EXAMPLE_URL || "http://127.0.0.1:3333/examples/import-meta-glob-test/";
const timeoutMs = Number(process.env.TEST_TIMEOUT_MS || 300_000);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on("console", (msg) => {
  console.log(`[browser:${msg.type()}] ${msg.text()}`);
});
page.on("pageerror", (err) => {
  console.log(`[pageerror] ${err.message}`);
});

console.log(`Navigating to ${url}`);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

console.log("Waiting for window.__globTestDone ...");
const result = await page.waitForFunction(
  () => window.__globTestDone || null,
  null,
  { timeout: timeoutMs },
).then((h) => h.jsonValue());

const status = await page.locator("#status").innerText();
const output = await page.locator("#output").innerText();

console.log("\n===== OUTPUT =====\n" + output.slice(-8000));
console.log("\n===== STATUS =====\n" + status);
console.log("\n===== RESULT =====\n" + JSON.stringify(result, null, 2));

await browser.close();

if (!result?.ok) {
  process.exit(1);
}
