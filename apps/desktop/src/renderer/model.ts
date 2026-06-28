import type { CommandRequest, CommandResponse, TaskEvent } from "@ai-config-hub/api";

import type { DesktopApi } from "../preload/api.js";

export type Route = "overview" | "assets" | "migration" | "deployment" | "history";

export interface AppState {
  readonly route: Route;
  readonly projectRoot?: string;
  readonly scanStatus: "idle" | "queued" | "complete" | "error";
  readonly assets: CommandResponse<"assets.list">["items"];
  readonly assetDetail?: CommandResponse<"assets.get">;
  readonly diagnostics: CommandResponse<"diagnostics.list">["items"];
  readonly diagnosticCounts: CommandResponse<"diagnostics.list">["countsBySeverity"];
  readonly preview?: CommandResponse<"migration.preview">;
  readonly deploymentConfirmed: boolean;
  readonly history: CommandResponse<"history.list">["items"];
  readonly message?: string;
}

export type AppAction =
  | { readonly type: "route"; readonly route: Route }
  | { readonly type: "project"; readonly root: string | undefined }
  | { readonly type: "message"; readonly message: string | undefined }
  | { readonly type: "scan"; readonly status: AppState["scanStatus"]; readonly message?: string }
  | { readonly type: "assets"; readonly assets: AppState["assets"] }
  | { readonly type: "assetDetail"; readonly detail: CommandResponse<"assets.get"> }
  | {
      readonly type: "diagnostics";
      readonly diagnostics: AppState["diagnostics"];
      readonly counts: AppState["diagnosticCounts"];
    }
  | { readonly type: "preview"; readonly preview: CommandResponse<"migration.preview"> }
  | { readonly type: "deploymentConfirmation"; readonly confirmed: boolean }
  | { readonly type: "history"; readonly history: AppState["history"] };

export const initialState: AppState = {
  route: "overview",
  scanStatus: "idle",
  assets: [],
  diagnostics: [],
  diagnosticCounts: { info: 0, warning: 0, error: 0 },
  deploymentConfirmed: false,
  history: [],
};

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "route":
      return { ...state, route: action.route };
    case "project":
      if (action.root === undefined) {
        return {
          route: state.route,
          scanStatus: state.scanStatus,
          assets: state.assets,
          diagnostics: state.diagnostics,
          diagnosticCounts: state.diagnosticCounts,
          deploymentConfirmed: state.deploymentConfirmed,
          history: state.history,
          ...(state.assetDetail === undefined ? {} : { assetDetail: state.assetDetail }),
          ...(state.preview === undefined ? {} : { preview: state.preview }),
          ...(state.message === undefined ? {} : { message: state.message }),
        };
      }
      return {
        route: state.route,
        scanStatus: state.scanStatus,
        assets: state.assets,
        diagnostics: state.diagnostics,
        diagnosticCounts: state.diagnosticCounts,
        deploymentConfirmed: state.deploymentConfirmed,
        history: state.history,
        projectRoot: action.root,
        ...(state.assetDetail === undefined ? {} : { assetDetail: state.assetDetail }),
        ...(state.preview === undefined ? {} : { preview: state.preview }),
      };
    case "message":
      return action.message === undefined
        ? {
            route: state.route,
            scanStatus: state.scanStatus,
            assets: state.assets,
            diagnostics: state.diagnostics,
            diagnosticCounts: state.diagnosticCounts,
            deploymentConfirmed: state.deploymentConfirmed,
            history: state.history,
            ...(state.projectRoot === undefined ? {} : { projectRoot: state.projectRoot }),
            ...(state.assetDetail === undefined ? {} : { assetDetail: state.assetDetail }),
            ...(state.preview === undefined ? {} : { preview: state.preview }),
          }
        : { ...state, message: action.message };
    case "scan":
      return {
        ...state,
        scanStatus: action.status,
        ...(action.message === undefined ? {} : { message: action.message }),
      };
    case "assets":
      return { ...state, assets: action.assets };
    case "assetDetail":
      return { ...state, assetDetail: action.detail };
    case "diagnostics":
      return { ...state, diagnostics: action.diagnostics, diagnosticCounts: action.counts };
    case "preview":
      return { ...state, preview: action.preview, deploymentConfirmed: false };
    case "deploymentConfirmation":
      return { ...state, deploymentConfirmed: action.confirmed };
    case "history":
      return { ...state, history: action.history };
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

export function previewRequestForState(
  state: AppState,
): CommandRequest<"migration.preview"> | undefined {
  const sourceAsset = state.assets[0];
  if (state.projectRoot === undefined || sourceAsset === undefined) return undefined;
  return {
    sourceAssetIds: [sourceAsset.id],
    targetToolKey: "cursor",
    targetScopeId: state.projectRoot,
    conflictPolicy: "replace",
  };
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

export function formatUiError(error: unknown, action: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  const lowerDetail = detail.toLowerCase();
  if (lowerDetail.includes("filechooser") || lowerDetail.includes("file chooser")) {
    return `${action} failed: the system file chooser is unavailable. Please type the project path manually and click Use path. (${detail})`;
  }
  return `${action} failed: ${detail}`;
}
