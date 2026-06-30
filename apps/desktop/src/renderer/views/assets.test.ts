import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssetIdSchema, ContentHashSchema, ScopeIdSchema } from "@ai-config-hub/shared";
import { describe, expect, it, vi } from "vitest";

import { initialState, reducer, type AppState } from "../model.js";
import { AssetsView } from "./assets.js";

describe("AssetsView", () => {
  it("groups assets by resource type in compact sections", () => {
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

    expect(html).toContain('class="asset-groups"');
    expect(html).toContain('class="asset-type-group" aria-label="Rule assets"');
    expect(html).toContain('class="asset-type-group" aria-label="Skill assets"');
    expect(html).toContain('class="asset-type-group" aria-label="Mcp assets"');
    expect(html).toContain('class="asset-row-compact"');
    expect(html).toContain('class="asset-row-meta"');
    expect(html).toContain("<h2>Rule assets</h2>");
    expect(html).toContain("<h2>Skill assets</h2>");
    expect(html).toContain("<h2>Mcp assets</h2>");
    expect(html.indexOf("<h2>Rule assets</h2>")).toBeLessThan(html.indexOf("rule:AGENTS"));
    expect(html.indexOf("<h2>Skill assets</h2>")).toBeLessThan(html.indexOf("skill:release"));
    expect(html.indexOf("<h2>Mcp assets</h2>")).toBeLessThan(html.indexOf("mcp:github"));
    expect(html).not.toContain("<th>Type</th>");
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
    Pick<AppState["assets"][number], "toolKey" | "resourceType" | "scopeKind">
  > = {},
  diagnosticCounts: AppState["diagnosticCounts"] = { info: 0, warning: 1, error: 0 },
): AppState["assets"][number] {
  return {
    id: AssetIdSchema.parse(id),
    toolKey: overrides.toolKey ?? "codex",
    resourceType: overrides.resourceType ?? "rule",
    scopeKind: overrides.scopeKind ?? "project",
    status: "enabled",
    logicalKey,
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
