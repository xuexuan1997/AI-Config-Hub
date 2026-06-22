import { CORE_COMMAND_NAMES } from "@ai-config-hub/core";
import {
  AssetIdSchema,
  ContentHashSchema,
  DeploymentPlanIdSchema,
  DeploymentRecordIdSchema,
  DiagnosticIdSchema,
  DiagnosticSeveritySchema,
  IsoDateTimeSchema,
  PaginationCursorSchema,
  ProjectIdSchema,
  ResourceKindSchema,
  ScopeIdSchema,
  ScopeKindSchema,
  TaskIdSchema,
  ToolIdSchema,
} from "@ai-config-hub/shared";
import { z } from "zod";

import { JsonValueSchema, TaskPhaseSchema, TaskProgressPayloadSchema } from "./events.js";

export const API_COMMAND_NAMES = CORE_COMMAND_NAMES;
export type ApiCommandName = (typeof API_COMMAND_NAMES)[number];

const RegisteredIdentifierSchema = z.string().trim().min(1).max(200);
const AuthorizedRootIdSchema = RegisteredIdentifierSchema.brand<"AuthorizedRootId">();
const RegisteredPathIdSchema = RegisteredIdentifierSchema.brand<"RegisteredPathId">();
const RevisionSchema = z.string().trim().min(1).max(200);
const PageLimitSchema = z.number().int().min(1).max(200).default(50);
const SearchQuerySchema = z.string().trim().min(1).max(500);
const DiagnosticCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

const ScanStartRequestSchema = z
  .object({
    mode: z.enum(["full", "incremental"]),
    projectId: ProjectIdSchema.optional(),
    toolKeys: z.array(ToolIdSchema).min(1).max(4).optional().readonly(),
    roots: z.array(AuthorizedRootIdSchema).min(1).max(100).optional().readonly(),
    changedPaths: z.array(RegisteredPathIdSchema).min(1).max(1_000).optional().readonly(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.mode === "incremental" &&
      request.projectId === undefined &&
      request.changedPaths === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Incremental scans require a registered project or changed paths",
        path: ["mode"],
      });
    }
  })
  .readonly();
const TaskIdRequestSchema = z.object({ taskId: TaskIdSchema }).strict().readonly();
const ScanCancelRequestSchema = z
  .object({ taskId: TaskIdSchema, reason: z.enum(["user", "shutdown"]).default("user") })
  .strict()
  .readonly();
const AssetsListRequestSchema = z
  .object({
    projectId: ProjectIdSchema.optional(),
    toolKeys: z.array(ToolIdSchema).min(1).max(4).optional().readonly(),
    resourceTypes: z.array(ResourceKindSchema).min(1).max(4).optional().readonly(),
    scopeKinds: z.array(ScopeKindSchema).min(1).max(3).optional().readonly(),
    diagnosticSeverity: DiagnosticSeveritySchema.optional(),
    query: SearchQuerySchema.optional(),
    cursor: PaginationCursorSchema.optional(),
    limit: PageLimitSchema,
  })
  .strict()
  .readonly();
const AssetsGetRequestSchema = z
  .object({
    assetId: AssetIdSchema,
    include: z
      .array(z.enum(["normalized", "references", "diagnostics"]))
      .max(3)
      .default([])
      .readonly(),
  })
  .strict()
  .readonly();
const EffectiveResolveRequestSchema = z
  .object({
    toolKey: ToolIdSchema,
    projectId: ProjectIdSchema,
    targetScopeId: ScopeIdSchema,
    resourceTypes: z.array(ResourceKindSchema).min(1).max(4).optional().readonly(),
  })
  .strict()
  .readonly();
const DiagnosticsListRequestSchema = z
  .object({
    projectId: ProjectIdSchema.optional(),
    assetId: AssetIdSchema.optional(),
    toolKeys: z.array(ToolIdSchema).min(1).max(4).optional().readonly(),
    severities: z.array(DiagnosticSeveritySchema).min(1).max(3).optional().readonly(),
    codes: z.array(DiagnosticCodeSchema).min(1).max(100).optional().readonly(),
    cursor: PaginationCursorSchema.optional(),
    limit: PageLimitSchema,
  })
  .strict()
  .readonly();
const MigrationPreviewRequestSchema = z
  .object({
    sourceAssetIds: z.array(AssetIdSchema).min(1).max(200).readonly(),
    targetToolKey: ToolIdSchema,
    targetScopeId: ScopeIdSchema,
    conflictPolicy: z.enum(["fail", "replace", "merge"]),
  })
  .strict()
  .readonly();
const DeploymentExecuteRequestSchema = z
  .object({ planId: DeploymentPlanIdSchema })
  .strict()
  .readonly();
const DeploymentRollbackRequestSchema = z
  .object({ deploymentId: DeploymentRecordIdSchema })
  .strict()
  .readonly();
const HistoryListRequestSchema = z
  .object({
    taskId: TaskIdSchema.optional(),
    kinds: z
      .array(z.enum(["scan", "preview", "deployment", "rollback"]))
      .min(1)
      .max(4)
      .optional()
      .readonly(),
    projectId: ProjectIdSchema.optional(),
    statuses: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional().readonly(),
    from: IsoDateTimeSchema.optional(),
    to: IsoDateTimeSchema.optional(),
    cursor: PaginationCursorSchema.optional(),
    limit: PageLimitSchema,
  })
  .strict()
  .refine(
    (request) =>
      request.from === undefined || request.to === undefined || request.from <= request.to,
    {
      message: "History start must not be after end",
      path: ["from"],
    },
  )
  .readonly();

export const PublicSettingKeySchema = z.enum(["theme", "pathDisplay", "scanHints", "fileWatching"]);
const PublicSettingsPatchSchema = z
  .object({
    theme: z.enum(["system", "light", "dark"]).optional(),
    pathDisplay: z.enum(["full", "abbreviated"]).optional(),
    scanHints: z.boolean().optional(),
    fileWatching: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "Settings patch cannot be empty")
  .readonly();
const SettingsGetRequestSchema = z
  .object({ keys: z.array(PublicSettingKeySchema).min(1).max(4).optional().readonly() })
  .strict()
  .readonly();
const SettingsUpdateRequestSchema = z
  .object({ patch: PublicSettingsPatchSchema, expectedRevision: z.number().int().nonnegative() })
  .strict()
  .readonly();

export const CommandRequestSchemas = {
  "scan.start": ScanStartRequestSchema,
  "scan.status": TaskIdRequestSchema,
  "scan.cancel": ScanCancelRequestSchema,
  "assets.list": AssetsListRequestSchema,
  "assets.get": AssetsGetRequestSchema,
  "effective.resolve": EffectiveResolveRequestSchema,
  "diagnostics.list": DiagnosticsListRequestSchema,
  "migration.preview": MigrationPreviewRequestSchema,
  "deployment.execute": DeploymentExecuteRequestSchema,
  "deployment.rollback": DeploymentRollbackRequestSchema,
  "history.list": HistoryListRequestSchema,
  "settings.get": SettingsGetRequestSchema,
  "settings.update": SettingsUpdateRequestSchema,
} as const satisfies Record<ApiCommandName, z.ZodType>;

const acceptedTaskShape = {
  taskId: TaskIdSchema,
  status: z.literal("queued"),
  acceptedAt: IsoDateTimeSchema,
};
const AcceptedTaskSchema = z.object(acceptedTaskShape).strict().readonly();
const ResultSummarySchema = z
  .object({
    succeededCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    diagnosticIds: z.array(DiagnosticIdSchema).readonly(),
  })
  .strict()
  .readonly();
const ScanStatusResponseSchema = z
  .object({
    taskId: TaskIdSchema,
    status: z.enum([
      "queued",
      "running",
      "succeeded",
      "partially_succeeded",
      "cancelled",
      "failed",
    ]),
    phase: TaskPhaseSchema,
    progress: TaskProgressPayloadSchema,
    resultSummary: ResultSummarySchema.optional(),
    lastSequence: z.number().int().nonnegative(),
    cancellable: z.boolean(),
    startedAt: IsoDateTimeSchema.optional(),
    finishedAt: IsoDateTimeSchema.optional(),
  })
  .strict()
  .readonly();
const ScanCancelResponseSchema = z
  .object({
    taskId: TaskIdSchema,
    cancelRequested: z.literal(true),
    effectiveAfterPhase: TaskPhaseSchema,
  })
  .strict()
  .readonly();
const DiagnosticCountsSchema = z
  .object({
    info: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
const AssetSummarySchema = z
  .object({
    id: AssetIdSchema,
    toolKey: ToolIdSchema,
    resourceType: ResourceKindSchema,
    scopeKind: ScopeKindSchema,
    logicalKey: z.string().trim().min(1).max(500),
    contentHash: ContentHashSchema,
    diagnosticCounts: DiagnosticCountsSchema,
  })
  .strict()
  .readonly();
const AssetsListResponseSchema = z
  .object({
    items: z.array(AssetSummarySchema).max(200).readonly(),
    nextCursor: PaginationCursorSchema.nullable(),
    snapshotRevision: RevisionSchema,
    stale: z.boolean(),
  })
  .strict()
  .readonly();
const RedactionMarkerSchema = z
  .object({ pointer: z.string().min(1).max(500), reason: z.enum(["secret", "path", "policy"]) })
  .strict()
  .readonly();
const AssetsGetResponseSchema = z
  .object({
    asset: z
      .object({
        id: AssetIdSchema,
        toolKey: ToolIdSchema,
        resourceType: ResourceKindSchema,
        scopeId: ScopeIdSchema,
        logicalKey: z.string().trim().min(1).max(500),
        normalized: JsonValueSchema.optional(),
        references: z.array(z.string().trim().min(1).max(500)).max(1_000).optional().readonly(),
        diagnosticIds: z.array(DiagnosticIdSchema).max(1_000).optional().readonly(),
      })
      .strict()
      .readonly(),
    source: z
      .object({
        pathDisplay: z.string().min(1).max(1_000),
        contentHash: ContentHashSchema,
        observedAt: IsoDateTimeSchema,
      })
      .strict()
      .readonly(),
    redactions: z.array(RedactionMarkerSchema).max(1_000).readonly(),
  })
  .strict()
  .readonly();
const DiagnosticViewSchema = z
  .object({
    id: DiagnosticIdSchema,
    code: DiagnosticCodeSchema,
    severity: DiagnosticSeveritySchema,
    assetId: AssetIdSchema.optional(),
    location: z
      .object({
        pathDisplay: z.string().min(1).max(1_000),
        line: z.number().int().positive().optional(),
        column: z.number().int().positive().optional(),
      })
      .strict()
      .readonly()
      .optional(),
    message: z.string().trim().min(1).max(1_000),
    suggestedAction: z.string().trim().min(1).max(500),
    blocking: z.boolean(),
  })
  .strict()
  .readonly();
const EffectiveResolveResponseSchema = z
  .object({
    effective: JsonValueSchema,
    contributors: z
      .array(
        z
          .object({
            assetId: AssetIdSchema,
            action: z.enum(["inherit", "merge", "override"]),
            reasonCode: z.string().trim().min(1).max(100),
          })
          .strict()
          .readonly(),
      )
      .max(10_000)
      .readonly(),
    ignored: z
      .array(
        z
          .object({ assetId: AssetIdSchema, reasonCode: z.string().trim().min(1).max(100) })
          .strict()
          .readonly(),
      )
      .max(10_000)
      .readonly(),
    diagnostics: z.array(DiagnosticViewSchema).max(10_000).readonly(),
    snapshotRevision: RevisionSchema,
  })
  .strict()
  .readonly();
const DiagnosticsListResponseSchema = z
  .object({
    items: z.array(DiagnosticViewSchema).max(200).readonly(),
    nextCursor: PaginationCursorSchema.nullable(),
    countsBySeverity: DiagnosticCountsSchema,
    snapshotRevision: RevisionSchema,
  })
  .strict()
  .readonly();
const PlannedChangeSchema = z
  .object({
    operation: z.enum(["create", "replace", "delete"]),
    pathDisplay: z.string().min(1).max(1_000),
    beforeHash: ContentHashSchema.nullable(),
    afterHash: ContentHashSchema.nullable(),
    diff: z.string().max(1_000_000),
  })
  .strict()
  .readonly();
const MigrationPreviewResponseSchema = z
  .object({
    planId: DeploymentPlanIdSchema,
    planHash: ContentHashSchema,
    compatibility: z.enum(["full", "partial"]),
    changes: z.array(PlannedChangeSchema).min(1).max(200).readonly(),
    warnings: z.array(DiagnosticViewSchema).max(1_000).readonly(),
    sourceHashes: z.record(AssetIdSchema, ContentHashSchema).readonly(),
    targetHashes: z.record(z.string().min(1), ContentHashSchema.nullable()).readonly(),
    expiresAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();
const DeploymentAcceptedSchema = z
  .object({ ...acceptedTaskShape, deploymentId: DeploymentRecordIdSchema })
  .strict()
  .readonly();
const RollbackAcceptedSchema = z
  .object({ ...acceptedTaskShape, rollbackId: DeploymentRecordIdSchema })
  .strict()
  .readonly();
const HistoryEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.enum(["scan", "preview", "deployment", "rollback"]),
    status: z.string().trim().min(1).max(100),
    taskId: TaskIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    createdAt: IsoDateTimeSchema,
    finishedAt: IsoDateTimeSchema.optional(),
    phase: TaskPhaseSchema.optional(),
    progress: TaskProgressPayloadSchema.optional(),
    lastSequence: z.number().int().nonnegative().optional(),
    cancellable: z.boolean().optional(),
  })
  .strict()
  .readonly();
const HistoryListResponseSchema = z
  .object({
    items: z.array(HistoryEntrySchema).max(200).readonly(),
    nextCursor: PaginationCursorSchema.nullable(),
  })
  .strict()
  .readonly();
const PublicSettingsValuesSchema = z
  .object({
    theme: z.enum(["system", "light", "dark"]).optional(),
    pathDisplay: z.enum(["full", "abbreviated"]).optional(),
    scanHints: z.boolean().optional(),
    fileWatching: z.boolean().optional(),
  })
  .strict()
  .readonly();
const SettingsGetResponseSchema = z
  .object({
    values: PublicSettingsValuesSchema,
    revision: z.number().int().nonnegative(),
    readOnlyRecovery: z.boolean(),
  })
  .strict()
  .readonly();
const SettingsUpdateResponseSchema = z
  .object({
    values: PublicSettingsValuesSchema,
    revision: z.number().int().nonnegative(),
    requiresRestart: z.boolean(),
  })
  .strict()
  .readonly();

export const CommandResponseSchemas = {
  "scan.start": AcceptedTaskSchema,
  "scan.status": ScanStatusResponseSchema,
  "scan.cancel": ScanCancelResponseSchema,
  "assets.list": AssetsListResponseSchema,
  "assets.get": AssetsGetResponseSchema,
  "effective.resolve": EffectiveResolveResponseSchema,
  "diagnostics.list": DiagnosticsListResponseSchema,
  "migration.preview": MigrationPreviewResponseSchema,
  "deployment.execute": DeploymentAcceptedSchema,
  "deployment.rollback": RollbackAcceptedSchema,
  "history.list": HistoryListResponseSchema,
  "settings.get": SettingsGetResponseSchema,
  "settings.update": SettingsUpdateResponseSchema,
} as const satisfies Record<ApiCommandName, z.ZodType>;

export type CommandRequest<Name extends ApiCommandName> = z.input<
  (typeof CommandRequestSchemas)[Name]
>;
export type CommandResponse<Name extends ApiCommandName> = z.infer<
  (typeof CommandResponseSchemas)[Name]
>;

export function commandChannel<Name extends ApiCommandName>(
  name: Name,
): `ai-config-hub:v1:${Name}` {
  return `ai-config-hub:v1:${name}`;
}
