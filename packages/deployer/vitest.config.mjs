import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

const packageSource = (name) => fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@ai-config-hub/adapters": packageSource("adapters"),
      "@ai-config-hub/core": packageSource("core"),
      "@ai-config-hub/shared": packageSource("shared"),
    },
  },
  test: {
    globalSetup: ["./scripts/vitest-native-setup.mjs"],
    include: ["src/**/*.test.ts"],
  },
});
