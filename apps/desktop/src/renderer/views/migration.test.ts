import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssetIdSchema, ContentHashSchema, DeploymentPlanIdSchema } from "@ai-config-hub/shared";
import { describe, expect, it, vi } from "vitest";

import { initialState, type AppState } from "../model.js";
import { MigrationView } from "./migration.js";

describe("MigrationView", () => {
  it("highlights refreshed source and target list differences before preview", () => {
    const html = renderMigration({
      migration: {
        ...initialState.migration,
        sourceProjectRoot: "/workspace/source",
        targetScopeId: "/workspace/target",
      },
      migrationSourceAssets: [
        assetSummaryFixture("asset-source-shared", "rule:shared", {
          contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
          toolKey: "codex",
        }),
        assetSummaryFixture("asset-source-new", "rule:new", {
          contentHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
          toolKey: "codex",
        }),
      ],
      migrationTargetAssets: [
        assetSummaryFixture("asset-target-shared", "rule:shared", {
          contentHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          toolKey: "cursor",
        }),
        assetSummaryFixture("asset-target-only", "rule:target-only", {
          contentHash: ContentHashSchema.parse(`sha256:${"e".repeat(64)}`),
          toolKey: "cursor",
        }),
        assetSummaryFixture("asset-target-other-tool", "rule:codex-only", {
          contentHash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
          toolKey: "codex",
        }),
      ],
    });

    expect(html).toContain("Added to target</span><strong>1</strong>");
    expect(html).toContain("Overwritten in target</span><strong>1</strong>");
    expect(html).toContain("Target-only kept</span><strong>1</strong>");
    expect(html).toContain("<strong>Rule</strong><span>3 differences</span>");
    expect(html).toContain('class="target-change-row is-create"');
    expect(html).toContain('class="target-change-row is-replace"');
    expect(html).toContain('class="target-change-row is-existing"');
    expect(html).toContain("rule:new");
    expect(html).toContain("rule:shared");
    expect(html).toContain("rule:target-only");
    expect(html).not.toContain("rule:codex-only");
  });

  it("renders deployment type labels and source paths for preview source operations", () => {
    const html = renderMigration({
      migration: {
        ...initialState.migration,
        sourceProjectRoot: "/workspace/source",
        sourceAssetIds: [AssetIdSchema.parse("asset-source-skill")],
        targetScopeId: "/workspace/target",
      },
      migrationSourceAssets: [
        assetSummaryFixture("asset-source-skill", "skill:release", {
          toolKey: "claude-code",
        }),
      ],
      preview: {
        planId: DeploymentPlanIdSchema.parse("plan-1"),
        planHash: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
        compatibility: "full",
        fieldLosses: [],
        changes: [
          {
            operation: "create",
            deploymentType: "copy",
            pathDisplay: ".agents/skills/release/assets/logo.png",
            sourcePathDisplay: "/workspace/source/.claude/skills/release/assets/logo.png",
            beforeHash: null,
            afterHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
            diff: "",
          },
        ],
        requiredConfirmations: [],
        warnings: [],
        sourceHashes: {
          [AssetIdSchema.parse("asset-source-skill")]: ContentHashSchema.parse(
            `sha256:${"c".repeat(64)}`,
          ),
        },
        targetHashes: { ".agents/skills/release/assets/logo.png": null },
        expiresAt: "2026-06-28T08:10:00.000Z",
      },
    });

    expect(html).toContain("Copy source file");
    expect(html).toContain("/workspace/source/.claude/skills/release/assets/logo.png");
    expect(html).toContain(".agents/skills/release/assets/logo.png");
  });
});

function renderMigration(statePatch: Partial<AppState>): string {
  return renderToStaticMarkup(
    createElement(MigrationView, {
      state: { ...initialState, ...statePatch },
      onPreview: vi.fn(),
      onToggleSource: vi.fn(),
      onTargetTool: vi.fn(),
      onConflictPolicy: vi.fn(),
      onConfirmMigration: vi.fn(),
      onConfirmRequirement: vi.fn(),
      onExecuteMigration: vi.fn(),
    }),
  );
}

function assetSummaryFixture(
  id: string,
  logicalKey: string,
  overrides: Partial<Pick<AppState["assets"][number], "contentHash" | "toolKey">> = {},
): AppState["assets"][number] {
  return {
    id: AssetIdSchema.parse(id),
    toolKey: overrides.toolKey ?? "codex",
    resourceType: "rule",
    scopeKind: "project",
    logicalKey,
    sourceDirectory: "/workspace",
    loadState: "loaded",
    contentHash: overrides.contentHash ?? ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
    status: "enabled",
    diagnosticCounts: { info: 0, warning: 0, error: 0 },
  };
}
