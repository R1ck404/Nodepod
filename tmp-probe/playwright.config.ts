import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  reporter: [["line"]],
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    baseURL: "http://localhost:3333",
    serviceWorkers: "allow",
  },
  webServer: {
    command: "node examples/serve.js",
    cwd: "..",
    url: "http://localhost:3333/tests/browser/clean-preview.html",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
