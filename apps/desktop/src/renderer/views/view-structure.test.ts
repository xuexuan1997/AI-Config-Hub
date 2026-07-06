import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AssetIdSchema,
  ContentHashSchema,
  DeploymentPlanIdSchema,
  DiagnosticIdSchema,
  ScopeIdSchema,
} from "@ai-config-hub/shared";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "../components/app-shell.js";
import { initialState, type AppState } from "../model.js";
import { AssetsView } from "./assets.js";
import { MigrationView } from "./migration.js";
import { SettingsView } from "./settings.js";

describe("desktop renderer view structure", () => {
  it("renders asset review and asset migration as sibling navigation without global project controls", () => {
    const html = renderToStaticMarkup(
      createElement(AppShell, {
        state: { ...initialState, projectRoot: "/Users/xuexuan/Desktop/project/AI-Config-Hub" },
        onRoute: vi.fn(),
        children: createElement("span", null, "Workspace"),
      }),
    );

    expect(html).toContain(">Asset Review</button>");
    expect(html).toContain(">Asset Migration</button>");
    expect(html).toContain(">Settings</button>");
    expect(html).not.toContain(">Overview</button>");
    expect(html).not.toContain(">Deployment</button>");
    expect(html).not.toContain(">History</button>");
    expect(html).not.toContain('class="sidebar-foot"');
    expect(html).not.toContain("Navigation model");
    expect(html).not.toContain("Review and migration are sibling workflows.");
    expect(html).not.toContain('class="project-topbar-main"');
    expect(html).not.toContain('class="project-path-editor"');
    expect(html).not.toContain("Selected project folder");
  });

  it("keeps current project controls inside Asset Review", () => {
    const projectRoot = "/Users/xuexuan/Desktop/project/AI-Config-Hub";
    const html = renderToStaticMarkup(
      createElement(AssetsView, {
        state: { ...initialState, projectRoot },
        onInspect: vi.fn(),
        onLoadEffective: vi.fn(),
        onOpenSource: vi.fn(),
        onToggleAssetStatus: vi.fn(),
        onCloseInspect: vi.fn(),
        onLocateDiagnostic: vi.fn(),
        onSelectProject: vi.fn(),
      }),
    );

    expect(html).toContain("<h1>Asset Review</h1>");
    expect(html).toContain('class="review-project-card"');
    expect(html).toContain("Current project");
    expect(html).toContain(`title="${projectRoot}"`);
    expect(html).toContain("Choose project");
    expect(html).toContain("Scans automatically after project selection.");
    expect(html).not.toContain("Refresh assets");
    expect(html).not.toContain("Scan current project");
    expect(html).not.toContain("Manual path fallback");
    expect(html).not.toContain("Use typed path");
  });

  it("binds the scroll container identity to the active route", () => {
    const html = renderToStaticMarkup(
      createElement(AppShell, {
        state: { ...initialState, route: "migration" },
        onRoute: vi.fn(),
        children: createElement("span", null, "Migration"),
      }),
    );

    expect(html).toContain('<main data-route="migration">');
    expect(html).toContain('<section class="workspace" data-route="migration">');
  });

  it("does not render global status banners above workspace content", () => {
    const html = renderToStaticMarkup(
      createElement(AppShell, {
        state: { ...initialState, message: "Scan complete: 2 succeeded, 1 skipped." },
        onRoute: vi.fn(),
        children: createElement("span", null, "Workspace"),
      }),
    );

    expect(html).not.toContain('class="status-banner"');
    expect(html).not.toContain("Scan complete: 2 succeeded, 1 skipped.");
  });

  it("adds settings to desktop navigation", () => {
    const html = renderToStaticMarkup(
      createElement(AppShell, {
        state: { ...initialState, route: "settings" },
        onRoute: vi.fn(),
        children: createElement("span", null, "Settings"),
      }),
    );

    expect(html).toContain('<main data-route="settings">');
    expect(html).toContain('<section class="workspace" data-route="settings">');
    expect(html).toContain(">Settings</button>");
  });

  it("applies language and theme preferences to the shell", () => {
    const html = renderToStaticMarkup(
      createElement(AppShell, {
        state: {
          ...initialState,
          settings: {
            ...initialState.settings,
            values: { theme: "dark", language: "zh-CN" },
          },
        },
        onRoute: vi.fn(),
        children: createElement("span", null, "Workspace"),
      }),
    );

    expect(html).toContain('class="app-shell"');
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('data-language="zh-CN"');
    expect(html).toContain('lang="zh-CN"');
  });

  it("renders general settings controls for language and theme", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsView, {
        state: {
          ...initialState,
          settings: {
            ...initialState.settings,
            values: { theme: "dark", language: "en" },
            revision: 2,
            status: "ready",
            readOnlyRecovery: false,
            requiresRestart: false,
          },
        },
        onThemeChange: vi.fn(),
        onLanguageChange: vi.fn(),
        onReload: vi.fn(),
        onLocalDataCategoryChange: vi.fn(),
        onLocalDataConfirmationChange: vi.fn(),
        onClearLocalData: vi.fn(),
      }),
    );

    expect(html).toContain('class="settings-panel"');
    expect(html).toContain('for="settings-theme"');
    expect(html).toContain('id="settings-theme"');
    expect(html).toContain('value="dark" selected="">Dark</option>');
    expect(html).toContain('for="settings-language"');
    expect(html).toContain('id="settings-language"');
    expect(html).toContain('value="zh-CN">Simplified Chinese</option>');
    expect(html).toContain("Revision 2");
    expect(html).toContain('class="settings-local-data"');
    expect(html).toContain('id="settings-clear-scan_cache"');
    expect(html).toContain('id="settings-clear-deployment_history"');
    expect(html).toContain('id="settings-clear-settings"');
    expect(html).toContain("Scan cache");
    expect(html).toContain("Deployment history");
    expect(html).toContain("Settings preferences");
    expect(html).toContain('id="settings-clear-confirmation"');
    expect(html).toContain("Clear selected data");
    expect(html).toContain("Database migration backups");
  });

  it("renders desktop update controls in settings", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsView, {
        state: {
          ...initialState,
          settings: {
            ...initialState.settings,
            values: { theme: "dark", language: "en" },
            revision: 2,
            status: "ready",
            readOnlyRecovery: false,
            requiresRestart: false,
          },
        },
        updateStatus: {
          enabled: true,
          status: "available",
          currentVersion: "0.2.12",
          updateVersion: "0.2.13",
          releaseName: "v0.2.13",
        },
        onThemeChange: vi.fn(),
        onLanguageChange: vi.fn(),
        onReload: vi.fn(),
        onLocalDataCategoryChange: vi.fn(),
        onLocalDataConfirmationChange: vi.fn(),
        onClearLocalData: vi.fn(),
        onCheckUpdates: vi.fn(),
        onDownloadUpdate: vi.fn(),
        onInstallUpdate: vi.fn(),
      }),
    );

    expect(html).toContain("Software updates");
    expect(html).toContain("Current version 0.2.12");
    expect(html).toContain("Version 0.2.13 is available.");
    expect(html).toContain("Check for updates");
    expect(html).toContain("Download update");
    expect(html).not.toContain("Restart and install");
  });

  it("renders core desktop chrome and settings in Simplified Chinese", () => {
    const zhState: AppState = {
      ...initialState,
      settings: {
        ...initialState.settings,
        values: { theme: "system", language: "zh-CN" },
        revision: 3,
        status: "ready",
      },
    };

    const shellHtml = renderToStaticMarkup(
      createElement(AppShell, {
        state: zhState,
        onRoute: vi.fn(),
        children: createElement("span", null, "工作区"),
      }),
    );
    const settingsHtml = renderToStaticMarkup(
      createElement(SettingsView, {
        state: zhState,
        onThemeChange: vi.fn(),
        onLanguageChange: vi.fn(),
        onReload: vi.fn(),
        onLocalDataCategoryChange: vi.fn(),
        onLocalDataConfirmationChange: vi.fn(),
        onClearLocalData: vi.fn(),
      }),
    );

    expect(shellHtml).toContain(">资产审查</button>");
    expect(shellHtml).toContain(">资产迁移</button>");
    expect(shellHtml).not.toContain(">总览</button>");
    expect(shellHtml).not.toContain(">历史</button>");
    expect(shellHtml).toContain("配置资产工作台");
    expect(shellHtml).not.toContain('class="sidebar-foot"');
    expect(shellHtml).not.toContain("导航关系");
    expect(settingsHtml).toContain("<h1>设置</h1>");
    expect(settingsHtml).toContain('value="zh-CN" selected="">简体中文</option>');
    expect(settingsHtml).toContain("修订版本 3");
  });

  it("renders primary workflow views in Simplified Chinese", () => {
    const zhState: AppState = {
      ...initialState,
      settings: {
        ...initialState.settings,
        values: { theme: "system", language: "zh-CN" },
        status: "ready",
      },
    };

    const assetsHtml = renderToStaticMarkup(
      createElement(AssetsView, {
        state: zhState,
        onRefresh: vi.fn(),
        onInspect: vi.fn(),
        onLoadEffective: vi.fn(),
        onOpenSource: vi.fn(),
        onToggleAssetStatus: vi.fn(),
        onRescanAfterEdit: vi.fn(),
        onCloseInspect: vi.fn(),
        onLocateDiagnostic: vi.fn(),
      }),
    );
    const migrationHtml = renderToStaticMarkup(
      createElement(MigrationView, {
        state: zhState,
        onPreview: vi.fn(),
        onToggleSource: vi.fn(),
        onTargetTool: vi.fn(),
        onConflictPolicy: vi.fn(),
        onConfirmMigration: vi.fn(),
        onConfirmRequirement: vi.fn(),
        onExecuteMigration: vi.fn(),
      }),
    );

    expect(assetsHtml).toContain("<h1>资产审查</h1>");
    expect(assetsHtml).toContain("选择项目后自动扫描。");
    expect(assetsHtml).toContain("尚未索引资产。");
    expect(migrationHtml).toContain("<h1>资产迁移</h1>");
    expect(migrationHtml).toContain("目标工具");
    expect(migrationHtml).toContain("预览写入");
    expect(migrationHtml).toContain("请先选择源项目再创建迁移预览。");
  });

  it("keeps migration execution inside the migration preview workflow", () => {
    const state: AppState = {
      ...initialState,
      preview: previewFixture(["overwrite", "partial_conversion"]),
    };

    const html = renderToStaticMarkup(
      createElement(MigrationView, {
        state,
        onPreview: vi.fn(),
        onToggleSource: vi.fn(),
        onTargetTool: vi.fn(),
        onConflictPolicy: vi.fn(),
        onConfirmMigration: vi.fn(),
        onConfirmRequirement: vi.fn(),
        onExecuteMigration: vi.fn(),
      }),
    );

    expect(html).toContain('class="migration-confirmation-panel"');
    expect(html).toContain('class="migration-execution-panel"');
    expect(html).toContain("Run migration");
    expect(html).toContain('class="confirmation-item"');
    expect(html).toContain('class="migration-action-row"');
    expect(html).toContain('class="blocker-panel"');
    expect(html).toContain("Execute migration");
    expect(html).not.toContain("Execute deployment");
    expect(html).not.toContain("Execute rollback");
    expect(html).not.toContain("Rollback");
  });

  it("renders active migration execution status as labeled product copy", () => {
    const html = renderToStaticMarkup(
      createElement(MigrationView, {
        state: {
          ...initialState,
          preview: previewFixture([]),
          activeTask: {
            taskId: "task:deployment:1",
            taskKind: "deployment",
            phase: "completed",
            status: "succeeded",
            progress: { phase: "completed", completed: 1, total: 1, unit: "operations" },
            message: "Deployment complete: 1 succeeded.",
            recoveryLock: false,
          },
        },
        onPreview: vi.fn(),
        onToggleSource: vi.fn(),
        onTargetTool: vi.fn(),
        onConflictPolicy: vi.fn(),
        onConfirmMigration: vi.fn(),
        onConfirmRequirement: vi.fn(),
        onExecuteMigration: vi.fn(),
      }),
    );

    const executionPanelStart = html.indexOf('class="migration-execution-panel"');
    const statusStart = html.indexOf('class="migration-run-status"', executionPanelStart);

    expect(executionPanelStart).toBeGreaterThan(-1);
    expect(statusStart).toBeGreaterThan(executionPanelStart);
    expect(html).toContain('class="task-status-summary"');
    expect(html).toContain("Status: Completed");
    expect(html).toContain("1/1 operations");
    expect(html).toContain("Deployment complete: 1 succeeded.");
    expect(html).not.toContain('<section class="task-status">');
    expect(html).not.toContain("<p>completed ");
  });

  it("states whether asset diagnostics are scoped to the workspace or inspected asset", () => {
    const selectedAssetState: AppState = {
      ...initialState,
      assets: [
        assetSummaryFixture("asset-1", "rule:AGENTS"),
        assetSummaryFixture("asset-2", "rule:.cursor/rules/agents.mdc"),
      ],
      assetDetail: assetDetailFixture("asset-1", "rule:AGENTS"),
      effective: {
        effective: { body: "Use local TypeScript conventions." },
        contributors: [
          {
            assetId: AssetIdSchema.parse("asset-1"),
            action: "inherit",
            reasonCode: "highest_priority_scope",
          },
        ],
        ignored: [{ assetId: AssetIdSchema.parse("asset-2"), reasonCode: "target_conflict" }],
        diagnostics: [],
        snapshotRevision: "revision-1",
      },
      diagnostics: [
        {
          id: DiagnosticIdSchema.parse("diagnostic-1"),
          code: "PARTIAL_CONVERSION",
          severity: "warning",
          assetId: AssetIdSchema.parse("asset-1"),
          message: "One Cursor field cannot be represented by Codex.",
          suggestedAction: "Review the converted output before deployment.",
          blocking: false,
        },
      ],
      diagnosticCounts: { info: 0, warning: 1, error: 0 },
    };

    const selectedAssetHtml = renderToStaticMarkup(
      createElement(AssetsView, {
        state: selectedAssetState,
        onRefresh: vi.fn(),
        onInspect: vi.fn(),
        onLoadEffective: vi.fn(),
        onOpenSource: vi.fn(),
        onToggleAssetStatus: vi.fn(),
        onRescanAfterEdit: vi.fn(),
        onCloseInspect: vi.fn(),
        onLocateDiagnostic: vi.fn(),
      }),
    );

    expect(selectedAssetHtml).toContain('class="diagnostic-scope-label"');
    expect(selectedAssetHtml).toContain("Selected asset diagnostics");
    expect(selectedAssetHtml).toContain("Counts reflect only the inspected asset");
    expect(selectedAssetHtml).toContain('class="asset-detail-diagnostics"');
    expect(selectedAssetHtml).toContain("<h3>Diagnostics</h3>");
    expect(selectedAssetHtml).toContain("<th>Source directory</th>");
    expect(selectedAssetHtml).toContain("<th>Will load</th>");
    expect(selectedAssetHtml).toContain(
      '<td class="asset-source-cell" title="/workspace">/workspace</td>',
    );
    expect(selectedAssetHtml).toContain('class="asset-load-badge loaded"');
    expect(selectedAssetHtml).toContain("<dd>Codex</dd>");
    expect(selectedAssetHtml).toContain("<dd>Rule</dd>");
    expect(selectedAssetHtml).toContain("<dd>2026-06-28 08:00 UTC</dd>");
    expect(selectedAssetHtml).toContain("<strong>Warning: Partial conversion</strong>");
    expect(selectedAssetHtml).toContain('class="diagnostic-action"');
    expect(selectedAssetHtml).toContain("<strong>rule:AGENTS</strong>");
    expect(selectedAssetHtml).toContain("rule:AGENTS</strong> <span>");
    expect(selectedAssetHtml).toContain("Inherited from highest priority scope.");
    expect(selectedAssetHtml).toContain("<strong>rule:.cursor/rules/agents.mdc</strong>");
    expect(selectedAssetHtml).toContain("rule:.cursor/rules/agents.mdc</strong> <span>");
    expect(selectedAssetHtml).toContain("Ignored because target conflict.");
    expect(selectedAssetHtml).not.toContain("warning PARTIAL_CONVERSION");
    expect(selectedAssetHtml).not.toContain("2026-06-28T08:00:00.000Z");
    expect(selectedAssetHtml).not.toContain("asset-1 inherit highest_priority_scope");
    expect(selectedAssetHtml).not.toContain("asset-2 target_conflict");

    const workspaceHtml = renderToStaticMarkup(
      createElement(AssetsView, {
        state: {
          ...initialState,
          assets: [assetSummaryFixture("asset-1", "rule:AGENTS")],
          diagnostics: selectedAssetState.diagnostics,
          diagnosticCounts: { info: 0, warning: 1, error: 0 },
        },
        onRefresh: vi.fn(),
        onInspect: vi.fn(),
        onLoadEffective: vi.fn(),
        onOpenSource: vi.fn(),
        onToggleAssetStatus: vi.fn(),
        onRescanAfterEdit: vi.fn(),
        onCloseInspect: vi.fn(),
        onLocateDiagnostic: vi.fn(),
      }),
    );

    expect(workspaceHtml).toContain("Workspace diagnostics");
    expect(workspaceHtml).toContain("Counts reflect every indexed asset");
  });

  it("pluralizes one asset error without suggesting multiple errors", () => {
    const html = renderToStaticMarkup(
      createElement(AssetsView, {
        state: {
          ...initialState,
          assets: [
            assetSummaryFixture("asset-1", "rule:.cursor/rules/agents.mdc", {
              info: 0,
              warning: 0,
              error: 1,
            }),
          ],
          diagnosticCounts: { info: 0, warning: 0, error: 1 },
        },
        onRefresh: vi.fn(),
        onInspect: vi.fn(),
        onLoadEffective: vi.fn(),
        onOpenSource: vi.fn(),
        onToggleAssetStatus: vi.fn(),
        onRescanAfterEdit: vi.fn(),
        onCloseInspect: vi.fn(),
        onLocateDiagnostic: vi.fn(),
      }),
    );

    expect(html).toContain("<strong>1 error</strong>");
    expect(html).toContain("<td>1 error</td>");
    expect(html).not.toContain("1 errors");
  });

  it("summarizes every nonzero diagnostic severity in asset table rows", () => {
    const html = renderToStaticMarkup(
      createElement(AssetsView, {
        state: {
          ...initialState,
          assets: [
            assetSummaryFixture("asset-1", "rule:AGENTS", {
              info: 1,
              warning: 1,
              error: 0,
            }),
            assetSummaryFixture("asset-2", "skill:release", {
              info: 0,
              warning: 0,
              error: 0,
            }),
          ],
        },
        onRefresh: vi.fn(),
        onInspect: vi.fn(),
        onLoadEffective: vi.fn(),
        onOpenSource: vi.fn(),
        onToggleAssetStatus: vi.fn(),
        onRescanAfterEdit: vi.fn(),
        onCloseInspect: vi.fn(),
        onLocateDiagnostic: vi.fn(),
      }),
    );

    expect(html).toContain("<td>1 warning, 1 info</td>");
    expect(html).toContain("<td>No diagnostics</td>");
    expect(html).not.toContain("<td>0 errors</td>");
  });

  it("renders asset resource types as compact quick-switching tabs", () => {
    const html = renderToStaticMarkup(
      createElement(AssetsView, {
        state: {
          ...initialState,
          assets: [
            assetSummaryFixture(
              "asset-rule",
              "rule:AGENTS",
              { info: 0, warning: 1, error: 0 },
              { resourceType: "rule", status: "disabled" },
            ),
            assetSummaryFixture(
              "asset-skill",
              "skill:release",
              { info: 0, warning: 0, error: 0 },
              { resourceType: "skill" },
            ),
            assetSummaryFixture(
              "asset-mcp",
              "mcp:github",
              { info: 1, warning: 0, error: 0 },
              { resourceType: "mcp" },
            ),
          ],
        },
        onRefresh: vi.fn(),
        onInspect: vi.fn(),
        onLoadEffective: vi.fn(),
        onOpenSource: vi.fn(),
        onToggleAssetStatus: vi.fn(),
        onRescanAfterEdit: vi.fn(),
        onCloseInspect: vi.fn(),
        onLocateDiagnostic: vi.fn(),
      }),
    );

    expect(html).toContain('class="asset-type-tabs"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-controls="asset-panel-rule"');
    expect(html).toContain('aria-controls="asset-panel-skill"');
    expect(html).toContain('aria-controls="asset-panel-mcp"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('id="asset-panel-rule"');
    expect(html).toContain('class="asset-type-group" aria-label="Rule assets"');
    expect(html).toContain('class="asset-row-compact"');
    expect(html).toContain('class="asset-row-meta"');
    expect(html).toContain('class="asset-status disabled"');
    expect(html).toContain("Disabled");
    expect(html).toContain("<h2>Rule assets</h2>");
    expect(html).toContain("<strong>Skill</strong><span>1 asset</span>");
    expect(html).toContain("<strong>MCP</strong><span>1 asset</span>");
    expect(html.indexOf("<h2>Rule assets</h2>")).toBeLessThan(html.indexOf("rule:AGENTS"));
    expect(html).not.toContain("skill:release");
    expect(html).not.toContain("mcp:github");
    expect(html).not.toContain('class="asset-groups"');
    expect(html).not.toContain("<th>Type</th>");
  });

  it("shows scan progress and detailed failures inside asset review", () => {
    const html = renderToStaticMarkup(
      createElement(AssetsView, {
        state: {
          ...initialState,
          activeTask: {
            taskId: "task:scan:asset-review",
            taskKind: "scan",
            phase: "reading",
            status: "running",
            progress: { phase: "reading", completed: 42, total: 120, unit: "files" },
            message: "scan reading: 42/120 files",
            recoveryLock: false,
            failure: {
              itemRef: "/workspace/.cursor/rules/broken.mdc",
              errorCode: "SCAN_READ_FAILED",
              retryable: true,
            },
          },
        },
        onRefresh: vi.fn(),
        onInspect: vi.fn(),
        onLoadEffective: vi.fn(),
        onOpenSource: vi.fn(),
        onToggleAssetStatus: vi.fn(),
        onRescanAfterEdit: vi.fn(),
        onCloseInspect: vi.fn(),
        onLocateDiagnostic: vi.fn(),
      }),
    );

    expect(html).toContain('class="scan-task-panel"');
    expect(html).toContain('aria-label="Scan status"');
    expect(html).toContain("Scanning assets");
    expect(html).toContain("Reading");
    expect(html).toContain("42/120 files");
    expect(html).toContain("/workspace/.cursor/rules/broken.mdc");
    expect(html).toContain("SCAN_READ_FAILED");
    expect(html).toContain("Retryable");
  });

  it("renders inspected asset detail as a modal dialog instead of an inline panel", () => {
    const html = renderToStaticMarkup(
      createElement(AssetsView, {
        state: {
          ...initialState,
          assets: [assetSummaryFixture("asset-1", "rule:AGENTS")],
          assetDetail: assetDetailFixture("asset-1", "rule:AGENTS"),
        },
        onRefresh: vi.fn(),
        onInspect: vi.fn(),
        onLoadEffective: vi.fn(),
        onOpenSource: vi.fn(),
        onToggleAssetStatus: vi.fn(),
        onRescanAfterEdit: vi.fn(),
        onCloseInspect: vi.fn(),
        onLocateDiagnostic: vi.fn(),
      }),
    );

    expect(html).toContain('class="asset-detail-modal"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Asset detail"');
    expect(html).toContain('class="asset-detail-dialog"');
    expect(html).toContain('class="asset-detail-scroll"');
    expect(html).toContain("Status</dt><dd>Enabled</dd>");
    expect(html).toContain("Disable asset");
    expect(html).toContain(">Close</button>");
    expect(html).not.toContain('<section class="detail-panel" aria-label="Asset detail">');
  });

  it("enables disabled assets from the asset detail modal", () => {
    const detail = assetDetailFixture("asset-1", "rule:AGENTS");
    const html = renderToStaticMarkup(
      createElement(AssetsView, {
        state: {
          ...initialState,
          assets: [
            {
              ...assetSummaryFixture("asset-1", "rule:AGENTS"),
              status: "disabled",
            },
          ],
          assetDetail: {
            ...detail,
            asset: { ...detail.asset, status: "disabled" },
          },
        },
        onRefresh: vi.fn(),
        onInspect: vi.fn(),
        onLoadEffective: vi.fn(),
        onOpenSource: vi.fn(),
        onToggleAssetStatus: vi.fn(),
        onRescanAfterEdit: vi.fn(),
        onCloseInspect: vi.fn(),
        onLocateDiagnostic: vi.fn(),
      }),
    );

    expect(html).toContain('class="asset-status disabled"');
    expect(html).toContain("Status</dt><dd>Disabled</dd>");
    expect(html).toContain("Enable asset");
  });

  it("renders migration as an independent source and target project comparison", () => {
    const html = renderToStaticMarkup(
      createElement(MigrationView, {
        state: {
          ...initialState,
          projectRoot: "/workspace/review-only",
          migration: {
            ...initialState.migration,
            sourceProjectRoot: "/workspace/source",
            targetScopeId: "/workspace/target",
          },
          migrationSourceAssets: [assetSummaryFixture("asset:codex:rule:agents", "rule:AGENTS")],
          migrationTargetAssets: [
            assetSummaryFixture(
              "asset-target-replace",
              "rule:.cursor/rules/agents.mdc",
              undefined,
              {
                contentHash: ContentHashSchema.parse(`sha256:${"e".repeat(64)}`),
                sourceDirectory: "/workspace/target/.cursor/rules",
                toolKey: "cursor",
              },
            ),
            assetSummaryFixture("asset-target-only", "rule:.cursor/rules/local.mdc", undefined, {
              sourceDirectory: "/workspace/target/.cursor/rules",
              toolKey: "cursor",
            }),
            assetSummaryFixture("asset-target-other-tool", "rule:codex-only", undefined, {
              toolKey: "codex",
            }),
            assetSummaryFixture("asset-target-other-type", "skill:release", undefined, {
              resourceType: "skill",
              toolKey: "cursor",
            }),
          ],
          preview: previewFixture(["overwrite", "partial_conversion"], "asset:codex:rule:agents"),
        },
        onPreview: vi.fn(),
        onToggleSource: vi.fn(),
        onTargetTool: vi.fn(),
        onConflictPolicy: vi.fn(),
        onConfirmMigration: vi.fn(),
        onConfirmRequirement: vi.fn(),
        onExecuteMigration: vi.fn(),
      }),
    );

    expect(html).toContain("<h1>Asset Migration</h1>");
    expect(html).toContain('class="migration-project-picker"');
    expect(html).toContain('class="migration-project-card source"');
    expect(html).toContain('class="migration-project-card target"');
    expect(html).toContain("Source project");
    expect(html).toContain("Target project");
    expect(html).toContain("/workspace/source");
    expect(html).toContain("/workspace/target");
    expect(html).toContain('aria-label="Swap source and target"');
    expect(html).toContain(">⇄</button>");
    expect(html).not.toContain("Scan source");
    expect(html).not.toContain('type="text"');
    expect(html).toContain('class="migration-comparison-body"');
    expect(html).toContain('class="migration-source-panel panel"');
    expect(html).toContain('class="migration-difference-summary"');
    expect(html).toContain('class="migration-target-panel panel"');
    expect(html).toContain("Added to target");
    expect(html).toContain("Overwritten in target");
    expect(html).toContain("Target assets");
    expect(html).toContain("Target tool");
    expect(html).toContain("Cursor");
    expect(html).toContain("Source asset");
    expect(html).toContain("Hash change");
    expect(html).toContain('class="target-change-row is-replace"');
    expect(html).toContain('class="target-change-row is-existing"');
    expect(html).toContain("2 assets");
    expect(html).toContain("Rule");
    expect(html).toContain("<strong>Agent</strong><span>0 differences</span>");
    expect(html).toContain("<strong>Skill</strong><span>0 differences</span>");
    expect(html).toContain("<strong>MCP</strong><span>0 differences</span>");
    expect(html).toContain("1 difference");
    expect(html).toContain("rule:AGENTS");
    expect(html).toContain("rule:.cursor/rules/local.mdc");
    expect(html).toContain(".cursor/rules/agents.mdc");
    expect(html).not.toContain("rule:codex-only");
    expect(html).not.toContain("skill:release");
    expect(html).toContain(
      "Confirmations: Overwrite existing target files. Deploy a partial conversion with documented warnings.",
    );
    expect(html).not.toContain("/workspace/review-only");
    expect(html).not.toContain("Selected project folder");
    expect(html).not.toContain("Plan deployment-plan:audit-preview");
    expect(html).not.toContain("2026-06-28T08:10:00.000Z");
    expect(html).not.toContain("asset:codex:rule:agents");
  });

  it("shows source scan progress and detailed failures inside asset migration", () => {
    const html = renderToStaticMarkup(
      createElement(MigrationView, {
        state: {
          ...initialState,
          migration: {
            ...initialState.migration,
            sourceProjectRoot: "/workspace/source",
            targetScopeId: "/workspace/target",
          },
          activeTask: {
            taskId: "task:scan:migration-source",
            taskKind: "scan",
            phase: "parsing",
            status: "partially_succeeded",
            progress: { phase: "parsing", completed: 99, total: 100, unit: "files" },
            message: "Scan partially complete: 98 succeeded, 1 failed, 1 skipped.",
            recoveryLock: false,
            failure: {
              itemRef: "/workspace/source/.claude/agents/reviewer.md",
              errorCode: "FRONTMATTER_INVALID",
              retryable: false,
            },
          },
        },
        onPreview: vi.fn(),
        onToggleSource: vi.fn(),
        onTargetTool: vi.fn(),
        onConflictPolicy: vi.fn(),
        onConfirmMigration: vi.fn(),
        onConfirmRequirement: vi.fn(),
        onExecuteMigration: vi.fn(),
      }),
    );

    expect(html).toContain('class="scan-task-panel"');
    expect(html).toContain('aria-label="Source scan status"');
    expect(html).toContain("Source scan");
    expect(html).toContain("Parsing");
    expect(html).toContain("99/100 files");
    expect(html).toContain("/workspace/source/.claude/agents/reviewer.md");
    expect(html).toContain("FRONTMATTER_INVALID");
    expect(html).toContain("Not retryable");
  });

  it("shows target project assets before preview and filters them by target tool and asset type", () => {
    const html = renderToStaticMarkup(
      createElement(MigrationView, {
        state: {
          ...initialState,
          migration: {
            ...initialState.migration,
            sourceProjectRoot: "/workspace/source",
            targetScopeId: "/workspace/target",
          },
          migrationSourceAssets: [assetSummaryFixture("asset:codex:rule:agents", "rule:AGENTS")],
          migrationTargetAssets: [
            assetSummaryFixture("asset-target-rule", "rule:.cursor/rules/local.mdc", undefined, {
              sourceDirectory: "/workspace/target/.cursor/rules",
              toolKey: "cursor",
            }),
            assetSummaryFixture("asset-target-codex", "rule:codex-target-only", undefined, {
              toolKey: "codex",
            }),
            assetSummaryFixture("asset-target-skill", "skill:release", undefined, {
              resourceType: "skill",
              toolKey: "cursor",
            }),
          ],
        },
        onPreview: vi.fn(),
        onToggleSource: vi.fn(),
        onTargetTool: vi.fn(),
        onConflictPolicy: vi.fn(),
        onConfirmMigration: vi.fn(),
        onConfirmRequirement: vi.fn(),
        onExecuteMigration: vi.fn(),
      }),
    );

    expect(html).toContain("Target assets");
    expect(html).toContain("rule:.cursor/rules/local.mdc");
    expect(html).toContain('class="target-change-row is-existing"');
    expect(html).toContain("1 asset");
    expect(html).not.toContain("Preview writes to see target impact.");
    expect(html).not.toContain("rule:codex-target-only");
    expect(html).not.toContain("skill:release");
  });

  it("renders detailed workflow states in Simplified Chinese", () => {
    const zhSettings: AppState["settings"] = {
      ...initialState.settings,
      values: { theme: "system", language: "zh-CN" },
      status: "ready",
    };
    const assetDetail = assetDetailFixture("asset-1", "rule:AGENTS");

    const assetsHtml = renderToStaticMarkup(
      createElement(AssetsView, {
        state: {
          ...initialState,
          settings: zhSettings,
          assets: [assetSummaryFixture("asset-1", "rule:AGENTS")],
          assetDetail: {
            ...assetDetail,
            asset: {
              ...assetDetail.asset,
              references: ["README.md"],
              normalized: { body: "Use local TypeScript conventions." },
            },
          },
          effective: {
            effective: { body: "Use local TypeScript conventions." },
            contributors: [],
            ignored: [],
            diagnostics: [],
            snapshotRevision: "revision-1",
          },
        },
        onRefresh: vi.fn(),
        onInspect: vi.fn(),
        onLoadEffective: vi.fn(),
        onOpenSource: vi.fn(),
        onToggleAssetStatus: vi.fn(),
        onRescanAfterEdit: vi.fn(),
        onCloseInspect: vi.fn(),
        onLocateDiagnostic: vi.fn(),
      }),
    );
    const migrationHtml = renderToStaticMarkup(
      createElement(MigrationView, {
        state: {
          ...initialState,
          settings: zhSettings,
          projectRoot: "/workspace/source",
          migration: { ...initialState.migration, targetScopeId: "/workspace/target" },
          migrationSourceAssets: [assetSummaryFixture("asset:codex:rule:agents", "rule:AGENTS")],
          preview: previewFixture(["overwrite", "partial_conversion"], "asset:codex:rule:agents"),
        },
        onPreview: vi.fn(),
        onToggleSource: vi.fn(),
        onTargetTool: vi.fn(),
        onConflictPolicy: vi.fn(),
        onConfirmMigration: vi.fn(),
        onConfirmRequirement: vi.fn(),
        onExecuteMigration: vi.fn(),
      }),
    );

    expect(assetsHtml).toContain('aria-label="资产详情"');
    expect(assetsHtml).toContain("检查资产");
    expect(assetsHtml).toContain("打开来源");
    expect(assetsHtml).toContain("状态</dt><dd>已启用</dd>");
    expect(assetsHtml).toContain("<h3>引用</h3>");
    expect(assetsHtml).toContain("<h3>标准化</h3>");
    expect(assetsHtml).toContain("<h3>有效配置</h3>");
    expect(assetsHtml).toContain("无贡献资产。");
    expect(assetsHtml).toContain("无有效诊断。");
    expect(migrationHtml).toContain("计划 audit-preview");
    expect(migrationHtml).toContain("兼容性：部分");
    expect(migrationHtml).toContain("确认项：覆盖现有目标文件。 部署包含警告的部分转换。");
    expect(migrationHtml).toContain("替换文件 .cursor/rules/agents.mdc");
  });
});

function assetSummaryFixture(
  id: string,
  logicalKey: string,
  diagnosticCounts: AppState["diagnosticCounts"] = { info: 0, warning: 1, error: 0 },
  overrides: Partial<
    Pick<
      AppState["assets"][number],
      | "toolKey"
      | "resourceType"
      | "scopeKind"
      | "status"
      | "sourceDirectory"
      | "loadState"
      | "contentHash"
    >
  > = {},
): AppState["assets"][number] {
  return {
    id: AssetIdSchema.parse(id),
    toolKey: overrides.toolKey ?? "claude-code",
    resourceType: overrides.resourceType ?? "rule",
    scopeKind: overrides.scopeKind ?? "project",
    logicalKey,
    sourceDirectory: overrides.sourceDirectory ?? "/workspace",
    loadState: overrides.loadState ?? "loaded",
    contentHash: overrides.contentHash ?? ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
    status: overrides.status ?? "enabled",
    diagnosticCounts,
  };
}

function assetDetailFixture(id: string, logicalKey: string): NonNullable<AppState["assetDetail"]> {
  return {
    asset: {
      id: AssetIdSchema.parse(id),
      toolKey: "codex",
      resourceType: "rule",
      scopeId: ScopeIdSchema.parse("/workspace"),
      logicalKey,
      status: "enabled",
      disablementOptions: [
        {
          method: "move_file",
          label: "Move file out of the tool load path",
          description: "Move the source file into the AI Config Hub disabled-assets area.",
          recommended: false,
        },
        {
          method: "hub_ignore",
          label: "Ignore inside AI Config Hub only",
          description: "Keep the tool configuration unchanged and ignore the asset in Hub.",
          recommended: true,
        },
      ],
    },
    source: {
      pathDisplay: "/workspace/AGENTS.md",
      contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
      observedAt: "2026-06-28T08:00:00.000Z",
      files: [
        {
          pathDisplay: "/workspace/AGENTS.md",
          relativePath: "AGENTS.md",
          role: "primary",
          mediaType: "text/markdown",
          isText: true,
          contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
        },
      ],
    },
    redactions: [],
  };
}

function previewFixture(
  requiredConfirmations: NonNullable<AppState["preview"]>["requiredConfirmations"],
  sourceAssetId = "asset-1",
): NonNullable<AppState["preview"]> {
  return {
    planId: DeploymentPlanIdSchema.parse("deployment-plan:audit-preview"),
    planHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
    compatibility: "partial",
    fieldLosses: [],
    requiredConfirmations,
    changes: [
      {
        operation: "replace",
        deploymentType: "generated_file",
        pathDisplay: ".cursor/rules/agents.mdc",
        beforeHash: ContentHashSchema.parse(`sha256:${"e".repeat(64)}`),
        afterHash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
        diff: "+ Use local TypeScript conventions.",
      },
    ],
    warnings: [],
    sourceHashes: {
      [AssetIdSchema.parse(sourceAssetId)]: ContentHashSchema.parse(`sha256:${"1".repeat(64)}`),
    },
    targetHashes: {},
    expiresAt: "2026-06-28T08:10:00.000Z",
  };
}
