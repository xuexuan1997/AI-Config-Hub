import { useReducer } from "react";

import type { DesktopApi } from "../preload/api.js";
import { AppShell } from "./components/app-shell.js";
import {
  formatUiError,
  initialState,
  previewRequestForState,
  reducer,
  refreshAssetDetail,
  refreshAssets,
  refreshDiagnostics,
  refreshHistory,
  rollbackRequestForState,
  scanActionForTaskEvent,
} from "./model.js";
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
      if (response.ok) {
        props.api.subscribeTask(response.data.taskId, 0, (event) => {
          const action = scanActionForTaskEvent(event);
          if (action !== undefined) dispatch(action);
          if (event.type === "completed") {
            void refreshAssets(props.api).then((assets) => dispatch({ type: "assets", assets }));
            void refreshDiagnostics(props.api).then(({ diagnostics, diagnosticCounts }) =>
              dispatch({ type: "diagnostics", diagnostics, counts: diagnosticCounts }),
            );
            void refreshHistory(props.api).then((history) =>
              dispatch({ type: "history", history }),
            );
          }
        });
      }
      dispatch({ type: "assets", assets: await refreshAssets(props.api) });
      const diagnostics = await refreshDiagnostics(props.api);
      dispatch({
        type: "diagnostics",
        diagnostics: diagnostics.diagnostics,
        counts: diagnostics.diagnosticCounts,
      });
      dispatch({ type: "history", history: await refreshHistory(props.api) });
    });
  }

  async function preview() {
    await runAction("Preview migration", async () => {
      const request = previewRequestForState(state);
      if (request === undefined) {
        dispatch({
          type: "message",
          message: "Select a project and scan at least one asset first.",
        });
        return;
      }
      const response = await props.api.invoke("migration.preview", request);
      if (response.ok) dispatch({ type: "preview", preview: response.data });
      else dispatch({ type: "message", message: response.error.message });
    });
  }

  async function deploy() {
    const previewPlan = state.preview;
    if (previewPlan === undefined || !state.deploymentConfirmed) return;
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
      dispatch({ type: "history", history: await refreshHistory(props.api) });
    });
  }

  async function rollback() {
    await runAction("Preview rollback", async () => {
      const request = rollbackRequestForState(state);
      if (request === undefined) {
        dispatch({
          type: "message",
          message: "No succeeded deployment is available to roll back.",
        });
        return;
      }
      const response = await props.api.invoke("deployment.rollback", request);
      dispatch({
        type: "scan",
        status: response.ok ? "complete" : "error",
        message: response.ok
          ? `Rollback queued: ${response.data.rollbackId}`
          : response.error.message,
      });
      dispatch({ type: "history", history: await refreshHistory(props.api) });
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
              const diagnostics = await refreshDiagnostics(props.api);
              dispatch({
                type: "diagnostics",
                diagnostics: diagnostics.diagnostics,
                counts: diagnostics.diagnosticCounts,
              });
            });
          }}
          onInspect={(assetId) => {
            void runAction("Inspect asset", async () => {
              const detail = await refreshAssetDetail(props.api, assetId);
              if (detail === undefined) {
                dispatch({ type: "message", message: "Asset detail is unavailable." });
                return;
              }
              dispatch({ type: "assetDetail", detail });
              const diagnostics = await refreshDiagnostics(props.api, assetId);
              dispatch({
                type: "diagnostics",
                diagnostics: diagnostics.diagnostics,
                counts: diagnostics.diagnosticCounts,
              });
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
          onConfirm={(confirmed) => dispatch({ type: "deploymentConfirmation", confirmed })}
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
