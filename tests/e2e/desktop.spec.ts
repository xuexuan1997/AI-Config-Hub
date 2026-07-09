import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

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
  test("launches with isolated app data, scans, previews, migrates, and verifies settings", async ({
    browserName,
  }, testInfo) => {
    testInfo.annotations.push({ type: "browser", description: browserName });
    const workspace = await createFixtureWorkspace();
    const cursorRulePath = join(workspace.targetProjectRoot, ".cursor/rules/agents.mdc");
    const app = await electron.launch({
      args: ["--lang=zh-CN", mainEntry],
      env: {
        ...process.env,
        AI_CONFIG_HUB_USER_DATA: workspace.userData,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        LANG: "zh_CN.UTF-8",
        LC_ALL: "zh_CN.UTF-8",
      },
    });

    try {
      await stubDirectoryPicker(app, [
        workspace.projectRoot,
        workspace.projectRoot,
        workspace.targetProjectRoot,
      ]);

      const page = await app.firstWindow();
      await expect(page.getByText("AI Config Hub", { exact: true })).toBeVisible();
      expect(existsSync(join(workspace.userData, "ai-config-hub.sqlite"))).toBe(true);
      await expect(page.getByRole("heading", { name: exactText("资产审查") })).toBeVisible();
      await captureDesktopScreenshot(page, testInfo, "01-asset-review-empty");

      await page.getByRole("button", { name: exactText("选择项目") }).click();
      await expect(page.getByText(workspace.projectRoot)).toBeVisible();
      await expect(page.getByText(scanCompletePattern())).toBeVisible({
        timeout: 30_000,
      });
      await captureDesktopScreenshot(page, testInfo, "02-asset-review-scanned");

      await page.getByRole("button", { name: "Codex" }).click();
      await expect(page.getByRole("heading", { name: exactText("Rule资产") })).toBeVisible();
      await page
        .locator("tbody tr")
        .filter({ hasText: "AGENTS" })
        .getByRole("button", { name: exactText("检查") })
        .click();

      const assetDetail = page.getByRole("dialog", { name: exactText("资产详情") });
      await expect(assetDetail).toContainText("AGENTS");
      await expect(assetDetail).toContainText(workspace.projectRoot);
      await captureDesktopScreenshot(page, testInfo, "03-asset-detail");
      await assetDetail.getByRole("button", { name: exactText("禁用资产") }).click();
      await expect(assetDetail).toContainText("已禁用");
      await assetDetail.getByRole("button", { name: exactText("启用资产") }).click();
      await expect(assetDetail).toContainText("已启用");
      await assetDetail.getByRole("button", { name: exactText("关闭") }).click();
      await expect(assetDetail).toBeHidden();

      await page.getByRole("button", { name: exactText("资产迁移") }).click();
      await expect(page.getByRole("heading", { name: exactText("资产迁移") })).toBeVisible();
      await captureDesktopScreenshot(page, testInfo, "04-migration-empty");

      await page.locator(".migration-project-card.source").getByRole("button").click();
      await expect(page.locator(".migration-project-card.source")).toContainText(
        workspace.projectRoot,
      );
      const sourceAssets = page.locator(".migration-source-panel");
      await expect(sourceAssets).toContainText("AGENTS", { timeout: 30_000 });
      await page.locator(".migration-project-card.target").getByRole("button").click();
      await expect(page.locator(".migration-project-card.target")).toContainText(
        workspace.targetProjectRoot,
      );
      await expect(page.locator(".migration-target-panel")).toContainText("rule:agents", {
        timeout: 30_000,
      });

      await clearMigrationSourceSelection(page, sourceAssets);
      await page.getByRole("tab", { name: /Rule/ }).click();
      const codexSource = sourceAssets
        .locator("label")
        .filter({ hasText: "rule:AGENTS" })
        .filter({ hasText: "Codex" })
        .getByRole("checkbox");
      if (!(await codexSource.isChecked())) await codexSource.check();
      await page.getByRole("tab", { name: /Skill/ }).click();
      const codexSkill = sourceAssets
        .locator("label")
        .filter({ hasText: "skill:release" })
        .filter({ hasText: "Codex" })
        .getByRole("checkbox");
      await codexSkill.check();
      await expect(page.getByRole("button", { name: exactText("预览写入") })).toBeDisabled();
      await expect(page.getByText(exactText("请选择同一种资源类型的源资产。"))).toBeVisible();
      await codexSkill.uncheck();
      await page.getByRole("tab", { name: /Rule/ }).click();
      await page.getByRole("button", { name: exactText("预览写入") }).click();
      await expect(page.locator(".preview-summary")).toContainText(/计划 [0-9a-f]{64}/, {
        timeout: 30_000,
      });
      await expect(
        page.getByRole("heading", {
          name: /替换文件 .*\.cursor\/rules\/agents\.mdc/,
        }),
      ).toBeVisible();
      await captureDesktopScreenshot(page, testInfo, "05-migration-preview");

      await expect(page.getByRole("button", { name: "Deployment" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "History" })).toHaveCount(0);
      await page.getByLabel(exactText("我确认这会写入已验证的配置文件。")).check();
      await expect(page.getByRole("button", { name: exactText("执行迁移") })).toBeDisabled();
      await expect(page.getByText(requiredConfirmationBlockerPattern())).toBeVisible();
      await page.getByLabel(exactText("覆盖现有目标文件。")).check();
      await page.getByRole("button", { name: exactText("执行迁移") }).click();
      await expect(page.getByText(migrationCompletePattern())).toBeVisible({
        timeout: 30_000,
      });
      await captureDesktopScreenshot(page, testInfo, "06-migration-complete");
      await expect.poll(() => existsSync(cursorRulePath)).toBe(true);
      expect(await readFile(cursorRulePath, "utf8")).toContain("Use local TypeScript conventions.");
      expect(await readFile(cursorRulePath, "utf8")).not.toContain("Existing Cursor Rule.");

      await page.getByRole("button", { name: exactText("设置") }).click();
      await expect(page.getByRole("heading", { name: exactText("设置") })).toBeVisible();
      await expect(page.getByText(exactText("软件更新"))).toBeVisible();
      const clearSelectedData = page.getByRole("button", { name: exactText("清理所选数据") });
      await expect(clearSelectedData).toBeDisabled();
      await clearSelectedData.scrollIntoViewIfNeeded();
      await captureDesktopScreenshot(page, testInfo, "07-settings");
      await expectDirectoryPickerInvocations(app, 3);
    } finally {
      await app.close();
      await workspace.dispose();
    }
  });
});

async function stubDirectoryPicker(
  app: ElectronApplication,
  selectedPaths: readonly string[],
): Promise<void> {
  await app.evaluate(
    (electronModule, paths) => {
      const dialog = electronModule.dialog as unknown as {
        showOpenDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePaths: string[] }>;
      };
      const state = {
        errors: [] as string[],
        invocations: 0,
      };
      (
        globalThis as typeof globalThis & { __aiConfigHubDirectoryPickerState?: typeof state }
      ).__aiConfigHubDirectoryPickerState = state;
      dialog.showOpenDialog = (...args: unknown[]) => {
        const candidate = args.length === 1 ? args[0] : args[1];
        const properties =
          typeof candidate === "object" && candidate !== null
            ? (candidate as { readonly properties?: unknown }).properties
            : undefined;
        if (!Array.isArray(properties) || !properties.includes("openDirectory")) {
          state.errors.push(`Invocation ${state.invocations + 1} did not request a directory`);
        }
        const selectedPath = paths[state.invocations];
        state.invocations += 1;
        if (selectedPath === undefined) {
          state.errors.push(`Unexpected directory picker invocation ${state.invocations}`);
          throw new Error(`Unexpected directory picker invocation ${state.invocations}`);
        }
        return Promise.resolve({ canceled: false, filePaths: [selectedPath] });
      };
    },
    [...selectedPaths],
  );
}

async function expectDirectoryPickerInvocations(
  app: ElectronApplication,
  expectedCount: number,
): Promise<void> {
  const state = await app.evaluate(() => {
    const pickerState = (
      globalThis as typeof globalThis & {
        __aiConfigHubDirectoryPickerState?: {
          readonly errors: readonly string[];
          readonly invocations: number;
        };
      }
    ).__aiConfigHubDirectoryPickerState;
    return pickerState === undefined
      ? undefined
      : { errors: [...pickerState.errors], invocations: pickerState.invocations };
  });
  expect(state).toEqual({ errors: [], invocations: expectedCount });
}

async function captureDesktopScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

async function clearMigrationSourceSelection(page: Page, sourceAssets: Locator): Promise<void> {
  for (const tab of await page.locator(".migration-tabs [role='tab']").all()) {
    await tab.click();
    for (const source of await sourceAssets.getByRole("checkbox").all()) {
      if (await source.isChecked()) await source.uncheck();
    }
  }
}

function exactText(value: string): RegExp {
  return new RegExp(`^${escapeRegExp(value)}$`);
}

function scanCompletePattern(): RegExp {
  return /扫描已完成：.*成功/;
}

function migrationCompletePattern(): RegExp {
  return /迁移已完成：.*成功/;
}

function requiredConfirmationBlockerPattern(): RegExp {
  return /确认必需的迁移动作：\s*覆盖现有目标文件。/;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function createFixtureWorkspace(): Promise<{
  readonly projectRoot: string;
  readonly targetProjectRoot: string;
  readonly userData: string;
  readonly dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-e2e-"));
  const projectRoot = join(root, "source-project");
  const targetProjectRoot = join(root, "target-project");
  const userData = join(root, "user-data");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(targetProjectRoot, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(join(projectRoot, ".agents", "skills", "release"), { recursive: true });
  await mkdir(join(targetProjectRoot, ".cursor", "rules"), { recursive: true });
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
  await writeFile(
    join(targetProjectRoot, ".cursor", "rules", "agents.mdc"),
    "Existing Cursor Rule.\n",
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  return {
    projectRoot,
    targetProjectRoot,
    userData,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
