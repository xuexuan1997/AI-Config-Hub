import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workspace = fileURLToPath(new URL("../..", import.meta.url));

function cruise(fixture: string) {
  return spawnSync(
    "pnpm",
    [
      "exec",
      "depcruise",
      "--config",
      "dependency-cruiser.mjs",
      `tests/architecture/fixtures/renderer/${fixture}`,
    ],
    { cwd: workspace, encoding: "utf8" },
  );
}

describe("renderer trust boundary", () => {
  it("allows the browser-safe API package", () => {
    const result = cruise("safe.ts");
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("rejects Node built-ins and privileged infrastructure packages", () => {
    const result = cruise("unsafe.ts");
    expect(result.status, "unsafe renderer fixture unexpectedly passed").not.toBe(0);
    expect(result.stdout).toContain("renderer-no-privileged-capabilities");
  });
});
