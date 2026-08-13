import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  // The suite drives one app container with one shared database, so tests must
  // not run concurrently.
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [["list"]],
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results",
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:8000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
