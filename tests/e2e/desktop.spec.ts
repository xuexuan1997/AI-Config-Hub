import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
const expectedSingleLineSelectors = [
  ".brand strong",
  ".brand span",
  ".sidebar nav button",
  ".shell-context small",
  ".shell-context strong",
  ".page-heading h1",
  ".tool-filter-button",
  ".asset-type-tab .asset-tab-main strong",
  ".asset-type-tab > span:last-child",
  ".asset-table-compact th",
  ".asset-key-label strong",
  ".asset-row-meta",
  ".asset-source-cell",
  ".asset-load-badge",
  ".diagnostic-severity-filter button",
  ".diagnostic-code-filter > span",
  ".diagnostic-row-title strong",
  ".migration-project-copy span",
  ".migration-project-copy strong",
  ".migration-tab-count",
  ".panel-title > strong",
  ".panel-title > span",
  ".panel-title-copy strong",
  ".panel-title-copy small",
  ".asset-option > span",
  ".asset-option > small",
  ".migration-summary-heading h2",
  ".migration-summary-heading small",
  ".summary-card > span",
  ".summary-card > strong",
  ".migration-difference-summary .field.compact > label",
  ".target-change-heading strong",
  ".target-change-meta span",
  ".preview-summary > strong",
  ".preview-summary > span",
  ".migration-execution-heading h2",
  ".confirmation-item",
  ".migration-action-row button",
  ".blocker-panel li",
  ".settings-heading h1",
  ".settings-heading > button",
  ".settings-grid label",
  ".settings-meta > span",
  ".settings-update-actions button",
  ".settings-section-heading h2",
  ".settings-check-row strong",
  ".settings-local-data-actions button",
  ".asset-detail-header h2",
  ".asset-detail-close",
  ".detail-actions button",
  ".scan-task-heading h2",
  ".task-status-summary > span",
  ".scan-task-state",
  ".scan-task-modal .scan-task-detail",
] as const;

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
      await setDesktopContentSize(app, 1024, 700);
      await expect(page.getByText("AI Config Hub", { exact: true })).toBeVisible();
      expect(existsSync(join(workspace.userData, "ai-config-hub.sqlite"))).toBe(true);
      await expect(page.getByRole("heading", { name: exactText("资产审查") })).toBeVisible();
      await captureDesktopScreenshot(page, testInfo, "01-asset-review-empty");
      await expectSingleLineUi(page, "asset review empty");

      await page.getByRole("button", { name: exactText("选择项目") }).click();
      await expectPathSummary(
        page.locator(".shell-context strong"),
        page.locator(".shell-context"),
        workspace.projectRoot,
      );
      await expect(page.getByText("rule:AGENTS", { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator(".scan-task-modal")).toHaveCount(0);
      await captureDesktopScreenshot(page, testInfo, "02-asset-review-scanned");
      await expectSingleLineUi(page, "asset review populated");

      const codexTool = page.getByRole("button", { name: "Codex" });
      await codexTool.click();
      await expect(codexTool).toHaveAttribute("aria-pressed", "true");
      const inspectCodexRule = page
        .locator("tbody tr")
        .filter({ hasText: "AGENTS" })
        .getByRole("button", { name: exactText("检查") });
      await expect(inspectCodexRule).toBeVisible();
      await inspectCodexRule.click();

      const assetDetail = page.getByRole("dialog", { name: exactText("资产详情") });
      await expect(assetDetail).toContainText("AGENTS");
      await expect(assetDetail).toContainText(workspace.projectRoot);
      await expect(assetDetail.getByRole("button", { name: exactText("关闭") })).toBeFocused();
      await assetDetail.getByRole("button", { name: exactText("加载有效配置") }).click();
      await expect(assetDetail.getByText(exactText("快照修订版本"))).toBeVisible();
      await expect(assetDetail.getByText(exactText("贡献者"))).toBeVisible();
      await captureDesktopScreenshot(page, testInfo, "03-asset-detail");
      await expectSingleLineUi(page, "asset detail");
      await assetDetail.getByRole("button", { name: exactText("禁用资产") }).click();
      await expect(assetDetail).toContainText("已禁用");
      await assetDetail.getByRole("button", { name: exactText("启用资产") }).click();
      await expect(assetDetail).toContainText("已启用");
      await page.keyboard.press("Escape");
      await expect(assetDetail).toBeHidden();
      await expect(inspectCodexRule).toBeFocused();

      await page.getByRole("button", { name: exactText("资产迁移") }).click();
      await expect(page.getByRole("heading", { name: exactText("资产迁移") })).toBeVisible();
      await captureDesktopScreenshot(page, testInfo, "04-migration-empty");
      await expectSingleLineUi(page, "migration empty");

      await page.locator(".migration-project-card.source").getByRole("button").click();
      await expectProjectCardPath(
        page.locator(".migration-project-card.source"),
        workspace.projectRoot,
      );
      const sourceAssets = page.locator(".migration-source-panel");
      await expect(sourceAssets).toContainText("AGENTS", { timeout: 30_000 });
      await page.locator(".migration-project-card.target").getByRole("button").click();
      await expectProjectCardPath(
        page.locator(".migration-project-card.target"),
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
      await page.locator("#migration-conflict").selectOption("fail");
      await page.getByRole("button", { name: exactText("预览写入") }).click();
      await expect(page.locator(".app-message")).toContainText(/目标已存在|Target already exists/, {
        timeout: 30_000,
      });
      await captureDesktopScreenshot(page, testInfo, "05-migration-conflict-visible");
      await page.locator(".app-message button").click();
      await page.locator("#migration-conflict").selectOption("replace");
      await page.getByRole("button", { name: exactText("预览写入") }).click();
      await expect(page.locator(".preview-summary")).toContainText(/计划 [0-9a-f]{64}/, {
        timeout: 30_000,
      });
      await expect(
        page.getByRole("heading", {
          name: /替换文件 .*\.cursor\/rules\/agents\.mdc/,
        }),
      ).toBeVisible();
      await captureDesktopScreenshot(page, testInfo, "06-migration-preview");
      await expectSingleLineUi(page, "migration preview blocked");

      await expect(page.getByRole("button", { name: "Deployment" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "History" })).toHaveCount(0);
      await page.getByLabel(exactText("我确认这会写入已验证的配置文件。")).check();
      await expect(page.getByRole("button", { name: exactText("执行迁移") })).toBeDisabled();
      await expect(page.getByText(requiredConfirmationBlockerPattern())).toBeVisible();
      await page.getByLabel(exactText("覆盖现有目标文件。")).check();
      await expectSingleLineUi(page, "migration preview ready");
      await page.getByRole("button", { name: exactText("执行迁移") }).click();
      await expect(page.getByText(migrationCompletePattern())).toBeVisible({
        timeout: 30_000,
      });
      await captureDesktopScreenshot(page, testInfo, "07-migration-complete");
      await expectSingleLineUi(page, "migration complete");
      await expect.poll(() => existsSync(cursorRulePath)).toBe(true);
      expect(await readFile(cursorRulePath, "utf8")).toContain("Use local TypeScript conventions.");
      expect(await readFile(cursorRulePath, "utf8")).not.toContain("Existing Cursor Rule.");
      await expect(page.locator(".migration-target-panel .target-change-row")).toHaveCount(1);

      await page.getByRole("button", { name: exactText("资产审查") }).click();
      await expect(page.locator(".review-workspace")).not.toContainText(
        workspace.targetProjectRoot,
      );

      await page.getByRole("button", { name: exactText("设置") }).click();
      await expect(page.getByRole("heading", { name: exactText("设置") })).toBeVisible();
      await expect(page.getByText(exactText("软件更新"))).toBeVisible();
      await expect(page.getByText(exactText("当前版本 0.2.19"))).toBeVisible();
      await expectSingleLineUi(page, "settings top");
      const clearSelectedData = page.getByRole("button", { name: exactText("清理所选数据") });
      await expect(clearSelectedData).toBeDisabled();
      await clearSelectedData.scrollIntoViewIfNeeded();
      await captureDesktopScreenshot(page, testInfo, "08-settings");
      await expectSingleLineUi(page, "settings bottom");
      await expectDirectoryPickerInvocations(app, 3);
    } finally {
      await app.close();
      await workspace.dispose();
    }
  });

  test("shows empty-target additions and blocks a stale source before writing", async ({
    browserName,
  }, testInfo) => {
    testInfo.annotations.push({ type: "browser", description: browserName });
    const workspace = await createFixtureWorkspace();
    const targetRulePath = join(workspace.emptyTargetProjectRoot, ".cursor/rules/agents.mdc");
    const app = await launchDesktop(workspace.userData);

    try {
      await stubDirectoryPicker(app, [workspace.projectRoot, workspace.emptyTargetProjectRoot]);
      const page = await app.firstWindow();
      await setDesktopContentSize(app, 1024, 700);
      // This scenario exercises deployment preflight drift detection. Disable
      // live watching so it cannot retire the preview before Execute is clicked.
      await setFileWatching(page, false);
      await page.getByRole("button", { name: exactText("资产迁移") }).click();
      await page.locator(".migration-project-card.source").getByRole("button").click();
      const sourceAssets = page.locator(".migration-source-panel");
      await expect(sourceAssets).toContainText("AGENTS", { timeout: 30_000 });
      await page.locator(".migration-project-card.target").getByRole("button").click();
      await expectProjectCardPath(
        page.locator(".migration-project-card.target"),
        workspace.emptyTargetProjectRoot,
      );
      await clearMigrationSourceSelection(page, sourceAssets);
      await page.getByRole("tab", { name: /Rule/ }).click();
      await sourceAssets
        .locator("label")
        .filter({ hasText: "rule:AGENTS" })
        .filter({ hasText: "Codex" })
        .getByRole("checkbox")
        .check();

      await expect(page.locator(".migration-difference-summary")).toContainText("新增到目标1");
      await expect(
        page.locator(".migration-target-panel .target-change-row.is-create"),
      ).toHaveCount(1);
      await page.getByRole("button", { name: exactText("预览写入") }).click();
      await expect(page.locator(".preview-summary")).toBeVisible({ timeout: 30_000 });

      await writeFile(join(workspace.projectRoot, "AGENTS.md"), "Use freshly edited rules.\n", {
        encoding: "utf8",
      });
      await page.getByLabel(exactText("我确认这会写入已验证的配置文件。")).check();
      await page.getByRole("button", { name: exactText("执行迁移") }).click();
      await expect(page.locator(".app-message")).toContainText(
        /部署前源资产已变更|Source changed before deployment/,
        { timeout: 30_000 },
      );
      const failedMigrationStatus = page.locator(".migration-run-status");
      await expect(failedMigrationStatus).toContainText(/状态：\s*失败|Status:\s*Failed/);
      await expect(failedMigrationStatus).not.toContainText(/状态：\s*已完成|Status:\s*Completed/);
      expect(existsSync(targetRulePath)).toBe(false);
      await expect(page.getByText(/恢复锁已激活|Recovery lock active/)).toHaveCount(0);
      await captureDesktopScreenshot(page, testInfo, "09-source-drift-blocked");
      await expectSingleLineUi(page, "migration failed");
      await expectDirectoryPickerInvocations(app, 2);
    } finally {
      await app.close();
      await workspace.dispose();
    }
  });

  test("launches two isolated desktop profiles concurrently", async () => {
    const firstWorkspace = await createFixtureWorkspace();
    const secondWorkspace = await createFixtureWorkspace();
    const firstApp = await launchDesktop(firstWorkspace.userData);
    const secondApp = await launchDesktop(secondWorkspace.userData);

    try {
      await expect(
        (await firstApp.firstWindow()).getByText("AI Config Hub", { exact: true }),
      ).toBeVisible();
      await expect(
        (await secondApp.firstWindow()).getByText("AI Config Hub", { exact: true }),
      ).toBeVisible();
    } finally {
      await Promise.all([firstApp.close(), secondApp.close()]);
      await Promise.all([firstWorkspace.dispose(), secondWorkspace.dispose()]);
    }
  });
});

function launchDesktop(userData: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ["--lang=zh-CN", mainEntry],
    env: {
      ...process.env,
      AI_CONFIG_HUB_USER_DATA: userData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      LANG: "zh_CN.UTF-8",
      LC_ALL: "zh_CN.UTF-8",
    },
  });
}

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

async function setFileWatching(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async (nextValue) => {
    const api = (
      globalThis as typeof globalThis & {
        aiConfigHub: {
          invoke(
            name: string,
            payload: unknown,
          ): Promise<{
            readonly ok: boolean;
            readonly data?: { readonly revision?: number };
            readonly error?: { readonly message?: string };
          }>;
        };
      }
    ).aiConfigHub;
    const current = await api.invoke("settings.get", {});
    const revision = current.data?.revision;
    if (!current.ok || revision === undefined) {
      throw new Error(current.error?.message ?? "Could not read desktop settings");
    }
    const updated = await api.invoke("settings.update", {
      patch: { fileWatching: nextValue },
      expectedRevision: revision,
    });
    if (!updated.ok) throw new Error(updated.error?.message ?? "Could not update desktop settings");
  }, enabled);
}

async function captureDesktopScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

async function setDesktopContentSize(
  app: ElectronApplication,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    (electronModule, size) => {
      const window = electronModule.BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("Expected an Electron BrowserWindow");
      window.webContents.setZoomFactor(1);
      window.setContentSize(size.width, size.height, false);
    },
    { width, height },
  );
}

async function expectSingleLineUi(page: Page, stateLabel: string): Promise<void> {
  const result = await page.evaluate((selectors) => {
    const findings: Array<Record<string, unknown>> = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!(element instanceof HTMLElement)) continue;
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const intersectsViewport =
          bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.bottom > 0 &&
          bounds.right > 0 &&
          bounds.top < innerHeight &&
          bounds.left < innerWidth &&
          style.visibility !== "hidden";
        if (!intersectsViewport) continue;
        const text = (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ");
        if (text.length === 0) continue;
        const lineTops: number[] = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if ((node.textContent ?? "").trim().length === 0) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (rect.width <= 0 || rect.height <= 0) continue;
            const top = Math.round(rect.top * 2) / 2;
            if (!lineTops.some((candidate) => Math.abs(candidate - top) < 1)) lineTops.push(top);
          }
        }
        const overflowX = element.scrollWidth > element.clientWidth + 1;
        const overflowY = element.scrollHeight > element.clientHeight + 1;
        const ellipsisAllowed =
          style.whiteSpace === "nowrap" &&
          (style.overflowX === "hidden" || style.overflowX === "clip") &&
          style.textOverflow === "ellipsis";
        const compactPanel = element.closest('.migration-preview-details[data-layout="compact"]');
        const compactBounds = compactPanel?.getBoundingClientRect();
        const compactClipTarget =
          selector === ".confirmation-item" || selector === ".blocker-panel li";
        const clippedByCompactPanel =
          compactClipTarget &&
          compactBounds !== undefined &&
          (bounds.top < compactBounds.top - 1 ||
            bounds.bottom > compactBounds.bottom + 1 ||
            bounds.left < compactBounds.left - 1 ||
            bounds.right > compactBounds.right + 1);
        if (
          lineTops.length > 1 ||
          (overflowX && !ellipsisAllowed) ||
          overflowY ||
          clippedByCompactPanel
        ) {
          findings.push({
            selector,
            text,
            lines: lineTops.length,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            whiteSpace: style.whiteSpace,
            overflowX: style.overflowX,
            textOverflow: style.textOverflow,
            clippedByCompactPanel,
          });
        }
      }
    }
    return {
      documentOverflowX:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      findings,
    };
  }, expectedSingleLineSelectors);

  expect(result.documentOverflowX, `${stateLabel}: document overflow`).toBe(0);
  expect(result.findings, `${stateLabel}: unexpected wraps or clipping`).toEqual([]);
}

async function expectProjectCardPath(card: Locator, expectedPath: string): Promise<void> {
  const value = card.locator(".migration-project-copy strong");
  await expectPathSummary(value, value, expectedPath);
}

async function expectPathSummary(
  visibleValue: Locator,
  tooltipOwner: Locator,
  expectedPath: string,
): Promise<void> {
  await expect(visibleValue).toHaveText(basename(expectedPath));
  await expect(tooltipOwner).toHaveAttribute("title", pathSuffixPattern(expectedPath));
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

function pathSuffixPattern(value: string): RegExp {
  return new RegExp(escapeRegExp(value) + "$");
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
  readonly emptyTargetProjectRoot: string;
  readonly targetProjectRoot: string;
  readonly userData: string;
  readonly dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-e2e-"));
  const projectRoot = join(root, "source-project");
  const emptyTargetProjectRoot = join(root, "empty-target-project");
  const targetProjectRoot = join(root, "target-project");
  const userData = join(root, "user-data");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(emptyTargetProjectRoot, { recursive: true });
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
    emptyTargetProjectRoot,
    targetProjectRoot,
    userData,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
