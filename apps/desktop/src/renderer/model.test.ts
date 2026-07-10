import {
  AssetIdSchema,
  ContentHashSchema,
  DeploymentPlanIdSchema,
  DiagnosticIdSchema,
  ScopeIdSchema,
  TaskIdSchema,
} from "@ai-config-hub/shared";
import { describe, expect, it, vi } from "vitest";

import {
  deploymentBlockersForState,
  deploymentConfirmationsForState,
  effectiveRequestForState,
  enabledMigrationAssets,
  assetStatusChangeRequestFor,
  formatUiError,
  initialState,
  migrationDifferenceSummaryForState,
  migrationHashRowsForPreview,
  migrationPreviewBlockersForState,
  migrationSourceDriftRowsForState,
  openSourceRequestForState,
  projectIdForRoot,
  previewRequestForState,
  reducer,
  refreshAssets,
  refreshDiagnostics,
  settingsUpdateRequestForState,
  settingsClearLocalDataRequestForState,
  taskActionForTaskEvent,
  scanActionForTaskEvent,
  type AppState,
} from "./model.js";
import type { DesktopApi } from "../preload/api.js";

const disablementOptionsFixture = [
  {
    method: "move_file",
    label: "Move file out of the tool load path",
    description: "Move the source file into the AI Config Hub disabled-assets area.",
    recommended: true,
  },
  {
    method: "hub_ignore",
    label: "Ignore inside AI Config Hub only",
    description: "Keep the tool configuration unchanged and ignore the asset in Hub.",
    recommended: false,
  },
] as const satisfies NonNullable<AppState["assetDetail"]>["asset"]["disablementOptions"];

const assetDetailSourceFixture = {
  pathDisplay: "/workspace/AGENTS.md",
  contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
  observedAt: "2026-06-28T08:00:00.000Z",
  sourceSummary: fileSourceSummary("AGENTS.md"),
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
} as const satisfies NonNullable<AppState["assetDetail"]>["source"];

type MigrationPreviewFixture = NonNullable<AppState["preview"]>;
type MigrationPreviewChangeFixture = Omit<MigrationPreviewFixture["changes"][number], "groupId"> &
  Partial<Pick<MigrationPreviewFixture["changes"][number], "groupId">>;
type MigrationPreviewFixtureOverrides = Omit<
  Partial<MigrationPreviewFixture>,
  "changes" | "changeGroups" | "differenceSummary"
> & {
  readonly changes?: readonly MigrationPreviewChangeFixture[];
  readonly changeGroups?: MigrationPreviewFixture["changeGroups"];
  readonly differenceSummary?: MigrationPreviewFixture["differenceSummary"];
};

function fileSourceSummary(fileName: string): AppState["assets"][number]["sourceSummary"] {
  return { kind: "file", fileName, mediaType: "text/markdown", isText: true };
}

function migrationPreviewFixture(
  overrides: MigrationPreviewFixtureOverrides = {},
): MigrationPreviewFixture {
  const {
    changes: rawChanges = [
      {
        operation: "create",
        deploymentType: "generated_file",
        pathDisplay: "/workspace/.cursor/rules/generated.mdc",
        beforeHash: null,
        afterHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
        diff: "+ Use tests.",
      },
    ],
    changeGroups: overrideChangeGroups,
    differenceSummary: overrideDifferenceSummary,
    changesTruncated = false,
    changeDetailLimit = 50,
    ...rest
  } = overrides;
  const changes = rawChanges.map((change, index) => ({
    groupId: change.groupId ?? `group-${index + 1}`,
    ...change,
  })) satisfies MigrationPreviewFixture["changes"];
  const changeGroups = overrideChangeGroups ?? changeGroupsForChanges(changes);
  const fieldLosses = rest.fieldLosses ?? [];
  const warnings = rest.warnings ?? [];
  const targetHashes = rest.targetHashes ?? {};

  return {
    planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
    planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
    compatibility: "full",
    fieldLosses,
    requiredConfirmations: [],
    warnings,
    sourceHashes: {},
    targetHashes,
    expiresAt: "2026-06-28T08:10:00.000Z",
    ...rest,
    changes,
    changeGroups,
    differenceSummary:
      overrideDifferenceSummary ??
      differenceSummaryForChanges({ changes, changeGroups, fieldLosses, warnings, targetHashes }),
    changesTruncated,
    changeDetailLimit,
  };
}

function changeGroupsForChanges(
  changes: MigrationPreviewFixture["changes"],
): MigrationPreviewFixture["changeGroups"] {
  if (changes.length === 0) return [];
  const createCount = changes.filter((change) => change.operation === "create").length;
  const replaceCount = changes.filter((change) => change.operation === "replace").length;
  const deleteCount = changes.filter((change) => change.operation === "delete").length;
  const operations = new Set(changes.map((change) => change.operation));
  const firstChange = changes[0]!;
  const targetRootPathDisplay = parentPathFor(firstChange.pathDisplay);
  return [
    {
      groupId: firstChange.groupId,
      operation: operations.size === 1 ? firstChange.operation : "mixed",
      resourceType: "rule",
      targetRootPathDisplay,
      targetRootRelativePath: targetRootPathDisplay,
      operationCount: changes.length,
      createCount,
      replaceCount,
      deleteCount,
      generatedFileCount: changes.filter((change) => change.deploymentType === "generated_file")
        .length,
      copyCount: changes.filter((change) => change.deploymentType === "copy").length,
      symlinkCount: changes.filter((change) => change.deploymentType === "symlink").length,
      changedTargetCount: changes.length,
      targetPathSample: changes.map((change) => change.pathDisplay).slice(0, 10),
      visibleDetailCount: changes.length,
      detailsTruncated: false,
    },
  ];
}

function differenceSummaryForChanges(input: {
  readonly changes: MigrationPreviewFixture["changes"];
  readonly changeGroups: MigrationPreviewFixture["changeGroups"];
  readonly fieldLosses: MigrationPreviewFixture["fieldLosses"];
  readonly warnings: MigrationPreviewFixture["warnings"];
  readonly targetHashes: MigrationPreviewFixture["targetHashes"];
}): MigrationPreviewFixture["differenceSummary"] {
  const changedTargetPaths = new Set(input.changes.map((change) => change.pathDisplay));
  const fieldLossWarningCount = input.fieldLosses.filter(
    (loss) =>
      loss.droppedFields.length > 0 ||
      loss.transformedFields.length > 0 ||
      loss.warnings.length > 0,
  ).length;
  return {
    addedToTarget: input.changes.filter((change) => change.operation === "create").length,
    overwrittenInTarget: input.changes.filter((change) => change.operation === "replace").length,
    unchangedPlannedTargetOutputs: Object.entries(input.targetHashes).filter(
      ([path, hash]) => hash !== null && !changedTargetPaths.has(path),
    ).length,
    conflictsOrWarnings: input.warnings.length + fieldLossWarningCount,
    changedGroupCount: input.changeGroups.length,
    changedFileCount: input.changes.length,
  };
}

function parentPathFor(pathDisplay: string): string {
  const separatorIndex = pathDisplay.lastIndexOf("/");
  return separatorIndex < 0 ? pathDisplay : pathDisplay.slice(0, separatorIndex);
}

describe("renderer project selection state", () => {
  it("builds asset disable requests with the selected disablement method", () => {
    expect(
      assetStatusChangeRequestFor(AssetIdSchema.parse("asset-1"), "disabled", "hub_ignore"),
    ).toEqual({
      command: "assets.disable",
      request: { assetId: "asset-1", method: "hub_ignore" },
    });
  });

  it("refreshes migration assets using the selected project root as an indexed project filter", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      data: { items: [], nextCursor: null, snapshotRevision: "revision-1", stale: false },
    });
    const api = { invoke } as unknown as DesktopApi;

    await refreshAssets(api, { projectRoot: "/workspace/source" });

    expect(await projectIdForRoot("/workspace/source")).toBe(
      "project:93fabdbc021c4fc11c24322a46ec5b7995a259a5fba13c71ed02faf3627ec9eb",
    );
    expect(invoke).toHaveBeenCalledWith("assets.list", {
      limit: 200,
      projectId: await projectIdForRoot("/workspace/source"),
    });
  });

  it("loads every asset and diagnostic page without silently truncating at the first page", async () => {
    const firstAsset = migrationAssetFixture("asset-page-1", "rule:first");
    const secondAsset = migrationAssetFixture("asset-page-2", "rule:second");
    const firstDiagnostic = {
      id: DiagnosticIdSchema.parse("diagnostic-page-1"),
      code: "FIRST_PAGE",
      severity: "warning" as const,
      message: "First page warning",
      suggestedAction: "Review it",
      blocking: false,
    };
    const secondDiagnostic = {
      id: DiagnosticIdSchema.parse("diagnostic-page-2"),
      code: "SECOND_PAGE",
      severity: "error" as const,
      message: "Second page error",
      suggestedAction: "Fix it",
      blocking: true,
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [firstAsset],
          nextCursor: "asset-page-1",
          snapshotRevision: "revision-1",
          stale: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [secondAsset],
          nextCursor: null,
          snapshotRevision: "revision-1",
          stale: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [firstDiagnostic],
          nextCursor: "diagnostic-page-1",
          countsBySeverity: { info: 0, warning: 1, error: 0 },
          snapshotRevision: "revision-1",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [secondDiagnostic],
          nextCursor: null,
          countsBySeverity: { info: 0, warning: 0, error: 1 },
          snapshotRevision: "revision-1",
        },
      });
    const api = { invoke } as unknown as DesktopApi;

    await expect(refreshAssets(api)).resolves.toEqual([firstAsset, secondAsset]);
    await expect(refreshDiagnostics(api)).resolves.toEqual({
      diagnostics: [firstDiagnostic, secondDiagnostic],
      diagnosticCounts: { info: 0, warning: 1, error: 1 },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "assets.list", {
      limit: 200,
      cursor: "asset-page-1",
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "diagnostics.list", {
      limit: 200,
      cursor: "diagnostic-page-1",
    });
  });

  it("restarts pagination when the index revision changes between pages", async () => {
    const staleAsset = migrationAssetFixture("asset-stale", "rule:stale");
    const firstAsset = migrationAssetFixture("asset-current-1", "rule:current-1");
    const secondAsset = migrationAssetFixture("asset-current-2", "rule:current-2");
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [staleAsset],
          nextCursor: "asset-stale",
          snapshotRevision: "revision-1",
          stale: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [],
          nextCursor: null,
          snapshotRevision: "revision-2",
          stale: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [firstAsset],
          nextCursor: "asset-current-1",
          snapshotRevision: "revision-3",
          stale: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [secondAsset],
          nextCursor: null,
          snapshotRevision: "revision-3",
          stale: false,
        },
      });

    await expect(refreshAssets({ invoke } as unknown as DesktopApi)).resolves.toEqual([
      firstAsset,
      secondAsset,
    ]);
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("surfaces a later page failure instead of replacing current data with an empty result", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [migrationAssetFixture("asset-page-1", "rule:first")],
          nextCursor: "asset-page-1",
          snapshotRevision: "revision-1",
          stale: false,
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { message: "Temporary index read failure" },
      });

    await expect(refreshAssets({ invoke } as unknown as DesktopApi)).rejects.toThrow(
      "Temporary index read failure",
    );
  });

  it("turns missing file chooser errors into a retryable picker message", () => {
    const message = formatUiError(
      new Error("No such interface “org.freedesktop.portal.FileChooser” on object"),
      "Select project",
    );

    expect(message).toContain("Select project failed");
    expect(message).toContain("system file chooser is unavailable");
    expect(message).toContain("check desktop file picker permissions");
    expect(message).not.toContain("Manual path fallback");
    expect(message).not.toContain("Use typed path");
  });

  it("stores a manually entered project path and clears the prior error", () => {
    const failed = reducer(initialState, {
      type: "message",
      message: "Select project failed",
    });

    const selected = reducer(failed, {
      type: "project",
      root: "/home/user/workspace",
    });

    expect(selected.projectRoot).toBe("/home/user/workspace");
    expect(selected.message).toBeUndefined();
  });

  it("clears the previous review project data as soon as a different project is selected", () => {
    const previous: AppState = {
      ...initialState,
      projectRoot: "/workspace/a",
      scanStatus: "complete",
      scanScope: "asset-review",
      assets: [migrationAssetFixture("asset-project-a", "rule:project-a")],
      diagnostics: [
        {
          id: DiagnosticIdSchema.parse("diagnostic-project-a"),
          code: "PROJECT_A_WARNING",
          severity: "warning",
          message: "Old project warning",
          suggestedAction: "Review it",
          blocking: false,
        },
      ],
      diagnosticCounts: { info: 0, warning: 1, error: 0 },
      message: "Scan complete: 1 succeeded.",
    };

    const selected = reducer(previous, { type: "project", root: "/workspace/b" });

    expect(selected).toMatchObject({
      projectRoot: "/workspace/b",
      scanStatus: "idle",
      assets: [],
      diagnostics: [],
      diagnosticCounts: { info: 0, warning: 0, error: 0 },
    });
    expect(selected.message).toBeUndefined();
    expect(selected.scanScope).toBeUndefined();
  });

  it("keeps asset review project selection out of migration previews", () => {
    expect(previewRequestForState(initialState)).toBeUndefined();

    const withReviewProject = reducer(initialState, {
      type: "project",
      root: "/home/user/workspace",
    });
    const withAssets = reducer(withReviewProject, {
      type: "assets",
      assets: [migrationAssetFixture("asset-1", "AGENTS.md")],
    });

    expect(withAssets.projectRoot).toBe("/home/user/workspace");
    expect(withAssets.migration.sourceProjectRoot).toBeUndefined();
    expect(withAssets.migration.targetScopeId).toBeUndefined();
    expect(previewRequestForState(withAssets)).toBeUndefined();
  });

  it("ignores migration source asset refreshes until a source project is selected", () => {
    const withReviewAssets = reducer(initialState, {
      type: "assets",
      assets: [migrationAssetFixture("asset-review", "review/AGENTS.md")],
    });
    const withoutSourceProject = reducer(withReviewAssets, {
      type: "migrationSourceAssets",
      assets: [migrationAssetFixture("asset-review", "review/AGENTS.md")],
    });

    expect(withoutSourceProject.migration.sourceProjectRoot).toBeUndefined();
    expect(withoutSourceProject.migrationSourceAssets).toEqual([]);
    expect(withoutSourceProject.migration.sourceAssetIds).toEqual([]);
    expect(previewRequestForState(withoutSourceProject)).toBeUndefined();
  });

  it("builds migration previews from independent source and target project selections", () => {
    const withSourceProject = reducer(initialState, {
      type: "migrationSourceProject",
      sourceProjectRoot: "/home/user/source-workspace",
    });
    const withTargetProject = reducer(withSourceProject, {
      type: "migrationTargetProject",
      targetScopeId: " /home/user/target-workspace ",
    });
    const withAssets = reducer(withTargetProject, {
      type: "migrationSourceAssets",
      assets: [migrationAssetFixture("asset-1", "AGENTS.md")],
    });

    expect(withAssets.projectRoot).toBeUndefined();
    expect(withAssets.assets).toEqual([]);
    expect(withAssets.migrationSourceAssets.map((asset) => asset.id)).toEqual(["asset-1"]);
    expect(previewRequestForState(withAssets)).toEqual({
      sourceAssetIds: ["asset-1"],
      targetToolKey: "cursor",
      targetScopeId: "/home/user/target-workspace",
      conflictPolicy: "replace",
    });
  });

  it("swaps migration source and target projects without changing asset review project", () => {
    const withReviewProject = reducer(initialState, {
      type: "project",
      root: "/home/user/review-workspace",
    });
    const withSourceProject = reducer(withReviewProject, {
      type: "migrationSourceProject",
      sourceProjectRoot: "/home/user/source-workspace",
    });
    const withTargetProject = reducer(withSourceProject, {
      type: "migrationTargetProject",
      targetScopeId: "/home/user/target-workspace",
    });
    const withPreview = reducer(withTargetProject, {
      type: "preview",
      preview: migrationPreviewFixture({
        planId: DeploymentPlanIdSchema.parse("deployment-plan:swap-test"),
        planHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
        sourceHashes: {
          [AssetIdSchema.parse("asset-1")]: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
        },
        compatibility: "full",
      }),
    });
    const swapped = reducer(withPreview, { type: "migrationSwapProjects" });

    expect(swapped.projectRoot).toBe("/home/user/review-workspace");
    expect(swapped.migration.sourceProjectRoot).toBe("/home/user/target-workspace");
    expect(swapped.migration.targetScopeId).toBe("/home/user/source-workspace");
    expect(swapped.preview).toBeUndefined();
  });

  it("retires a preview and every confirmation immediately", () => {
    const withPreview = {
      ...initialState,
      preview: migrationPreviewFixture({
        planId: DeploymentPlanIdSchema.parse("deployment-plan:watcher-invalidated"),
        planHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
        sourceHashes: {},
        compatibility: "full",
      }),
      deploymentConfirmed: true,
      deploymentConfirmationGrants: ["overwrite" as const],
    };

    const invalidated = reducer(withPreview, { type: "previewInvalidated" });

    expect(invalidated.preview).toBeUndefined();
    expect(invalidated.deploymentConfirmed).toBe(false);
    expect(invalidated.deploymentConfirmationGrants).toEqual([]);
  });

  it("builds migration previews for an explicit target project", () => {
    const withSourceProject = reducer(initialState, {
      type: "migrationSourceProject",
      sourceProjectRoot: "/home/user/source-workspace",
    });
    const withAssets = reducer(withSourceProject, {
      type: "migrationSourceAssets",
      assets: [migrationAssetFixture("asset-1", "AGENTS.md")],
    });
    const withTargetProject = reducer(withAssets, {
      type: "migrationTargetProject",
      targetScopeId: " /home/user/target-workspace ",
    });
    const switchedReviewProject = reducer(withTargetProject, {
      type: "project",
      root: "/home/user/review-workspace",
    });

    expect(previewRequestForState(withTargetProject)).toEqual({
      sourceAssetIds: ["asset-1"],
      targetToolKey: "cursor",
      targetScopeId: "/home/user/target-workspace",
      conflictPolicy: "replace",
    });
    expect(switchedReviewProject.migration.sourceProjectRoot).toBe("/home/user/source-workspace");
    expect(switchedReviewProject.migration.targetScopeId).toBe("/home/user/target-workspace");
  });

  it("clears stale scan task and error state when a project scan is retried", () => {
    const stale: AppState = {
      ...initialState,
      message: "Previous source scan failed.",
      activeTask: {
        taskId: "task:scan:old-source",
        taskKind: "scan",
        scanScope: "migration-source",
        phase: "completed",
        status: "failed",
        recoveryLock: false,
      },
    };
    const selected = reducer(stale, {
      type: "migrationSourceProject",
      sourceProjectRoot: "/workspace/new-source",
    });
    const retried = reducer(selected, {
      type: "scan",
      status: "queued",
      scanScope: "migration-source",
    });

    expect(selected.activeTask).toBeUndefined();
    expect(retried.message).toBeUndefined();
  });

  it("blocks migration previews when selected source assets have duplicate names", () => {
    const withSourceProject = reducer(initialState, {
      type: "migrationSourceProject",
      sourceProjectRoot: "/home/user/source-workspace",
    });
    const withTargetProject = reducer(withSourceProject, {
      type: "migrationTargetProject",
      targetScopeId: "/home/user/target-workspace",
    });
    const withAssets = reducer(withTargetProject, {
      type: "migrationSourceAssets",
      assets: [
        migrationAssetFixture("asset-1", "AGENTS.md"),
        migrationAssetFixture("asset-2", "AGENTS.md", {
          contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
        }),
      ],
    });
    const withDuplicateSelected = reducer(withAssets, {
      type: "migrationSource",
      assetId: AssetIdSchema.parse("asset-2"),
      selected: true,
    });

    expect(migrationPreviewBlockersForState(withDuplicateSelected)).toContain(
      "Cannot migrate duplicate source assets with the same name: AGENTS.md.",
    );
    expect(previewRequestForState(withDuplicateSelected)).toBeUndefined();
  });

  it("does not select a disabled migration source", () => {
    const disabledAsset = migrationAssetFixture("asset-disabled", "AGENTS.md", {
      status: "disabled",
    });
    const withAssets: AppState = {
      ...initialState,
      migrationSourceAssets: [disabledAsset],
    };

    const selected = reducer(withAssets, {
      type: "migrationSource",
      assetId: disabledAsset.id,
      selected: true,
    });

    expect(selected).toBe(withAssets);
    expect(selected.migration.sourceAssetIds).toEqual([]);
  });

  it("blocks preview and repeated execution while a migration task is running", () => {
    const running: AppState = {
      ...initialState,
      activeTask: {
        taskId: "task:deployment:running",
        taskKind: "deployment",
        phase: "writing",
        status: "running",
        recoveryLock: false,
      },
    };

    expect(migrationPreviewBlockersForState(running)).toContain(
      "Wait for the active task to finish before creating a migration preview.",
    );
    expect(deploymentBlockersForState(running)).toContain(
      "Wait for the active migration task to finish.",
    );
  });

  it("builds migration previews from explicit migration selections", () => {
    const withSourceProject = reducer(initialState, {
      type: "migrationSourceProject",
      sourceProjectRoot: "/home/user/source-workspace",
    });
    const withTargetProject = reducer(withSourceProject, {
      type: "migrationTargetProject",
      targetScopeId: "/home/user/target-workspace",
    });
    const withAssets = reducer(withTargetProject, {
      type: "migrationSourceAssets",
      assets: [
        migrationAssetFixture("asset-1", "AGENTS.md"),
        migrationAssetFixture("asset-2", "review/SKILL.md", {
          contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
          resourceType: "skill",
          toolKey: "claude-code",
        }),
      ],
    });
    const withSource = reducer(withAssets, {
      type: "migrationSource",
      assetId: AssetIdSchema.parse("asset-2"),
      selected: true,
    });
    const withoutDefaultSource = reducer(withSource, {
      type: "migrationSource",
      assetId: AssetIdSchema.parse("asset-1"),
      selected: false,
    });
    const withTarget = reducer(withoutDefaultSource, {
      type: "migrationTarget",
      targetToolKey: "opencode",
    });
    const withConflictPolicy = reducer(withTarget, {
      type: "migrationConflictPolicy",
      conflictPolicy: "fail",
    });

    expect(withAssets.migration.sourceAssetIds).toEqual(["asset-1"]);
    expect(previewRequestForState(withConflictPolicy)).toEqual({
      sourceAssetIds: ["asset-2"],
      targetToolKey: "opencode",
      targetScopeId: "/home/user/target-workspace",
      conflictPolicy: "fail",
    });
  });

  it("keeps disabled assets visible but out of default migration selections", () => {
    const withSourceProject = reducer(initialState, {
      type: "migrationSourceProject",
      sourceProjectRoot: "/home/user/source-workspace",
    });
    const withTargetProject = reducer(withSourceProject, {
      type: "migrationTargetProject",
      targetScopeId: "/home/user/target-workspace",
    });
    const withAssets = reducer(withTargetProject, {
      type: "migrationSourceAssets",
      assets: [
        migrationAssetFixture("asset-disabled", "disabled/AGENTS.md", {
          status: "disabled",
        }),
        migrationAssetFixture("asset-enabled", "AGENTS.md", {
          contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
        }),
      ],
    });
    const manuallySelectedDisabled = reducer(withAssets, {
      type: "migrationSource",
      assetId: AssetIdSchema.parse("asset-disabled"),
      selected: true,
    });

    expect(withAssets.assets).toEqual([]);
    expect(withAssets.migrationSourceAssets.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "asset-disabled", status: "disabled" },
      { id: "asset-enabled", status: "enabled" },
    ]);
    expect(withAssets.migration.sourceAssetIds).toEqual(["asset-enabled"]);
    expect(enabledMigrationAssets(withAssets).map(({ id }) => id)).toEqual(["asset-enabled"]);
    expect(previewRequestForState(manuallySelectedDisabled)?.sourceAssetIds).toEqual([
      "asset-enabled",
    ]);
  });

  it("keeps asset review refreshes from replacing migration source assets or previews", () => {
    const sourceAsset = migrationAssetFixture("asset-source", "source/AGENTS.md");
    const reviewAsset = migrationAssetFixture("asset-review", "review/SKILL.md", {
      contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
      resourceType: "skill",
      toolKey: "cursor",
    });
    const withSourceProject = reducer(initialState, {
      type: "migrationSourceProject",
      sourceProjectRoot: "/home/user/source-workspace",
    });
    const withTargetProject = reducer(withSourceProject, {
      type: "migrationTargetProject",
      targetScopeId: "/home/user/target-workspace",
    });
    const withSourceAssets = reducer(withTargetProject, {
      type: "migrationSourceAssets",
      assets: [sourceAsset],
    });
    const withPreview = reducer(withSourceAssets, {
      type: "preview",
      preview: migrationPreviewFixture({
        planId: DeploymentPlanIdSchema.parse("deployment-plan:state-isolation"),
        planHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
        sourceHashes: {
          [sourceAsset.id]: sourceAsset.contentHash,
        },
        compatibility: "full",
      }),
    });
    const withReviewAssets = reducer(withPreview, {
      type: "assets",
      assets: [reviewAsset],
    });

    expect(withReviewAssets.assets.map((asset) => asset.id)).toEqual(["asset-review"]);
    expect(withReviewAssets.migrationSourceAssets.map((asset) => asset.id)).toEqual([
      "asset-source",
    ]);
    expect(withReviewAssets.preview).toBe(withPreview.preview);
    expect(previewRequestForState(withReviewAssets)).toEqual({
      sourceAssetIds: ["asset-source"],
      targetToolKey: "cursor",
      targetScopeId: "/home/user/target-workspace",
      conflictPolicy: "replace",
    });
  });

  it("stores scanned migration target assets separately and swaps them with the source", () => {
    const reviewAsset = migrationAssetFixture("asset-review", "review/AGENTS.md");
    const sourceAsset = {
      ...migrationAssetFixture("asset-source", "source/AGENTS.md"),
      contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
    };
    const targetAsset = {
      ...migrationAssetFixture("asset-target", "target/AGENTS.md"),
      contentHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
    };
    const withReview = reducer(initialState, {
      type: "assets",
      assets: [reviewAsset],
    });
    const withProjects = reducer(
      reducer(withReview, {
        type: "migrationSourceProject",
        sourceProjectRoot: "/home/user/source-workspace",
      }),
      {
        type: "migrationTargetProject",
        targetScopeId: "/home/user/target-workspace",
      },
    );
    const withSourceAssets = reducer(withProjects, {
      type: "migrationSourceAssets",
      assets: [sourceAsset],
    });
    const withTargetAssets = reducer(withSourceAssets, {
      type: "migrationTargetAssets",
      assets: [targetAsset],
    });
    const swapped = reducer(withTargetAssets, { type: "migrationSwapProjects" });

    expect(swapped.assets.map((asset) => asset.id)).toEqual(["asset-review"]);
    expect(swapped.migration.sourceProjectRoot).toBe("/home/user/target-workspace");
    expect(swapped.migration.targetScopeId).toBe("/home/user/source-workspace");
    expect(swapped.migrationSourceAssets.map((asset) => asset.id)).toEqual(["asset-target"]);
    expect(swapped.migrationTargetAssets.map((asset) => asset.id)).toEqual(["asset-source"]);
    expect(swapped.migration.sourceAssetIds).toEqual(["asset-target"]);
  });

  it("updates an inspected asset status without requiring a full asset refresh", () => {
    const withProject = reducer(initialState, {
      type: "project",
      root: "/home/user/workspace",
    });
    const withMigrationSource = reducer(withProject, {
      type: "migrationSourceProject",
      sourceProjectRoot: "/home/user/workspace",
    });
    const withMigrationAssets = reducer(withMigrationSource, {
      type: "migrationSourceAssets",
      assets: [migrationAssetFixture("asset-1", "AGENTS.md")],
    });
    const withAssets = reducer(withMigrationAssets, {
      type: "assets",
      assets: [migrationAssetFixture("asset-1", "AGENTS.md")],
    });
    const withPreview = reducer(withAssets, {
      type: "preview",
      preview: migrationPreviewFixture({
        planId: DeploymentPlanIdSchema.parse("deployment-plan:status-test"),
        planHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
        sourceHashes: Object.fromEntries([
          [AssetIdSchema.parse("asset-1"), ContentHashSchema.parse(`sha256:${"a".repeat(64)}`)],
        ]),
        compatibility: "full",
      }),
    });
    const withDetail = reducer(withPreview, {
      type: "assetDetail",
      detail: {
        asset: {
          id: AssetIdSchema.parse("asset-1"),
          toolKey: "codex",
          resourceType: "rule",
          scopeId: ScopeIdSchema.parse("/home/user/workspace"),
          logicalKey: "AGENTS.md",
          status: "enabled",
          disablementOptions: disablementOptionsFixture,
        },
        source: {
          pathDisplay: "/home/user/workspace/AGENTS.md",
          contentHash: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
          observedAt: "2026-06-28T08:00:00.000Z",
          sourceSummary: fileSourceSummary("AGENTS.md"),
          files: [
            {
              pathDisplay: "/home/user/workspace/AGENTS.md",
              relativePath: "AGENTS.md",
              role: "primary",
              mediaType: "text/markdown",
              isText: true,
              contentHash: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
            },
          ],
        },
        redactions: [],
      },
    });

    const withEffective = reducer(withDetail, {
      type: "effective",
      effective: {
        effective: { rules: ["Use tests."] },
        contributors: [],
        ignored: [],
        diagnostics: [],
        snapshotRevision: "revision-before-disable",
      },
    });
    const disabled = reducer(withEffective, {
      type: "assetStatus",
      assetId: AssetIdSchema.parse("asset-1"),
      status: "disabled",
    });
    const enabled = reducer(disabled, {
      type: "assetStatus",
      assetId: AssetIdSchema.parse("asset-1"),
      status: "enabled",
    });

    expect(disabled.assets[0]?.status).toBe("disabled");
    expect(disabled.migrationSourceAssets[0]?.status).toBe("disabled");
    expect(disabled.assetDetail?.asset.status).toBe("disabled");
    expect(disabled.migration.sourceAssetIds).toEqual([]);
    expect(disabled.preview).toBeUndefined();
    expect(disabled.effective).toBeUndefined();
    expect(enabled.assets[0]?.status).toBe("enabled");
    expect(enabled.migrationSourceAssets[0]?.status).toBe("enabled");
    expect(enabled.assetDetail?.asset.status).toBe("enabled");
    expect(enabled.migration.sourceAssetIds).toEqual([]);
  });

  it("maps task completion events onto scan status without global messages", () => {
    expect(
      scanActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task-scan"),
        sequence: 1,
        emittedAt: "2026-06-28T08:00:00.000Z",
        type: "completed",
        payload: {
          status: "succeeded",
          succeededCount: 2,
          failedCount: 0,
          skippedCount: 1,
          systemRecoveryLock: false,
        },
      }),
    ).toEqual({
      type: "scan",
      status: "complete",
    });
    expect(
      scanActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:scan:replayed"),
        sequence: null,
        emittedAt: "2026-06-28T08:00:01.000Z",
        type: "snapshot",
        payload: {
          taskKind: "scan",
          phase: "completed",
          status: "failed",
          progress: { phase: "completed", completed: 1, total: 1, unit: "items" },
          lastSequence: 205,
          cancellable: false,
          systemRecoveryLock: false,
        },
      }),
    ).toEqual({ type: "scan", status: "error" });
  });

  it("marks scan cancellation requests as no longer cancellable", () => {
    const action = taskActionForTaskEvent(
      {
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:scan:cancel"),
        sequence: 3,
        emittedAt: "2026-06-28T08:00:02.000Z",
        type: "cancel.requested",
        payload: { reason: "user", effectiveAfterPhase: "reading" },
      },
      "asset-review",
    );

    expect(action).toMatchObject({
      taskId: "task:scan:cancel",
      taskKind: "scan",
      scanScope: "asset-review",
      cancellable: false,
      message: "Scan cancellation requested.",
    });
  });

  it("attaches scan scope to scan status and task updates", () => {
    const acceptedEvent = {
      apiVersion: 1,
      eventVersion: 1,
      taskId: TaskIdSchema.parse("task:scan:migration-target"),
      sequence: 1,
      emittedAt: "2026-06-28T08:00:00.000Z",
      type: "accepted",
      payload: {
        taskKind: "scan",
        phase: "queued",
        acceptedAt: "2026-06-28T08:00:00.000Z",
      },
    } as const;
    const progressEvent = {
      apiVersion: 1,
      eventVersion: 1,
      taskId: TaskIdSchema.parse("task:scan:migration-target"),
      sequence: 2,
      emittedAt: "2026-06-28T08:00:01.000Z",
      type: "progress",
      payload: {
        phase: "reading",
        completed: 3,
        total: 8,
        unit: "files",
      },
    } as const;

    expect(scanActionForTaskEvent(acceptedEvent, "migration-target")).toEqual({
      type: "scan",
      status: "queued",
      scanScope: "migration-target",
    });

    const accepted = reducer(initialState, {
      type: "taskEvent",
      action: taskActionForTaskEvent(acceptedEvent, "migration-target")!,
    });
    const progressed = reducer(accepted, {
      type: "taskEvent",
      action: taskActionForTaskEvent(progressEvent, "migration-target")!,
    });

    expect(accepted.activeTask?.scanScope).toBe("migration-target");
    expect(progressed.activeTask?.scanScope).toBe("migration-target");
    expect(progressed.activeTask?.message).toBe("scan reading: 3/8 files");
  });

  it("hydrates the matching route and project selection for a restored scan", () => {
    const review = reducer(initialState, {
      type: "runtimeScanRestored",
      scanScope: "asset-review",
      projectRoot: "/workspace/review",
    });
    const source = reducer(initialState, {
      type: "runtimeScanRestored",
      scanScope: "migration-source",
      projectRoot: "/workspace/source",
    });
    const target = reducer(initialState, {
      type: "runtimeScanRestored",
      scanScope: "migration-target",
      projectRoot: "/workspace/target",
    });

    expect(review).toMatchObject({
      route: "assets",
      projectRoot: "/workspace/review",
      scanStatus: "queued",
      scanScope: "asset-review",
    });
    expect(source).toMatchObject({
      route: "migration",
      scanStatus: "queued",
      scanScope: "migration-source",
      migration: { sourceProjectRoot: "/workspace/source" },
    });
    expect(target).toMatchObject({
      route: "migration",
      scanStatus: "queued",
      scanScope: "migration-target",
      migration: { targetScopeId: "/workspace/target" },
    });
  });

  it("clears transient messages when navigating to another workspace route", () => {
    const withMessage = reducer(initialState, {
      type: "message",
      message: "Scan complete: 1 succeeded.",
    });

    const navigated = reducer(withMessage, { type: "route", route: "assets" });

    expect(navigated.route).toBe("assets");
    expect(navigated.message).toBeUndefined();
  });

  it("accumulates scan item failures for detailed page-level reporting", () => {
    const accepted = reducer(initialState, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:scan:detailed-failures"),
        sequence: 1,
        emittedAt: "2026-06-28T08:00:00.000Z",
        type: "accepted",
        payload: {
          taskKind: "scan",
          phase: "queued",
          acceptedAt: "2026-06-28T08:00:00.000Z",
        },
      })!,
    });
    const firstFailure = reducer(accepted, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:scan:detailed-failures"),
        sequence: 2,
        emittedAt: "2026-06-28T08:00:01.000Z",
        type: "item.failed",
        payload: {
          itemRef: "/workspace/.cursor/rules/broken.mdc",
          diagnosticId: "diagnostic:scan:1",
          errorCode: "SCAN_READ_FAILED",
          retryable: true,
        },
      })!,
    });
    const secondFailure = reducer(firstFailure, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:scan:detailed-failures"),
        sequence: 3,
        emittedAt: "2026-06-28T08:00:02.000Z",
        type: "item.failed",
        payload: {
          itemRef: "/workspace/.claude/agents/reviewer.md",
          diagnosticId: "diagnostic:scan:2",
          errorCode: "FRONTMATTER_INVALID",
          retryable: false,
        },
      })!,
    });

    const completed = reducer(secondFailure, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:scan:detailed-failures"),
        sequence: 4,
        emittedAt: "2026-06-28T08:00:03.000Z",
        type: "completed",
        payload: {
          status: "partially_succeeded",
          succeededCount: 3,
          failedCount: 2,
          skippedCount: 1,
          resultRef: "scan:detailed-failures",
          systemRecoveryLock: false,
        },
      })!,
    });

    expect(completed.activeTask?.failures).toEqual([
      {
        itemRef: "/workspace/.cursor/rules/broken.mdc",
        errorCode: "SCAN_READ_FAILED",
        retryable: true,
      },
      {
        itemRef: "/workspace/.claude/agents/reviewer.md",
        errorCode: "FRONTMATTER_INVALID",
        retryable: false,
      },
    ]);
    expect(completed.activeTask).toMatchObject({
      phase: "completed",
      status: "partially_succeeded",
      progress: { phase: "completed", completed: 5, total: 6, unit: "items" },
      message: "Scan partially complete: 3 succeeded, 2 failed, 1 skipped.",
    });
  });

  it("stores loaded desktop settings and builds optimistic update requests", () => {
    const loaded = reducer(initialState, {
      type: "settingsLoaded",
      settings: {
        values: { theme: "dark", language: "zh-CN" },
        revision: 3,
        readOnlyRecovery: false,
      },
    });
    const saved = reducer(loaded, {
      type: "settingsUpdated",
      settings: {
        values: { theme: "light", language: "en" },
        revision: 4,
        requiresRestart: false,
      },
    });

    expect(loaded.settings).toMatchObject({
      values: { theme: "dark", language: "zh-CN" },
      revision: 3,
      status: "ready",
      readOnlyRecovery: false,
    });
    expect(settingsUpdateRequestForState(loaded, { language: "en" })).toEqual({
      expectedRevision: 3,
      patch: { language: "en" },
    });
    const saving = reducer(loaded, {
      type: "settingsSaving",
      patch: { language: "en" },
    });
    expect(saving.settings.status).toBe("saving");
    expect(saving.settings.values.language).toBe("en");
    expect(saved.settings).toMatchObject({
      values: { theme: "light", language: "en" },
      revision: 4,
      status: "ready",
    });
  });

  it("builds confirmed local data cleanup requests and resets confirmation on category edits", () => {
    const withDeploymentHistory = reducer(initialState, {
      type: "settingsClearLocalDataCategory",
      category: "deployment_history",
      selected: true,
    });
    const confirmed = reducer(withDeploymentHistory, {
      type: "settingsClearLocalDataConfirmation",
      confirmed: true,
    });
    const changedAfterConfirming = reducer(confirmed, {
      type: "settingsClearLocalDataCategory",
      category: "settings",
      selected: true,
    });

    expect(settingsClearLocalDataRequestForState(withDeploymentHistory)).toBeUndefined();
    expect(settingsClearLocalDataRequestForState(confirmed)).toEqual({
      categories: ["scan_cache", "deployment_history"],
      confirmation: "clear-local-data",
    });
    expect(changedAfterConfirming.settings.clearLocalData.confirmed).toBe(false);
    expect(settingsClearLocalDataRequestForState(changedAfterConfirming)).toBeUndefined();
  });

  it("clears stale renderer scan state after local scan cache cleanup succeeds", () => {
    const withData: AppState = {
      ...initialState,
      projectRoot: "/workspace",
      scanStatus: "complete",
      assets: [migrationAssetFixture("asset-1", "rule:AGENTS")],
      migrationSourceAssets: [
        migrationAssetFixture("asset-2", "rule:.cursor/rules/local.mdc", {
          contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
          toolKey: "cursor",
        }),
      ],
      diagnostics: [
        {
          id: DiagnosticIdSchema.parse("diagnostic-1"),
          code: "PARTIAL_CONVERSION",
          severity: "warning",
          message: "Review conversion",
          suggestedAction: "Inspect the converted output",
          blocking: false,
        },
      ],
      diagnosticCounts: { info: 0, warning: 1, error: 0 },
      preview: migrationPreviewFixture({
        planId: DeploymentPlanIdSchema.parse("deployment-plan:clear-cache"),
        planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
        sourceHashes: {
          [AssetIdSchema.parse("asset-1")]: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
        },
        compatibility: "full",
        expiresAt: "2026-07-04T08:10:00.000Z",
      }),
      deploymentConfirmed: true,
      deploymentConfirmationGrants: ["overwrite"],
      activeTask: {
        taskId: "task:scan:cleanup",
        taskKind: "scan",
        scanScope: "asset-review",
        phase: "parsing",
        status: "running",
        recoveryLock: false,
      },
    };

    const cleared = reducer(withData, {
      type: "settingsClearLocalDataCompleted",
      result: {
        clearedAt: "2026-07-04T08:00:00.000Z",
        categories: ["scan_cache", "settings"],
        counts: {
          scanRuns: 1,
          projects: 1,
          scopes: 2,
          assets: 2,
          diagnostics: 1,
          deploymentRecords: 0,
          deploymentOperations: 0,
          settings: 1,
          localHistoryDirectories: 0,
        },
        retained: {
          databaseBackups: true,
          deploymentBackups: true,
          disabledAssets: true,
        },
        requiresRestart: false,
      },
    });

    expect(cleared.projectRoot).toBe("/workspace");
    expect(cleared.scanStatus).toBe("idle");
    expect(cleared.assets).toEqual([]);
    expect(cleared.migrationSourceAssets).toEqual([]);
    expect(cleared.diagnostics).toEqual([]);
    expect(cleared.diagnosticCounts).toEqual({ info: 0, warning: 0, error: 0 });
    expect(cleared.preview).toBeUndefined();
    expect(cleared.activeTask).toBeUndefined();
    expect(cleared.deploymentConfirmed).toBe(false);
    expect(cleared.settings.values).toEqual({ theme: "system", language: "system" });
    expect(cleared.settings.revision).toBe(0);
    expect(cleared.settings.clearLocalData.status).toBe("cleared");
    expect(cleared.settings.clearLocalData.confirmed).toBe(false);
  });

  it("retires a stale migration preview and deployment task after deployment history cleanup", () => {
    const withDeploymentState: AppState = {
      ...initialState,
      preview: migrationPreviewFixture(),
      deploymentConfirmed: true,
      deploymentConfirmationGrants: ["overwrite"],
      activeTask: {
        taskId: TaskIdSchema.parse("task:deployment:cleanup"),
        taskKind: "deployment",
        phase: "completed",
        status: "succeeded",
        recoveryLock: false,
      },
    };

    const cleared = reducer(withDeploymentState, {
      type: "settingsClearLocalDataCompleted",
      result: {
        clearedAt: "2026-07-04T08:00:00.000Z",
        categories: ["deployment_history"],
        counts: {
          scanRuns: 0,
          projects: 0,
          scopes: 0,
          assets: 0,
          diagnostics: 0,
          deploymentRecords: 1,
          deploymentOperations: 1,
          settings: 0,
          localHistoryDirectories: 1,
        },
        retained: {
          databaseBackups: true,
          deploymentBackups: true,
          disabledAssets: true,
        },
        requiresRestart: false,
      },
    });

    expect(cleared.preview).toBeUndefined();
    expect(cleared.deploymentConfirmed).toBe(false);
    expect(cleared.deploymentConfirmationGrants).toEqual([]);
    expect(cleared.activeTask).toBeUndefined();
  });

  it("maps deployment task events to active task progress and recovery state", () => {
    const accepted = reducer(initialState, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:deployment:deployment-1"),
        sequence: 1,
        emittedAt: "2026-06-28T08:00:00.000Z",
        type: "accepted",
        payload: {
          taskKind: "deployment",
          phase: "queued",
          acceptedAt: "2026-06-28T08:00:00.000Z",
        },
      })!,
    });
    const writing = reducer(accepted, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:deployment:deployment-1"),
        sequence: 4,
        emittedAt: "2026-06-28T08:00:01.000Z",
        type: "progress",
        payload: { phase: "writing", completed: 2, total: 3, unit: "operations" },
      })!,
    });
    const failed = reducer(writing, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:deployment:deployment-1"),
        sequence: 5,
        emittedAt: "2026-06-28T08:00:02.000Z",
        type: "item.failed",
        payload: {
          itemRef: "deployment-1",
          diagnosticId: "diagnostic:deployment:deployment-1",
          errorCode: "VALIDATION_FAILED",
          retryable: false,
        },
      })!,
    });
    const completed = reducer(failed, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:deployment:deployment-1"),
        sequence: 7,
        emittedAt: "2026-06-28T08:00:03.000Z",
        type: "completed",
        payload: {
          status: "failed",
          succeededCount: 0,
          failedCount: 1,
          skippedCount: 0,
          resultRef: "deployment-1",
          systemRecoveryLock: true,
        },
      })!,
    });

    expect(accepted.activeTask).toMatchObject({
      taskId: "task:deployment:deployment-1",
      taskKind: "deployment",
      phase: "queued",
      status: "running",
      recoveryLock: false,
    });
    expect(writing.activeTask).toMatchObject({
      phase: "writing",
      progress: { phase: "writing", completed: 2, total: 3, unit: "operations" },
      message: "deployment writing: 2/3 operations",
    });
    expect(failed.activeTask).toMatchObject({
      failure: { itemRef: "deployment-1", errorCode: "VALIDATION_FAILED", retryable: false },
      message: "deployment failed: VALIDATION_FAILED",
    });
    expect(completed.activeTask).toMatchObject({
      phase: "completed",
      status: "failed",
      recoveryLock: true,
      message: "Deployment failed: 1 failed.",
    });
  });

  it("restores active task state from replay snapshots", () => {
    const restored = reducer(initialState, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:rollback:replay"),
        sequence: null,
        emittedAt: "2026-06-28T08:00:03.000Z",
        type: "snapshot",
        payload: {
          taskKind: "rollback",
          phase: "verifying",
          status: "running",
          progress: { phase: "verifying", completed: 1, total: 2, unit: "operations" },
          lastSequence: 12,
          cancellable: true,
        },
      })!,
    });

    expect(restored.activeTask).toMatchObject({
      taskId: "task:rollback:replay",
      taskKind: "rollback",
      phase: "verifying",
      status: "running",
      progress: { phase: "verifying", completed: 1, total: 2, unit: "operations" },
      recoveryLock: false,
    });

    const failedWithoutLock = reducer(initialState, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:deployment:preflight-replay"),
        sequence: null,
        emittedAt: "2026-06-28T08:00:04.000Z",
        type: "snapshot",
        payload: {
          taskKind: "deployment",
          phase: "completed",
          status: "failed",
          progress: { phase: "completed", completed: 1, total: 1, unit: "operations" },
          lastSequence: 220,
          cancellable: false,
          systemRecoveryLock: false,
        },
      })!,
    });
    expect(failedWithoutLock.activeTask?.recoveryLock).toBe(false);
  });

  it("keeps a recovery lock across later scans until rollback succeeds", () => {
    const locked = reducer(initialState, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:deployment:failed-write"),
        sequence: 8,
        emittedAt: "2026-06-28T08:00:05.000Z",
        type: "completed",
        payload: {
          status: "failed",
          succeededCount: 0,
          failedCount: 1,
          skippedCount: 0,
          resultRef: "deployment-record:failed-write",
          systemRecoveryLock: true,
        },
      })!,
    });
    const scanning = reducer(locked, {
      type: "taskEvent",
      action: taskActionForTaskEvent(
        {
          apiVersion: 1,
          eventVersion: 1,
          taskId: TaskIdSchema.parse("task:scan:after-failure"),
          sequence: 1,
          emittedAt: "2026-06-28T08:00:06.000Z",
          type: "accepted",
          payload: {
            taskKind: "scan",
            phase: "queued",
            acceptedAt: "2026-06-28T08:00:06.000Z",
          },
        },
        "asset-review",
      )!,
    });
    const failedRollback = reducer(scanning, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:rollback:failed-recovery"),
        sequence: 8,
        emittedAt: "2026-06-28T08:00:06.500Z",
        type: "completed",
        payload: {
          status: "failed",
          succeededCount: 0,
          failedCount: 1,
          skippedCount: 0,
          resultRef: "rollback-record:failed-recovery",
          systemRecoveryLock: true,
        },
      })!,
    });
    const recovered = reducer(failedRollback, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:rollback:recovery"),
        sequence: 8,
        emittedAt: "2026-06-28T08:00:07.000Z",
        type: "completed",
        payload: {
          status: "succeeded",
          succeededCount: 1,
          failedCount: 0,
          skippedCount: 0,
          resultRef: "rollback-record:recovery",
          systemRecoveryLock: false,
        },
      })!,
    });

    expect(locked.recoveryLock).toEqual({ deploymentId: "deployment-record:failed-write" });
    expect(scanning.recoveryLock).toEqual({ deploymentId: "deployment-record:failed-write" });
    expect(failedRollback.recoveryLock).toEqual({
      deploymentId: "deployment-record:failed-write",
    });
    expect(deploymentBlockersForState(scanning)).toContain(
      "Resolve the active recovery lock before migrating.",
    );
    expect(recovered.recoveryLock).toBeUndefined();
  });

  it("retires a consumed preview after a failed deployment preflight", () => {
    const planned: AppState = {
      ...initialState,
      preview: migrationPreviewFixture(),
      deploymentConfirmed: true,
      deploymentConfirmationGrants: ["overwrite"],
    };
    const failed = reducer(planned, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:deployment:failed-preflight"),
        sequence: 4,
        emittedAt: "2026-06-28T08:00:08.000Z",
        type: "completed",
        payload: {
          status: "failed",
          succeededCount: 0,
          failedCount: 1,
          skippedCount: 0,
          resultRef: "deployment-record:failed-preflight",
          systemRecoveryLock: false,
        },
      })!,
    });

    expect(failed.preview).toBeUndefined();
    expect(failed.deploymentConfirmed).toBe(false);
    expect(failed.deploymentConfirmationGrants).toEqual([]);
  });

  it("stores asset details and diagnostics for the assets workspace", () => {
    const detail = {
      asset: {
        id: AssetIdSchema.parse("asset-1"),
        toolKey: "codex" as const,
        resourceType: "rule" as const,
        scopeId: ScopeIdSchema.parse("scope-1"),
        logicalKey: "AGENTS.md",
        status: "enabled" as const,
        disablementOptions: disablementOptionsFixture,
        normalized: { kind: "rule", data: { instructions: "Use tests." } },
        references: ["README.md"],
        diagnosticIds: [DiagnosticIdSchema.parse("diagnostic-1")],
      },
      source: assetDetailSourceFixture,
      redactions: [],
    };
    const diagnostics = [
      {
        id: DiagnosticIdSchema.parse("diagnostic-1"),
        code: "MISSING_REFERENCE",
        severity: "warning" as const,
        assetId: AssetIdSchema.parse("asset-1"),
        message: "A referenced file is missing",
        suggestedAction: "Create the referenced file or remove the reference",
        blocking: false,
      },
    ];

    const withDetail = reducer(initialState, { type: "assetDetail", detail });
    const withDiagnostics = reducer(withDetail, {
      type: "diagnostics",
      diagnostics,
      counts: { info: 0, warning: 1, error: 0 },
    });

    expect(withDiagnostics.assetDetail).toBe(detail);
    expect(withDiagnostics.diagnostics).toBe(diagnostics);
    expect(withDiagnostics.diagnosticCounts).toEqual({ info: 0, warning: 1, error: 0 });
  });

  it("builds and stores effective configuration explanations from the selected asset", () => {
    const detail = {
      asset: {
        id: AssetIdSchema.parse("asset-1"),
        toolKey: "codex" as const,
        resourceType: "rule" as const,
        scopeId: ScopeIdSchema.parse("scope-1"),
        logicalKey: "AGENTS.md",
        status: "enabled" as const,
        disablementOptions: disablementOptionsFixture,
      },
      source: assetDetailSourceFixture,
      redactions: [],
    };
    const effective = {
      effective: { rules: ["Use tests."] },
      contributors: [
        {
          assetId: AssetIdSchema.parse("asset-1"),
          action: "inherit" as const,
          reasonCode: "PROJECT_SCOPE",
        },
      ],
      ignored: [{ assetId: AssetIdSchema.parse("asset-2"), reasonCode: "OVERRIDDEN" }],
      diagnostics: [],
      snapshotRevision: "revision-1",
    };
    const withProject = reducer(initialState, { type: "project", root: "/workspace" });
    const withDetail = reducer(withProject, { type: "assetDetail", detail });
    const withEffective = reducer(withDetail, { type: "effective", effective });

    expect(effectiveRequestForState(withDetail)).toEqual({
      toolKey: "codex",
      projectId: "/workspace",
      targetScopeId: "/workspace",
      resourceTypes: ["rule"],
    });
    expect(withEffective.effective).toBe(effective);
  });

  it("does not relabel diagnostics while asset detail scope is changing", () => {
    const detail = {
      asset: {
        id: AssetIdSchema.parse("asset-1"),
        toolKey: "codex" as const,
        resourceType: "rule" as const,
        scopeId: ScopeIdSchema.parse("scope-1"),
        logicalKey: "AGENTS.md",
        status: "enabled" as const,
        disablementOptions: disablementOptionsFixture,
      },
      source: assetDetailSourceFixture,
      redactions: [],
    };
    const workspaceDiagnostics: AppState = {
      ...initialState,
      diagnostics: [
        {
          id: DiagnosticIdSchema.parse("diagnostic-workspace"),
          code: "WORKSPACE_WARNING",
          severity: "warning",
          message: "Workspace warning",
          suggestedAction: "Review it",
          blocking: false,
        },
      ],
      diagnosticCounts: { info: 0, warning: 1, error: 0 },
    };
    const opened = reducer(workspaceDiagnostics, { type: "assetDetail", detail });
    const withAssetDiagnostics = reducer(opened, {
      type: "diagnostics",
      diagnostics: [
        {
          id: DiagnosticIdSchema.parse("diagnostic-asset"),
          code: "ASSET_WARNING",
          severity: "warning",
          assetId: AssetIdSchema.parse("asset-1"),
          message: "Asset warning",
          suggestedAction: "Review it",
          blocking: false,
        },
      ],
      counts: { info: 0, warning: 1, error: 0 },
    });
    const closed = reducer(withAssetDiagnostics, { type: "assetDetailClosed" });

    expect(opened.diagnostics).toEqual([]);
    expect(opened.diagnosticCounts).toEqual({ info: 0, warning: 0, error: 0 });
    expect(closed.diagnostics).toEqual([]);
    expect(closed.diagnosticCounts).toEqual({ info: 0, warning: 0, error: 0 });
  });

  it("opens source files by selected asset id only", () => {
    const detail = {
      asset: {
        id: AssetIdSchema.parse("asset-1"),
        toolKey: "codex" as const,
        resourceType: "rule" as const,
        scopeId: ScopeIdSchema.parse("scope-1"),
        logicalKey: "AGENTS.md",
        status: "enabled" as const,
        disablementOptions: disablementOptionsFixture,
      },
      source: assetDetailSourceFixture,
      redactions: [],
    };
    const withDetail = reducer(initialState, { type: "assetDetail", detail });

    expect(openSourceRequestForState(initialState)).toBeUndefined();
    expect(openSourceRequestForState(withDetail)).toEqual({ assetId: "asset-1" });
  });

  it("clears inspected asset detail and effective configuration when inspect closes", () => {
    const detail = {
      asset: {
        id: AssetIdSchema.parse("asset-1"),
        toolKey: "codex" as const,
        resourceType: "rule" as const,
        scopeId: ScopeIdSchema.parse("scope-1"),
        logicalKey: "AGENTS.md",
        status: "enabled" as const,
        disablementOptions: disablementOptionsFixture,
      },
      source: assetDetailSourceFixture,
      redactions: [],
    };
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

  it("clears project-scoped details when the project changes", () => {
    const detail = {
      asset: {
        id: AssetIdSchema.parse("asset-1"),
        toolKey: "codex" as const,
        resourceType: "rule" as const,
        scopeId: ScopeIdSchema.parse("scope-1"),
        logicalKey: "AGENTS.md",
        status: "enabled" as const,
        disablementOptions: disablementOptionsFixture,
      },
      source: assetDetailSourceFixture,
      redactions: [],
    };
    const effective = {
      effective: { rules: ["Use tests."] },
      contributors: [],
      ignored: [],
      diagnostics: [],
      snapshotRevision: "revision-1",
    };
    const withProject = reducer(initialState, { type: "project", root: "/workspace" });
    const withDetail = reducer(withProject, { type: "assetDetail", detail });
    const withEffective = reducer(withDetail, { type: "effective", effective });
    const switched = reducer(withEffective, { type: "project", root: "/other-workspace" });

    expect(switched.projectRoot).toBe("/other-workspace");
    expect(switched.assetDetail).toBeUndefined();
    expect(switched.effective).toBeUndefined();
  });

  it("drops late review results from a previously selected project", () => {
    const current = reducer(initialState, { type: "project", root: "/workspace/b" });
    const asset = migrationAssetFixture("asset-old", "rule:old");
    const lateAssets = reducer(current, {
      type: "assets",
      projectRoot: "/workspace/a",
      assets: [asset],
    });
    const lateDiagnostics = reducer(current, {
      type: "diagnostics",
      projectRoot: "/workspace/a",
      diagnostics: [
        {
          id: DiagnosticIdSchema.parse("diagnostic-old"),
          code: "OLD_PROJECT",
          severity: "warning",
          message: "Old project result",
          suggestedAction: "Ignore it",
          blocking: false,
        },
      ],
      counts: { info: 0, warning: 1, error: 0 },
    });
    const lateScan = reducer(current, {
      type: "scan",
      status: "complete",
      scanScope: "asset-review",
      projectRoot: "/workspace/a",
    });

    expect(lateAssets).toBe(current);
    expect(lateDiagnostics).toBe(current);
    expect(lateScan).toBe(current);
  });

  it("prunes stale asset details after refreshes", () => {
    const detail = {
      asset: {
        id: AssetIdSchema.parse("asset-1"),
        toolKey: "codex" as const,
        resourceType: "rule" as const,
        scopeId: ScopeIdSchema.parse("scope-1"),
        logicalKey: "AGENTS.md",
        status: "enabled" as const,
        disablementOptions: disablementOptionsFixture,
      },
      source: assetDetailSourceFixture,
      redactions: [],
    };
    const effective = {
      effective: { rules: ["Use tests."] },
      contributors: [],
      ignored: [],
      diagnostics: [],
      snapshotRevision: "revision-1",
    };
    const withDetail = reducer(initialState, { type: "assetDetail", detail });
    const withEffective = reducer(withDetail, { type: "effective", effective });
    const assetsRefreshed = reducer(withEffective, { type: "assets", assets: [] });

    expect(assetsRefreshed.assetDetail).toBeUndefined();
    expect(assetsRefreshed.effective).toBeUndefined();
  });

  it("closes inspected detail when its index snapshot refreshes", () => {
    const detail = {
      asset: {
        id: AssetIdSchema.parse("asset-1"),
        toolKey: "codex" as const,
        resourceType: "rule" as const,
        scopeId: ScopeIdSchema.parse("scope-1"),
        logicalKey: "AGENTS.md",
        status: "enabled" as const,
        disablementOptions: disablementOptionsFixture,
      },
      source: assetDetailSourceFixture,
      redactions: [],
    };
    const withDetail = reducer(initialState, { type: "assetDetail", detail });
    const refreshed = reducer(withDetail, {
      type: "assets",
      assets: [migrationAssetFixture("asset-1", "rule:AGENTS")],
    });

    expect(refreshed.assetDetail).toBeUndefined();
    expect(refreshed.effective).toBeUndefined();
  });

  it("requires explicit deployment confirmation for each fresh preview", () => {
    const preview = migrationPreviewFixture({
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "full" as const,
      changes: [
        {
          operation: "create" as const,
          deploymentType: "generated_file" as const,
          pathDisplay: "/workspace/.cursor/rules/generated.mdc",
          beforeHash: null,
          afterHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          diff: "+ Use tests.",
        },
      ],
      expiresAt: "2026-06-28T08:10:00.000Z",
    });
    const confirmed = reducer(initialState, { type: "deploymentConfirmation", confirmed: true });
    const withPreview = reducer(confirmed, { type: "preview", preview });

    expect(confirmed.deploymentConfirmed).toBe(true);
    expect(withPreview.deploymentConfirmed).toBe(false);
    expect(
      reducer(withPreview, { type: "deploymentConfirmation", confirmed: true }).deploymentConfirmed,
    ).toBe(true);
  });

  it("retires a deployment preview after a successful deployment task completes", () => {
    const preview = migrationPreviewFixture({
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "full" as const,
      requiredConfirmations: ["overwrite"] as const,
      changes: [
        {
          operation: "replace" as const,
          deploymentType: "generated_file" as const,
          pathDisplay: "/workspace/.cursor/rules/generated.mdc",
          beforeHash: ContentHashSchema.parse(`sha256:${"e".repeat(64)}`),
          afterHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          diff: "+ Use tests.",
        },
      ],
      expiresAt: "2026-06-28T08:10:00.000Z",
    });
    const selected: AppState = {
      ...initialState,
      migration: {
        ...initialState.migration,
        sourceAssetIds: [AssetIdSchema.parse("asset-source")],
      },
    };
    const withPreview = reducer(selected, { type: "preview", preview });
    const confirmed = reducer(withPreview, { type: "deploymentConfirmation", confirmed: true });
    const granted = reducer(confirmed, {
      type: "deploymentConfirmationGrant",
      confirmation: "overwrite",
      granted: true,
    });
    const completed = reducer(granted, {
      type: "taskEvent",
      action: taskActionForTaskEvent({
        apiVersion: 1,
        eventVersion: 1,
        taskId: TaskIdSchema.parse("task:deployment:deployment-1"),
        sequence: 8,
        emittedAt: "2026-06-28T08:00:04.000Z",
        type: "completed",
        payload: {
          status: "succeeded",
          succeededCount: 1,
          failedCount: 0,
          skippedCount: 0,
          resultRef: "deployment-1",
          systemRecoveryLock: false,
        },
      })!,
    });

    expect(completed.preview).toBeUndefined();
    expect(completed.deploymentConfirmed).toBe(false);
    expect(completed.deploymentConfirmationGrants).toEqual([]);
    expect(completed.migration.sourceAssetIds).toEqual([]);
    expect(completed.activeTask?.message).toBe("Deployment complete: 1 succeeded.");
    expect(deploymentBlockersForState(completed, "2026-06-28T08:00:04.000Z")).toEqual([
      "Create a migration preview before migrating.",
    ]);
  });

  it("requires every migration confirmation grant before deployment", () => {
    const preview = migrationPreviewFixture({
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "partial" as const,
      requiredConfirmations: ["overwrite", "partial_conversion"] as const,
      changes: [
        {
          operation: "replace" as const,
          deploymentType: "generated_file" as const,
          pathDisplay: "/workspace/.cursor/rules/generated.mdc",
          beforeHash: ContentHashSchema.parse(`sha256:${"e".repeat(64)}`),
          afterHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          diff: "+ Use tests.",
        },
      ],
      expiresAt: "2026-06-28T08:10:00.000Z",
    });
    const withPreview = reducer(initialState, { type: "preview", preview });
    const acknowledged = reducer(withPreview, {
      type: "deploymentConfirmation",
      confirmed: true,
    });
    const overwriteGranted = reducer(acknowledged, {
      type: "deploymentConfirmationGrant",
      confirmation: "overwrite",
      granted: true,
    });
    const allGranted = reducer(overwriteGranted, {
      type: "deploymentConfirmationGrant",
      confirmation: "partial_conversion",
      granted: true,
    });

    expect(deploymentBlockersForState(acknowledged, "2026-06-28T08:00:00.000Z")).toEqual([
      "Confirm required migration actions: Overwrite existing target files. Deploy a partial conversion with documented warnings.",
    ]);
    expect(deploymentBlockersForState(overwriteGranted, "2026-06-28T08:00:00.000Z")).toEqual([
      "Confirm required migration actions: Deploy a partial conversion with documented warnings.",
    ]);
    expect(deploymentBlockersForState(allGranted, "2026-06-28T08:00:00.000Z")).toEqual([]);
    expect(deploymentConfirmationsForState(allGranted)).toEqual([
      "overwrite",
      "partial_conversion",
    ]);
    expect(reducer(allGranted, { type: "preview", preview }).deploymentConfirmationGrants).toEqual(
      [],
    );
  });

  it("blocks deployment without a confirmed fresh preview and when sources drift", () => {
    expect(deploymentBlockersForState(initialState)).toEqual([
      "Create a migration preview before migrating.",
    ]);

    const preview = migrationPreviewFixture({
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "full" as const,
      changes: [
        {
          operation: "create" as const,
          deploymentType: "generated_file" as const,
          pathDisplay: "/workspace/.cursor/rules/generated.mdc",
          beforeHash: null,
          afterHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          diff: "+ Use tests.",
        },
      ],
      warnings: [],
      sourceHashes: {
        [AssetIdSchema.parse("asset-1")]: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
      },
      expiresAt: "2026-06-28T08:10:00.000Z",
    });
    const withAssets = reducer(initialState, {
      type: "migrationSourceAssets",
      assets: [
        {
          ...migrationAssetFixture("asset-1", "AGENTS.md"),
          contentHash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
        },
      ],
    });
    const withPreview = reducer(withAssets, { type: "preview", preview });
    const confirmed = reducer(withPreview, { type: "deploymentConfirmation", confirmed: true });

    expect(deploymentBlockersForState(withPreview, "2026-06-28T08:00:00.000Z")).toEqual([
      "Refresh the scan and create a fresh migration preview before migrating.",
      "Confirm that this writes verified config files.",
    ]);
    expect(deploymentBlockersForState(confirmed, "2026-06-28T08:00:00.000Z")).toEqual([
      "Refresh the scan and create a fresh migration preview before migrating.",
    ]);
  });

  it("blocks deployment after a migration preview expires", () => {
    const preview = migrationPreviewFixture({
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "full" as const,
      changes: [
        {
          operation: "create" as const,
          deploymentType: "generated_file" as const,
          pathDisplay: "/workspace/.cursor/rules/generated.mdc",
          beforeHash: null,
          afterHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          diff: "+ Use tests.",
        },
      ],
      expiresAt: "2026-06-28T08:10:00.000Z",
    });
    const confirmed = reducer(reducer(initialState, { type: "preview", preview }), {
      type: "deploymentConfirmation",
      confirmed: true,
    });

    expect(deploymentBlockersForState(confirmed, "2026-06-28T08:10:00.000Z")).toEqual([]);
    expect(deploymentBlockersForState(confirmed, "2026-06-28T08:10:00.001Z")).toEqual([
      "Create a fresh migration preview; the current plan has expired.",
    ]);
  });

  it("blocks deployment while a recovery lock is active", () => {
    const state = reducer(initialState, {
      type: "taskEvent",
      action: {
        taskId: "task:deployment:failed",
        taskKind: "deployment",
        phase: "completed",
        status: "failed",
        recoveryLock: true,
      },
    });

    expect(deploymentBlockersForState(state)).toContain(
      "Resolve the active recovery lock before migrating.",
    );
  });

  it("summarizes migration preview hashes in stable source and target order", () => {
    const preview = migrationPreviewFixture({
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "full" as const,
      changes: [
        {
          operation: "replace" as const,
          deploymentType: "generated_file" as const,
          pathDisplay: "/workspace/.cursor/rules/generated.mdc",
          beforeHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          afterHash: ContentHashSchema.parse(`sha256:${"e".repeat(64)}`),
          diff: "+ Use tests.",
        },
      ],
      sourceHashes: {
        [AssetIdSchema.parse("asset-z")]: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
        [AssetIdSchema.parse("asset-a")]: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
      },
      targetHashes: {
        "/workspace/.cursor/rules/generated.mdc": ContentHashSchema.parse(
          `sha256:${"d".repeat(64)}`,
        ),
        "/workspace/.cursor/rules/new.mdc": null,
      },
      expiresAt: "2026-06-28T08:10:00.000Z",
    });

    expect(migrationHashRowsForPreview(preview)).toEqual([
      {
        kind: "source",
        label: "asset-a",
        hash: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
      },
      {
        kind: "source",
        label: "asset-z",
        hash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
      },
      {
        kind: "target",
        label: "/workspace/.cursor/rules/generated.mdc",
        hash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
      },
      {
        kind: "target",
        label: "/workspace/.cursor/rules/new.mdc",
        hash: "absent",
      },
    ]);
  });

  it("summarizes active migration differences from the preview plan", () => {
    const preview = migrationPreviewFixture({
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "partial" as const,
      fieldLosses: [
        {
          assetId: AssetIdSchema.parse("asset-field-loss"),
          droppedFields: ["/unsupported"],
          retainedFields: ["/name"],
          transformedFields: [],
          warnings: ["Unsupported field will be dropped"],
        },
      ],
      requiredConfirmations: ["overwrite"] as const,
      changes: [
        {
          operation: "create" as const,
          deploymentType: "generated_file" as const,
          pathDisplay: "/workspace/.cursor/rules/new.mdc",
          beforeHash: null,
          afterHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          diff: "+ New",
        },
        {
          operation: "replace" as const,
          deploymentType: "generated_file" as const,
          pathDisplay: "/workspace/.cursor/rules/existing.mdc",
          beforeHash: ContentHashSchema.parse(`sha256:${"e".repeat(64)}`),
          afterHash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
          diff: "- Old\n+ New",
        },
      ],
      warnings: [
        {
          id: DiagnosticIdSchema.parse("diagnostic-warning"),
          code: "PARTIAL_CONVERSION",
          severity: "warning" as const,
          message: "One field cannot be represented by the target tool.",
          suggestedAction: "Review before deployment.",
          blocking: false,
        },
      ],
      sourceHashes: {
        [AssetIdSchema.parse("asset-create")]: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
        [AssetIdSchema.parse("asset-replace")]: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
      },
      targetHashes: {
        "/workspace/.cursor/rules/new.mdc": null,
        "/workspace/.cursor/rules/existing.mdc": ContentHashSchema.parse(
          `sha256:${"e".repeat(64)}`,
        ),
      },
      expiresAt: "2026-06-28T08:10:00.000Z",
    });
    const state = reducer(initialState, { type: "preview", preview });

    expect(migrationDifferenceSummaryForState(state)).toEqual({
      addedToTarget: 1,
      overwrittenInTarget: 1,
      targetOnlyKept: 0,
      conflictsOrWarnings: 2,
    });
    expect(migrationDifferenceSummaryForState(initialState)).toEqual({
      addedToTarget: 0,
      overwrittenInTarget: 0,
      targetOnlyKept: 0,
      conflictsOrWarnings: 0,
    });
  });

  it("summarizes refreshed source and target list differences before a preview exists", () => {
    const state = reducer(
      reducer(
        reducer(
          reducer(initialState, {
            type: "migrationSourceProject",
            sourceProjectRoot: "/workspace/source",
          }),
          {
            type: "migrationTargetProject",
            targetScopeId: "/workspace/target",
          },
        ),
        {
          type: "migrationSourceAssets",
          sourceProjectRoot: "/workspace/source",
          assets: [
            migrationAssetFixture("asset-source-shared", "rule:shared", {
              contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
              toolKey: "codex",
            }),
            migrationAssetFixture("asset-source-new", "rule:new", {
              contentHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
              toolKey: "codex",
            }),
          ],
        },
      ),
      {
        type: "migrationTargetAssets",
        targetScopeId: "/workspace/target",
        assets: [
          migrationAssetFixture("asset-target-shared", "rule:shared", {
            contentHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
            toolKey: "cursor",
          }),
          migrationAssetFixture("asset-target-only", "rule:target-only", {
            contentHash: ContentHashSchema.parse(`sha256:${"e".repeat(64)}`),
            toolKey: "cursor",
          }),
          migrationAssetFixture("asset-target-other-tool", "rule:codex-only", {
            contentHash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
            toolKey: "codex",
          }),
        ],
      },
    );

    expect(state.preview).toBeUndefined();
    expect(state.migration.sourceAssetIds).toEqual(["asset-source-shared"]);
    expect(migrationDifferenceSummaryForState(state)).toEqual({
      addedToTarget: 0,
      overwrittenInTarget: 1,
      targetOnlyKept: 1,
      conflictsOrWarnings: 0,
    });

    const withBothSources = reducer(state, {
      type: "migrationSource",
      assetId: AssetIdSchema.parse("asset-source-new"),
      selected: true,
    });
    expect(migrationDifferenceSummaryForState(withBothSources)).toEqual({
      addedToTarget: 1,
      overwrittenInTarget: 1,
      targetOnlyKept: 1,
      conflictsOrWarnings: 0,
    });
  });

  it("shows selected source assets as additions when the target project is empty", () => {
    const withProjects = reducer(
      reducer(initialState, {
        type: "migrationSourceProject",
        sourceProjectRoot: "/workspace/source",
      }),
      { type: "migrationTargetProject", targetScopeId: "/workspace/empty-target" },
    );
    const withSource = reducer(withProjects, {
      type: "migrationSourceAssets",
      sourceProjectRoot: "/workspace/source",
      assets: [migrationAssetFixture("asset-source-new", "rule:new", { toolKey: "codex" })],
    });
    const withEmptyTarget = reducer(withSource, {
      type: "migrationTargetAssets",
      targetScopeId: "/workspace/empty-target",
      assets: [],
    });

    expect(migrationDifferenceSummaryForState(withEmptyTarget)).toEqual({
      addedToTarget: 1,
      overwrittenInTarget: 0,
      targetOnlyKept: 0,
      conflictsOrWarnings: 0,
    });
  });

  it("ignores stale scoped migration asset refreshes after the project changes", () => {
    const withSourceA = reducer(initialState, {
      type: "migrationSourceProject",
      sourceProjectRoot: "/workspace/source-a",
    });
    const withSourceB = reducer(withSourceA, {
      type: "migrationSourceProject",
      sourceProjectRoot: "/workspace/source-b",
    });
    const staleSource = reducer(withSourceB, {
      type: "migrationSourceAssets",
      sourceProjectRoot: "/workspace/source-a",
      assets: [migrationAssetFixture("asset-source-a", "rule:old-source")],
    });
    const freshSource = reducer(staleSource, {
      type: "migrationSourceAssets",
      sourceProjectRoot: "/workspace/source-b",
      assets: [migrationAssetFixture("asset-source-b", "rule:new-source")],
    });

    expect(staleSource.migrationSourceAssets).toEqual([]);
    expect(freshSource.migrationSourceAssets.map((asset) => asset.id)).toEqual(["asset-source-b"]);

    const withTargetA = reducer(freshSource, {
      type: "migrationTargetProject",
      targetScopeId: "/workspace/target-a",
    });
    const withTargetB = reducer(withTargetA, {
      type: "migrationTargetProject",
      targetScopeId: "/workspace/target-b",
    });
    const staleTarget = reducer(withTargetB, {
      type: "migrationTargetAssets",
      targetScopeId: "/workspace/target-a",
      assets: [migrationAssetFixture("asset-target-a", "rule:old-target")],
    });
    const freshTarget = reducer(staleTarget, {
      type: "migrationTargetAssets",
      targetScopeId: "/workspace/target-b",
      assets: [migrationAssetFixture("asset-target-b", "rule:new-target")],
    });

    expect(staleTarget.migrationTargetAssets).toEqual([]);
    expect(freshTarget.migrationTargetAssets.map((asset) => asset.id)).toEqual(["asset-target-b"]);
  });

  it("detects source asset drift against the current indexed asset hashes", () => {
    const preview = migrationPreviewFixture({
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "full" as const,
      changes: [
        {
          operation: "create" as const,
          deploymentType: "generated_file" as const,
          pathDisplay: "/workspace/.cursor/rules/generated.mdc",
          beforeHash: null,
          afterHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          diff: "+ Use tests.",
        },
      ],
      warnings: [],
      sourceHashes: {
        [AssetIdSchema.parse("asset-current")]: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
        [AssetIdSchema.parse("asset-changed")]: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
        [AssetIdSchema.parse("asset-missing")]: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      },
      targetHashes: {},
      expiresAt: "2026-06-28T08:10:00.000Z",
    });
    const state = reducer(
      reducer(
        reducer(initialState, {
          type: "migrationSourceProject",
          sourceProjectRoot: "/workspace/source",
        }),
        {
          type: "migrationSourceAssets",
          assets: [
            migrationAssetFixture("asset-current", "AGENTS.md"),
            {
              ...migrationAssetFixture("asset-changed", "STALE.md"),
              contentHash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
            },
          ],
        },
      ),
      { type: "preview", preview },
    );

    expect(migrationSourceDriftRowsForState(state)).toEqual([
      {
        assetId: "asset-changed",
        status: "changed",
        expectedHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
        currentHash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
      },
      {
        assetId: "asset-current",
        status: "current",
        expectedHash: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
        currentHash: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
      },
      {
        assetId: "asset-missing",
        status: "missing",
        expectedHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
        currentHash: null,
      },
    ]);
  });
});

function migrationAssetFixture(
  id: string,
  logicalKey: string,
  overrides: Partial<
    Pick<
      AppState["assets"][number],
      "contentHash" | "resourceType" | "scopeKind" | "status" | "toolKey"
    >
  > = {},
): AppState["assets"][number] {
  return {
    id: AssetIdSchema.parse(id),
    toolKey: overrides.toolKey ?? "codex",
    resourceType: overrides.resourceType ?? "rule",
    scopeKind: overrides.scopeKind ?? "project",
    logicalKey,
    sourceSummary: fileSourceSummary(logicalKey.split("/").at(-1) ?? logicalKey),
    contentHash: overrides.contentHash ?? ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
    status: overrides.status ?? "enabled",
    diagnosticCounts: { info: 0, warning: 0, error: 0 },
  };
}
