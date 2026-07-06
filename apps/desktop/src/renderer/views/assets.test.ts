import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AssetIdSchema,
  ContentHashSchema,
  DiagnosticIdSchema,
  ScopeIdSchema,
} from "@ai-config-hub/shared";
import { describe, expect, it, vi } from "vitest";

import { initialState, reducer, type AppState } from "../model.js";
import { AssetsView } from "./assets.js";

describe("AssetsView", () => {
  it("renders asset resource types as quick-switching tabs", () => {
    const html = renderAssets({
      assets: [
        assetSummaryFixture(
          "asset-rule",
          "rule:AGENTS",
          { resourceType: "rule" },
          {
            info: 0,
            warning: 1,
            error: 0,
          },
        ),
        assetSummaryFixture(
          "asset-skill",
          "skill:release",
          { resourceType: "skill" },
          {
            info: 0,
            warning: 0,
            error: 0,
          },
        ),
        assetSummaryFixture(
          "asset-mcp",
          "mcp:github",
          { resourceType: "mcp" },
          {
            info: 1,
            warning: 0,
            error: 0,
          },
        ),
      ],
    });

    expect(html).toContain('class="asset-type-tabs"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-controls="asset-panel-rule"');
    expect(html).toContain('aria-controls="asset-panel-skill"');
    expect(html).toContain('aria-controls="asset-panel-mcp"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('id="asset-panel-rule"');
    expect(html).toContain('class="asset-row-compact"');
    expect(html).toContain('class="asset-row-meta"');
    expect(html).toContain("Rule");
    expect(html).toContain("Skill");
    expect(html).toContain("MCP");
    expect(html).toContain("rule:AGENTS");
    expect(html).not.toContain("skill:release");
    expect(html).not.toContain("mcp:github");
    expect(html).not.toContain('class="asset-groups"');
    expect(html).not.toContain("<th>Type</th>");
  });

  it("defaults to Claude Code assets and renders the review table columns", () => {
    const html = renderAssets({
      assets: [
        assetSummaryFixture("asset-claude-root", "mcp:docs", {
          toolKey: "claude-code",
          resourceType: "mcp",
          sourceDirectory: "/workspace",
          loadState: "covered",
          coveredByLogicalKey: "mcp:docs",
        }),
        assetSummaryFixture("asset-claude-nested", "mcp:docs", {
          toolKey: "claude-code",
          resourceType: "mcp",
          sourceDirectory: "/workspace/src",
          loadState: "loaded",
        }),
        assetSummaryFixture("asset-codex", "mcp:docs", {
          toolKey: "codex",
          resourceType: "mcp",
          sourceDirectory: "/workspace/.codex",
          loadState: "loaded",
        }),
      ],
    });

    expect(html).toContain('class="tool-filter-list"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(">Claude Code</button>");
    expect(html).toContain(">Codex</button>");
    expect(html).toContain("<th>Logical key</th>");
    expect(html).toContain("<th>Source directory</th>");
    expect(html).toContain("<th>Will load</th>");
    expect(html).toContain("<th>Diagnostics</th>");
    expect(html).toContain("<th>Detail</th>");
    expect(html).not.toContain("<th>Tool</th>");
    expect(html).not.toContain("<th>Resource</th>");
    expect(html).toContain("/workspace");
    expect(html).toContain("/workspace/src");
    expect(html).toContain("No, covered by mcp:docs");
    expect(html).toContain(">Yes</span>");
    expect(html).not.toContain("/workspace/.codex");
  });

  it("opens the rule tab first when assets arrive in another order", () => {
    const html = renderAssets({
      assets: [
        assetSummaryFixture(
          "asset-skill",
          "skill:release",
          { resourceType: "skill" },
          {
            info: 0,
            warning: 0,
            error: 0,
          },
        ),
        assetSummaryFixture("asset-rule", "rule:AGENTS", { resourceType: "rule" }),
      ],
    });

    expect(html).toContain('aria-controls="asset-panel-rule" aria-selected="true"');
    expect(html).toContain("<h2>Rule assets</h2>");
    expect(html).toContain("rule:AGENTS");
    expect(html).not.toContain("skill:release");
  });

  it("renders inspected asset detail as a modal dialog instead of an inline panel", () => {
    const html = renderAssets({
      assets: [assetSummaryFixture("asset-1", "rule:AGENTS")],
      assetDetail: assetDetailFixture("asset-1", "rule:AGENTS"),
    });

    expect(html).toContain('class="asset-detail-modal"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Asset detail"');
    expect(html).toContain('class="asset-detail-dialog"');
    expect(html).toContain('class="asset-detail-scroll"');
    expect(html).toContain("Disable impact");
    expect(html).toContain("Only hide it in AI Config Hub");
    expect(html).toContain("Also disables it in the AI tool");
    expect(html).toContain("Choose how far this disable action should go.");
    expect(html).toContain("Recommended");
    expect(html).toContain(
      '<button class="disable-asset-primary" type="button">Disable asset</button>',
    );
    expect(html).toContain(">Close</button>");
    expect(html).not.toContain('<section class="detail-panel" aria-label="Asset detail">');
  });

  it("renders package member source files for multi-file assets", () => {
    const detail = assetDetailFixture("asset-1", "skill:release");
    const html = renderAssets({
      assets: [assetSummaryFixture("asset-1", "skill:release", { resourceType: "skill" })],
      assetDetail: {
        ...detail,
        asset: { ...detail.asset, resourceType: "skill" },
        source: {
          ...detail.source,
          files: [
            {
              pathDisplay: "/workspace/.codex/skills/release/SKILL.md",
              relativePath: "SKILL.md",
              role: "primary",
              mediaType: "text/markdown",
              isText: true,
              contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
            },
            {
              pathDisplay: "/workspace/.codex/skills/release/assets/logo.png",
              relativePath: "assets/logo.png",
              role: "support",
              mediaType: "image/png",
              isText: false,
              contentHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
            },
          ],
        },
      },
    });

    expect(html).toContain("Source package files");
    expect(html).toContain("SKILL.md");
    expect(html).toContain("assets/logo.png");
    expect(html).toContain("support");
    expect(html).toContain("image/png / binary");
  });

  it("renders disablement options as an accessible radio group defaulting to the recommended method", () => {
    const html = renderAssets({
      assets: [assetSummaryFixture("asset-1", "rule:AGENTS")],
      assetDetail: assetDetailFixture("asset-1", "rule:AGENTS"),
    });

    expect(html).toContain('<fieldset class="disable-methods">');
    expect(html).toContain("<legend>Disable impact</legend>");
    expect(html).toContain(
      'type="radio" name="disable-method-asset-1" checked="" value="hub_ignore"',
    );
    expect(html).toContain('type="radio" name="disable-method-asset-1" value="move_file"');
    expect(html).toContain("Only hide it in AI Config Hub");
    expect(html).toContain("Also disables it in the AI tool");
    expect(html).toContain("Recommended");
    expect(html).toContain(
      '<button class="disable-asset-primary" type="button">Disable asset</button>',
    );
  });

  it("localizes disablement option guidance in Simplified Chinese", () => {
    const html = renderAssets({
      settings: {
        ...initialState.settings,
        values: { ...initialState.settings.values, language: "zh-CN" },
      },
      assets: [assetSummaryFixture("asset-1", "rule:AGENTS")],
      assetDetail: assetDetailFixture("asset-1", "rule:AGENTS"),
    });

    expect(html).toContain("禁用影响");
    expect(html).toContain("也在 AI 工具中禁用");
    expect(html).toContain("仅在 AI Config Hub 中隐藏");
    expect(html).toContain("选择这次禁用会影响到哪里。");
    expect(html).not.toContain("Move file out of the tool load path");
    expect(html).not.toContain("Ignore inside AI Config Hub only");
  });

  it("does not show disablement method selection when restoring a disabled asset", () => {
    const detail = assetDetailFixture("asset-1", "rule:AGENTS");
    const html = renderAssets({
      assets: [assetSummaryFixture("asset-1", "rule:AGENTS", { status: "disabled" })],
      assetDetail: { ...detail, asset: { ...detail.asset, status: "disabled" } },
    });

    expect(html).toContain('class="asset-status-control disabled"');
    expect(html).toContain("Asset is disabled");
    expect(html).toContain(
      "Enable it to include it again in review, effective configuration, and migration.",
    );
    expect(html).toContain(
      '<button class="enable-asset-primary" type="button">Enable asset</button>',
    );
    expect(html).not.toContain('<fieldset class="disable-methods">');
    expect(html).not.toContain("<legend>Disable method</legend>");
    expect(html).not.toContain('type="radio"');
  });

  it("shows asset status operation messages inside the open detail dialog", () => {
    const html = renderAssets({
      assets: [assetSummaryFixture("asset-1", "rule:AGENTS", { status: "disabled" })],
      assetDetail: assetDetailFixture("asset-1", "rule:AGENTS"),
      message: "Cannot restore disabled asset because a file already exists at the original path",
    });

    expect(html).toContain('class="asset-detail-message"');
    expect(html).toContain(
      "Cannot restore disabled asset because a file already exists at the original path",
    );
  });

  it("clears inspected asset detail and effective configuration when inspect closes", () => {
    const detail = assetDetailFixture("asset-1", "rule:AGENTS");
    const effective = {
      effective: { rules: ["Use tests."] },
      contributors: [],
      ignored: [],
      diagnostics: [],
      snapshotRevision: "revision-1",
    };
    const withDetail = reducer(initialState, { type: "assetDetail", detail });
    const withEffective = reducer(withDetail, { type: "effective", effective });
    const closed = reducer(withEffective, { type: "assetDetailClosed" });

    expect(closed.assetDetail).toBeUndefined();
    expect(closed.effective).toBeUndefined();
  });

  it("shows selected asset diagnostics inside the asset detail dialog", () => {
    const html = renderAssets({
      assets: [assetSummaryFixture("asset-1", "rule:AGENTS")],
      assetDetail: assetDetailFixture("asset-1", "rule:AGENTS"),
      diagnostics: [
        {
          id: DiagnosticIdSchema.parse("diagnostic-1"),
          code: "PARTIAL_CONVERSION",
          severity: "warning",
          assetId: AssetIdSchema.parse("asset-1"),
          message: "One field cannot be represented by the target tool.",
          suggestedAction: "Review the generated output before deployment.",
          blocking: false,
        },
      ],
      diagnosticCounts: { info: 0, warning: 1, error: 0 },
    });

    expect(html).toContain('class="asset-detail-diagnostics"');
    expect(html).toContain("<h3>Diagnostics</h3>");
    expect(html).toContain('<span class="diagnostic-severity-pill warning">Warning</span>');
    expect(html).toContain("<strong>Partial conversion</strong>");
    expect(html).toContain("One field cannot be represented by the target tool.");
    expect(html).not.toContain(
      '<section class="detail-panel" aria-label="Diagnostics for rule:AGENTS">',
    );
  });

  it("keeps resource type keywords untranslated in Simplified Chinese", () => {
    const html = renderAssets({
      settings: {
        ...initialState.settings,
        values: { ...initialState.settings.values, language: "zh-CN" },
      },
      assets: [
        assetSummaryFixture("asset-rule", "rule:AGENTS", { resourceType: "rule" }),
        assetSummaryFixture("asset-agent", "agent:reviewer", { resourceType: "agent" }),
        assetSummaryFixture("asset-mcp", "mcp:docs", { resourceType: "mcp" }),
      ],
    });

    expect(html).toContain("<strong>rule</strong>");
    expect(html).toContain("<strong>agent</strong>");
    expect(html).toContain("<strong>MCP</strong>");
  });

  it("localizes workspace diagnostic text in Simplified Chinese", () => {
    const html = renderAssets({
      settings: {
        ...initialState.settings,
        values: { ...initialState.settings.values, language: "zh-CN" },
      },
      diagnostics: [
        {
          id: DiagnosticIdSchema.parse("diagnostic-1"),
          code: "SCAN_READ_FAILED",
          severity: "warning",
          assetId: AssetIdSchema.parse("asset-1"),
          message: "The configuration file could not be read safely",
          suggestedAction: "Check file permissions and retry the scan",
          blocking: false,
        },
      ],
      diagnosticCounts: { info: 0, warning: 1, error: 0 },
    });

    expect(html).toContain("扫描读取失败");
    expect(html).toContain("无法安全读取配置文件。");
    expect(html).toContain("检查文件权限后重新扫描。");
    expect(html).not.toContain("Scan read failed");
    expect(html).not.toContain("The configuration file could not be read safely");
    expect(html).not.toContain("Check file permissions and retry the scan");
  });

  it("renders workspace diagnostic filters by severity and diagnostic code", () => {
    const html = renderAssets({
      diagnostics: [
        diagnosticFixture("diagnostic-warning", "SCAN_READ_FAILED", "warning"),
        diagnosticFixture("diagnostic-error", "MCP_LITERAL_SECRET_RISK", "error"),
      ],
      diagnosticCounts: { info: 0, warning: 1, error: 1 },
    });

    expect(html).toContain('class="diagnostic-filter-bar diagnostic-filter-surface"');
    expect(html).toContain('aria-label="Diagnostic severity filters"');
    expect(html).toContain(">All diagnostics</button>");
    expect(html).toContain(">Errors 1</button>");
    expect(html).toContain(">Warnings 1</button>");
    expect(html).toContain('aria-label="Diagnostic code filter"');
    expect(html).toContain('<option value="__all__" selected="">All diagnostic codes</option>');
    expect(html).toContain(
      '<option value="MCP_LITERAL_SECRET_RISK">MCP_LITERAL_SECRET_RISK</option>',
    );
    expect(html).toContain('<option value="SCAN_READ_FAILED">SCAN_READ_FAILED</option>');
  });

  it("renders workspace diagnostics as a compact review panel", () => {
    const html = renderAssets({
      diagnostics: [
        diagnosticFixture("diagnostic-warning", "SCAN_READ_FAILED", "warning"),
        diagnosticFixture("diagnostic-error", "MCP_LITERAL_SECRET_RISK", "error"),
      ],
      diagnosticCounts: { info: 0, warning: 1, error: 1 },
    });

    expect(html).toContain('class="diagnostic-panel-header"');
    expect(html).toContain('class="diagnostic-result-summary"');
    expect(html).toContain("2 shown of 2");
    expect(html).toContain('class="diagnostic-filter-bar diagnostic-filter-surface"');
    expect(html).toContain('class="diagnostic-row warning"');
    expect(html).toContain('class="diagnostic-row error"');
    expect(html).toContain('class="diagnostic-severity-pill warning"');
    expect(html).toContain('class="diagnostic-severity-pill error"');
    expect(html).toContain('class="diagnostic-row-action"');
  });

  it("filters workspace diagnostics by warning severity", () => {
    const html = renderAssets(
      {
        diagnostics: [
          diagnosticFixture("diagnostic-warning", "SCAN_READ_FAILED", "warning"),
          diagnosticFixture("diagnostic-error", "MCP_LITERAL_SECRET_RISK", "error"),
        ],
        diagnosticCounts: { info: 0, warning: 1, error: 1 },
      },
      { initialDiagnosticSeverity: "warning" },
    );

    expect(html).toContain('<span class="diagnostic-severity-pill warning">Warning</span>');
    expect(html).toContain("<strong>Scan read failed</strong>");
    expect(html).not.toContain('<span class="diagnostic-severity-pill error">Error</span>');
    expect(html).not.toContain("<strong>Mcp literal secret risk</strong>");
  });

  it("filters workspace diagnostics by diagnostic code", () => {
    const html = renderAssets(
      {
        diagnostics: [
          diagnosticFixture("diagnostic-warning", "SCAN_READ_FAILED", "warning"),
          diagnosticFixture("diagnostic-error", "MCP_LITERAL_SECRET_RISK", "error"),
        ],
        diagnosticCounts: { info: 0, warning: 1, error: 1 },
      },
      { initialDiagnosticCode: "MCP_LITERAL_SECRET_RISK" },
    );

    expect(html).toContain('<span class="diagnostic-severity-pill error">Error</span>');
    expect(html).toContain("<strong>Mcp literal secret risk</strong>");
    expect(html).not.toContain('<span class="diagnostic-severity-pill warning">Warning</span>');
    expect(html).not.toContain("<strong>Scan read failed</strong>");
  });

  it("resets a stale diagnostic code when the selected severity excludes it", () => {
    const html = renderAssets(
      {
        diagnostics: [
          diagnosticFixture("diagnostic-warning", "SCAN_READ_FAILED", "warning"),
          diagnosticFixture("diagnostic-error", "MCP_LITERAL_SECRET_RISK", "error"),
        ],
        diagnosticCounts: { info: 0, warning: 1, error: 1 },
      },
      { initialDiagnosticSeverity: "warning", initialDiagnosticCode: "MCP_LITERAL_SECRET_RISK" },
    );

    expect(html).toContain('<option value="__all__" selected="">All diagnostic codes</option>');
    expect(html).toContain('<span class="diagnostic-severity-pill warning">Warning</span>');
    expect(html).toContain("<strong>Scan read failed</strong>");
    expect(html).not.toContain('<span class="diagnostic-severity-pill error">Error</span>');
    expect(html).not.toContain("<strong>Mcp literal secret risk</strong>");
  });

  it("shows a localized empty state when workspace diagnostic filters have no matches", () => {
    const html = renderAssets(
      {
        settings: {
          ...initialState.settings,
          values: { ...initialState.settings.values, language: "zh-CN" },
        },
        diagnostics: [diagnosticFixture("diagnostic-warning", "SCAN_READ_FAILED", "warning")],
        diagnosticCounts: { info: 0, warning: 1, error: 0 },
      },
      { initialDiagnosticSeverity: "error" },
    );

    expect(html).toContain("没有匹配当前筛选的诊断。");
    expect(html).not.toContain("扫描读取失败");
  });
});

function renderAssets(
  statePatch: Partial<AppState>,
  propsPatch: Pick<
    Parameters<typeof AssetsView>[0],
    "initialDiagnosticSeverity" | "initialDiagnosticCode"
  > = {},
): string {
  return renderToStaticMarkup(
    createElement(AssetsView, {
      state: { ...initialState, ...statePatch },
      ...(propsPatch.initialDiagnosticSeverity === undefined
        ? {}
        : { initialDiagnosticSeverity: propsPatch.initialDiagnosticSeverity }),
      ...(propsPatch.initialDiagnosticCode === undefined
        ? {}
        : { initialDiagnosticCode: propsPatch.initialDiagnosticCode }),
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
}

function diagnosticFixture(
  id: string,
  code: string,
  severity: AppState["diagnostics"][number]["severity"],
): AppState["diagnostics"][number] {
  return {
    id: DiagnosticIdSchema.parse(id),
    code,
    severity,
    assetId: AssetIdSchema.parse("asset-1"),
    message:
      code === "SCAN_READ_FAILED"
        ? "The configuration file could not be read safely"
        : "MCP configuration appears to contain a literal secret; prefer an environment reference",
    suggestedAction:
      code === "SCAN_READ_FAILED"
        ? "Check file permissions and retry the scan"
        : "Review the source configuration and scan again",
    blocking: severity === "error",
  };
}

function assetSummaryFixture(
  id: string,
  logicalKey: string,
  overrides: Partial<
    Pick<
      AppState["assets"][number],
      | "toolKey"
      | "resourceType"
      | "scopeKind"
      | "sourceDirectory"
      | "loadState"
      | "coveredByLogicalKey"
      | "status"
    >
  > = {},
  diagnosticCounts: AppState["diagnosticCounts"] = { info: 0, warning: 1, error: 0 },
): AppState["assets"][number] {
  return {
    id: AssetIdSchema.parse(id),
    toolKey: overrides.toolKey ?? "claude-code",
    resourceType: overrides.resourceType ?? "rule",
    scopeKind: overrides.scopeKind ?? "project",
    status: "enabled",
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
    logicalKey,
    ...(overrides.sourceDirectory === undefined
      ? {}
      : { sourceDirectory: overrides.sourceDirectory }),
    ...(overrides.loadState === undefined ? {} : { loadState: overrides.loadState }),
    ...(overrides.coveredByLogicalKey === undefined
      ? {}
      : { coveredByLogicalKey: overrides.coveredByLogicalKey }),
    contentHash: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
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
      logicalKey,
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
