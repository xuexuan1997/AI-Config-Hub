import type { CommandRequest, CommandResponse, TaskEvent, TaskPhase } from "@ai-config-hub/api";
import {
  DeploymentRecordIdSchema,
  ProjectIdSchema,
  ResourceKindSchema,
  ScopeIdSchema,
  ToolIdSchema,
} from "@ai-config-hub/shared";

import type { DesktopApi } from "../preload/api.js";

export type Route = "overview" | "assets" | "migration" | "deployment" | "history";

export type MigrationTargetToolKey = CommandRequest<"migration.preview">["targetToolKey"];
export type MigrationConflictPolicy = CommandRequest<"migration.preview">["conflictPolicy"];
export type MigrationSourceAssetId = CommandResponse<"assets.list">["items"][number]["id"];
export type DeploymentConfirmation = CommandRequest<"deployment.execute">["confirmations"][number];

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

export interface MigrationFormState {
  readonly sourceAssetIds: readonly MigrationSourceAssetId[];
  readonly targetToolKey: MigrationTargetToolKey;
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
  readonly assetDetail?: CommandResponse<"assets.get">;
  readonly effective?: CommandResponse<"effective.resolve">;
  readonly diagnostics: CommandResponse<"diagnostics.list">["items"];
  readonly diagnosticCounts: CommandResponse<"diagnostics.list">["countsBySeverity"];
  readonly migration: MigrationFormState;
  readonly preview?: CommandResponse<"migration.preview">;
  readonly deploymentConfirmed: boolean;
  readonly deploymentConfirmationGrants: readonly DeploymentConfirmation[];
  readonly history: CommandResponse<"history.list">["items"];
  readonly historyDetail?: CommandResponse<"history.get">;
  readonly activeTask?: ActiveTaskState;
  readonly message?: string;
}

export type AppAction =
  | { readonly type: "route"; readonly route: Route }
  | { readonly type: "project"; readonly root: string | undefined }
  | { readonly type: "message"; readonly message: string | undefined }
  | { readonly type: "scan"; readonly status: AppState["scanStatus"]; readonly message?: string }
  | { readonly type: "assets"; readonly assets: AppState["assets"] }
  | { readonly type: "assetDetail"; readonly detail: CommandResponse<"assets.get"> }
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
  | { readonly type: "migrationTarget"; readonly targetToolKey: MigrationTargetToolKey }
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
  | { readonly type: "history"; readonly history: AppState["history"] }
  | { readonly type: "historyDetail"; readonly detail: CommandResponse<"history.get"> }
  | { readonly type: "taskEvent"; readonly action: ActiveTaskUpdate };

export const initialState: AppState = {
  route: "overview",
  scanStatus: "idle",
  assets: [],
  diagnostics: [],
  diagnosticCounts: { info: 0, warning: 0, error: 0 },
  migration: { sourceAssetIds: [], targetToolKey: "cursor", conflictPolicy: "replace" },
  deploymentConfirmed: false,
  deploymentConfirmationGrants: [],
  history: [],
};

function clearPreview(state: AppState): AppState {
  const { preview: discardedPreview, ...withoutPreview } = state;
  void discardedPreview;
  return { ...withoutPreview, deploymentConfirmed: false, deploymentConfirmationGrants: [] };
}

function clearProjectDetails(state: AppState): AppState {
  const {
    assetDetail: discardedAssetDetail,
    effective: discardedEffective,
    historyDetail: discardedHistoryDetail,
    ...withoutDetails
  } = state;
  void discardedAssetDetail;
  void discardedEffective;
  void discardedHistoryDetail;
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

function clearHistoryDetail(state: AppState): AppState {
  const { historyDetail: discardedHistoryDetail, ...withoutHistoryDetail } = state;
  void discardedHistoryDetail;
  return withoutHistoryDetail;
}

function migrationSourceAssetIds(
  state: AppState,
  assets: AppState["assets"],
): MigrationFormState["sourceAssetIds"] {
  const available = new Set(assets.map((asset) => asset.id));
  const retained = state.migration.sourceAssetIds.filter((assetId) => available.has(assetId));
  if (retained.length > 0) return retained;
  const first = assets[0];
  return first === undefined ? [] : [first.id];
}

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "route":
      return { ...state, route: action.route };
    case "project":
      if (action.root === undefined) {
        return clearProjectDetails(
          clearPreview({
            route: state.route,
            scanStatus: state.scanStatus,
            assets: state.assets,
            diagnostics: state.diagnostics,
            diagnosticCounts: state.diagnosticCounts,
            migration: state.migration,
            deploymentConfirmed: state.deploymentConfirmed,
            deploymentConfirmationGrants: state.deploymentConfirmationGrants,
            history: state.history,
            ...(state.activeTask === undefined ? {} : { activeTask: state.activeTask }),
            ...(state.message === undefined ? {} : { message: state.message }),
          }),
        );
      }
      return clearProjectDetails(
        clearPreview({
          route: state.route,
          scanStatus: state.scanStatus,
          assets: state.assets,
          diagnostics: state.diagnostics,
          diagnosticCounts: state.diagnosticCounts,
          migration: state.migration,
          deploymentConfirmed: state.deploymentConfirmed,
          deploymentConfirmationGrants: state.deploymentConfirmationGrants,
          history: state.history,
          projectRoot: action.root,
          ...(state.activeTask === undefined ? {} : { activeTask: state.activeTask }),
        }),
      );
    case "message":
      return action.message === undefined
        ? {
            route: state.route,
            scanStatus: state.scanStatus,
            assets: state.assets,
            diagnostics: state.diagnostics,
            diagnosticCounts: state.diagnosticCounts,
            migration: state.migration,
            deploymentConfirmed: state.deploymentConfirmed,
            deploymentConfirmationGrants: state.deploymentConfirmationGrants,
            history: state.history,
            ...(state.projectRoot === undefined ? {} : { projectRoot: state.projectRoot }),
            ...(state.assetDetail === undefined ? {} : { assetDetail: state.assetDetail }),
            ...(state.effective === undefined ? {} : { effective: state.effective }),
            ...(state.preview === undefined ? {} : { preview: state.preview }),
            ...(state.historyDetail === undefined ? {} : { historyDetail: state.historyDetail }),
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
        migration: {
          ...state.migration,
          sourceAssetIds: migrationSourceAssetIds(state, action.assets),
        },
      };
      return clearPreview(
        action.assets.some((asset) => asset.id === state.assetDetail?.asset.id)
          ? refreshed
          : clearAssetDetail(refreshed),
      );
    }
    case "assetDetail": {
      const { effective: discardedEffective, ...withoutEffective } = state;
      void discardedEffective;
      return { ...withoutEffective, assetDetail: action.detail };
    }
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
    case "migrationTarget":
      return clearPreview({
        ...state,
        migration: { ...state.migration, targetToolKey: action.targetToolKey },
      });
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
    case "history":
      return action.history.some((entry) => entry.id === state.historyDetail?.entry.id)
        ? { ...state, history: action.history }
        : { ...clearHistoryDetail(state), history: action.history };
    case "historyDetail":
      return { ...state, historyDetail: action.detail };
    case "taskEvent":
      return { ...state, activeTask: mergeActiveTask(state.activeTask, action.action) };
  }
}

export async function refreshAssets(api: DesktopApi): Promise<AppState["assets"]> {
  const response = await api.invoke("assets.list", { limit: 50 });
  return response.ok ? response.data.items : [];
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

export async function refreshHistory(api: DesktopApi): Promise<AppState["history"]> {
  const response = await api.invoke("history.list", { limit: 50 });
  return response.ok ? response.data.items : [];
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

export function historyDetailRequestForEntry(id: string): CommandRequest<"history.get"> {
  return { id: DeploymentRecordIdSchema.parse(id) };
}

export function previewRequestForState(
  state: AppState,
): CommandRequest<"migration.preview"> | undefined {
  if (migrationPreviewBlockersForState(state).length > 0) return undefined;
  const targetScopeId = state.projectRoot;
  if (targetScopeId === undefined) return undefined;
  const available = new Set(state.assets.map((asset) => asset.id));
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
  const availableAssets = new Map(state.assets.map((asset) => [asset.id, asset]));
  const selectedAssets = state.migration.sourceAssetIds
    .map((assetId) => availableAssets.get(assetId))
    .filter((asset) => asset !== undefined);

  if (state.projectRoot === undefined) {
    blockers.push("Select a project before creating a migration preview.");
  }
  if (selectedAssets.length === 0) {
    blockers.push("Select at least one source asset.");
  }
  if (new Set(selectedAssets.map((asset) => asset.resourceType)).size > 1) {
    blockers.push("Select source assets from one resource type.");
  }
  return blockers;
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
    state.assets.map((asset) => [asset.id, asset.contentHash]),
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
    blockers.push("Create a migration preview before deploying.");
  } else if (Date.parse(now) > Date.parse(state.preview.expiresAt)) {
    blockers.push("Create a fresh migration preview; the current plan has expired.");
  }
  if (migrationSourceDriftRowsForState(state).some((row) => row.status !== "current")) {
    blockers.push("Refresh the scan and create a fresh migration preview before deploying.");
  }
  if (state.activeTask?.recoveryLock === true) {
    blockers.push("Review recovery history and resolve the active recovery lock before deploying.");
  }
  const missingConfirmations = missingDeploymentConfirmationsForState(state);
  if (missingConfirmations.length > 0) {
    blockers.push(`Confirm required migration actions: ${missingConfirmations.join(", ")}.`);
  }
  if (!state.deploymentConfirmed) {
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

export function rollbackRequestForState(
  state: AppState,
): CommandRequest<"deployment.rollback"> | undefined {
  const deployment = state.history.find(
    (entry) => entry.kind === "deployment" && entry.status === "succeeded",
  );
  return deployment === undefined ? undefined : { deploymentId: deployment.id };
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
    message: `Task ${event.taskId} ${event.payload.status}: ${event.payload.succeededCount} succeeded, ${event.payload.failedCount} failed, ${event.payload.skippedCount} skipped.`,
  };
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
      message: `${taskKind} ${event.payload.status}: ${event.payload.succeededCount} succeeded, ${event.payload.failedCount} failed, ${event.payload.skippedCount} skipped.`,
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
    return `${action} failed: the system file chooser is unavailable. Please type the project path manually and click Use path. (${detail})`;
  }
  return `${action} failed: ${detail}`;
}
