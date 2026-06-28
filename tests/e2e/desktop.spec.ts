import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { _electron as electron, expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mainEntry = join(repoRoot, "apps/desktop/dist/main/main/main.js");

test.setTimeout(120_000);

test.beforeAll(async () => {
  await execFileAsync("pnpm", ["build"], {
    cwd: repoRoot,
    env: process.env,
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
  });
});

test.describe("Desktop end to end", () => {
  test("launches with isolated app data, scans, deploys, and rolls back", async () => {
    const workspace = await createFixtureWorkspace();
    const cursorRulePath = join(workspace.projectRoot, ".cursor/rules/agents.mdc");
    const app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        AI_CONFIG_HUB_USER_DATA: workspace.userData,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      },
    });

    try {
      const page = await app.firstWindow();
      await expect(page.getByText("AI Config Hub")).toBeVisible();
      expect(existsSync(join(workspace.userData, "ai-config-hub.sqlite"))).toBe(true);

      await page.getByLabel("Project path").fill(workspace.projectRoot);
      await page.getByRole("button", { name: "Use path" }).click();
      await expect(page.getByText(workspace.projectRoot)).toBeVisible();

      await page.getByRole("button", { name: "Start scan" }).click();
      await expect(page.getByText(/Task task:scan:.*succeeded/)).toBeVisible({ timeout: 30_000 });

      await page.getByRole("button", { name: "Assets" }).click();
      await expect(page.getByRole("cell", { name: "codex" }).first()).toBeVisible();
      await page.getByRole("button", { name: "Inspect" }).first().click();

      await expect(page.getByRole("region", { name: "Asset detail" })).toContainText("AGENTS");
      await expect(page.getByRole("region", { name: "Asset detail" })).toContainText(
        workspace.projectRoot,
      );

      await page.getByRole("button", { name: "Migration" }).click();
      await page.getByRole("button", { name: "Preview Codex → Cursor" }).click();
      await expect(page.getByText(/Plan deployment-plan:/)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/\.cursor\/rules\/agents\.mdc/)).toBeVisible();

      await page.getByRole("button", { name: "Deployment" }).click();
      await page.getByLabel("I understand this writes verified config files.").check();
      await page.getByRole("button", { name: "Execute deployment" }).click();
      await expect(page.getByText(/Deployment queued:/)).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => existsSync(cursorRulePath)).toBe(true);
      expect(await readFile(cursorRulePath, "utf8")).toContain("Use local TypeScript conventions.");

      await page.getByRole("button", { name: "History" }).click();
      await page.getByRole("button", { name: "Refresh history" }).click();
      await expect(
        page.locator(".history-list li").filter({ hasText: "deployment succeeded" }),
      ).toBeVisible();

      await page.getByRole("button", { name: "Deployment" }).click();
      await page.getByRole("button", { name: "Preview rollback" }).click();
      await expect(page.getByText(/Rollback queued:/)).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => existsSync(cursorRulePath)).toBe(false);

      await page.getByRole("button", { name: "History" }).click();
      await page.getByRole("button", { name: "Refresh history" }).click();
      await expect(
        page.locator(".history-list li").filter({ hasText: "rollback succeeded" }),
      ).toBeVisible();
    } finally {
      await app.close();
      await workspace.dispose();
    }
  });
});

async function createFixtureWorkspace(): Promise<{
  readonly projectRoot: string;
  readonly userData: string;
  readonly dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-e2e-"));
  const projectRoot = join(root, "project");
  const userData = join(root, "user-data");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(join(projectRoot, "AGENTS.md"), "Use local TypeScript conventions.\n", {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    projectRoot,
    userData,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
