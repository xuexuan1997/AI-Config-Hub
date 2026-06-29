import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const packageSource = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@ai-config-hub/api/browser",
        replacement: fileURLToPath(new URL("./packages/api/src/browser.ts", import.meta.url)),
      },
      { find: "@ai-config-hub/adapters", replacement: packageSource("adapters") },
      { find: "@ai-config-hub/api", replacement: packageSource("api") },
      { find: "@ai-config-hub/asset-library", replacement: packageSource("asset-library") },
      { find: "@ai-config-hub/core", replacement: packageSource("core") },
      { find: "@ai-config-hub/deployer", replacement: packageSource("deployer") },
      { find: "@ai-config-hub/git", replacement: packageSource("git") },
      { find: "@ai-config-hub/local-api", replacement: packageSource("local-api") },
      { find: "@ai-config-hub/scanner", replacement: packageSource("scanner") },
      { find: "@ai-config-hub/shared", replacement: packageSource("shared") },
      { find: "@ai-config-hub/storage", replacement: packageSource("storage") },
    ],
  },
  test: {
    globalSetup: ["./packages/deployer/scripts/vitest-native-setup.mjs"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.worktrees/**",
      "tests/integration/**",
      "tests/e2e/**",
    ],
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
