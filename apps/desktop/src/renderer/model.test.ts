import {
  AssetIdSchema,
  ContentHashSchema,
  DeploymentPlanIdSchema,
  DeploymentRecordIdSchema,
  DiagnosticIdSchema,
  ScopeIdSchema,
  TaskIdSchema,
} from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import {
  deploymentBlockersForState,
  deploymentConfirmationsForState,
  effectiveRequestForState,
  formatUiError,
  historyDetailRequestForEntry,
  initialState,
  migrationHashRowsForPreview,
  migrationSourceDriftRowsForState,
  openSourceRequestForState,
  previewRequestForState,
  reducer,
  rollbackRequestForState,
  taskActionForTaskEvent,
  scanActionForTaskEvent,
} from "./model.js";

describe("renderer project selection state", () => {
  it("turns missing Linux file chooser errors into a manual path fallback message", () => {
    const message = formatUiError(
      new Error("No such interface “org.freedesktop.portal.FileChooser” on object"),
      "Select project",
    );

    expect(message).toContain("Select project failed");
    expect(message).toContain("system file chooser is unavailable");
    expect(message).toContain("type the project path manually");
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

  it("builds migration previews from the selected project and indexed assets only", () => {
    expect(previewRequestForState(initialState)).toBeUndefined();

    const withProject = reducer(initialState, {
      type: "project",
      root: "/home/user/workspace",
    });
    const withAssets = reducer(withProject, {
      type: "assets",
      assets: [
        {
          id: AssetIdSchema.parse("asset-1"),
          toolKey: "codex",
          resourceType: "rule",
          scopeKind: "project",
          logicalKey: "AGENTS.md",
          contentHash: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
          diagnosticCounts: { info: 0, warning: 0, error: 0 },
        },
      ],
    });

    expect(previewRequestForState(withAssets)).toEqual({
      sourceAssetIds: ["asset-1"],
      targetToolKey: "cursor",
      targetScopeId: "/home/user/workspace",
      conflictPolicy: "replace",
    });
  });

  it("builds migration previews from explicit migration selections", () => {
    const withProject = reducer(initialState, {
      type: "project",
      root: "/home/user/workspace",
    });
    const withAssets = reducer(withProject, {
      type: "assets",
      assets: [
        {
          id: AssetIdSchema.parse("asset-1"),
          toolKey: "codex",
          resourceType: "rule",
          scopeKind: "project",
          logicalKey: "AGENTS.md",
          contentHash: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
          diagnosticCounts: { info: 0, warning: 0, error: 0 },
        },
        {
          id: AssetIdSchema.parse("asset-2"),
          toolKey: "claude-code",
          resourceType: "skill",
          scopeKind: "project",
          logicalKey: "review/SKILL.md",
          contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
          diagnosticCounts: { info: 0, warning: 0, error: 0 },
        },
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
      targetScopeId: "/home/user/workspace",
      conflictPolicy: "fail",
    });
  });

  it("uses the newest succeeded deployment history item for rollback", () => {
    expect(rollbackRequestForState(initialState)).toBeUndefined();

    const state = reducer(initialState, {
      type: "history",
      history: [
        {
          id: "rollback-1",
          kind: "rollback",
          status: "succeeded",
          createdAt: "2026-06-28T08:05:00.000Z",
        },
        {
          id: "deployment-1",
          kind: "deployment",
          status: "succeeded",
          createdAt: "2026-06-28T08:00:00.000Z",
        },
      ],
    });

    expect(rollbackRequestForState(state)).toEqual({ deploymentId: "deployment-1" });
  });

  it("maps task completion events onto scan status messages", () => {
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
      message: "Task task-scan succeeded: 2 succeeded, 0 failed, 1 skipped.",
    });
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
      message: "deployment failed: 0 succeeded, 1 failed, 0 skipped.",
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
  });

  it("stores asset details and diagnostics for the assets workspace", () => {
    const detail = {
      asset: {
        id: AssetIdSchema.parse("asset-1"),
        toolKey: "codex" as const,
        resourceType: "rule" as const,
        scopeId: ScopeIdSchema.parse("scope-1"),
        logicalKey: "AGENTS.md",
        normalized: { kind: "rule", data: { instructions: "Use tests." } },
        references: ["README.md"],
        diagnosticIds: [DiagnosticIdSchema.parse("diagnostic-1")],
      },
      source: {
        pathDisplay: "/workspace/AGENTS.md",
        contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
        observedAt: "2026-06-28T08:00:00.000Z",
      },
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
      },
      source: {
        pathDisplay: "/workspace/AGENTS.md",
        contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
        observedAt: "2026-06-28T08:00:00.000Z",
      },
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

  it("opens source files by selected asset id only", () => {
    const detail = {
      asset: {
        id: AssetIdSchema.parse("asset-1"),
        toolKey: "codex" as const,
        resourceType: "rule" as const,
        scopeId: ScopeIdSchema.parse("scope-1"),
        logicalKey: "AGENTS.md",
      },
      source: {
        pathDisplay: "/workspace/AGENTS.md",
        contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
        observedAt: "2026-06-28T08:00:00.000Z",
      },
      redactions: [],
    };
    const withDetail = reducer(initialState, { type: "assetDetail", detail });

    expect(openSourceRequestForState(initialState)).toBeUndefined();
    expect(openSourceRequestForState(withDetail)).toEqual({ assetId: "asset-1" });
  });

  it("clears project-scoped details when the project changes", () => {
    const detail = {
      asset: {
        id: AssetIdSchema.parse("asset-1"),
        toolKey: "codex" as const,
        resourceType: "rule" as const,
        scopeId: ScopeIdSchema.parse("scope-1"),
        logicalKey: "AGENTS.md",
      },
      source: {
        pathDisplay: "/workspace/AGENTS.md",
        contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
        observedAt: "2026-06-28T08:00:00.000Z",
      },
      redactions: [],
    };
    const effective = {
      effective: { rules: ["Use tests."] },
      contributors: [],
      ignored: [],
      diagnostics: [],
      snapshotRevision: "revision-1",
    };
    const historyDetail = {
      entry: {
        id: DeploymentRecordIdSchema.parse("deployment-1"),
        kind: "deployment" as const,
        status: "succeeded",
        createdAt: "2026-06-28T08:00:00.000Z",
      },
      plan: {
        planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
        planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
        requiredConfirmations: [],
      },
      changes: [],
    };
    const withProject = reducer(initialState, { type: "project", root: "/workspace" });
    const withDetail = reducer(withProject, { type: "assetDetail", detail });
    const withEffective = reducer(withDetail, { type: "effective", effective });
    const withHistoryDetail = reducer(withEffective, {
      type: "historyDetail",
      detail: historyDetail,
    });
    const switched = reducer(withHistoryDetail, { type: "project", root: "/other-workspace" });

    expect(switched.projectRoot).toBe("/other-workspace");
    expect(switched.assetDetail).toBeUndefined();
    expect(switched.effective).toBeUndefined();
    expect(switched.historyDetail).toBeUndefined();
  });

  it("prunes stale asset and history details after refreshes", () => {
    const detail = {
      asset: {
        id: AssetIdSchema.parse("asset-1"),
        toolKey: "codex" as const,
        resourceType: "rule" as const,
        scopeId: ScopeIdSchema.parse("scope-1"),
        logicalKey: "AGENTS.md",
      },
      source: {
        pathDisplay: "/workspace/AGENTS.md",
        contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
        observedAt: "2026-06-28T08:00:00.000Z",
      },
      redactions: [],
    };
    const effective = {
      effective: { rules: ["Use tests."] },
      contributors: [],
      ignored: [],
      diagnostics: [],
      snapshotRevision: "revision-1",
    };
    const historyDetail = {
      entry: {
        id: DeploymentRecordIdSchema.parse("deployment-1"),
        kind: "deployment" as const,
        status: "succeeded",
        createdAt: "2026-06-28T08:00:00.000Z",
      },
      plan: {
        planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
        planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
        requiredConfirmations: [],
      },
      changes: [],
    };
    const withDetail = reducer(initialState, { type: "assetDetail", detail });
    const withEffective = reducer(withDetail, { type: "effective", effective });
    const withHistoryDetail = reducer(withEffective, {
      type: "historyDetail",
      detail: historyDetail,
    });
    const assetsRefreshed = reducer(withHistoryDetail, { type: "assets", assets: [] });
    const historyRefreshed = reducer(withHistoryDetail, { type: "history", history: [] });

    expect(assetsRefreshed.assetDetail).toBeUndefined();
    expect(assetsRefreshed.effective).toBeUndefined();
    expect(historyRefreshed.historyDetail).toBeUndefined();
  });

  it("requires explicit deployment confirmation for each fresh preview", () => {
    const preview = {
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "full" as const,
      fieldLosses: [],
      requiredConfirmations: [],
      changes: [
        {
          operation: "create" as const,
          pathDisplay: "/workspace/.cursor/rules/generated.mdc",
          beforeHash: null,
          afterHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          diff: "+ Use tests.",
        },
      ],
      warnings: [],
      sourceHashes: {},
      targetHashes: {},
      expiresAt: "2026-06-28T08:10:00.000Z",
    };
    const confirmed = reducer(initialState, { type: "deploymentConfirmation", confirmed: true });
    const withPreview = reducer(confirmed, { type: "preview", preview });

    expect(confirmed.deploymentConfirmed).toBe(true);
    expect(withPreview.deploymentConfirmed).toBe(false);
    expect(
      reducer(withPreview, { type: "deploymentConfirmation", confirmed: true }).deploymentConfirmed,
    ).toBe(true);
  });

  it("requires every migration confirmation grant before deployment", () => {
    const preview = {
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "partial" as const,
      fieldLosses: [],
      requiredConfirmations: ["overwrite", "partial_conversion"] as const,
      changes: [
        {
          operation: "replace" as const,
          pathDisplay: "/workspace/.cursor/rules/generated.mdc",
          beforeHash: ContentHashSchema.parse(`sha256:${"e".repeat(64)}`),
          afterHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          diff: "+ Use tests.",
        },
      ],
      warnings: [],
      sourceHashes: {},
      targetHashes: {},
      expiresAt: "2026-06-28T08:10:00.000Z",
    };
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
      "Confirm required migration actions: overwrite, partial_conversion.",
    ]);
    expect(deploymentBlockersForState(overwriteGranted, "2026-06-28T08:00:00.000Z")).toEqual([
      "Confirm required migration actions: partial_conversion.",
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
      "Create a migration preview before deploying.",
      "Confirm that this writes verified config files.",
    ]);

    const preview = {
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "full" as const,
      fieldLosses: [],
      requiredConfirmations: [],
      changes: [
        {
          operation: "create" as const,
          pathDisplay: "/workspace/.cursor/rules/generated.mdc",
          beforeHash: null,
          afterHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          diff: "+ Use tests.",
        },
      ],
      warnings: [],
      sourceHashes: {
        "asset-1": ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
      },
      targetHashes: {},
      expiresAt: "2026-06-28T08:10:00.000Z",
    };
    const withAssets = reducer(initialState, {
      type: "assets",
      assets: [
        {
          id: AssetIdSchema.parse("asset-1"),
          toolKey: "codex",
          resourceType: "rule",
          scopeKind: "project",
          logicalKey: "AGENTS.md",
          contentHash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
          diagnosticCounts: { info: 0, warning: 0, error: 0 },
        },
      ],
    });
    const withPreview = reducer(withAssets, { type: "preview", preview });
    const confirmed = reducer(withPreview, { type: "deploymentConfirmation", confirmed: true });

    expect(deploymentBlockersForState(withPreview, "2026-06-28T08:00:00.000Z")).toEqual([
      "Refresh the scan and create a fresh migration preview before deploying.",
      "Confirm that this writes verified config files.",
    ]);
    expect(deploymentBlockersForState(confirmed, "2026-06-28T08:00:00.000Z")).toEqual([
      "Refresh the scan and create a fresh migration preview before deploying.",
    ]);
  });

  it("blocks deployment after a migration preview expires", () => {
    const preview = {
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "full" as const,
      fieldLosses: [],
      requiredConfirmations: [],
      changes: [
        {
          operation: "create" as const,
          pathDisplay: "/workspace/.cursor/rules/generated.mdc",
          beforeHash: null,
          afterHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          diff: "+ Use tests.",
        },
      ],
      warnings: [],
      sourceHashes: {},
      targetHashes: {},
      expiresAt: "2026-06-28T08:10:00.000Z",
    };
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
      "Review recovery history and resolve the active recovery lock before deploying.",
    );
  });

  it("builds and stores history detail requests for diff inspection", () => {
    const detail = {
      entry: {
        id: DeploymentRecordIdSchema.parse("deployment-1"),
        kind: "deployment" as const,
        status: "succeeded",
        createdAt: "2026-06-28T08:00:00.000Z",
      },
      plan: {
        planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
        planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
        requiredConfirmations: ["overwrite"] as const,
      },
      changes: [
        {
          operation: "replace" as const,
          pathDisplay: "/workspace/.cursor/rules/generated.mdc",
          beforeHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          afterHash: ContentHashSchema.parse(`sha256:${"e".repeat(64)}`),
          diff: "- Old\n+ Use tests.",
        },
      ],
    };
    const withDetail = reducer(initialState, { type: "historyDetail", detail });

    expect(historyDetailRequestForEntry("deployment-1")).toEqual({
      id: DeploymentRecordIdSchema.parse("deployment-1"),
    });
    expect(withDetail.historyDetail).toBe(detail);
  });

  it("summarizes migration preview hashes in stable source and target order", () => {
    const preview = {
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "full" as const,
      fieldLosses: [],
      requiredConfirmations: [],
      changes: [
        {
          operation: "replace" as const,
          pathDisplay: "/workspace/.cursor/rules/generated.mdc",
          beforeHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          afterHash: ContentHashSchema.parse(`sha256:${"e".repeat(64)}`),
          diff: "+ Use tests.",
        },
      ],
      warnings: [],
      sourceHashes: {
        "asset-z": ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
        "asset-a": ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
      },
      targetHashes: {
        "/workspace/.cursor/rules/generated.mdc": ContentHashSchema.parse(
          `sha256:${"d".repeat(64)}`,
        ),
        "/workspace/.cursor/rules/new.mdc": null,
      },
      expiresAt: "2026-06-28T08:10:00.000Z",
    };

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

  it("detects source asset drift against the current indexed asset hashes", () => {
    const preview = {
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "full" as const,
      fieldLosses: [],
      requiredConfirmations: [],
      changes: [
        {
          operation: "create" as const,
          pathDisplay: "/workspace/.cursor/rules/generated.mdc",
          beforeHash: null,
          afterHash: ContentHashSchema.parse(`sha256:${"d".repeat(64)}`),
          diff: "+ Use tests.",
        },
      ],
      warnings: [],
      sourceHashes: {
        "asset-current": ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
        "asset-changed": ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
        "asset-missing": ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      },
      targetHashes: {},
      expiresAt: "2026-06-28T08:10:00.000Z",
    };
    const state = reducer(
      reducer(initialState, {
        type: "assets",
        assets: [
          {
            id: AssetIdSchema.parse("asset-current"),
            toolKey: "codex",
            resourceType: "rule",
            scopeKind: "project",
            logicalKey: "AGENTS.md",
            contentHash: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
            diagnosticCounts: { info: 0, warning: 0, error: 0 },
          },
          {
            id: AssetIdSchema.parse("asset-changed"),
            toolKey: "codex",
            resourceType: "rule",
            scopeKind: "project",
            logicalKey: "STALE.md",
            contentHash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
            diagnosticCounts: { info: 0, warning: 0, error: 0 },
          },
        ],
      }),
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
