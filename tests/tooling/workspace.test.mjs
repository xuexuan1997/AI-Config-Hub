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

  it("ignores TypeScript incremental build state", async () => {
    const gitignore = await readFile(".gitignore", "utf8");

    assert.match(gitignore, /^\*\.tsbuildinfo$/m);
  });

  it("pins phase-two dependencies in the package that owns each capability", async () => {
    const [storage, adapters, scanner] = await Promise.all(
      ["storage", "adapters", "scanner"].map(async (name) =>
        JSON.parse(await readFile(`packages/${name}/package.json`, "utf8")),
      ),
    );

    assert.equal(storage.dependencies["drizzle-orm"], "0.45.2");
    assert.equal(adapters.dependencies.yaml, "2.9.0");
    assert.equal(adapters.dependencies["smol-toml"], "1.6.1");
    assert.equal(adapters.dependencies["jsonc-parser"], "3.3.1");
    for (const manifest of [storage, adapters, scanner]) {
      assert.equal(manifest.scripts.test, "vitest run src");
    }
  });

  it("installs pnpm before setup-node initializes its pnpm cache", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    const jobsSection = workflow.split(/^jobs:\s*$/m)[1];
    assert.ok(jobsSection, "workflow must define jobs");
    const jobs = jobsSection.split(/^ {2}[a-z][a-z-]+:\s*$/m).slice(1);

    assert.equal(jobs.length, 4);
    for (const job of jobs) {
      const installPnpm = job.indexOf("uses: pnpm/action-setup@v4");
      const setupNode = job.indexOf("uses: actions/setup-node@v4");

      assert.ok(installPnpm >= 0, "job must install pnpm");
      assert.ok(installPnpm < setupNode, "pnpm must be installed before setup-node cache lookup");
    }
  });
});
