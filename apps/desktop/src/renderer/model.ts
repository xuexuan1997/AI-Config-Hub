import type { CommandResponse } from "@ai-config-hub/api";

import type { DesktopApi } from "../preload/api.js";

export type Route = "overview" | "assets" | "migration" | "deployment" | "history";

export interface AppState {
  readonly route: Route;
  readonly projectRoot?: string;
  readonly scanStatus: "idle" | "queued" | "complete" | "error";
  readonly assets: CommandResponse<"assets.list">["items"];
  readonly preview?: CommandResponse<"migration.preview">;
  readonly history: CommandResponse<"history.list">["items"];
  readonly message?: string;
}

export type AppAction =
  | { readonly type: "route"; readonly route: Route }
  | { readonly type: "project"; readonly root: string | undefined }
  | { readonly type: "message"; readonly message: string | undefined }
  | { readonly type: "scan"; readonly status: AppState["scanStatus"]; readonly message?: string }
  | { readonly type: "assets"; readonly assets: AppState["assets"] }
  | { readonly type: "preview"; readonly preview: CommandResponse<"migration.preview"> }
  | { readonly type: "history"; readonly history: AppState["history"] };

export const initialState: AppState = {
  route: "overview",
  scanStatus: "idle",
  assets: [],
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
          history: state.history,
          ...(state.preview === undefined ? {} : { preview: state.preview }),
          ...(state.message === undefined ? {} : { message: state.message }),
        };
      }
      return {
        route: state.route,
        scanStatus: state.scanStatus,
        assets: state.assets,
        history: state.history,
        projectRoot: action.root,
        ...(state.preview === undefined ? {} : { preview: state.preview }),
      };
    case "message":
      return action.message === undefined
        ? {
            route: state.route,
            scanStatus: state.scanStatus,
            assets: state.assets,
            history: state.history,
            ...(state.projectRoot === undefined ? {} : { projectRoot: state.projectRoot }),
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
    case "preview":
      return { ...state, preview: action.preview };
    case "history":
      return { ...state, history: action.history };
  }
}

export async function refreshAssets(api: DesktopApi): Promise<AppState["assets"]> {
  const response = await api.invoke("assets.list", { limit: 50 });
  return response.ok ? response.data.items : [];
}

export async function refreshHistory(api: DesktopApi): Promise<AppState["history"]> {
  const response = await api.invoke("history.list", { limit: 50 });
  return response.ok ? response.data.items : [];
}

export function formatUiError(error: unknown, action: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  const lowerDetail = detail.toLowerCase();
  if (lowerDetail.includes("filechooser") || lowerDetail.includes("file chooser")) {
    return `${action} failed: the system file chooser is unavailable. Please type the project path manually and click Use path. (${detail})`;
  }
  return `${action} failed: ${detail}`;
}
