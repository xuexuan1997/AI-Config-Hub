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

test.beforeAll(async ({ browserName }, testInfo) => {
  testInfo.annotations.push({ type: "browser", description: browserName });
  testInfo.setTimeout(120_000);
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
      await expect(page.getByText("AI Config Hub", { exact: true })).toBeVisible();
      expect(existsSync(join(workspace.userData, "ai-config-hub.sqlite"))).toBe(true);

      await page.getByLabel("Project path").fill(workspace.projectRoot);
      await page.getByRole("button", { name: "Use typed path" }).click();
      await expect(page.getByText(workspace.projectRoot)).toBeVisible();

      await page.getByRole("button", { name: "Start scan" }).click();
      await expect(page.getByText(/Scan complete: \d+ succeeded\./)).toBeVisible({
        timeout: 30_000,
      });

      await page.getByRole("button", { name: "Assets" }).click();
      await expect(page.getByRole("heading", { name: "Rule assets" })).toBeVisible();
      await page
        .locator("tbody tr")
        .filter({ hasText: "Codex" })
        .filter({ hasText: "AGENTS" })
        .getByRole("button", { name: "Inspect" })
        .click();

      await expect(page.getByRole("dialog", { name: "Asset detail" })).toContainText("AGENTS");
      await expect(page.getByRole("dialog", { name: "Asset detail" })).toContainText(
        workspace.projectRoot,
      );
      await page
        .getByRole("dialog", { name: "Asset detail" })
        .getByRole("button", { name: "Disable asset" })
        .click();
      await expect(page.getByRole("dialog", { name: "Asset detail" })).toContainText("Disabled");
      await page
        .getByRole("dialog", { name: "Asset detail" })
        .getByRole("button", { name: "Enable asset" })
        .click();
      await expect(page.getByRole("dialog", { name: "Asset detail" })).toContainText("Enabled");
      await page.getByRole("button", { name: "Close" }).click();
      await expect(page.getByRole("dialog", { name: "Asset detail" })).toBeHidden();

      await page.getByRole("button", { name: "Migration" }).click();
      const sourceAssets = page.getByRole("group", { name: "Source assets" });
      for (const source of await sourceAssets.getByRole("checkbox").all()) {
        if (await source.isChecked()) await source.uncheck();
      }
      const codexSource = sourceAssets
        .locator("label")
        .filter({ hasText: "rule:AGENTS" })
        .filter({ hasText: "codex / rule" })
        .getByRole("checkbox");
      const codexSkill = sourceAssets
        .locator("label")
        .filter({ hasText: "codex / skill" })
        .getByRole("checkbox");
      if (!(await codexSource.isChecked())) await codexSource.check();
      await codexSkill.check();
      await expect(page.getByRole("button", { name: "Preview migration" })).toBeDisabled();
      await expect(page.getByText("Select source assets from one resource type.")).toBeVisible();
      await codexSkill.uncheck();
      await page.getByRole("button", { name: "Preview migration" }).click();
      await expect(page.locator(".preview-summary")).toContainText(/Plan [0-9a-f]{64}/, {
        timeout: 30_000,
      });
      await expect(
        page.getByRole("heading", { name: /Replace file .*\.cursor\/rules\/agents\.mdc/ }),
      ).toBeVisible();

      await page.getByRole("button", { name: "Deployment" }).click();
      await expect(page.getByRole("button", { name: "Execute rollback" })).toBeDisabled();
      await expect(
        page.getByText("No succeeded deployment is available to roll back."),
      ).toBeVisible();
      await page.getByLabel("I understand this writes verified config files.").check();
      await expect(page.getByRole("button", { name: "Execute deployment" })).toBeDisabled();
      await expect(
        page.getByText("Confirm required migration actions: Overwrite existing target files."),
      ).toBeVisible();
      await page.getByLabel("Overwrite existing target files.").check();
      await page.getByRole("button", { name: "Execute deployment" }).click();
      await expect(page.getByText("Deployment complete: 1 succeeded.")).toBeVisible({
        timeout: 30_000,
      });
      await expect.poll(() => existsSync(cursorRulePath)).toBe(true);
      expect(await readFile(cursorRulePath, "utf8")).toContain("Use local TypeScript conventions.");
      expect(await readFile(cursorRulePath, "utf8")).not.toContain("Existing Cursor rule.");

      await page.getByRole("button", { name: "History" }).click();
      await page.getByRole("button", { name: "Refresh history" }).click();
      await expect(
        page
          .locator(".history-list li")
          .filter({ hasText: "Deployment" })
          .filter({ hasText: "Succeeded" }),
      ).toBeVisible();

      await page.getByRole("button", { name: "Deployment" }).click();
      await page.getByRole("button", { name: "Execute rollback" }).click();
      await expect(page.getByText("Rollback complete: 1 succeeded.")).toBeVisible({
        timeout: 30_000,
      });
      await expect.poll(() => existsSync(cursorRulePath)).toBe(true);
      expect(await readFile(cursorRulePath, "utf8")).toBe("Existing Cursor rule.\n");

      await page.getByRole("button", { name: "History" }).click();
      await page.getByRole("button", { name: "Refresh history" }).click();
      await expect(
        page
          .locator(".history-list li")
          .filter({ hasText: "Rollback" })
          .filter({ hasText: "Succeeded" }),
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
  await mkdir(join(projectRoot, ".agents", "skills", "release"), { recursive: true });
  await mkdir(join(projectRoot, ".cursor", "rules"), { recursive: true });
  await writeFile(join(projectRoot, "AGENTS.md"), "Use local TypeScript conventions.\n", {
    encoding: "utf8",
    flag: "wx",
  });
  await writeFile(
    join(projectRoot, ".agents", "skills", "release", "SKILL.md"),
    "---\nname: release\ndescription: Release safely\n---\nRun the checklist.\n",
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  await writeFile(join(projectRoot, ".cursor", "rules", "agents.mdc"), "Existing Cursor rule.\n", {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    projectRoot,
    userData,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
