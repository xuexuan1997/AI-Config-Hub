import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/playwright",
  reporter: [["html", { outputFolder: "playwright-report", open: "never" }], ["list"]],
  retries: process.env["CI"] === undefined ? 0 : 2,
  ...(process.env["CI"] === undefined ? {} : { workers: 1 }),
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
