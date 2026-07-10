import type { CommandRequest, CommandResponse, TaskEvent, TaskPhase } from "@ai-config-hub/api";
import {
  ProjectIdSchema,
  ResourceKindSchema,
  ScopeIdSchema,
  ToolIdSchema,
  type ProjectId,
} from "@ai-config-hub/shared";

import type { DesktopApi } from "../preload/api.js";

export type Route = "assets" | "migration" | "settings";

export type MigrationTargetToolKey = CommandRequest<"migration.preview">["targetToolKey"];
export type MigrationConflictPolicy = CommandRequest<"migration.preview">["conflictPolicy"];
export type MigrationSourceAssetId = CommandResponse<"assets.list">["items"][number]["id"];
export type AssetDisablementMethod = CommandRequest<"assets.disable">["method"];
export type AssetStatus = NonNullable<CommandResponse<"assets.list">["items"][number]["status"]>;
export type DeploymentConfirmation = CommandRequest<"deployment.execute">["confirmations"][number];
export type ThemeSetting = NonNullable<CommandResponse<"settings.get">["values"]["theme"]>;
export type LanguageSetting = NonNullable<CommandResponse<"settings.get">["values"]["language"]>;
export type LocalDataCategory = CommandRequest<"settings.clearLocalData">["categories"][number];
export type AssetStatusChangeRequest =
  | {
      readonly command: "assets.disable";
      readonly request: CommandRequest<"assets.disable">;
    }
  | {
      readonly command: "assets.enable";
      readonly request: CommandRequest<"assets.enable">;
    };

export const MIGRATION_TARGET_TOOL_OPTIONS = [
  "claude-code",
  "cursor",
  "codex",
  "opencode",
] as const satisfies readonly MigrationTargetToolKey[];
export const MIGRATION_CONFLICT_POLICY_OPTIONS = [
  "replace",
  "fail",
] as const satisfies readonly MigrationConflictPolicy[];
export const THEME_SETTING_OPTIONS = [
  "system",
  "light",
  "dark",
] as const satisfies readonly ThemeSetting[];
export const LANGUAGE_SETTING_OPTIONS = [
  "system",
  "en",
  "zh-CN",
] as const satisfies readonly LanguageSetting[];
export const LOCAL_DATA_CATEGORY_OPTIONS = [
  "scan_cache",
  "deployment_history",
  "settings",
] as const satisfies readonly LocalDataCategory[];

export interface AppSettingsValues {
  readonly theme: ThemeSetting;
  readonly language: LanguageSetting;
}

export interface ClearLocalDataState {
  readonly selectedCategories: readonly LocalDataCategory[];
  readonly confirmed: boolean;
  readonly status: "idle" | "clearing" | "cleared" | "error";
  readonly result?: CommandResponse<"settings.clearLocalData">;
}

export interface AppSettingsState {
  readonly values: AppSettingsValues;
  readonly revision: number;
  readonly status: "idle" | "loading" | "ready" | "saving" | "error";
  readonly readOnlyRecovery: boolean;
  readonly requiresRestart: boolean;
  readonly clearLocalData: ClearLocalDataState;
}

export interface MigrationFormState {
  readonly sourceProjectRoot?: string;
  readonly sourceAssetIds: readonly MigrationSourceAssetId[];
  readonly targetToolKey: MigrationTargetToolKey;
  readonly targetScopeId?: string;
  readonly conflictPolicy: MigrationConflictPolicy;
}

export interface MigrationHashRow {
  readonly kind: "source" | "target";
  readonly label: string;
  readonly hash: CommandResponse<"migration.preview">["planHash"] | "absent";
}

export interface MigrationSourceDriftRow {
  readonly assetId: string;
  readonly status: "current" | "changed" | "missing";
  readonly expectedHash: CommandResponse<"migration.preview">["planHash"];
  readonly currentHash: CommandResponse<"migration.preview">["planHash"] | null;
}

export interface ActiveTaskState {
  readonly taskId: string;
  readonly taskKind: "scan" | "deployment" | "rollback";
  readonly scanScope?: ScanTaskScope;
  readonly phase: TaskPhase;
  readonly status:
    | "running"
    | "succeeded"
    | "partially_succeeded"
    | "cancelled"
    | "failed"
    | "rolled_back";
  readonly progress?: {
    readonly phase: string;
    readonly completed: number;
    readonly total: number | null;
    readonly unit: "files" | "operations" | "items";
  };
  readonly message?: string;
  readonly cancellable?: boolean;
  readonly resultRef?: string;
  readonly recoveryLock: boolean;
  readonly failure?: {
    readonly itemRef: string;
    readonly errorCode: string;
    readonly retryable: boolean;
  };
  readonly failures?: readonly {
    readonly itemRef: string;
    readonly errorCode: string;
    readonly retryable: boolean;
  }[];
}

export type ActiveTaskUpdate = Partial<ActiveTaskState> &
  Pick<ActiveTaskState, "taskId" | "taskKind">;

export type ScanTaskScope = "asset-review" | "migration-source" | "migration-target";

export interface AppState {
  readonly route: Route;
  readonly projectRoot?: string;
  readonly scanStatus: "idle" | "queued" | "complete" | "error";
  readonly scanScope?: ScanTaskScope;
  readonly assets: CommandResponse<"assets.list">["items"];
  readonly migrationSourceAssets: CommandResponse<"assets.list">["items"];
  readonly migrationTargetAssets: CommandResponse<"assets.list">["items"];
  readonly assetDetail?: CommandResponse<"assets.get">;
  readonly effective?: CommandResponse<"effective.resolve">;
  readonly diagnostics: CommandResponse<"diagnostics.list">["items"];
  readonly diagnosticCounts: CommandResponse<"diagnostics.list">["countsBySeverity"];
  readonly migration: MigrationFormState;
  readonly preview?: CommandResponse<"migration.preview">;
  readonly deploymentConfirmed: boolean;
  readonly deploymentConfirmationGrants: readonly DeploymentConfirmation[];
  readonly activeTask?: ActiveTaskState;
  readonly recoveryLock?: { readonly deploymentId?: string };
  readonly settings: AppSettingsState;
  readonly message?: string;
}

export type AppAction =
  | { readonly type: "route"; readonly route: Route }
  | { readonly type: "project"; readonly root: string | undefined }
  | { readonly type: "message"; readonly message: string | undefined }
  | {
      readonly type: "scan";
      readonly status: AppState["scanStatus"];
      readonly scanScope?: ScanTaskScope;
      readonly projectRoot?: string;
      readonly message?: string;
    }
  | {
      readonly type: "assets";
      readonly assets: AppState["assets"];
      readonly projectRoot?: string;
    }
  | {
      readonly type: "migrationSourceAssets";
      readonly assets: AppState["assets"];
      readonly sourceProjectRoot?: string;
    }
  | {
      readonly type: "migrationTargetAssets";
      readonly assets: AppState["assets"];
      readonly targetScopeId?: string;
    }
  | {
      readonly type: "assetStatus";
      readonly assetId: AppState["assets"][number]["id"];
      readonly status: NonNullable<AppState["assets"][number]["status"]>;
    }
  | { readonly type: "assetDetail"; readonly detail: CommandResponse<"assets.get"> }
  | { readonly type: "assetDetailClosed" }
  | { readonly type: "effective"; readonly effective: CommandResponse<"effective.resolve"> }
  | {
      readonly type: "diagnostics";
      readonly diagnostics: AppState["diagnostics"];
      readonly counts: AppState["diagnosticCounts"];
      readonly projectRoot?: string;
    }
  | {
      readonly type: "migrationSource";
      readonly assetId: AppState["assets"][number]["id"];
      readonly selected: boolean;
    }
  | { readonly type: "migrationSourceProject"; readonly sourceProjectRoot: string }
  | { readonly type: "migrationTarget"; readonly targetToolKey: MigrationTargetToolKey }
  | { readonly type: "migrationTargetProject"; readonly targetScopeId: string }
  | { readonly type: "migrationSwapProjects" }
  | {
      readonly type: "migrationConflictPolicy";
      readonly conflictPolicy: MigrationConflictPolicy;
    }
  | { readonly type: "preview"; readonly preview: CommandResponse<"migration.preview"> }
  | { readonly type: "previewInvalidated" }
  | { readonly type: "deploymentConfirmation"; readonly confirmed: boolean }
  | {
      readonly type: "deploymentConfirmationGrant";
      readonly confirmation: DeploymentConfirmation;
      readonly granted: boolean;
    }
  | { readonly type: "taskEvent"; readonly action: ActiveTaskUpdate }
  | { readonly type: "runtimeRecovery"; readonly deploymentIds: readonly string[] }
  | {
      readonly type: "runtimeScanRestored";
      readonly scanScope: ScanTaskScope;
      readonly projectRoot: string;
    }
  | { readonly type: "settingsLoading" }
  | {
      readonly type: "settingsSaving";
      readonly patch: CommandRequest<"settings.update">["patch"];
    }
  | { readonly type: "settingsFailed" }
  | { readonly type: "settingsLoaded"; readonly settings: CommandResponse<"settings.get"> }
  | { readonly type: "settingsUpdated"; readonly settings: CommandResponse<"settings.update"> }
  | {
      readonly type: "settingsClearLocalDataCategory";
      readonly category: LocalDataCategory;
      readonly selected: boolean;
    }
  | { readonly type: "settingsClearLocalDataConfirmation"; readonly confirmed: boolean }
  | { readonly type: "settingsClearLocalDataStarted" }
  | { readonly type: "settingsClearLocalDataFailed" }
  | {
      readonly type: "settingsClearLocalDataCompleted";
      readonly result: CommandResponse<"settings.clearLocalData">;
    };

const DEFAULT_SETTINGS_VALUES: AppSettingsValues = {
  theme: "system",
  language: "system",
};
const DEFAULT_CLEAR_LOCAL_DATA_STATE: ClearLocalDataState = {
  selectedCategories: ["scan_cache"],
  confirmed: false,
  status: "idle",
};

export const initialState: AppState = {
  route: "assets",
  scanStatus: "idle",
  assets: [],
  migrationSourceAssets: [],
  migrationTargetAssets: [],
  diagnostics: [],
  diagnosticCounts: { info: 0, warning: 0, error: 0 },
  migration: { sourceAssetIds: [], targetToolKey: "cursor", conflictPolicy: "replace" },
  deploymentConfirmed: false,
  deploymentConfirmationGrants: [],
  settings: {
    values: DEFAULT_SETTINGS_VALUES,
    revision: 0,
    status: "idle",
    readOnlyRecovery: false,
    requiresRestart: false,
    clearLocalData: DEFAULT_CLEAR_LOCAL_DATA_STATE,
  },
};

export function assetStatusChangeRequestFor(
  assetId: CommandResponse<"assets.list">["items"][number]["id"],
  nextStatus: AssetStatus,
  disablementMethod?: AssetDisablementMethod,
): AssetStatusChangeRequest {
  if (nextStatus === "disabled") {
    if (disablementMethod === undefined) {
      throw new Error("Disablement method is required to disable an asset.");
    }
    return { command: "assets.disable", request: { assetId, method: disablementMethod } };
  }
  return { command: "assets.enable", request: { assetId } };
}

function clearPreview(state: AppState): AppState {
  const { preview: discardedPreview, ...withoutPreview } = state;
  void discardedPreview;
  return { ...withoutPreview, deploymentConfirmed: false, deploymentConfirmationGrants: [] };
}

function clearProjectDetails(state: AppState): AppState {
  const {
    assetDetail: discardedAssetDetail,
    effective: discardedEffective,
    ...withoutDetails
  } = state;
  void discardedAssetDetail;
  void discardedEffective;
  return withoutDetails;
}

function clearAssetDetail(state: AppState): AppState {
  const {
    assetDetail: discardedAssetDetail,
    effective: discardedEffective,
    ...withoutAsset
  } = state;
  void discardedAssetDetail;
  void discardedEffective;
  return withoutAsset;
}

function clearScanCacheState(state: AppState): AppState {
  const {
    assetDetail: discardedAssetDetail,
    effective: discardedEffective,
    preview: discardedPreview,
    activeTask: currentTask,
    ...withoutScanDetails
  } = state;
  void discardedAssetDetail;
  void discardedEffective;
  void discardedPreview;
  return {
    ...withoutScanDetails,
    scanStatus: "idle",
    assets: [],
    migrationSourceAssets: [],
    migrationTargetAssets: [],
    diagnostics: [],
    diagnosticCounts: { info: 0, warning: 0, error: 0 },
    migration: { ...state.migration, sourceAssetIds: [] },
    deploymentConfirmed: false,
    deploymentConfirmationGrants: [],
    ...(currentTask !== undefined && currentTask.taskKind !== "scan"
      ? { activeTask: currentTask }
      : {}),
  };
}

function clearDeploymentHistoryState(state: AppState): AppState {
  const withoutPreview = clearPreview(state);
  if (
    withoutPreview.activeTask?.taskKind !== "deployment" &&
    withoutPreview.activeTask?.taskKind !== "rollback"
  ) {
    return withoutPreview;
  }
  const { activeTask: discardedActiveTask, ...withoutDeploymentTask } = withoutPreview;
  void discardedActiveTask;
  return withoutDeploymentTask;
}

type MigrationAssetSummary = AppState["assets"][number];
type MigrationAssetWithStatus = MigrationAssetSummary & {
  readonly status?: "enabled" | "disabled";
};

function isEnabledMigrationAsset(asset: MigrationAssetSummary): boolean {
  return (asset as MigrationAssetWithStatus).status !== "disabled";
}

export function enabledMigrationAssets(state: AppState): readonly MigrationAssetSummary[] {
  return state.migrationSourceAssets.filter(isEnabledMigrationAsset);
}

function migrationSourceAssetIds(
  migration: MigrationFormState,
  assets: AppState["assets"],
): MigrationFormState["sourceAssetIds"] {
  if (migration.sourceProjectRoot === undefined) return [];
  const enabledAssets = assets.filter(isEnabledMigrationAsset);
  const available = new Set(enabledAssets.map((asset) => asset.id));
  const retained = migration.sourceAssetIds.filter((assetId) => available.has(assetId));
  if (retained.length > 0) return retained;
  const first = enabledAssets[0];
  return first === undefined ? [] : [first.id];
}

function normalizedTargetScopeId(
  targetScopeId: MigrationFormState["targetScopeId"],
): string | undefined {
  if (targetScopeId === undefined) return undefined;
  const trimmed = targetScopeId.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function normalizedProjectRoot(projectRoot: string | undefined): string | undefined {
  if (projectRoot === undefined) return undefined;
  const trimmed = projectRoot.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function migrationWithTargetScopeId(
  migration: MigrationFormState,
  targetScopeId: string | undefined,
): MigrationFormState {
  const { targetScopeId: discardedTargetScopeId, ...withoutTargetScopeId } = migration;
  void discardedTargetScopeId;
  return targetScopeId === undefined
    ? withoutTargetScopeId
    : { ...withoutTargetScopeId, targetScopeId };
}

function migrationWithSourceProjectRoot(
  migration: MigrationFormState,
  sourceProjectRoot: string | undefined,
): MigrationFormState {
  const { sourceProjectRoot: discardedSourceProjectRoot, ...withoutSourceProjectRoot } = migration;
  void discardedSourceProjectRoot;
  return sourceProjectRoot === undefined
    ? { ...withoutSourceProjectRoot, sourceAssetIds: [] }
    : { ...withoutSourceProjectRoot, sourceProjectRoot, sourceAssetIds: [] };
}

function scanTaskMatchesScope(
  task: ActiveTaskState | undefined,
  scanScope: ScanTaskScope | undefined,
): boolean {
  if (task?.taskKind !== "scan") return false;
  return scanScope === undefined || task.scanScope === undefined || task.scanScope === scanScope;
}

function withoutMatchingScanTask(state: AppState, scanScope: ScanTaskScope): AppState {
  if (!scanTaskMatchesScope(state.activeTask, scanScope)) return state;
  const { activeTask: discardedActiveTask, ...withoutTask } = state;
  void discardedActiveTask;
  return withoutTask;
}

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "route": {
      const { message: discardedMessage, ...withoutMessage } = state;
      void discardedMessage;
      return { ...withoutMessage, route: action.route };
    }
    case "project": {
      const root = normalizedProjectRoot(action.root);
      const currentRoot = normalizedProjectRoot(state.projectRoot);
      const withoutDetails = clearProjectDetails(state);
      const {
        projectRoot: discardedProjectRoot,
        message: discardedMessage,
        scanScope: discardedScanScope,
        activeTask: currentTask,
        ...base
      } = withoutDetails;
      void discardedProjectRoot;
      void discardedMessage;
      void discardedScanScope;
      if (root !== undefined && root === currentRoot) {
        return {
          ...base,
          projectRoot: root,
          ...(currentTask === undefined ? {} : { activeTask: currentTask }),
        };
      }
      const keepCurrentTask =
        currentTask !== undefined &&
        !(
          currentTask.taskKind === "scan" &&
          (currentTask.scanScope === undefined || currentTask.scanScope === "asset-review")
        );
      return {
        ...base,
        scanStatus: "idle",
        assets: [],
        diagnostics: [],
        diagnosticCounts: { info: 0, warning: 0, error: 0 },
        ...(root === undefined ? {} : { projectRoot: root }),
        ...(keepCurrentTask ? { activeTask: currentTask } : {}),
      };
    }
    case "message":
      return action.message === undefined
        ? {
            route: state.route,
            scanStatus: state.scanStatus,
            ...(state.scanScope === undefined ? {} : { scanScope: state.scanScope }),
            assets: state.assets,
            migrationSourceAssets: state.migrationSourceAssets,
            migrationTargetAssets: state.migrationTargetAssets,
            diagnostics: state.diagnostics,
            diagnosticCounts: state.diagnosticCounts,
            migration: state.migration,
            deploymentConfirmed: state.deploymentConfirmed,
            deploymentConfirmationGrants: state.deploymentConfirmationGrants,
            settings: state.settings,
            ...(state.projectRoot === undefined ? {} : { projectRoot: state.projectRoot }),
            ...(state.assetDetail === undefined ? {} : { assetDetail: state.assetDetail }),
            ...(state.effective === undefined ? {} : { effective: state.effective }),
            ...(state.preview === undefined ? {} : { preview: state.preview }),
            ...(state.activeTask === undefined ? {} : { activeTask: state.activeTask }),
            ...(state.recoveryLock === undefined ? {} : { recoveryLock: state.recoveryLock }),
          }
        : { ...state, message: action.message };
    case "scan": {
      if (
        action.scanScope === "asset-review" &&
        action.projectRoot !== undefined &&
        normalizedProjectRoot(action.projectRoot) !== normalizedProjectRoot(state.projectRoot)
      ) {
        return state;
      }
      const {
        scanScope: discardedScanScope,
        message: discardedMessage,
        activeTask: currentTask,
        ...withoutScanScope
      } = state;
      void discardedScanScope;
      void discardedMessage;
      const keepCurrentTask = !scanTaskMatchesScope(currentTask, action.scanScope);
      return {
        ...withoutScanScope,
        scanStatus: action.status,
        ...(action.scanScope === undefined ? {} : { scanScope: action.scanScope }),
        ...(action.message === undefined ? {} : { message: action.message }),
        ...(keepCurrentTask && currentTask !== undefined ? { activeTask: currentTask } : {}),
      };
    }
    case "assets": {
      if (
        action.projectRoot !== undefined &&
        normalizedProjectRoot(action.projectRoot) !== normalizedProjectRoot(state.projectRoot)
      ) {
        return state;
      }
      const refreshed = {
        ...state,
        assets: action.assets,
        diagnostics: [],
        diagnosticCounts: { info: 0, warning: 0, error: 0 },
      };
      return clearAssetDetail(refreshed);
    }
    case "migrationSourceAssets": {
      const actionSourceProjectRoot = normalizedProjectRoot(action.sourceProjectRoot);
      const stateSourceProjectRoot = normalizedProjectRoot(state.migration.sourceProjectRoot);
      if (stateSourceProjectRoot === undefined) {
        return state;
      }
      if (
        actionSourceProjectRoot !== undefined &&
        actionSourceProjectRoot !== stateSourceProjectRoot
      ) {
        return state;
      }
      return clearPreview({
        ...state,
        migrationSourceAssets: action.assets,
        migration: {
          ...state.migration,
          sourceAssetIds: migrationSourceAssetIds(state.migration, action.assets),
        },
      });
    }
    case "migrationTargetAssets": {
      const actionTargetScopeId = normalizedTargetScopeId(action.targetScopeId);
      if (
        actionTargetScopeId !== undefined &&
        actionTargetScopeId !== normalizedTargetScopeId(state.migration.targetScopeId)
      ) {
        return state;
      }
      return clearPreview({
        ...state,
        migrationTargetAssets: action.assets,
      });
    }
    case "assetStatus": {
      const updateAssetStatus = (asset: AppState["assets"][number]) =>
        asset.id === action.assetId ? { ...asset, status: action.status } : asset;
      const assets = state.assets.map(updateAssetStatus);
      const migrationSourceAssets = state.migrationSourceAssets.map(updateAssetStatus);
      const migrationTargetAssets = state.migrationTargetAssets.map(updateAssetStatus);
      const assetDetail =
        state.assetDetail?.asset.id === action.assetId
          ? {
              ...state.assetDetail,
              asset: { ...state.assetDetail.asset, status: action.status },
            }
          : state.assetDetail;
      const refreshed = {
        ...state,
        assets,
        migrationSourceAssets,
        migrationTargetAssets,
        migration: {
          ...state.migration,
          sourceAssetIds:
            action.status === "disabled"
              ? state.migration.sourceAssetIds.filter((assetId) => assetId !== action.assetId)
              : state.migration.sourceAssetIds,
        },
        ...(assetDetail === undefined ? {} : { assetDetail }),
      };
      const { effective: discardedEffective, ...withoutEffective } = refreshed;
      void discardedEffective;
      return clearPreview(withoutEffective);
    }
    case "assetDetail": {
      const {
        effective: discardedEffective,
        message: discardedMessage,
        ...withoutEffective
      } = state;
      void discardedEffective;
      void discardedMessage;
      return {
        ...withoutEffective,
        assetDetail: action.detail,
        diagnostics: [],
        diagnosticCounts: { info: 0, warning: 0, error: 0 },
      };
    }
    case "assetDetailClosed":
      return {
        ...clearAssetDetail(state),
        diagnostics: [],
        diagnosticCounts: { info: 0, warning: 0, error: 0 },
      };
    case "effective":
      return { ...state, effective: action.effective };
    case "diagnostics":
      if (
        action.projectRoot !== undefined &&
        normalizedProjectRoot(action.projectRoot) !== normalizedProjectRoot(state.projectRoot)
      ) {
        return state;
      }
      return { ...state, diagnostics: action.diagnostics, diagnosticCounts: action.counts };
    case "migrationSource": {
      const sourceAsset = state.migrationSourceAssets.find((asset) => asset.id === action.assetId);
      if (action.selected && sourceAsset?.status !== "enabled") return state;
      const current = state.migration.sourceAssetIds;
      const sourceAssetIds = action.selected
        ? current.includes(action.assetId)
          ? current
          : [...current, action.assetId]
        : current.filter((assetId) => assetId !== action.assetId);
      return clearPreview({
        ...state,
        migration: { ...state.migration, sourceAssetIds },
      });
    }
    case "migrationSourceProject":
      return clearPreview({
        ...withoutMatchingScanTask(state, "migration-source"),
        migrationSourceAssets: [],
        migration: migrationWithSourceProjectRoot(
          state.migration,
          normalizedProjectRoot(action.sourceProjectRoot),
        ),
      });
    case "migrationTarget":
      return clearPreview({
        ...state,
        migration: { ...state.migration, targetToolKey: action.targetToolKey },
      });
    case "migrationTargetProject":
      return clearPreview({
        ...withoutMatchingScanTask(state, "migration-target"),
        migrationTargetAssets: [],
        migration: migrationWithTargetScopeId(
          state.migration,
          normalizedTargetScopeId(action.targetScopeId),
        ),
      });
    case "migrationSwapProjects": {
      const sourceProjectRoot = normalizedProjectRoot(state.migration.sourceProjectRoot);
      const targetScopeId = normalizedTargetScopeId(state.migration.targetScopeId);
      const migrationWithSwappedSource = migrationWithSourceProjectRoot(
        state.migration,
        targetScopeId,
      );
      const swappedMigration = migrationWithTargetScopeId(
        migrationWithSwappedSource,
        sourceProjectRoot,
      );
      return clearPreview({
        ...state,
        migrationSourceAssets: state.migrationTargetAssets,
        migrationTargetAssets: state.migrationSourceAssets,
        migration: {
          ...swappedMigration,
          sourceAssetIds: migrationSourceAssetIds(swappedMigration, state.migrationTargetAssets),
        },
      });
    }
    case "migrationConflictPolicy":
      return clearPreview({
        ...state,
        migration: { ...state.migration, conflictPolicy: action.conflictPolicy },
      });
    case "preview":
      return {
        ...state,
        preview: action.preview,
        deploymentConfirmed: false,
        deploymentConfirmationGrants: [],
      };
    case "previewInvalidated":
      return clearPreview(state);
    case "deploymentConfirmation":
      return { ...state, deploymentConfirmed: action.confirmed };
    case "deploymentConfirmationGrant": {
      const current = state.deploymentConfirmationGrants;
      const deploymentConfirmationGrants = action.granted
        ? current.includes(action.confirmation)
          ? current
          : [...current, action.confirmation]
        : current.filter((confirmation) => confirmation !== action.confirmation);
      return { ...state, deploymentConfirmationGrants };
    }
    case "taskEvent": {
      const activeTask = mergeActiveTask(state.activeTask, action.action);
      const clearsRecoveryLock =
        activeTask.taskKind === "rollback" &&
        activeTask.phase === "completed" &&
        activeTask.status === "succeeded";
      const recoveryLock = clearsRecoveryLock
        ? undefined
        : activeTask.recoveryLock
          ? activeTask.taskKind === "rollback" && state.recoveryLock !== undefined
            ? state.recoveryLock
            : {
                ...(activeTask.resultRef === undefined
                  ? {}
                  : { deploymentId: activeTask.resultRef }),
              }
          : state.recoveryLock;
      const { recoveryLock: discardedRecoveryLock, ...withoutRecoveryLock } = state;
      void discardedRecoveryLock;
      const updated = {
        ...withoutRecoveryLock,
        activeTask,
        ...(recoveryLock === undefined ? {} : { recoveryLock }),
      };
      const retired = shouldRetireDeploymentPreview(activeTask) ? clearPreview(updated) : updated;
      return shouldClearMigratedSourceSelection(activeTask)
        ? {
            ...retired,
            migration: { ...retired.migration, sourceAssetIds: [] },
          }
        : retired;
    }
    case "runtimeRecovery": {
      const { recoveryLock: discardedRecoveryLock, ...withoutRecoveryLock } = state;
      void discardedRecoveryLock;
      const deploymentId = action.deploymentIds[0];
      return {
        ...withoutRecoveryLock,
        ...(deploymentId === undefined ? {} : { recoveryLock: { deploymentId } }),
      };
    }
    case "runtimeScanRestored": {
      const restoredSelection =
        action.scanScope === "asset-review"
          ? reducer(state, { type: "project", root: action.projectRoot })
          : action.scanScope === "migration-source"
            ? reducer(state, {
                type: "migrationSourceProject",
                sourceProjectRoot: action.projectRoot,
              })
            : reducer(state, {
                type: "migrationTargetProject",
                targetScopeId: action.projectRoot,
              });
      return {
        ...restoredSelection,
        route: action.scanScope === "asset-review" ? "assets" : "migration",
        scanStatus: "queued",
        scanScope: action.scanScope,
      };
    }
    case "settingsLoading":
      return { ...state, settings: { ...state.settings, status: "loading" } };
    case "settingsSaving":
      return {
        ...state,
        settings: {
          ...state.settings,
          status: "saving",
          values: {
            ...state.settings.values,
            ...(action.patch.theme === undefined ? {} : { theme: action.patch.theme }),
            ...(action.patch.language === undefined ? {} : { language: action.patch.language }),
          },
        },
      };
    case "settingsFailed":
      return { ...state, settings: { ...state.settings, status: "error" } };
    case "settingsLoaded":
      return {
        ...state,
        settings: {
          values: settingsValuesFromResponse(action.settings.values),
          revision: action.settings.revision,
          status: "ready",
          readOnlyRecovery: action.settings.readOnlyRecovery,
          requiresRestart: false,
          clearLocalData: state.settings.clearLocalData,
        },
      };
    case "settingsUpdated":
      return {
        ...state,
        settings: {
          ...state.settings,
          values: settingsValuesFromResponse(action.settings.values),
          revision: action.settings.revision,
          status: "ready",
          requiresRestart: action.settings.requiresRestart,
          clearLocalData: state.settings.clearLocalData,
        },
      };
    case "settingsClearLocalDataCategory": {
      const selected = new Set(state.settings.clearLocalData.selectedCategories);
      if (action.selected) selected.add(action.category);
      else selected.delete(action.category);
      return {
        ...state,
        settings: {
          ...state.settings,
          clearLocalData: {
            ...state.settings.clearLocalData,
            selectedCategories: LOCAL_DATA_CATEGORY_OPTIONS.filter((category) =>
              selected.has(category),
            ),
            confirmed: false,
            status: "idle",
          },
        },
      };
    }
    case "settingsClearLocalDataConfirmation":
      return {
        ...state,
        settings: {
          ...state.settings,
          clearLocalData: {
            ...state.settings.clearLocalData,
            confirmed: action.confirmed,
            status: "idle",
          },
        },
      };
    case "settingsClearLocalDataStarted":
      return {
        ...state,
        settings: {
          ...state.settings,
          clearLocalData: { ...state.settings.clearLocalData, status: "clearing" },
        },
      };
    case "settingsClearLocalDataFailed":
      return {
        ...state,
        settings: {
          ...state.settings,
          clearLocalData: { ...state.settings.clearLocalData, status: "error" },
        },
      };
    case "settingsClearLocalDataCompleted": {
      const clearLocalData = {
        selectedCategories: ["scan_cache"] as const,
        confirmed: false,
        status: "cleared" as const,
        result: action.result,
      };
      const settings = {
        ...state.settings,
        ...(action.result.categories.includes("settings")
          ? { values: DEFAULT_SETTINGS_VALUES, revision: 0, requiresRestart: false }
          : {}),
        clearLocalData,
      };
      let updated: AppState = { ...state, settings };
      if (action.result.categories.includes("scan_cache")) {
        updated = clearScanCacheState(updated);
      }
      if (action.result.categories.includes("deployment_history")) {
        updated = clearDeploymentHistoryState(updated);
      }
      return updated;
    }
  }
}

function settingsValuesFromResponse(
  values: CommandResponse<"settings.get">["values"],
): AppSettingsValues {
  return {
    theme: values.theme ?? DEFAULT_SETTINGS_VALUES.theme,
    language: values.language ?? DEFAULT_SETTINGS_VALUES.language,
  };
}

export function settingsUpdateRequestForState(
  state: AppState,
  patch: CommandRequest<"settings.update">["patch"],
): CommandRequest<"settings.update"> {
  return {
    expectedRevision: state.settings.revision,
    patch,
  };
}

export function settingsClearLocalDataRequestForState(
  state: AppState,
): CommandRequest<"settings.clearLocalData"> | undefined {
  const categories = LOCAL_DATA_CATEGORY_OPTIONS.filter((category) =>
    state.settings.clearLocalData.selectedCategories.includes(category),
  );
  if (categories.length === 0 || !state.settings.clearLocalData.confirmed) return undefined;
  return { categories, confirmation: "clear-local-data" };
}

function shouldRetireDeploymentPreview(activeTask: ActiveTaskState): boolean {
  return (
    activeTask.taskKind === "deployment" &&
    activeTask.phase === "completed" &&
    activeTask.status !== "running"
  );
}

function shouldClearMigratedSourceSelection(activeTask: ActiveTaskState): boolean {
  return (
    activeTask.taskKind === "deployment" &&
    activeTask.phase === "completed" &&
    activeTask.status === "succeeded"
  );
}

export async function refreshAssets(
  api: DesktopApi,
  options: { readonly projectRoot?: string } = {},
): Promise<AppState["assets"]> {
  const projectId =
    options.projectRoot === undefined ? undefined : await projectIdForRoot(options.projectRoot);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const items: AppState["assets"][number][] = [];
    const visitedCursors = new Set<string>();
    let cursor: string | undefined;
    let snapshotRevision: string | undefined;
    let changedDuringRead = false;
    do {
      const response = await api.invoke("assets.list", {
        limit: 200,
        ...(projectId === undefined ? {} : { projectId }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!response.ok) throw new Error(response.error.message);
      snapshotRevision ??= response.data.snapshotRevision;
      if (response.data.snapshotRevision !== snapshotRevision) {
        changedDuringRead = true;
        break;
      }
      items.push(...response.data.items);
      cursor = response.data.nextCursor ?? undefined;
      if (cursor !== undefined && visitedCursors.has(cursor)) {
        throw new Error("Asset pagination returned a repeated cursor.");
      }
      if (cursor !== undefined) visitedCursors.add(cursor);
    } while (cursor !== undefined);
    if (!changedDuringRead) return items;
  }
  throw new Error("The asset index kept changing while it was being refreshed. Try again.");
}

export async function projectIdForRoot(projectRoot: string): Promise<ProjectId> {
  const encoder = new TextEncoder();
  const rootBytes = encoder.encode(projectRoot);
  const payload = encoder.encode(
    `ai-config-hub:identity:v1\0project\0${rootBytes.byteLength}:${projectRoot}`,
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", payload);
  const bytes = Array.from(new Uint8Array(digest));
  return ProjectIdSchema.parse(
    `project:${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
}

export async function refreshAssetDetail(
  api: DesktopApi,
  assetId: CommandResponse<"assets.list">["items"][number]["id"],
): Promise<CommandResponse<"assets.get"> | undefined> {
  const response = await api.invoke("assets.get", {
    assetId,
    include: ["normalized", "references", "diagnostics"],
  });
  return response.ok ? response.data : undefined;
}

export async function refreshDiagnostics(
  api: DesktopApi,
  options: {
    readonly assetId?: CommandResponse<"assets.list">["items"][number]["id"];
    readonly projectRoot?: string;
  } = {},
): Promise<Pick<AppState, "diagnostics" | "diagnosticCounts">> {
  const projectId =
    options.projectRoot === undefined ? undefined : await projectIdForRoot(options.projectRoot);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const diagnostics: AppState["diagnostics"][number][] = [];
    const diagnosticCounts = { info: 0, warning: 0, error: 0 };
    const visitedCursors = new Set<string>();
    let cursor: string | undefined;
    let snapshotRevision: string | undefined;
    let changedDuringRead = false;
    do {
      const response = await api.invoke("diagnostics.list", {
        limit: 200,
        ...(options.assetId === undefined ? {} : { assetId: options.assetId }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!response.ok) throw new Error(response.error.message);
      snapshotRevision ??= response.data.snapshotRevision;
      if (response.data.snapshotRevision !== snapshotRevision) {
        changedDuringRead = true;
        break;
      }
      diagnostics.push(...response.data.items);
      diagnosticCounts.info += response.data.countsBySeverity.info;
      diagnosticCounts.warning += response.data.countsBySeverity.warning;
      diagnosticCounts.error += response.data.countsBySeverity.error;
      cursor = response.data.nextCursor ?? undefined;
      if (cursor !== undefined && visitedCursors.has(cursor)) {
        throw new Error("Diagnostic pagination returned a repeated cursor.");
      }
      if (cursor !== undefined) visitedCursors.add(cursor);
    } while (cursor !== undefined);
    if (!changedDuringRead) return { diagnostics, diagnosticCounts };
  }
  throw new Error("Diagnostics kept changing while they were being refreshed. Try again.");
}

export function effectiveRequestForState(
  state: AppState,
): CommandRequest<"effective.resolve"> | undefined {
  const detail = state.assetDetail;
  if (detail === undefined || state.projectRoot === undefined) return undefined;
  return {
    toolKey: ToolIdSchema.parse(detail.asset.toolKey),
    projectId: ProjectIdSchema.parse(state.projectRoot),
    targetScopeId: ScopeIdSchema.parse(state.projectRoot),
    resourceTypes: [ResourceKindSchema.parse(detail.asset.resourceType)],
  };
}

export function openSourceRequestForState(
  state: AppState,
): CommandRequest<"assets.openSource"> | undefined {
  const detail = state.assetDetail;
  return detail === undefined ? undefined : { assetId: detail.asset.id };
}

export function previewRequestForState(
  state: AppState,
): CommandRequest<"migration.preview"> | undefined {
  if (migrationPreviewBlockersForState(state).length > 0) return undefined;
  const targetScopeId = normalizedTargetScopeId(state.migration.targetScopeId);
  if (targetScopeId === undefined) return undefined;
  const available = new Set(enabledMigrationAssets(state).map((asset) => asset.id));
  const sourceAssetIds = state.migration.sourceAssetIds.filter((assetId) => available.has(assetId));
  return {
    sourceAssetIds,
    targetToolKey: state.migration.targetToolKey,
    targetScopeId,
    conflictPolicy: state.migration.conflictPolicy,
  };
}

export function migrationPreviewBlockersForState(state: AppState): readonly string[] {
  const blockers: string[] = [];
  const availableAssets = new Map(enabledMigrationAssets(state).map((asset) => [asset.id, asset]));
  const selectedAssets = state.migration.sourceAssetIds
    .map((assetId) => availableAssets.get(assetId))
    .filter((asset) => asset !== undefined);

  if (isActiveTaskRunning(state.activeTask)) {
    blockers.push("Wait for the active task to finish before creating a migration preview.");
  }
  if (state.recoveryLock !== undefined || state.activeTask?.recoveryLock === true) {
    blockers.push("Resolve the active recovery lock before migrating.");
  }

  if (normalizedProjectRoot(state.migration.sourceProjectRoot) === undefined) {
    blockers.push("Choose a source project before creating a migration preview.");
  }
  if (normalizedTargetScopeId(state.migration.targetScopeId) === undefined) {
    blockers.push("Enter a target project folder.");
  }
  if (selectedAssets.length === 0) {
    blockers.push("Select at least one source asset.");
  }
  if (new Set(selectedAssets.map((asset) => asset.resourceType)).size > 1) {
    blockers.push("Select source assets from one resource type.");
  }
  const selectedKeys = new Set<string>();
  const duplicateSelectedAsset = selectedAssets.find((asset) => {
    const key = migrationAssetComparisonKey(asset);
    if (selectedKeys.has(key)) return true;
    selectedKeys.add(key);
    return false;
  });
  if (duplicateSelectedAsset !== undefined) {
    blockers.push(
      `Cannot migrate duplicate source assets with the same name: ${duplicateSelectedAsset.logicalKey}.`,
    );
  }
  return blockers;
}

export interface MigrationDifferenceSummary {
  readonly addedToTarget: number;
  readonly overwrittenInTarget: number;
  readonly targetOnlyKept: number;
  readonly conflictsOrWarnings: number;
}

export type MigrationAssetDifferenceOperation = "create" | "replace" | "target-only" | "unchanged";

export interface MigrationAssetDifference {
  readonly operation: MigrationAssetDifferenceOperation;
  readonly resourceType: string;
  readonly logicalKey: string;
  readonly sourceAsset?: MigrationAssetSummary;
  readonly targetAsset?: MigrationAssetSummary;
}

export function migrationDifferenceSummaryForState(state: AppState): MigrationDifferenceSummary {
  const preview = state.preview;
  if (preview === undefined) return liveMigrationDifferenceSummaryForState(state);
  const differenceSummary: CommandResponse<"migration.preview">["differenceSummary"] | undefined =
    preview.differenceSummary;
  if (differenceSummary === undefined) {
    const changedTargetPaths = new Set(preview.changes.map((change) => change.pathDisplay));
    return {
      addedToTarget: preview.changes.filter((change) => change.operation === "create").length,
      overwrittenInTarget: preview.changes.filter((change) => change.operation === "replace")
        .length,
      targetOnlyKept: Object.entries(preview.targetHashes).filter(
        ([path, hash]) => hash !== null && !changedTargetPaths.has(path),
      ).length,
      conflictsOrWarnings:
        preview.warnings.length +
        preview.fieldLosses.filter(
          (loss) =>
            loss.droppedFields.length > 0 ||
            loss.transformedFields.length > 0 ||
            loss.warnings.length > 0,
        ).length,
    };
  }
  return {
    addedToTarget: differenceSummary.addedToTarget,
    overwrittenInTarget: differenceSummary.overwrittenInTarget,
    targetOnlyKept: differenceSummary.unchangedPlannedTargetOutputs,
    conflictsOrWarnings: differenceSummary.conflictsOrWarnings,
  };
}

export function migrationAssetDifferencesForState(
  state: AppState,
): readonly MigrationAssetDifference[] {
  const sourceProjectRoot = normalizedProjectRoot(state.migration.sourceProjectRoot);
  const targetScopeId = normalizedTargetScopeId(state.migration.targetScopeId);
  if (sourceProjectRoot === undefined || targetScopeId === undefined) return [];

  const selectedSourceAssetIds = new Set(state.migration.sourceAssetIds);
  const sourceAssets = enabledMigrationAssets(state).filter((asset) =>
    selectedSourceAssetIds.has(asset.id),
  );
  if (sourceAssets.length === 0) return [];

  const targetAssets = state.migrationTargetAssets.filter(
    (asset) => asset.toolKey === state.migration.targetToolKey,
  );
  const targetQueues = new Map<string, MigrationAssetSummary[]>();
  for (const targetAsset of [...targetAssets].sort(compareMigrationAssets)) {
    const key = migrationAssetComparisonKey(targetAsset);
    const queue = targetQueues.get(key);
    if (queue === undefined) targetQueues.set(key, [targetAsset]);
    else queue.push(targetAsset);
  }

  const differences: MigrationAssetDifference[] = [];
  const matchedTargetIds = new Set<string>();
  for (const sourceAsset of [...sourceAssets].sort(compareMigrationAssets)) {
    const key = migrationAssetComparisonKey(sourceAsset);
    const targetAsset = targetQueues.get(key)?.shift();
    if (targetAsset === undefined) {
      differences.push({
        operation: "create",
        resourceType: sourceAsset.resourceType,
        logicalKey: sourceAsset.logicalKey,
        sourceAsset,
      });
      continue;
    }

    matchedTargetIds.add(targetAsset.id);
    differences.push({
      operation: sourceAsset.contentHash === targetAsset.contentHash ? "unchanged" : "replace",
      resourceType: sourceAsset.resourceType,
      logicalKey: sourceAsset.logicalKey,
      sourceAsset,
      targetAsset,
    });
  }

  for (const targetAsset of [...targetAssets].sort(compareMigrationAssets)) {
    if (matchedTargetIds.has(targetAsset.id)) continue;
    differences.push({
      operation: "target-only",
      resourceType: targetAsset.resourceType,
      logicalKey: targetAsset.logicalKey,
      targetAsset,
    });
  }

  return differences.sort(compareMigrationAssetDifferences);
}

function liveMigrationDifferenceSummaryForState(state: AppState): MigrationDifferenceSummary {
  const differences = migrationAssetDifferencesForState(state);
  return {
    addedToTarget: differences.filter((difference) => difference.operation === "create").length,
    overwrittenInTarget: differences.filter((difference) => difference.operation === "replace")
      .length,
    targetOnlyKept: differences.filter((difference) => difference.operation === "target-only")
      .length,
    conflictsOrWarnings: 0,
  };
}

function migrationAssetComparisonKey(asset: MigrationAssetSummary): string {
  return `${asset.resourceType}\0${asset.logicalKey}`;
}

function compareMigrationAssets(left: MigrationAssetSummary, right: MigrationAssetSummary): number {
  const resourceTypeComparison = left.resourceType.localeCompare(right.resourceType);
  if (resourceTypeComparison !== 0) return resourceTypeComparison;
  const logicalKeyComparison = left.logicalKey.localeCompare(right.logicalKey);
  if (logicalKeyComparison !== 0) return logicalKeyComparison;
  return left.id.localeCompare(right.id);
}

function compareMigrationAssetDifferences(
  left: MigrationAssetDifference,
  right: MigrationAssetDifference,
): number {
  const resourceTypeComparison = left.resourceType.localeCompare(right.resourceType);
  if (resourceTypeComparison !== 0) return resourceTypeComparison;
  const logicalKeyComparison = left.logicalKey.localeCompare(right.logicalKey);
  if (logicalKeyComparison !== 0) return logicalKeyComparison;
  return differenceOperationPriority(left.operation) - differenceOperationPriority(right.operation);
}

function differenceOperationPriority(operation: MigrationAssetDifferenceOperation): number {
  switch (operation) {
    case "replace":
      return 0;
    case "create":
      return 1;
    case "target-only":
      return 2;
    case "unchanged":
      return 3;
  }
}

export function migrationHashRowsForPreview(
  preview: CommandResponse<"migration.preview">,
): readonly MigrationHashRow[] {
  const sourceRows = Object.entries(preview.sourceHashes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, hash]) => ({ kind: "source" as const, label, hash }));
  const targetRows = Object.entries(preview.targetHashes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([label, hash]): MigrationHashRow => ({
        kind: "target" as const,
        label,
        hash: hash === null ? "absent" : hash,
      }),
    );
  return [...sourceRows, ...targetRows];
}

export function migrationSourceDriftRowsForState(
  state: AppState,
): readonly MigrationSourceDriftRow[] {
  if (state.preview === undefined) return [];
  const currentHashes = new Map<string, CommandResponse<"migration.preview">["planHash"]>(
    state.migrationSourceAssets.map((asset) => [asset.id, asset.contentHash]),
  );
  return Object.entries(state.preview.sourceHashes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([assetId, expectedHash]) => {
      const currentHash = currentHashes.get(assetId) ?? null;
      return {
        assetId,
        status:
          currentHash === null ? "missing" : currentHash === expectedHash ? "current" : "changed",
        expectedHash,
        currentHash,
      };
    });
}

export function deploymentBlockersForState(
  state: AppState,
  now = new Date().toISOString(),
): readonly string[] {
  const blockers: string[] = [];
  if (
    isActiveTaskRunning(state.activeTask) &&
    (state.activeTask?.taskKind === "deployment" || state.activeTask?.taskKind === "rollback")
  ) {
    blockers.push("Wait for the active migration task to finish.");
  } else if (isActiveTaskRunning(state.activeTask)) {
    blockers.push("Wait for the active task to finish before migrating.");
  }
  if (state.preview === undefined) {
    blockers.push("Create a migration preview before migrating.");
  } else if (Date.parse(now) > Date.parse(state.preview.expiresAt)) {
    blockers.push("Create a fresh migration preview; the current plan has expired.");
  }
  if (migrationSourceDriftRowsForState(state).some((row) => row.status !== "current")) {
    blockers.push("Refresh the scan and create a fresh migration preview before migrating.");
  }
  if (state.recoveryLock !== undefined || state.activeTask?.recoveryLock === true) {
    blockers.push("Resolve the active recovery lock before migrating.");
  }
  const missingConfirmations = missingDeploymentConfirmationsForState(state);
  if (missingConfirmations.length > 0) {
    blockers.push(
      `Confirm required migration actions: ${missingConfirmations
        .map(deploymentConfirmationLabel)
        .join(" ")}`,
    );
  }
  if (state.preview !== undefined && !state.deploymentConfirmed) {
    blockers.push("Confirm that this writes verified config files.");
  }
  return blockers;
}

function isActiveTaskRunning(task: ActiveTaskState | undefined): boolean {
  return task !== undefined && task.status === "running" && task.phase !== "completed";
}

export function deploymentConfirmationsForState(
  state: AppState,
): CommandRequest<"deployment.execute">["confirmations"] {
  if (state.preview === undefined) return [];
  const granted = new Set(state.deploymentConfirmationGrants);
  return state.preview.requiredConfirmations.filter((confirmation) => granted.has(confirmation));
}

function missingDeploymentConfirmationsForState(
  state: AppState,
): readonly DeploymentConfirmation[] {
  if (state.preview === undefined) return [];
  const granted = new Set(state.deploymentConfirmationGrants);
  return state.preview.requiredConfirmations.filter((confirmation) => !granted.has(confirmation));
}

export function deploymentConfirmationLabel(confirmation: DeploymentConfirmation): string {
  switch (confirmation) {
    case "overwrite":
      return "Overwrite existing target files.";
    case "partial_conversion":
      return "Deploy a partial conversion with documented warnings.";
    case "delete":
      return "Delete target files listed in the preview.";
  }
}

export function scanActionForTaskEvent(
  event: TaskEvent,
  scanScope?: ScanTaskScope,
): Extract<AppAction, { readonly type: "scan" }> | undefined {
  if (event.type === "accepted") {
    return { type: "scan", status: "queued", ...(scanScope === undefined ? {} : { scanScope }) };
  }
  if (
    event.type !== "completed" &&
    !(event.type === "snapshot" && event.payload.status !== "running")
  ) {
    return undefined;
  }
  const status = event.payload.status === "failed" ? "error" : "complete";
  return {
    type: "scan",
    status,
    ...(scanScope === undefined ? {} : { scanScope }),
  };
}

function formatTaskCompletionMessage(
  taskKind: ActiveTaskState["taskKind"],
  payload: Extract<TaskEvent, { type: "completed" }>["payload"],
): string {
  const counts = [
    payload.succeededCount > 0 ? `${payload.succeededCount} succeeded` : undefined,
    payload.failedCount > 0 ? `${payload.failedCount} failed` : undefined,
    payload.skippedCount > 0 ? `${payload.skippedCount} skipped` : undefined,
  ].filter((count) => count !== undefined);
  const prefix = `${taskKindLabel(taskKind)} ${taskCompletionStatusLabel(payload.status)}`;
  return counts.length === 0 ? `${prefix}.` : `${prefix}: ${counts.join(", ")}.`;
}

function taskKindLabel(taskKind: ActiveTaskState["taskKind"]): string {
  switch (taskKind) {
    case "scan":
      return "Scan";
    case "deployment":
      return "Deployment";
    case "rollback":
      return "Rollback";
  }
}

function taskCompletionStatusLabel(
  status: Extract<TaskEvent, { type: "completed" }>["payload"]["status"],
): string {
  switch (status) {
    case "succeeded":
      return "complete";
    case "partially_succeeded":
      return "partially complete";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "rolled_back":
      return "rolled back";
  }
}

export function taskActionForTaskEvent(
  event: TaskEvent,
  scanScope?: ScanTaskScope,
): ActiveTaskUpdate | undefined {
  const withScanScope = (update: ActiveTaskUpdate): ActiveTaskUpdate =>
    update.taskKind === "scan" && scanScope !== undefined ? { ...update, scanScope } : update;
  if (event.type === "cursor.reset") return undefined;
  if (event.type === "snapshot") {
    return withScanScope({
      taskId: event.taskId,
      taskKind: event.payload.taskKind,
      phase: event.payload.phase,
      status: event.payload.status,
      progress: event.payload.progress,
      cancellable: event.payload.cancellable,
      ...(event.payload.resultRef === undefined ? {} : { resultRef: event.payload.resultRef }),
      recoveryLock: event.payload.systemRecoveryLock ?? false,
      message: `${event.payload.taskKind} ${event.payload.status}: restored from event snapshot.`,
    });
  }
  const taskKind =
    event.type === "accepted" ? event.payload.taskKind : taskKindForTaskId(event.taskId);
  if (taskKind === undefined) return undefined;
  if (event.type === "accepted") {
    return withScanScope({
      taskId: event.taskId,
      taskKind,
      phase: "queued",
      status: "running",
      cancellable: true,
      recoveryLock: false,
      message: `Queued ${taskKind} ${event.taskId}`,
    });
  }
  if (event.type === "phase.changed") {
    return withScanScope({
      taskId: event.taskId,
      taskKind,
      phase: event.payload.to,
      ...(event.payload.to === "completed" ? {} : { status: "running" }),
    });
  }
  if (event.type === "progress") {
    const total = event.payload.total;
    const progress = {
      phase: event.payload.phase,
      completed: event.payload.completed,
      total,
      unit: event.payload.unit,
    };
    return withScanScope({
      taskId: event.taskId,
      taskKind,
      phase: event.payload.phase,
      progress,
      status: "running",
      message: `${taskKind} ${event.payload.phase}: ${event.payload.completed}/${total ?? "?"} ${event.payload.unit}`,
    });
  }
  if (event.type === "item.failed") {
    const failure = {
      itemRef: event.payload.itemRef,
      errorCode: event.payload.errorCode,
      retryable: event.payload.retryable,
    };
    return withScanScope({
      taskId: event.taskId,
      taskKind,
      failure,
      failures: [failure],
      message: `${taskKind} failed: ${event.payload.errorCode}`,
    });
  }
  if (event.type === "cancel.requested") {
    return withScanScope({
      taskId: event.taskId,
      taskKind,
      cancellable: false,
      message: `${taskKindLabel(taskKind)} cancellation requested.`,
    });
  }
  if (event.type === "completed") {
    const completed = event.payload.succeededCount + event.payload.failedCount;
    return withScanScope({
      taskId: event.taskId,
      taskKind,
      phase: "completed",
      status: event.payload.status,
      cancellable: false,
      ...(event.payload.resultRef === undefined ? {} : { resultRef: event.payload.resultRef }),
      recoveryLock: event.payload.systemRecoveryLock,
      progress: {
        phase: "completed",
        completed,
        total: completed + event.payload.skippedCount,
        unit: taskKind === "scan" ? "items" : "operations",
      },
      message: formatTaskCompletionMessage(taskKind, event.payload),
    });
  }
  return undefined;
}

function mergeActiveTask(
  current: ActiveTaskState | undefined,
  update: ActiveTaskUpdate,
): ActiveTaskState {
  const base: ActiveTaskState =
    current?.taskId === update.taskId
      ? current
      : {
          taskId: update.taskId,
          taskKind: update.taskKind,
          phase: "queued",
          status: "running",
          recoveryLock: false,
        };
  const merged = { ...base, ...update };
  const failures =
    current?.taskId === update.taskId && update.failures !== undefined
      ? [...(current.failures ?? []), ...update.failures]
      : merged.failures;
  return {
    taskId: merged.taskId,
    taskKind: merged.taskKind,
    phase: merged.phase ?? base.phase,
    status: merged.status ?? base.status,
    recoveryLock: merged.recoveryLock ?? base.recoveryLock,
    ...(merged.cancellable === undefined ? {} : { cancellable: merged.cancellable }),
    ...(merged.resultRef === undefined ? {} : { resultRef: merged.resultRef }),
    ...(merged.scanScope === undefined ? {} : { scanScope: merged.scanScope }),
    ...(merged.progress === undefined ? {} : { progress: merged.progress }),
    ...(merged.message === undefined ? {} : { message: merged.message }),
    ...(merged.failure === undefined ? {} : { failure: merged.failure }),
    ...(failures === undefined || failures.length === 0 ? {} : { failures }),
  };
}

function taskKindForTaskId(taskId: string): ActiveTaskState["taskKind"] | undefined {
  if (taskId.startsWith("task:scan:") || taskId === "task-scan") return "scan";
  if (taskId.startsWith("task:deployment:")) return "deployment";
  if (taskId.startsWith("task:rollback:")) return "rollback";
  return undefined;
}

export function formatUiError(error: unknown, action: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  const lowerDetail = detail.toLowerCase();
  if (lowerDetail.includes("filechooser") || lowerDetail.includes("file chooser")) {
    return `${action} failed: the system file chooser is unavailable; check desktop file picker permissions and try again. (${detail})`;
  }
  return `${action} failed: ${detail}`;
}
