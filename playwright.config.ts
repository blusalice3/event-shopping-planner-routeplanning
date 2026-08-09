import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "./artifacts/playwright",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [
        ["line"],
        [
          "html",
          { open: "never", outputFolder: "artifacts/playwright-report" },
        ],
      ]
    : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    serviceWorkers: "allow",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  webServer:
    process.env.PLAYWRIGHT_BASE_URL === undefined
      ? {
          command:
            "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173",
          url: baseURL,
          reuseExistingServer: false,
          timeout: 30_000,
        }
      : undefined,
});
