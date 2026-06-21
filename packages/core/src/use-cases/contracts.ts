import type {
  AbsolutePath,
  AssetId,
  ContentHash,
  DeploymentPlanId,
  DeploymentRecordId,
  DiagnosticSeverity,
  PaginationCursor,
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
  "effective.resolve",
  "diagnostics.list",
  "migration.preview",
  "deployment.execute",
  "deployment.rollback",
  "history.list",
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

export interface EffectiveResolveRequest {
  readonly toolInstallationId: ToolInstallationId;
  readonly canonicalTargetPath: AbsolutePath;
  readonly resourceKinds?: readonly ResourceKind[];
}

export interface DiagnosticsListRequest {
  readonly assetId?: AssetId;
  readonly severity?: readonly DiagnosticSeverity[];
  readonly cursor?: PaginationCursor;
  readonly limit: number;
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
  readonly "effective.resolve": {
    readonly input: EffectiveResolveRequest;
    readonly output: EffectiveConfig;
  };
  readonly "diagnostics.list": {
    readonly input: DiagnosticsListRequest;
    readonly output: Page<Diagnostic>;
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
