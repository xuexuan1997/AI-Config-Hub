import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("workspace contract", () => {
  it("pins pnpm and exposes every required root command", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));

    assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
    for (const script of [
      "build",
      "dev",
      "typecheck",
      "lint",
      "test",
      "test:integration",
      "test:e2e",
      "package",
    ]) {
      assert.ok(script in manifest.scripts, `missing script: ${script}`);
    }
  });
});
