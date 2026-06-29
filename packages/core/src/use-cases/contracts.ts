import type {
  AbsolutePath,
  AssetId,
  ContentHash,
  DeploymentPlanId,
  DeploymentRecordId,
  DiagnosticSeverity,
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

import type { Asset } from "../domain/asset.js";
import type { DeploymentPlan, DeploymentRecord } from "../domain/deployment.js";
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
  "effective.resolve",
  "diagnostics.list",
  "diagnostics.export",
  "migration.preview",
  "deployment.execute",
  "deployment.rollback",
  "history.list",
  "history.get",
  "settings.get",
  "settings.update",
] as const;
export type CoreCommandName = (typeof CORE_COMMAND_NAMES)[number];

export interface StartScanRequest {
  readonly roots: readonly AbsolutePath[];
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

export interface AssetOpenSourceRequest {
  readonly assetId: AssetId;
}

export interface AssetOpenSourceResult {
  readonly assetId: AssetId;
  readonly opened: true;
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

interface ConfirmationGrantBase {
  readonly grantId: string;
  readonly issuedBy: "desktop-main" | "cli";
  readonly sessionId: string;
  readonly issuedAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
}

export interface DeploymentExecuteConfirmationGrant extends ConfirmationGrantBase {
  readonly action: "deployment.execute";
  readonly deploymentPlanId: DeploymentPlanId;
  readonly planHash: ContentHash;
}

export interface DeploymentRollbackConfirmationGrant extends ConfirmationGrantBase {
  readonly action: "deployment.rollback";
  readonly deploymentRecordId: DeploymentRecordId;
  readonly rollbackPlanHash: ContentHash;
}

export interface DeploymentExecuteRequest {
  readonly deploymentPlanId: DeploymentPlanId;
  readonly confirmationGrant: DeploymentExecuteConfirmationGrant;
}

export interface DeploymentRollbackRequest {
  readonly deploymentRecordId: DeploymentRecordId;
  readonly confirmationGrant: DeploymentRollbackConfirmationGrant;
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
  readonly operation: DeploymentPlan["operations"][number]["kind"];
  readonly pathDisplay: AbsolutePath;
  readonly beforeHash: ContentHash | null;
  readonly afterHash: ContentHash | null;
  readonly diff: string;
}

export interface HistoryGetResult {
  readonly entry: HistoryEntryResult;
  readonly plan: HistoryPlanResult;
  readonly changes: readonly HistoryChangeResult[];
}

export interface SettingsUpdateRequest {
  readonly expectedRevision: string;
  readonly patch: Partial<PublicSettings>;
}

export interface UseCaseContractMap {
  readonly "scan.start": { readonly input: StartScanRequest; readonly output: StartScanResult };
  readonly "scan.status": { readonly input: ScanStatusRequest; readonly output: ScanStatusResult };
  readonly "scan.cancel": { readonly input: ScanStatusRequest; readonly output: ScanCancelResult };
  readonly "assets.list": { readonly input: AssetsListRequest; readonly output: Page<Asset> };
  readonly "assets.get": { readonly input: AssetGetRequest; readonly output: Asset };
  readonly "assets.openSource": {
    readonly input: AssetOpenSourceRequest;
    readonly output: AssetOpenSourceResult;
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
    readonly output: DeploymentPlan;
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
