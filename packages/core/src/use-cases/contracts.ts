import type {
  AbsolutePath,
  AssetId,
  ContentHash,
  DeploymentPlanId,
  DeploymentRecordId,
  DiagnosticSeverity,
  DiagnosticId,
  PaginationCursor,
  ProjectId,
  ResourceKind,
  ScanRunId,
  ScopeId,
  TaskId,
  ToolId,
  ToolInstallationId,
  IsoDateTime,
} from "@ai-config-hub/shared";

import type { AssetDisablementMethod, AssetStatus } from "../domain/asset.js";
import type {
  DeploymentOperationType,
  DeploymentPlan,
  DeploymentRecord,
} from "../domain/deployment.js";
import type { Diagnostic } from "../domain/diagnostic.js";
import type { EffectiveConfig } from "../domain/effective-config.js";
import type { ScanRunStatus, ScanRunSummary, TaskProgress } from "../domain/task.js";
import type { Page, PublicSettings } from "../ports/repositories.js";

export const CORE_COMMAND_NAMES = [
  "scan.start",
  "scan.status",
  "scan.cancel",
  "assets.list",
  "assets.get",
  "assets.openSource",
  "assets.disable",
  "assets.enable",
  "effective.resolve",
  "diagnostics.list",
  "diagnostics.export",
  "migration.preview",
  "deployment.execute",
  "deployment.rollback",
  "history.list",
  "history.get",
  "settings.get",
  "settings.clearLocalData",
  "settings.update",
] as const;
export type CoreCommandName = (typeof CORE_COMMAND_NAMES)[number];

export interface StartScanRequest {
  readonly roots: readonly AbsolutePath[];
  readonly projectId?: ProjectId;
  readonly changedPaths?: readonly AbsolutePath[];
  readonly toolIds?: readonly ToolId[];
  readonly mode: "full" | "incremental";
  readonly readOnly: boolean;
}
export interface StartScanResult {
  readonly taskId: TaskId;
  readonly scanRunId: ScanRunId;
}
export interface ScanStatusRequest {
  readonly taskId: TaskId;
}
export interface ScanStatusResult {
  readonly taskId: TaskId;
  readonly status: ScanRunStatus;
  readonly progress?: TaskProgress;
  readonly summary?: ScanRunSummary;
}
export interface ScanCancelResult {
  readonly accepted: boolean;
}

export interface AssetsListRequest {
  readonly toolIds?: readonly ToolId[];
  readonly scopeIds?: readonly ScopeId[];
  readonly resourceKinds?: readonly ResourceKind[];
  readonly search?: string;
  readonly cursor?: PaginationCursor;
  readonly limit: number;
}

export interface AssetGetRequest {
  readonly assetId: AssetId;
}

export type AssetSourceSummary =
  | {
      readonly kind: "file";
      readonly fileName: string;
      readonly mediaType: string;
      readonly isText: boolean;
    }
  | {
      readonly kind: "package";
      readonly rootName: string;
      readonly fileCount: number;
      readonly folderCount: number;
      readonly textCount: number;
      readonly binaryCount: number;
      readonly roleCounts: {
        readonly primary: number;
        readonly metadata: number;
        readonly support: number;
      };
    };

export interface AssetListItemResult {
  readonly id: AssetId;
  readonly toolKey: ToolId;
  readonly resourceType: ResourceKind;
  readonly scopeKind: "user" | "project" | "global";
  readonly logicalKey: string;
  readonly sourceDirectory?: string;
  readonly sourceSummary: AssetSourceSummary;
  readonly loadState?: "loaded" | "covered" | "disabled";
  readonly coveredByAssetId?: AssetId;
  readonly coveredByLogicalKey?: string;
  readonly contentHash: ContentHash;
  readonly status: AssetStatus;
  readonly diagnosticCounts: {
    readonly info: number;
    readonly warning: number;
    readonly error: number;
  };
}

export interface AssetsListResult {
  readonly items: readonly AssetListItemResult[];
  readonly nextCursor: PaginationCursor | null;
  readonly snapshotRevision: string;
  readonly stale: boolean;
}

export interface AssetSourceFileViewResult {
  readonly pathDisplay: string;
  readonly relativePath: string;
  readonly role: "primary" | "metadata" | "support";
  readonly mediaType: string;
  readonly isText: boolean;
  readonly contentHash: ContentHash;
}

export interface AssetGetResult {
  readonly asset: {
    readonly id: AssetId;
    readonly toolKey: ToolId;
    readonly resourceType: ResourceKind;
    readonly scopeId: ScopeId;
    readonly logicalKey: string;
    readonly status: AssetStatus;
    readonly disablementOptions: readonly {
      readonly method: AssetDisablementMethod;
      readonly label: string;
      readonly description: string;
      readonly recommended: boolean;
    }[];
    readonly normalized?: unknown;
    readonly references?: readonly string[];
    readonly diagnosticIds?: readonly DiagnosticId[];
  };
  readonly source: {
    readonly pathDisplay: string;
    readonly contentHash: ContentHash;
    readonly observedAt: IsoDateTime;
    readonly sourceSummary: AssetSourceSummary;
    readonly files: readonly AssetSourceFileViewResult[];
  };
  readonly redactions: readonly {
    readonly pointer: string;
    readonly reason: "secret" | "path" | "policy";
  }[];
}

export interface AssetOpenSourceRequest {
  readonly assetId: AssetId;
}

export interface AssetOpenSourceResult {
  readonly assetId: AssetId;
  readonly opened: true;
}

export interface AssetStatusChangeRequest {
  readonly assetId: AssetId;
}

export interface AssetDisableRequest {
  readonly assetId: AssetId;
  readonly method: AssetDisablementMethod;
}

export interface AssetStatusChangeResult {
  readonly assetId: AssetId;
  readonly status: AssetStatus;
}

export interface EffectiveResolveRequest {
  readonly toolInstallationId: ToolInstallationId;
  readonly canonicalTargetPath: AbsolutePath;
  readonly resourceKinds?: readonly ResourceKind[];
}

export interface DiagnosticsListRequest {
  readonly projectId?: ProjectId;
  readonly assetId?: AssetId;
  readonly toolIds?: readonly ToolId[];
  readonly severity?: readonly DiagnosticSeverity[];
  readonly codes?: readonly string[];
  readonly cursor?: PaginationCursor;
  readonly limit: number;
}

export interface DiagnosticsExportRequest {
  readonly format: "json" | "markdown";
  readonly taskId?: TaskId;
  readonly projectId?: ProjectId;
  readonly toolKeys?: readonly ToolId[];
  readonly severities?: readonly DiagnosticSeverity[];
  readonly from?: IsoDateTime;
  readonly to?: IsoDateTime;
}

export interface DiagnosticsExportItem {
  readonly id: Diagnostic["diagnosticId"];
  readonly code: Diagnostic["code"];
  readonly severity: Diagnostic["severity"];
  readonly assetId?: AssetId;
  readonly location?: {
    readonly pathDisplay: string;
    readonly line?: number;
    readonly column?: number;
  };
  readonly message: Diagnostic["message"];
  readonly suggestedAction: string;
  readonly blocking: Diagnostic["blocking"];
}

export interface DiagnosticsExportResult {
  readonly format: DiagnosticsExportRequest["format"];
  readonly generatedAt: IsoDateTime;
  readonly filters: Omit<DiagnosticsExportRequest, "format">;
  readonly summary: {
    readonly total: number;
    readonly info: number;
    readonly warning: number;
    readonly error: number;
  };
  readonly items: readonly DiagnosticsExportItem[];
  readonly redactions: readonly {
    readonly pointer: string;
    readonly reason: "secret" | "path" | "policy";
  }[];
  readonly content: string;
}

export interface MigrationPreviewRequest {
  readonly sourceAssetIds: readonly AssetId[];
  readonly targetToolId: ToolId;
  readonly targetRoot: AbsolutePath;
}

export interface MigrationFieldLossResult {
  readonly assetId: AssetId;
  readonly droppedFields: readonly string[];
  readonly retainedFields: readonly string[];
  readonly transformedFields: readonly {
    readonly sourceField: string;
    readonly targetField: string;
    readonly reason: string;
  }[];
  readonly warnings: readonly string[];
}

export interface MigrationChangeResult {
  readonly groupId: string;
  readonly operation: DeploymentPlan["operations"][number]["kind"];
  readonly deploymentType: DeploymentOperationType;
  readonly pathDisplay: AbsolutePath;
  readonly sourcePathDisplay?: AbsolutePath;
  readonly beforeHash: ContentHash | null;
  readonly afterHash: ContentHash | null;
  readonly diff: string;
}

export interface MigrationChangeGroupResult {
  readonly groupId: string;
  readonly operation: "create" | "replace" | "delete" | "mixed";
  readonly resourceType?: ResourceKind;
  readonly sourceAssetId?: AssetId;
  readonly targetRootPathDisplay: AbsolutePath;
  readonly targetRootRelativePath: string;
  readonly operationCount: number;
  readonly createCount: number;
  readonly replaceCount: number;
  readonly deleteCount: number;
  readonly generatedFileCount: number;
  readonly copyCount: number;
  readonly symlinkCount: number;
  readonly changedTargetCount: number;
  readonly targetPathSample: readonly string[];
  readonly packageOutputCount?: number;
  readonly packagePathSample?: readonly string[];
  readonly visibleDetailCount: number;
  readonly detailsTruncated: boolean;
}

export interface MigrationDifferenceSummaryResult {
  readonly addedToTarget: number;
  readonly overwrittenInTarget: number;
  readonly unchangedPlannedTargetOutputs: number;
  readonly conflictsOrWarnings: number;
  readonly changedGroupCount: number;
  readonly changedFileCount: number;
}

export interface MigrationPreviewResult {
  readonly planId: DeploymentPlanId;
  readonly planHash: ContentHash;
  readonly compatibility: "full" | "partial";
  readonly fieldLosses: readonly MigrationFieldLossResult[];
  readonly changeGroups: readonly MigrationChangeGroupResult[];
  readonly differenceSummary: MigrationDifferenceSummaryResult;
  readonly changes: readonly MigrationChangeResult[];
  readonly changesTruncated: boolean;
  readonly changeDetailLimit: number;
  readonly requiredConfirmations: DeploymentPlan["requiredConfirmations"];
  readonly warnings: readonly {
    readonly id: DiagnosticId;
    readonly code: string;
    readonly severity: "warning";
    readonly message: string;
    readonly suggestedAction: string;
    readonly blocking: false;
  }[];
  readonly sourceHashes: Readonly<Record<AssetId, ContentHash>>;
  readonly targetHashes: Readonly<Record<string, ContentHash | null>>;
  readonly expiresAt: IsoDateTime;
}

export interface DeploymentExecuteRequest {
  readonly deploymentPlanId: DeploymentPlanId;
  readonly confirmedPlanHash: ContentHash;
  readonly confirmations: readonly DeploymentPlan["requiredConfirmations"][number][];
}

export interface DeploymentRollbackRequest {
  readonly deploymentRecordId: DeploymentRecordId;
}

export interface HistoryListRequest {
  readonly cursor?: PaginationCursor;
  readonly limit: number;
}

export interface HistoryGetRequest {
  readonly id: DeploymentRecordId;
}

export interface HistoryEntryResult {
  readonly id: DeploymentRecordId;
  readonly kind: "deployment" | "rollback";
  readonly status: DeploymentRecord["status"];
  readonly createdAt: IsoDateTime;
  readonly finishedAt?: IsoDateTime;
}

export interface HistoryPlanResult {
  readonly planId: DeploymentPlanId;
  readonly planHash: ContentHash;
  readonly requiredConfirmations: DeploymentPlan["requiredConfirmations"];
}

export interface HistoryChangeResult {
  readonly groupId: string;
  readonly operation: DeploymentPlan["operations"][number]["kind"];
  readonly deploymentType: DeploymentOperationType;
  readonly pathDisplay: AbsolutePath;
  readonly sourcePathDisplay?: AbsolutePath;
  readonly beforeHash: ContentHash | null;
  readonly afterHash: ContentHash | null;
  readonly diff: string;
}

export interface HistoryGetResult {
  readonly entry: HistoryEntryResult;
  readonly plan: HistoryPlanResult;
  readonly changeGroups: readonly MigrationChangeGroupResult[];
  readonly differenceSummary: MigrationDifferenceSummaryResult;
  readonly changes: readonly HistoryChangeResult[];
  readonly changesTruncated: boolean;
  readonly changeDetailLimit: number;
}

export interface SettingsUpdateRequest {
  readonly expectedRevision: string;
  readonly patch: Partial<PublicSettings>;
}

export type LocalDataCategory = "scan_cache" | "deployment_history" | "settings";

export interface ClearLocalDataRequest {
  readonly categories: readonly LocalDataCategory[];
  readonly confirmation: "clear-local-data";
}

export interface ClearLocalDataCounts {
  readonly scanRuns: number;
  readonly projects: number;
  readonly scopes: number;
  readonly assets: number;
  readonly diagnostics: number;
  readonly deploymentRecords: number;
  readonly deploymentOperations: number;
  readonly settings: number;
  readonly localHistoryDirectories: number;
}

export interface ClearLocalDataResult {
  readonly clearedAt: IsoDateTime;
  readonly categories: readonly LocalDataCategory[];
  readonly counts: ClearLocalDataCounts;
  readonly retained: {
    readonly databaseBackups: true;
    readonly deploymentBackups: true;
    readonly disabledAssets: true;
  };
  readonly requiresRestart: false;
}

export interface UseCaseContractMap {
  readonly "scan.start": { readonly input: StartScanRequest; readonly output: StartScanResult };
  readonly "scan.status": { readonly input: ScanStatusRequest; readonly output: ScanStatusResult };
  readonly "scan.cancel": { readonly input: ScanStatusRequest; readonly output: ScanCancelResult };
  readonly "assets.list": { readonly input: AssetsListRequest; readonly output: AssetsListResult };
  readonly "assets.get": { readonly input: AssetGetRequest; readonly output: AssetGetResult };
  readonly "assets.openSource": {
    readonly input: AssetOpenSourceRequest;
    readonly output: AssetOpenSourceResult;
  };
  readonly "assets.disable": {
    readonly input: AssetDisableRequest;
    readonly output: { readonly assetId: AssetId; readonly status: "disabled" };
  };
  readonly "assets.enable": {
    readonly input: AssetStatusChangeRequest;
    readonly output: { readonly assetId: AssetId; readonly status: "enabled" };
  };
  readonly "effective.resolve": {
    readonly input: EffectiveResolveRequest;
    readonly output: EffectiveConfig;
  };
  readonly "diagnostics.list": {
    readonly input: DiagnosticsListRequest;
    readonly output: Page<Diagnostic>;
  };
  readonly "diagnostics.export": {
    readonly input: DiagnosticsExportRequest;
    readonly output: DiagnosticsExportResult;
  };
  readonly "migration.preview": {
    readonly input: MigrationPreviewRequest;
    readonly output: MigrationPreviewResult;
  };
  readonly "deployment.execute": {
    readonly input: DeploymentExecuteRequest;
    readonly output: { readonly taskId: TaskId };
  };
  readonly "deployment.rollback": {
    readonly input: DeploymentRollbackRequest;
    readonly output: { readonly taskId: TaskId };
  };
  readonly "history.list": {
    readonly input: HistoryListRequest;
    readonly output: Page<DeploymentRecord>;
  };
  readonly "history.get": {
    readonly input: HistoryGetRequest;
    readonly output: HistoryGetResult;
  };
  readonly "settings.get": {
    readonly input: Readonly<Record<never, never>>;
    readonly output: { readonly revision: string; readonly settings: PublicSettings };
  };
  readonly "settings.clearLocalData": {
    readonly input: ClearLocalDataRequest;
    readonly output: ClearLocalDataResult;
  };
  readonly "settings.update": {
    readonly input: SettingsUpdateRequest;
    readonly output: { readonly revision: string; readonly settings: PublicSettings };
  };
}

export type UseCaseHandler<Name extends CoreCommandName> = (
  input: UseCaseContractMap[Name]["input"],
) => Promise<UseCaseContractMap[Name]["output"]>;

export type CoreUseCases = {
  readonly [Name in CoreCommandName]: UseCaseHandler<Name>;
};
