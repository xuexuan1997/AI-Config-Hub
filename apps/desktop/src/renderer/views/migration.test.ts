import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssetIdSchema, ContentHashSchema, DeploymentPlanIdSchema } from "@ai-config-hub/shared";
import { describe, expect, it, vi } from "vitest";

import { initialState, type AppState } from "../model.js";
import { MigrationView } from "./migration.js";

describe("MigrationView", () => {
  it("keeps resource type labels consistent with English in Simplified Chinese", () => {
    const html = renderMigration({
      settings: {
        ...initialState.settings,
        values: { ...initialState.settings.values, language: "zh-CN" },
      },
      migration: {
        ...initialState.migration,
        sourceProjectRoot: "/workspace/source",
        targetScopeId: "/workspace/target",
      },
      migrationSourceAssets: [
        assetSummaryFixture("asset-rule", "rule:AGENTS", { resourceType: "rule" }),
        assetSummaryFixture("asset-agent", "agent:reviewer", { resourceType: "agent" }),
        assetSummaryFixture("asset-mcp", "mcp:docs", { resourceType: "mcp" }),
        assetSummaryFixture("asset-skill", "skill:release", { resourceType: "skill" }),
      ],
    });

    expect(html).toContain("<strong>Rule</strong>");
    expect(html).toContain("<strong>Agent</strong>");
    expect(html).toContain("<strong>MCP</strong>");
    expect(html).toContain("<strong>Skill</strong>");
    expect(html).not.toContain("<strong>规则</strong>");
    expect(html).not.toContain("<strong>代理</strong>");
    expect(html).not.toContain("<strong>技能</strong>");
  });

  it("localizes duplicate selected source asset blockers in Chinese", () => {
    const html = renderMigration({
      settings: {
        ...initialState.settings,
        values: { ...initialState.settings.values, language: "zh-CN" },
      },
      migration: {
        ...initialState.migration,
        sourceProjectRoot: "/workspace/source",
        sourceAssetIds: [
          AssetIdSchema.parse("asset-source-codex"),
          AssetIdSchema.parse("asset-source-cursor"),
        ],
        targetScopeId: "/workspace/target",
      },
      migrationSourceAssets: [
        assetSummaryFixture("asset-source-codex", "rule:AGENTS", { toolKey: "codex" }),
        assetSummaryFixture("asset-source-cursor", "rule:AGENTS", { toolKey: "cursor" }),
      ],
    });

    expect(html).toContain("存在同名源资产，无法迁移：rule:AGENTS。");
    expect(html).not.toContain("Cannot migrate duplicate source assets with the same name");
  });

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
          resourceType: "skill",
          toolKey: "claude-code",
        }),
      ],
      preview: skillPackagePreviewFixture({ diff: "" }),
    });

    expect(html).toContain("Copy source file");
    expect(html).toContain("/workspace/source/.claude/skills/release/assets/logo.png");
    expect(html).toContain(".agents/skills/release/assets/logo.png");
  });

  it("keeps verbose migration target and preview details collapsed", () => {
    const html = renderMigration({
      migration: {
        ...initialState.migration,
        sourceProjectRoot: "/workspace/source",
        sourceAssetIds: [AssetIdSchema.parse("asset-source-skill")],
        targetScopeId: "/workspace/target",
      },
      migrationSourceAssets: [
        assetSummaryFixture("asset-source-skill", "skill:release", {
          resourceType: "skill",
          toolKey: "claude-code",
        }),
      ],
      preview: skillPackagePreviewFixture({ diff: "+ copied binary asset" }),
    });

    expect(html).toContain('class="target-change-meta"');
    expect(html).toContain('class="target-change-details"');
    expect(html).toContain("<summary>Details</summary>");
    expect(html).toContain('class="planned-change-summary"');
    expect(html).toContain("<summary>Show diff and hashes</summary>");
    expect(html).toContain("<pre>+ copied binary asset</pre>");
  });

  it("renders multi-file Skill previews as one top-level package row", () => {
    const html = renderMigration({
      migration: {
        ...initialState.migration,
        sourceProjectRoot: "/workspace/source",
        sourceAssetIds: [AssetIdSchema.parse("asset-source-skill")],
        targetScopeId: "/workspace/target",
      },
      migrationSourceAssets: [
        assetSummaryFixture("asset-source-skill", "skill:release", {
          resourceType: "skill",
          toolKey: "claude-code",
        }),
      ],
      preview: skillPackagePreviewFixture({
        changes: [
          {
            groupId: "group-skill",
            operation: "create",
            deploymentType: "generated_file",
            pathDisplay: ".agents/skills/release/SKILL.md",
            beforeHash: null,
            afterHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
            diff: "+ skill",
          },
          {
            groupId: "group-skill",
            operation: "create",
            deploymentType: "copy",
            pathDisplay: ".agents/skills/release/assets/logo.png",
            sourcePathDisplay: "/workspace/source/.claude/skills/release/assets/logo.png",
            beforeHash: null,
            afterHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
            diff: "",
          },
        ],
      }),
    });

    expect(html).toContain("<strong>.agents/skills/release</strong>");
    expect(html).toContain("2 files");
    expect(html).not.toContain("<strong>.agents/skills/release/SKILL.md</strong>");
    expect(html).not.toContain("<strong>.agents/skills/release/assets/logo.png</strong>");
    expect(html).toContain(".agents/skills/release/assets/logo.png");
  });

  it("uses complete preview groups for target rows when file details are truncated", () => {
    const preview = skillPackagePreviewFixture({ changedTargetCount: 51, changesTruncated: true });
    const html = renderMigration({
      migration: {
        ...initialState.migration,
        sourceProjectRoot: "/workspace/source",
        sourceAssetIds: [AssetIdSchema.parse("asset-source-skill")],
        targetScopeId: "/workspace/target",
      },
      migrationSourceAssets: [
        assetSummaryFixture("asset-source-skill", "skill:release", {
          resourceType: "skill",
          toolKey: "claude-code",
        }),
      ],
      migrationTargetAssets: [
        assetSummaryFixture(
          "asset-target-outside-bounded-detail",
          "target-only-outside-bounded-detail",
          {
            contentHash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
            resourceType: "skill",
            toolKey: "cursor",
          },
        ),
      ],
      preview,
    });

    expect(html).toContain("<strong>.agents/skills/release</strong>");
    expect(html).toContain("51 files");
    expect(html).toContain("File details are truncated to 1.");
    expect(html).not.toContain("target-only-outside-bounded-detail");
  });

  it("filters preview target groups by the active resource type tab", () => {
    const html = renderMigration({
      migration: {
        ...initialState.migration,
        sourceProjectRoot: "/workspace/source",
        sourceAssetIds: [AssetIdSchema.parse("asset-source-skill")],
        targetScopeId: "/workspace/target",
      },
      migrationSourceAssets: [
        assetSummaryFixture("asset-source-rule", "rule:AGENTS", {
          resourceType: "rule",
          toolKey: "codex",
        }),
        assetSummaryFixture("asset-source-skill", "skill:release", {
          resourceType: "skill",
          toolKey: "claude-code",
        }),
      ],
      preview: skillPackagePreviewFixture(),
    });

    expect(html).toContain("No target assets for this tool and type.");
    expect(html).not.toContain('class="target-change-row is-create"');
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
  overrides: Partial<
    Pick<AppState["assets"][number], "contentHash" | "resourceType" | "toolKey">
  > = {},
): AppState["assets"][number] {
  return {
    id: AssetIdSchema.parse(id),
    toolKey: overrides.toolKey ?? "codex",
    resourceType: overrides.resourceType ?? "rule",
    scopeKind: "project",
    logicalKey,
    sourceDirectory: "/workspace",
    sourceSummary: {
      kind: "file",
      fileName: "AGENTS.md",
      mediaType: "text/markdown",
      isText: true,
    },
    loadState: "loaded",
    contentHash: overrides.contentHash ?? ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
    status: "enabled",
    diagnosticCounts: { info: 0, warning: 0, error: 0 },
  };
}

function skillPackagePreviewFixture(
  overrides: {
    readonly changes?: NonNullable<AppState["preview"]>["changes"];
    readonly changedTargetCount?: number;
    readonly changesTruncated?: boolean;
    readonly diff?: string;
  } = {},
): NonNullable<AppState["preview"]> {
  const changes = overrides.changes ?? [
    {
      groupId: "group-skill",
      operation: "create",
      deploymentType: "copy",
      pathDisplay: ".agents/skills/release/assets/logo.png",
      sourcePathDisplay: "/workspace/source/.claude/skills/release/assets/logo.png",
      beforeHash: null,
      afterHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
      diff: overrides.diff ?? "",
    },
  ];
  return {
    planId: DeploymentPlanIdSchema.parse("plan-1"),
    planHash: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
    compatibility: "full",
    fieldLosses: [],
    changeGroups: [
      {
        groupId: "group-skill",
        operation: "create",
        resourceType: "skill",
        sourceAssetId: AssetIdSchema.parse("asset-source-skill"),
        targetRootPathDisplay: ".agents/skills/release",
        targetRootRelativePath: ".agents/skills/release",
        operationCount: changes.length,
        createCount: changes.length,
        replaceCount: 0,
        deleteCount: 0,
        generatedFileCount: changes.filter((change) => change.deploymentType === "generated_file")
          .length,
        copyCount: changes.filter((change) => change.deploymentType === "copy").length,
        symlinkCount: 0,
        changedTargetCount: overrides.changedTargetCount ?? changes.length,
        targetPathSample: changes.map((change) => change.pathDisplay),
        packageOutputCount: overrides.changedTargetCount ?? changes.length,
        packagePathSample: changes.map((change) => change.pathDisplay),
        visibleDetailCount: changes.length,
        detailsTruncated: Boolean(overrides.changesTruncated),
      },
    ],
    differenceSummary: {
      addedToTarget: overrides.changedTargetCount ?? changes.length,
      overwrittenInTarget: 0,
      unchangedPlannedTargetOutputs: 0,
      conflictsOrWarnings: 0,
      changedGroupCount: 1,
      changedFileCount: overrides.changedTargetCount ?? changes.length,
    },
    changes,
    changesTruncated: Boolean(overrides.changesTruncated),
    changeDetailLimit: 50,
    requiredConfirmations: [],
    warnings: [],
    sourceHashes: {
      [AssetIdSchema.parse("asset-source-skill")]: ContentHashSchema.parse(
        `sha256:${"c".repeat(64)}`,
      ),
    },
    targetHashes: Object.fromEntries(changes.map((change) => [change.pathDisplay, null])),
    expiresAt: "2026-06-28T08:10:00.000Z",
  };
}
