import {
  AssetSourceFileRoleSchema,
  AssetSourceRelativePathSchema,
  CHANGE_DETAIL_LIMIT,
  CORE_COMMAND_NAMES,
  DeploymentOperationTypeSchema,
  GROUP_TARGET_PATH_SAMPLE_LIMIT,
  PACKAGE_PATH_SAMPLE_LIMIT,
} from "@ai-config-hub/core";
import {
  AssetIdSchema,
  ContentHashSchema,
  DeploymentPlanIdSchema,
  DeploymentRecordIdSchema,
  DiagnosticIdSchema,
  DiagnosticSeveritySchema,
  IsoDateTimeSchema,
  JsonPointerSchema,
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

function isDateRangeOrdered(input: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): boolean {
  return (
    input.from === undefined ||
    input.to === undefined ||
    Date.parse(input.from) <= Date.parse(input.to)
  );
}

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
const AssetsOpenSourceRequestSchema = z.object({ assetId: AssetIdSchema }).strict().readonly();
const AssetDisablementMethodSchema = z.enum([
  "native",
  "move_file",
  "remove_config_entry",
  "hub_ignore",
]);
const AssetsDisableRequestSchema = z
  .object({ assetId: AssetIdSchema, method: AssetDisablementMethodSchema })
  .strict()
  .readonly();
const AssetsStatusChangeRequestSchema = z.object({ assetId: AssetIdSchema }).strict().readonly();
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
const DiagnosticsExportFormatSchema = z.enum(["json", "markdown"]);
const diagnosticsExportFilterShape = {
  taskId: TaskIdSchema.optional(),
  projectId: ProjectIdSchema.optional(),
  toolKeys: z.array(ToolIdSchema).min(1).max(4).optional().readonly(),
  severities: z.array(DiagnosticSeveritySchema).min(1).max(3).optional().readonly(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
};
const DiagnosticsExportFiltersSchema = z
  .object(diagnosticsExportFilterShape)
  .strict()
  .refine(isDateRangeOrdered, {
    message: "Diagnostic export start must not be after end",
    path: ["from"],
  })
  .readonly();
const DiagnosticsExportRequestSchema = z
  .object({
    format: DiagnosticsExportFormatSchema,
    ...diagnosticsExportFilterShape,
  })
  .strict()
  .refine(isDateRangeOrdered, {
    message: "Diagnostic export start must not be after end",
    path: ["from"],
  })
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
const DeploymentConfirmationSchema = z.enum(["partial_conversion", "overwrite", "delete"]);
const DeploymentExecuteRequestSchema = z
  .object({
    planId: DeploymentPlanIdSchema,
    confirmedPlanHash: ContentHashSchema,
    confirmations: z.array(DeploymentConfirmationSchema).max(3).readonly(),
  })
  .strict()
  .readonly();
const DeploymentRollbackRequestSchema = z
  .object({ deploymentId: DeploymentRecordIdSchema })
  .strict()
  .readonly();
const HistoryKindSchema = z.enum(["deployment", "rollback"]);
const HistoryListRequestSchema = z
  .object({
    taskId: TaskIdSchema.optional(),
    kinds: z.array(HistoryKindSchema).min(1).max(2).optional().readonly(),
    projectId: ProjectIdSchema.optional(),
    statuses: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional().readonly(),
    from: IsoDateTimeSchema.optional(),
    to: IsoDateTimeSchema.optional(),
    cursor: PaginationCursorSchema.optional(),
    limit: PageLimitSchema,
  })
  .strict()
  .refine(isDateRangeOrdered, {
    message: "History start must not be after end",
    path: ["from"],
  })
  .readonly();
const HistoryGetRequestSchema = z.object({ id: DeploymentRecordIdSchema }).strict().readonly();

export const PublicSettingKeySchema = z.enum([
  "theme",
  "language",
  "pathDisplay",
  "scanHints",
  "fileWatching",
]);
const PublicSettingsPatchSchema = z
  .object({
    theme: z.enum(["system", "light", "dark"]).optional(),
    language: z.enum(["system", "en", "zh-CN"]).optional(),
    pathDisplay: z.enum(["full", "abbreviated"]).optional(),
    scanHints: z.boolean().optional(),
    fileWatching: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "Settings patch cannot be empty")
  .readonly();
const SettingsGetRequestSchema = z
  .object({ keys: z.array(PublicSettingKeySchema).min(1).max(5).optional().readonly() })
  .strict()
  .readonly();
const SettingsUpdateRequestSchema = z
  .object({ patch: PublicSettingsPatchSchema, expectedRevision: z.number().int().nonnegative() })
  .strict()
  .readonly();
const LocalDataCategorySchema = z.enum(["scan_cache", "deployment_history", "settings"]);
const ClearLocalDataCategoriesSchema = z
  .array(LocalDataCategorySchema)
  .min(1)
  .max(3)
  .superRefine((categories, context) => {
    const seen = new Set<string>();
    categories.forEach((category, index) => {
      if (seen.has(category)) {
        context.addIssue({
          code: "custom",
          message: "Local data categories must be unique",
          path: [index],
        });
      }
      seen.add(category);
    });
  })
  .readonly();
const SettingsClearLocalDataRequestSchema = z
  .object({
    categories: ClearLocalDataCategoriesSchema,
    confirmation: z.literal("clear-local-data"),
  })
  .strict()
  .readonly();

export const CommandRequestSchemas = {
  "scan.start": ScanStartRequestSchema,
  "scan.status": TaskIdRequestSchema,
  "scan.cancel": ScanCancelRequestSchema,
  "assets.list": AssetsListRequestSchema,
  "assets.get": AssetsGetRequestSchema,
  "assets.openSource": AssetsOpenSourceRequestSchema,
  "assets.disable": AssetsDisableRequestSchema,
  "assets.enable": AssetsStatusChangeRequestSchema,
  "effective.resolve": EffectiveResolveRequestSchema,
  "diagnostics.list": DiagnosticsListRequestSchema,
  "diagnostics.export": DiagnosticsExportRequestSchema,
  "migration.preview": MigrationPreviewRequestSchema,
  "deployment.execute": DeploymentExecuteRequestSchema,
  "deployment.rollback": DeploymentRollbackRequestSchema,
  "history.list": HistoryListRequestSchema,
  "history.get": HistoryGetRequestSchema,
  "settings.get": SettingsGetRequestSchema,
  "settings.clearLocalData": SettingsClearLocalDataRequestSchema,
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
const AssetLoadStateSchema = z.enum(["loaded", "covered", "disabled"]);
const AssetSourceSummarySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file"),
      fileName: z.string().trim().min(1).max(500),
      mediaType: z.string().trim().min(1).max(200),
      isText: z.boolean(),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("package"),
      rootName: z.string().trim().min(1).max(500),
      fileCount: z.number().int().positive(),
      folderCount: z.number().int().nonnegative(),
      textCount: z.number().int().nonnegative(),
      binaryCount: z.number().int().nonnegative(),
      roleCounts: z
        .object({
          primary: z.number().int().nonnegative(),
          metadata: z.number().int().nonnegative(),
          support: z.number().int().nonnegative(),
        })
        .strict()
        .readonly(),
    })
    .strict()
    .readonly(),
]);
const AssetSummarySchema = z
  .object({
    id: AssetIdSchema,
    toolKey: ToolIdSchema,
    resourceType: ResourceKindSchema,
    scopeKind: ScopeKindSchema,
    logicalKey: z.string().trim().min(1).max(500),
    sourceDirectory: z.string().trim().min(1).max(1_000).optional(),
    sourceSummary: AssetSourceSummarySchema,
    loadState: AssetLoadStateSchema.optional(),
    coveredByAssetId: AssetIdSchema.optional(),
    coveredByLogicalKey: z.string().trim().min(1).max(500).optional(),
    contentHash: ContentHashSchema,
    status: z.enum(["enabled", "disabled"]),
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
const AssetDisablementOptionSchema = z
  .object({
    method: AssetDisablementMethodSchema,
    label: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(1_000),
    recommended: z.boolean(),
  })
  .strict()
  .readonly();
const AssetSourceFileViewSchema = z
  .object({
    pathDisplay: z.string().min(1).max(1_000),
    relativePath: AssetSourceRelativePathSchema,
    role: AssetSourceFileRoleSchema,
    mediaType: z.string().trim().min(1).max(200),
    isText: z.boolean(),
    contentHash: ContentHashSchema,
  })
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
        status: z.enum(["enabled", "disabled"]),
        disablementOptions: z.array(AssetDisablementOptionSchema).max(4).readonly(),
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
        sourceSummary: AssetSourceSummarySchema,
        files: z.array(AssetSourceFileViewSchema).min(1).max(1_000).readonly(),
      })
      .strict()
      .readonly(),
    redactions: z.array(RedactionMarkerSchema).max(1_000).readonly(),
  })
  .strict()
  .readonly();
const AssetsOpenSourceResponseSchema = z
  .object({
    assetId: AssetIdSchema,
    opened: z.literal(true),
  })
  .strict()
  .readonly();
const AssetsDisableResponseSchema = z
  .object({
    assetId: AssetIdSchema,
    status: z.literal("disabled"),
  })
  .strict()
  .readonly();
const AssetsEnableResponseSchema = z
  .object({
    assetId: AssetIdSchema,
    status: z.literal("enabled"),
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
          .object({
            assetId: AssetIdSchema,
            reasonCode: z.string().trim().min(1).max(100),
            coveredByAssetId: AssetIdSchema.optional(),
          })
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
const DiagnosticsExportSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
const DiagnosticsExportResponseSchema = z
  .object({
    format: DiagnosticsExportFormatSchema,
    generatedAt: IsoDateTimeSchema,
    filters: DiagnosticsExportFiltersSchema,
    summary: DiagnosticsExportSummarySchema,
    items: z.array(DiagnosticViewSchema).max(10_000).readonly(),
    redactions: z.array(RedactionMarkerSchema).max(10_000).readonly(),
    content: z.string().max(1_000_000),
  })
  .strict()
  .readonly();
const GroupedPlannedChangeSchema = z
  .object({
    groupId: z.string().trim().min(1).max(1_000),
    operation: z.enum(["create", "replace", "delete"]),
    deploymentType: DeploymentOperationTypeSchema,
    pathDisplay: z.string().min(1).max(1_000),
    sourcePathDisplay: z.string().min(1).max(1_000).optional(),
    beforeHash: ContentHashSchema.nullable(),
    afterHash: ContentHashSchema.nullable(),
    diff: z.string().max(1_000_000),
  })
  .strict()
  .readonly();
const MigrationChangeGroupSchema = z
  .object({
    groupId: z.string().trim().min(1).max(1_000),
    operation: z.enum(["create", "replace", "delete", "mixed"]),
    resourceType: ResourceKindSchema.optional(),
    sourceAssetId: AssetIdSchema.optional(),
    targetRootPathDisplay: z.string().min(1).max(1_000),
    targetRootRelativePath: z.string().min(1).max(1_000),
    operationCount: z.number().int().min(1),
    createCount: z.number().int().nonnegative(),
    replaceCount: z.number().int().nonnegative(),
    deleteCount: z.number().int().nonnegative(),
    generatedFileCount: z.number().int().nonnegative(),
    copyCount: z.number().int().nonnegative(),
    symlinkCount: z.number().int().nonnegative(),
    changedTargetCount: z.number().int().min(1),
    targetPathSample: z
      .array(z.string().min(1).max(1_000))
      .max(GROUP_TARGET_PATH_SAMPLE_LIMIT)
      .readonly(),
    packageOutputCount: z.number().int().nonnegative().optional(),
    packagePathSample: z
      .array(z.string().min(1).max(1_000))
      .max(PACKAGE_PATH_SAMPLE_LIMIT)
      .readonly()
      .optional(),
    visibleDetailCount: z.number().int().nonnegative(),
    detailsTruncated: z.boolean(),
  })
  .strict()
  .readonly();
const MigrationDifferenceSummarySchema = z
  .object({
    addedToTarget: z.number().int().nonnegative(),
    overwrittenInTarget: z.number().int().nonnegative(),
    unchangedPlannedTargetOutputs: z.number().int().nonnegative(),
    conflictsOrWarnings: z.number().int().nonnegative(),
    changedGroupCount: z.number().int().nonnegative(),
    changedFileCount: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
const MigrationFieldLossSchema = z
  .object({
    assetId: AssetIdSchema,
    droppedFields: z.array(JsonPointerSchema).max(1_000).readonly(),
    retainedFields: z.array(JsonPointerSchema).max(1_000).readonly(),
    transformedFields: z
      .array(
        z
          .object({
            sourceField: JsonPointerSchema,
            targetField: JsonPointerSchema,
            reason: z.string().trim().min(1).max(1_000),
          })
          .strict()
          .readonly(),
      )
      .max(1_000)
      .readonly(),
    warnings: z.array(z.string().trim().min(1).max(1_000)).max(1_000).readonly(),
  })
  .strict()
  .readonly();
const MigrationPreviewResponseSchema = z
  .object({
    planId: DeploymentPlanIdSchema,
    planHash: ContentHashSchema,
    compatibility: z.enum(["full", "partial"]),
    fieldLosses: z.array(MigrationFieldLossSchema).max(1_000).readonly(),
    changeGroups: z.array(MigrationChangeGroupSchema).min(1).max(1_000).readonly(),
    differenceSummary: MigrationDifferenceSummarySchema,
    changes: z.array(GroupedPlannedChangeSchema).min(1).max(CHANGE_DETAIL_LIMIT).readonly(),
    changesTruncated: z.boolean(),
    changeDetailLimit: z.literal(CHANGE_DETAIL_LIMIT),
    requiredConfirmations: z.array(DeploymentConfirmationSchema).max(3).readonly(),
    warnings: z.array(DiagnosticViewSchema).max(1_000).readonly(),
    sourceHashes: z.record(AssetIdSchema, ContentHashSchema).readonly(),
    targetHashes: z.record(z.string().min(1), ContentHashSchema.nullable()).readonly(),
    expiresAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();
const SnapshotErrorSchema = z
  .object({
    code: DiagnosticCodeSchema,
    message: z.string().trim().min(1).max(500),
  })
  .strict()
  .readonly();
const SnapshotMetadataSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("recorded"),
        commitId: z.string().trim().min(1).max(200),
        authoredAt: IsoDateTimeSchema,
        message: z.string().trim().min(1).max(500),
      })
      .strict()
      .readonly(),
    z
      .object({ status: z.literal("missing") })
      .strict()
      .readonly(),
    z
      .object({ status: z.literal("failed"), error: SnapshotErrorSchema })
      .strict()
      .readonly(),
    z
      .object({ status: z.literal("unavailable"), error: SnapshotErrorSchema })
      .strict()
      .readonly(),
  ])
  .readonly();
const DeploymentAcceptedSchema = z
  .object({
    ...acceptedTaskShape,
    deploymentId: DeploymentRecordIdSchema,
    snapshot: SnapshotMetadataSchema.optional(),
  })
  .strict()
  .readonly();
const RollbackAcceptedSchema = z
  .object({
    ...acceptedTaskShape,
    rollbackId: DeploymentRecordIdSchema,
    snapshot: SnapshotMetadataSchema.optional(),
  })
  .strict()
  .readonly();
const HistoryEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: HistoryKindSchema,
    status: z.string().trim().min(1).max(100),
    taskId: TaskIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    createdAt: IsoDateTimeSchema,
    finishedAt: IsoDateTimeSchema.optional(),
    phase: TaskPhaseSchema.optional(),
    progress: TaskProgressPayloadSchema.optional(),
    lastSequence: z.number().int().nonnegative().optional(),
    cancellable: z.boolean().optional(),
    snapshot: SnapshotMetadataSchema.optional(),
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
const HistoryGetResponseSchema = z
  .object({
    entry: HistoryEntrySchema,
    plan: z
      .object({
        planId: DeploymentPlanIdSchema,
        planHash: ContentHashSchema,
        requiredConfirmations: z.array(DeploymentConfirmationSchema).max(3).readonly(),
      })
      .strict()
      .readonly(),
    changeGroups: z.array(MigrationChangeGroupSchema).min(1).max(1_000).readonly(),
    differenceSummary: MigrationDifferenceSummarySchema,
    changes: z.array(GroupedPlannedChangeSchema).max(CHANGE_DETAIL_LIMIT).readonly(),
    changesTruncated: z.boolean(),
    changeDetailLimit: z.literal(CHANGE_DETAIL_LIMIT),
  })
  .strict()
  .readonly();
const PublicSettingsValuesSchema = z
  .object({
    theme: z.enum(["system", "light", "dark"]).optional(),
    language: z.enum(["system", "en", "zh-CN"]).optional(),
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
const SettingsClearLocalDataResponseSchema = z
  .object({
    clearedAt: IsoDateTimeSchema,
    categories: ClearLocalDataCategoriesSchema,
    counts: z
      .object({
        scanRuns: z.number().int().nonnegative(),
        projects: z.number().int().nonnegative(),
        scopes: z.number().int().nonnegative(),
        assets: z.number().int().nonnegative(),
        diagnostics: z.number().int().nonnegative(),
        deploymentRecords: z.number().int().nonnegative(),
        deploymentOperations: z.number().int().nonnegative(),
        settings: z.number().int().nonnegative(),
        localHistoryDirectories: z.number().int().nonnegative(),
      })
      .strict()
      .readonly(),
    retained: z
      .object({
        databaseBackups: z.literal(true),
        deploymentBackups: z.literal(true),
        disabledAssets: z.literal(true),
      })
      .strict()
      .readonly(),
    requiresRestart: z.literal(false),
  })
  .strict()
  .readonly();

export const CommandResponseSchemas = {
  "scan.start": AcceptedTaskSchema,
  "scan.status": ScanStatusResponseSchema,
  "scan.cancel": ScanCancelResponseSchema,
  "assets.list": AssetsListResponseSchema,
  "assets.get": AssetsGetResponseSchema,
  "assets.openSource": AssetsOpenSourceResponseSchema,
  "assets.disable": AssetsDisableResponseSchema,
  "assets.enable": AssetsEnableResponseSchema,
  "effective.resolve": EffectiveResolveResponseSchema,
  "diagnostics.list": DiagnosticsListResponseSchema,
  "diagnostics.export": DiagnosticsExportResponseSchema,
  "migration.preview": MigrationPreviewResponseSchema,
  "deployment.execute": DeploymentAcceptedSchema,
  "deployment.rollback": RollbackAcceptedSchema,
  "history.list": HistoryListResponseSchema,
  "history.get": HistoryGetResponseSchema,
  "settings.get": SettingsGetResponseSchema,
  "settings.clearLocalData": SettingsClearLocalDataResponseSchema,
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
