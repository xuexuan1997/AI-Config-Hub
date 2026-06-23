import { type ApiCommandName, type CommandServiceMap } from "@ai-config-hub/api";
import {
  ContentHashSchema,
  DeploymentPlanIdSchema,
  DeploymentRecordIdSchema,
  TaskIdSchema,
} from "@ai-config-hub/shared";

const acceptedAt = "2026-06-22T12:00:00.000Z";
const emptyCounts = { info: 0, warning: 0, error: 0 };
const planHash = ContentHashSchema.parse(`sha256:${"1".repeat(64)}`);
const planId = DeploymentPlanIdSchema.parse("desktop-preview-plan");
const deploymentId = DeploymentRecordIdSchema.parse("desktop-deployment");

export function createDesktopCommandServices(): CommandServiceMap {
  const services: Record<ApiCommandName, (payload: unknown) => Promise<unknown>> = {
    "scan.start": () =>
      resolved({
        taskId: TaskIdSchema.parse("task-scan"),
        status: "queued",
        acceptedAt,
      }),
    "scan.status": (payload) =>
      resolved({
        taskId: (payload as { readonly taskId: string }).taskId,
        status: "succeeded",
        phase: "completed",
        progress: { phase: "completed", completed: 1, total: 1, unit: "items" },
        resultSummary: { succeededCount: 1, failedCount: 0, skippedCount: 0, diagnosticIds: [] },
        lastSequence: 1,
        cancellable: false,
        startedAt: acceptedAt,
        finishedAt: acceptedAt,
      }),
    "scan.cancel": (payload) =>
      resolved({
        taskId: (payload as { readonly taskId: string }).taskId,
        cancelRequested: true,
        effectiveAfterPhase: "completed",
      }),
    "assets.list": () =>
      resolved({
        items: [
          {
            id: "asset-demo",
            toolKey: "codex",
            resourceType: "rule",
            scopeKind: "project",
            logicalKey: "Project instructions",
            contentHash: ContentHashSchema.parse(`sha256:${"2".repeat(64)}`),
            diagnosticCounts: emptyCounts,
          },
        ],
        nextCursor: null,
        snapshotRevision: "desktop-demo",
        stale: false,
      }),
    "assets.get": (payload) =>
      resolved({
        asset: {
          id: (payload as { readonly assetId: string }).assetId,
          toolKey: "codex",
          resourceType: "rule",
          scopeId: "scope-demo",
          logicalKey: "Project instructions",
          normalized: { kind: "rule", instructions: "Use the project conventions." },
          references: [],
          diagnosticIds: [],
        },
        source: {
          pathDisplay: "Selected project / AGENTS.md",
          contentHash: ContentHashSchema.parse(`sha256:${"2".repeat(64)}`),
          observedAt: acceptedAt,
        },
        redactions: [],
      }),
    "effective.resolve": () =>
      resolved({
        effective: { instructions: "Use the project conventions." },
        contributors: [],
        ignored: [],
        diagnostics: [],
        snapshotRevision: "desktop-demo",
      }),
    "diagnostics.list": () =>
      resolved({
        items: [],
        nextCursor: null,
        countsBySeverity: emptyCounts,
        snapshotRevision: "desktop-demo",
      }),
    "migration.preview": () =>
      resolved({
        planId,
        planHash,
        compatibility: "full",
        changes: [
          {
            operation: "replace",
            pathDisplay: ".cursor/rules/generated.mdc",
            beforeHash: ContentHashSchema.parse(`sha256:${"3".repeat(64)}`),
            afterHash: ContentHashSchema.parse(`sha256:${"4".repeat(64)}`),
            diff: "- old\n+ Use the project conventions.",
          },
        ],
        warnings: [],
        sourceHashes: { "asset-demo": ContentHashSchema.parse(`sha256:${"2".repeat(64)}`) },
        targetHashes: {
          ".cursor/rules/generated.mdc": ContentHashSchema.parse(`sha256:${"3".repeat(64)}`),
        },
        expiresAt: "2026-06-22T12:10:00.000Z",
      }),
    "deployment.execute": () =>
      resolved({
        taskId: TaskIdSchema.parse("task-deployment"),
        status: "queued",
        acceptedAt,
        deploymentId,
      }),
    "deployment.rollback": () =>
      resolved({
        taskId: TaskIdSchema.parse("task-rollback"),
        status: "queued",
        acceptedAt,
        rollbackId: DeploymentRecordIdSchema.parse("desktop-rollback"),
      }),
    "history.list": () =>
      resolved({
        items: [
          {
            id: "desktop-deployment",
            kind: "deployment",
            status: "succeeded",
            createdAt: acceptedAt,
            finishedAt: acceptedAt,
          },
        ],
        nextCursor: null,
      }),
    "settings.get": () =>
      resolved({
        values: {
          theme: "system",
          pathDisplay: "abbreviated",
          scanHints: true,
          fileWatching: true,
        },
        revision: 0,
        readOnlyRecovery: false,
      }),
    "settings.update": (payload) =>
      resolved({
        values: (payload as { readonly patch: unknown }).patch,
        revision: (payload as { readonly expectedRevision: number }).expectedRevision + 1,
        requiresRestart: false,
      }),
  };
  return services as unknown as CommandServiceMap;
}

function resolved(value: unknown): Promise<unknown> {
  return Promise.resolve(value);
}
