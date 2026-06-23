import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const packageSource = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@ai-config-hub/adapters": packageSource("adapters"),
      "@ai-config-hub/api": packageSource("api"),
      "@ai-config-hub/core": packageSource("core"),
      "@ai-config-hub/deployer": packageSource("deployer"),
      "@ai-config-hub/git": packageSource("git"),
      "@ai-config-hub/scanner": packageSource("scanner"),
      "@ai-config-hub/shared": packageSource("shared"),
      "@ai-config-hub/storage": packageSource("storage"),
    },
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
