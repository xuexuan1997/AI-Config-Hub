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
    expect(html).toContain(">Close</button>");
    expect(html).not.toContain('<section class="detail-panel" aria-label="Asset detail">');
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
    expect(html).toContain("<strong>Warning: Partial conversion</strong>");
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
});

function renderAssets(statePatch: Partial<AppState>): string {
  return renderToStaticMarkup(
    createElement(AssetsView, {
      state: { ...initialState, ...statePatch },
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
      logicalKey,
    },
    source: {
      pathDisplay: "/workspace/AGENTS.md",
      contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
      observedAt: "2026-06-28T08:00:00.000Z",
    },
    redactions: [],
  };
}
