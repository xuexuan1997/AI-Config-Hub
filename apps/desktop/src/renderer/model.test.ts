import {
  AssetIdSchema,
  ContentHashSchema,
  DeploymentPlanIdSchema,
  DiagnosticIdSchema,
  ScopeIdSchema,
  TaskIdSchema,
} from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import {
  deploymentBlockersForState,
  deploymentConfirmationsForState,
  formatUiError,
  initialState,
  migrationHashRowsForPreview,
  migrationSourceDriftRowsForState,
  previewRequestForState,
  reducer,
  rollbackRequestForState,
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

  it("requires explicit deployment confirmation for each fresh preview", () => {
    const preview = {
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "full" as const,
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

  it("summarizes migration preview hashes in stable source and target order", () => {
    const preview = {
      planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
      planHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
      compatibility: "full" as const,
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
