import type {
  AbsolutePath,
  AssetId,
  DeploymentPlanId,
  DeploymentRecordId,
  DiagnosticId,
  PaginationCursor,
  ScanRunId,
  ScopeId,
  TaskId,
  ToolId,
} from "@ai-config-hub/shared";

import type { Asset } from "../domain/asset.js";
import type { DeploymentPlan, DeploymentRecord } from "../domain/deployment.js";
import type { Diagnostic } from "../domain/diagnostic.js";
import type { EffectiveConfig } from "../domain/effective-config.js";
import type { Scope } from "../domain/scope.js";
import type { ScanRunStatus, ScanRunSummary, TaskProgress } from "../domain/task.js";
import type { ToolInstallation } from "./adapter.js";

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: PaginationCursor;
  readonly snapshotRevision: string;
}

export interface DerivedIndexReplacement {
  readonly scanRunId: ScanRunId;
  readonly tools: readonly ToolInstallation[];
  readonly scopes: readonly Scope[];
  readonly assets: readonly Asset[];
  readonly effectiveConfigs: readonly EffectiveConfig[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface IndexRepository {
  replaceDerivedIndex(replacement: DerivedIndexReplacement): Promise<{ readonly revision: string }>;
  listAssets(query: {
    readonly toolIds?: readonly ToolId[];
    readonly scopeIds?: readonly ScopeId[];
    readonly resourceKinds?: readonly Asset["resource"]["kind"][];
    readonly search?: string;
    readonly cursor?: PaginationCursor;
    readonly limit: number;
  }): Promise<Page<Asset>>;
  getAsset(assetId: AssetId): Promise<Asset | undefined>;
  getEffectiveConfig(
    id: EffectiveConfig["effectiveConfigId"],
  ): Promise<EffectiveConfig | undefined>;
  listDiagnostics(query: {
    readonly assetId?: AssetId;
    readonly severity?: readonly Diagnostic["severity"][];
    readonly cursor?: PaginationCursor;
    readonly limit: number;
  }): Promise<Page<Diagnostic>>;
  getDiagnostic(id: DiagnosticId): Promise<Diagnostic | undefined>;
}

export interface DeploymentRepository {
  savePlanAndRecord(input: {
    readonly plan: DeploymentPlan;
    readonly record: DeploymentRecord;
  }): Promise<void>;
  getPlan(id: DeploymentPlanId): Promise<DeploymentPlan | undefined>;
  getRecord(id: DeploymentRecordId): Promise<DeploymentRecord | undefined>;
  compareAndSetRecord(input: {
    readonly expectedStatus: DeploymentRecord["status"];
    readonly record: DeploymentRecord;
  }): Promise<boolean>;
  listRecords(input: {
    readonly kinds?: readonly ("deployment" | "rollback")[];
    readonly statuses?: readonly DeploymentRecord["status"][];
    readonly from?: DeploymentRecord["createdAt"];
    readonly to?: DeploymentRecord["createdAt"];
    readonly cursor?: PaginationCursor;
    readonly limit: number;
  }): Promise<Page<DeploymentRecord>>;
}

export interface PublicSettings {
  readonly readOnlyMode: boolean;
  readonly customScanRoots: readonly AbsolutePath[];
  readonly theme: "system" | "light" | "dark";
  readonly scanHints: boolean;
  readonly fileWatching: boolean;
  readonly pathDisplay: "full" | "abbreviated";
}

export interface SettingsRepository {
  getPublic(): Promise<{ readonly revision: string; readonly settings: PublicSettings }>;
  updatePublic(input: {
    readonly expectedRevision: string;
    readonly settings: PublicSettings;
  }): Promise<{ readonly revision: string; readonly settings: PublicSettings }>;
}

export interface TaskRepository {
  create(input: {
    readonly taskId: TaskId;
    readonly scanRunId: ScanRunId;
    readonly status: ScanRunStatus;
  }): Promise<void>;
  updateProgress(progress: TaskProgress): Promise<void>;
  finish(summary: ScanRunSummary): Promise<void>;
  get(taskId: TaskId): Promise<
    | {
        readonly taskId: TaskId;
        readonly scanRunId: ScanRunId;
        readonly status: ScanRunStatus;
        readonly progress?: TaskProgress;
        readonly summary?: ScanRunSummary;
      }
    | undefined
  >;
}
