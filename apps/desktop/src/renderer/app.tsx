import { useReducer } from "react";

import type { DesktopApi } from "../preload/api.js";
import { AppShell } from "./components/app-shell.js";
import { formatUiError, initialState, reducer, refreshAssets, refreshHistory } from "./model.js";
import { AssetsView } from "./views/assets.js";
import { DeploymentView } from "./views/deployment.js";
import { HistoryView } from "./views/history.js";
import { MigrationView } from "./views/migration.js";
import { OverviewView } from "./views/overview.js";

export function App(props: { readonly api: DesktopApi }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  async function runAction(action: string, work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      dispatch({ type: "message", message: formatUiError(error, action) });
    }
  }

  async function selectProject() {
    await runAction("Select project", async () => {
      dispatch({ type: "project", root: await props.api.selectProjectRoot() });
    });
  }

  function useProjectPath(path: string) {
    const root = path.trim();
    if (root.length === 0) {
      dispatch({ type: "message", message: "Enter a project path first." });
    } else {
      dispatch({ type: "project", root });
    }
  }

  async function scan() {
    await runAction("Start scan", async () => {
      const response = await props.api.invoke("scan.start", {
        mode: "full",
        ...(state.projectRoot === undefined ? {} : { roots: [state.projectRoot] }),
      });
      dispatch({
        type: "scan",
        status: response.ok ? "queued" : "error",
        message: response.ok ? `Queued ${response.data.taskId}` : response.error.message,
      });
      dispatch({ type: "assets", assets: await refreshAssets(props.api) });
      dispatch({ type: "history", history: await refreshHistory(props.api) });
    });
  }

  async function preview() {
    await runAction("Preview migration", async () => {
      const sourceAssetId = state.assets[0]?.id ?? "asset-demo";
      const response = await props.api.invoke("migration.preview", {
        sourceAssetIds: [sourceAssetId],
        targetToolKey: "cursor",
        targetScopeId: "scope-demo",
        conflictPolicy: "replace",
      });
      if (response.ok) dispatch({ type: "preview", preview: response.data });
      else dispatch({ type: "message", message: response.error.message });
    });
  }

  async function deploy() {
    const previewPlan = state.preview;
    if (previewPlan === undefined) return;
    await runAction("Execute deployment", async () => {
      const response = await props.api.invoke("deployment.execute", {
        planId: previewPlan.planId,
      });
      dispatch({
        type: "scan",
        status: response.ok ? "complete" : "error",
        message: response.ok
          ? `Deployment queued: ${response.data.deploymentId}`
          : response.error.message,
      });
    });
  }

  async function rollback() {
    await runAction("Preview rollback", async () => {
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
    });
  }

  return (
    <AppShell
      state={state}
      onRoute={(route) => dispatch({ type: "route", route })}
      onSelectProject={() => void selectProject()}
      onUseProjectPath={useProjectPath}
    >
      {state.route === "overview" ? (
        <OverviewView state={state} onScan={() => void scan()} />
      ) : null}
      {state.route === "assets" ? (
        <AssetsView
          state={state}
          onRefresh={() => {
            void runAction("Refresh assets", async () => {
              dispatch({ type: "assets", assets: await refreshAssets(props.api) });
            });
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
            void runAction("Refresh history", async () => {
              dispatch({ type: "history", history: await refreshHistory(props.api) });
            });
          }}
        />
      ) : null}
    </AppShell>
  );
}
