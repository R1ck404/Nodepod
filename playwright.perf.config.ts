import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/performance",
  timeout: 240_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["line"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3333",
    serviceWorkers: "allow",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec vite --config vite.perf.config.ts",
    url: "http://127.0.0.1:3333/examples/scelar-auth-template/",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
