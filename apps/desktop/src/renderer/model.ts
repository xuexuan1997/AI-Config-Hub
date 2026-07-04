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
  "merge",
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

export interface AppSettingsValues {
  readonly theme: ThemeSetting;
  readonly language: LanguageSetting;
}

export interface AppSettingsState {
  readonly values: AppSettingsValues;
  readonly revision: number;
  readonly status: "idle" | "loading" | "ready" | "saving" | "error";
  readonly readOnlyRecovery: boolean;
  readonly requiresRestart: boolean;
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
  readonly recoveryLock: boolean;
  readonly failure?: {
    readonly itemRef: string;
    readonly errorCode: string;
    readonly retryable: boolean;
  };
}

export type ActiveTaskUpdate = Partial<ActiveTaskState> &
  Pick<ActiveTaskState, "taskId" | "taskKind">;

export interface AppState {
  readonly route: Route;
  readonly projectRoot?: string;
  readonly scanStatus: "idle" | "queued" | "complete" | "error";
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
  readonly settings: AppSettingsState;
  readonly message?: string;
}

export type AppAction =
  | { readonly type: "route"; readonly route: Route }
  | { readonly type: "project"; readonly root: string | undefined }
  | { readonly type: "message"; readonly message: string | undefined }
  | { readonly type: "scan"; readonly status: AppState["scanStatus"]; readonly message?: string }
  | { readonly type: "assets"; readonly assets: AppState["assets"] }
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
  | { readonly type: "deploymentConfirmation"; readonly confirmed: boolean }
  | {
      readonly type: "deploymentConfirmationGrant";
      readonly confirmation: DeploymentConfirmation;
      readonly granted: boolean;
    }
  | { readonly type: "taskEvent"; readonly action: ActiveTaskUpdate }
  | { readonly type: "settingsLoading" }
  | { readonly type: "settingsSaving" }
  | { readonly type: "settingsFailed" }
  | { readonly type: "settingsLoaded"; readonly settings: CommandResponse<"settings.get"> }
  | { readonly type: "settingsUpdated"; readonly settings: CommandResponse<"settings.update"> };

const DEFAULT_SETTINGS_VALUES: AppSettingsValues = {
  theme: "system",
  language: "system",
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

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "route": {
      const { message: discardedMessage, ...withoutMessage } = state;
      void discardedMessage;
      return { ...withoutMessage, route: action.route };
    }
    case "project":
      if (action.root === undefined) {
        return clearProjectDetails({
          route: state.route,
          scanStatus: state.scanStatus,
          assets: state.assets,
          migrationSourceAssets: state.migrationSourceAssets,
          migrationTargetAssets: state.migrationTargetAssets,
          diagnostics: state.diagnostics,
          diagnosticCounts: state.diagnosticCounts,
          migration: state.migration,
          deploymentConfirmed: state.deploymentConfirmed,
          deploymentConfirmationGrants: state.deploymentConfirmationGrants,
          settings: state.settings,
          ...(state.activeTask === undefined ? {} : { activeTask: state.activeTask }),
          ...(state.message === undefined ? {} : { message: state.message }),
          ...(state.preview === undefined ? {} : { preview: state.preview }),
        });
      }
      return clearProjectDetails({
        route: state.route,
        scanStatus: state.scanStatus,
        assets: state.assets,
        migrationSourceAssets: state.migrationSourceAssets,
        migrationTargetAssets: state.migrationTargetAssets,
        diagnostics: state.diagnostics,
        diagnosticCounts: state.diagnosticCounts,
        migration: state.migration,
        deploymentConfirmed: state.deploymentConfirmed,
        deploymentConfirmationGrants: state.deploymentConfirmationGrants,
        settings: state.settings,
        projectRoot: action.root,
        ...(state.activeTask === undefined ? {} : { activeTask: state.activeTask }),
        ...(state.preview === undefined ? {} : { preview: state.preview }),
      });
    case "message":
      return action.message === undefined
        ? {
            route: state.route,
            scanStatus: state.scanStatus,
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
          }
        : { ...state, message: action.message };
    case "scan":
      return {
        ...state,
        scanStatus: action.status,
        ...(action.message === undefined ? {} : { message: action.message }),
      };
    case "assets": {
      const refreshed = {
        ...state,
        assets: action.assets,
      };
      return action.assets.some((asset) => asset.id === state.assetDetail?.asset.id)
        ? refreshed
        : clearAssetDetail(refreshed);
    }
    case "migrationSourceAssets": {
      const actionSourceProjectRoot = normalizedProjectRoot(action.sourceProjectRoot);
      if (
        actionSourceProjectRoot !== undefined &&
        actionSourceProjectRoot !== normalizedProjectRoot(state.migration.sourceProjectRoot)
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
      const assets = state.assets.map((asset) =>
        asset.id === action.assetId ? { ...asset, status: action.status } : asset,
      );
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
        ...(assetDetail === undefined ? {} : { assetDetail }),
      };
      return refreshed;
    }
    case "assetDetail": {
      const { effective: discardedEffective, ...withoutEffective } = state;
      void discardedEffective;
      return { ...withoutEffective, assetDetail: action.detail };
    }
    case "assetDetailClosed":
      return clearAssetDetail(state);
    case "effective":
      return { ...state, effective: action.effective };
    case "diagnostics":
      return { ...state, diagnostics: action.diagnostics, diagnosticCounts: action.counts };
    case "migrationSource": {
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
        ...state,
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
        ...state,
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
      const updated = { ...state, activeTask };
      return shouldRetireDeploymentPreview(activeTask) ? clearPreview(updated) : updated;
    }
    case "settingsLoading":
      return { ...state, settings: { ...state.settings, status: "loading" } };
    case "settingsSaving":
      return { ...state, settings: { ...state.settings, status: "saving" } };
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
        },
      };
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

function shouldRetireDeploymentPreview(activeTask: ActiveTaskState): boolean {
  return (
    activeTask.taskKind === "deployment" &&
    activeTask.phase === "completed" &&
    (activeTask.status === "succeeded" ||
      activeTask.status === "partially_succeeded" ||
      activeTask.status === "rolled_back")
  );
}

export async function refreshAssets(
  api: DesktopApi,
  options: { readonly projectRoot?: string } = {},
): Promise<AppState["assets"]> {
  const projectId =
    options.projectRoot === undefined ? undefined : await projectIdForRoot(options.projectRoot);
  const response = await api.invoke("assets.list", {
    limit: 50,
    ...(projectId === undefined ? {} : { projectId }),
  });
  return response.ok ? response.data.items : [];
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
  assetId?: CommandResponse<"assets.list">["items"][number]["id"],
): Promise<Pick<AppState, "diagnostics" | "diagnosticCounts">> {
  const response = await api.invoke("diagnostics.list", {
    limit: 50,
    ...(assetId === undefined ? {} : { assetId }),
  });
  return response.ok
    ? { diagnostics: response.data.items, diagnosticCounts: response.data.countsBySeverity }
    : { diagnostics: [], diagnosticCounts: { info: 0, warning: 0, error: 0 } };
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
  const changedTargetPaths = new Set(preview.changes.map((change) => change.pathDisplay));
  return {
    addedToTarget: preview.changes.filter((change) => change.operation === "create").length,
    overwrittenInTarget: preview.changes.filter((change) => change.operation === "replace").length,
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

export function migrationAssetDifferencesForState(
  state: AppState,
): readonly MigrationAssetDifference[] {
  const sourceProjectRoot = normalizedProjectRoot(state.migration.sourceProjectRoot);
  const targetScopeId = normalizedTargetScopeId(state.migration.targetScopeId);
  if (sourceProjectRoot === undefined || targetScopeId === undefined) return [];

  const sourceAssets = enabledMigrationAssets(state);
  if (sourceAssets.length === 0) return [];

  const targetAssets = state.migrationTargetAssets.filter(
    (asset) => asset.toolKey === state.migration.targetToolKey,
  );
  if (targetAssets.length === 0) return [];

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
  if (state.preview === undefined) {
    blockers.push("Create a migration preview before migrating.");
  } else if (Date.parse(now) > Date.parse(state.preview.expiresAt)) {
    blockers.push("Create a fresh migration preview; the current plan has expired.");
  }
  if (migrationSourceDriftRowsForState(state).some((row) => row.status !== "current")) {
    blockers.push("Refresh the scan and create a fresh migration preview before migrating.");
  }
  if (state.activeTask?.recoveryLock === true) {
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

export function scanActionForTaskEvent(event: TaskEvent): AppAction | undefined {
  if (event.type === "accepted") {
    return { type: "scan", status: "queued", message: `Queued ${event.taskId}` };
  }
  if (event.type !== "completed") return undefined;
  const status = event.payload.status === "failed" ? "error" : "complete";
  return {
    type: "scan",
    status,
    message: formatTaskCompletionMessage("scan", event.payload),
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

export function taskActionForTaskEvent(event: TaskEvent): ActiveTaskUpdate | undefined {
  if (event.type === "cursor.reset") return undefined;
  if (event.type === "snapshot") {
    return {
      taskId: event.taskId,
      taskKind: event.payload.taskKind,
      phase: event.payload.phase,
      status: event.payload.status,
      progress: event.payload.progress,
      recoveryLock: event.payload.status === "failed",
      message: `${event.payload.taskKind} ${event.payload.status}: restored from event snapshot.`,
    };
  }
  const taskKind =
    event.type === "accepted" ? event.payload.taskKind : taskKindForTaskId(event.taskId);
  if (taskKind === undefined) return undefined;
  if (event.type === "accepted") {
    return {
      taskId: event.taskId,
      taskKind,
      phase: "queued",
      status: "running",
      recoveryLock: false,
      message: `Queued ${taskKind} ${event.taskId}`,
    };
  }
  if (event.type === "phase.changed") {
    return {
      taskId: event.taskId,
      taskKind,
      phase: event.payload.to,
      ...(event.payload.to === "completed" ? {} : { status: "running" }),
    };
  }
  if (event.type === "progress") {
    const total = event.payload.total;
    const progress = {
      phase: event.payload.phase,
      completed: event.payload.completed,
      total,
      unit: event.payload.unit,
    };
    return {
      taskId: event.taskId,
      taskKind,
      phase: event.payload.phase,
      progress,
      status: "running",
      message: `${taskKind} ${event.payload.phase}: ${event.payload.completed}/${total ?? "?"} ${event.payload.unit}`,
    };
  }
  if (event.type === "item.failed") {
    return {
      taskId: event.taskId,
      taskKind,
      failure: {
        itemRef: event.payload.itemRef,
        errorCode: event.payload.errorCode,
        retryable: event.payload.retryable,
      },
      message: `${taskKind} failed: ${event.payload.errorCode}`,
    };
  }
  if (event.type === "completed") {
    return {
      taskId: event.taskId,
      taskKind,
      phase: "completed",
      status: event.payload.status,
      recoveryLock: event.payload.systemRecoveryLock,
      message: formatTaskCompletionMessage(taskKind, event.payload),
    };
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
  return {
    taskId: merged.taskId,
    taskKind: merged.taskKind,
    phase: merged.phase ?? base.phase,
    status: merged.status ?? base.status,
    recoveryLock: merged.recoveryLock ?? base.recoveryLock,
    ...(merged.progress === undefined ? {} : { progress: merged.progress }),
    ...(merged.message === undefined ? {} : { message: merged.message }),
    ...(merged.failure === undefined ? {} : { failure: merged.failure }),
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
