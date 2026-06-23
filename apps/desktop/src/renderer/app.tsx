import { useReducer } from "react";

import type { DesktopApi } from "../preload/api.js";
import { AppShell } from "./components/app-shell.js";
import { initialState, reducer, refreshAssets, refreshHistory } from "./model.js";
import { AssetsView } from "./views/assets.js";
import { DeploymentView } from "./views/deployment.js";
import { HistoryView } from "./views/history.js";
import { MigrationView } from "./views/migration.js";
import { OverviewView } from "./views/overview.js";

export function App(props: { readonly api: DesktopApi }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  async function selectProject() {
    dispatch({ type: "project", root: await props.api.selectProjectRoot() });
  }

  async function scan() {
    const response = await props.api.invoke("scan.start", { mode: "full" });
    dispatch({
      type: "scan",
      status: response.ok ? "queued" : "error",
      message: response.ok ? `Queued ${response.data.taskId}` : response.error.message,
    });
    dispatch({ type: "assets", assets: await refreshAssets(props.api) });
    dispatch({ type: "history", history: await refreshHistory(props.api) });
  }

  async function preview() {
    const sourceAssetId = state.assets[0]?.id ?? "asset-demo";
    const response = await props.api.invoke("migration.preview", {
      sourceAssetIds: [sourceAssetId],
      targetToolKey: "cursor",
      targetScopeId: "scope-demo",
      conflictPolicy: "replace",
    });
    if (response.ok) dispatch({ type: "preview", preview: response.data });
  }

  async function deploy() {
    if (state.preview === undefined) return;
    const response = await props.api.invoke("deployment.execute", { planId: state.preview.planId });
    dispatch({
      type: "scan",
      status: response.ok ? "complete" : "error",
      message: response.ok
        ? `Deployment queued: ${response.data.deploymentId}`
        : response.error.message,
    });
  }

  async function rollback() {
    const response = await props.api.invoke("deployment.rollback", {
      deploymentId: "desktop-deployment",
    });
    dispatch({
      type: "scan",
      status: response.ok ? "complete" : "error",
      message: response.ok
        ? `Rollback queued: ${response.data.rollbackId}`
        : response.error.message,
    });
  }

  return (
    <AppShell
      state={state}
      onRoute={(route) => dispatch({ type: "route", route })}
      onSelectProject={() => void selectProject()}
    >
      {state.route === "overview" ? (
        <OverviewView state={state} onScan={() => void scan()} />
      ) : null}
      {state.route === "assets" ? (
        <AssetsView
          state={state}
          onRefresh={() => {
            void refreshAssets(props.api).then((assets) => dispatch({ type: "assets", assets }));
          }}
        />
      ) : null}
      {state.route === "migration" ? (
        <MigrationView state={state} onPreview={() => void preview()} />
      ) : null}
      {state.route === "deployment" ? (
        <DeploymentView
          state={state}
          onDeploy={() => void deploy()}
          onRollback={() => void rollback()}
        />
      ) : null}
      {state.route === "history" ? (
        <HistoryView
          state={state}
          onRefresh={() => {
            void refreshHistory(props.api).then((history) =>
              dispatch({ type: "history", history }),
            );
          }}
        />
      ) : null}
    </AppShell>
  );
}
