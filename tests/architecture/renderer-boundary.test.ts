import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workspace = fileURLToPath(new URL("../..", import.meta.url));
const dependencyCruiseTimeoutMs = 30_000;
function cruise(fixture: string) {
  const pnpmExecPath = process.env["npm_execpath"];
  if (pnpmExecPath === undefined && process.platform === "win32") {
    return spawnSync(
      process.env["ComSpec"] ?? "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        `pnpm exec depcruise --config dependency-cruiser.mjs tests/architecture/fixtures/renderer/${fixture}`,
      ],
      { cwd: workspace, encoding: "utf8" },
    );
  }
  const command = pnpmExecPath === undefined ? "pnpm" : process.execPath;
  const commandArgs = [
    ...(pnpmExecPath === undefined ? [] : [pnpmExecPath]),
    "exec",
    "depcruise",
    "--config",
    "dependency-cruiser.mjs",
    `tests/architecture/fixtures/renderer/${fixture}`,
  ];
  return spawnSync(command, commandArgs, {
    cwd: workspace,
    encoding: "utf8",
  });
}

describe("renderer trust boundary", () => {
  it(
    "allows the browser-safe API package",
    () => {
      const result = cruise("safe.ts");
      expect(result.status, result.stderr || result.stdout).toBe(0);
    },
    dependencyCruiseTimeoutMs,
  );

  it(
    "rejects Node built-ins and privileged infrastructure packages",
    () => {
      const result = cruise("unsafe.ts");
      expect(result.status, "unsafe renderer fixture unexpectedly passed").not.toBe(0);
      expect(result.stdout).toContain("renderer-no-privileged-capabilities");
    },
    dependencyCruiseTimeoutMs,
  );
});
