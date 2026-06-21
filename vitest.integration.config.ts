import { mergeConfig } from "vitest/config";

import unitConfig from "./vitest.config.js";

export default mergeConfig(unitConfig, {
  test: {
    coverage: { enabled: false },
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
  },
});
