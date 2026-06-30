import { useEffect, useReducer } from "react";

import type { CommandRequest, CommandResponse, TaskEvent } from "@ai-config-hub/api";

import type { DesktopApi } from "../preload/api.js";
import { AppShell } from "./components/app-shell.js";
import {
  deploymentBlockersForState,
  deploymentConfirmationsForState,
  effectiveRequestForState,
  formatUiError,
  historyDetailRequestForEntry,
  initialState,
  migrationPreviewBlockersForState,
  openSourceRequestForState,
  previewRequestForState,
  reducer,
  refreshAssetDetail,
  refreshAssets,
  refreshDiagnostics,
  refreshHistory,
  rollbackRequestForState,
  scanActionForTaskEvent,
  settingsUpdateRequestForState,
  taskActionForTaskEvent,
} from "./model.js";
import { AssetsView } from "./views/assets.js";
import { DeploymentView } from "./views/deployment.js";
import { HistoryView } from "./views/history.js";
import { MigrationView } from "./views/migration.js";
import { OverviewView } from "./views/overview.js";
import { SettingsView } from "./views/settings.js";

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

  async function loadSettings() {
    dispatch({ type: "settingsLoading" });
    try {
      const response = await props.api.invoke("settings.get", { keys: ["theme", "language"] });
      if (response.ok) dispatch({ type: "settingsLoaded", settings: response.data });
      else {
        dispatch({ type: "settingsFailed" });
        dispatch({ type: "message", message: response.error.message });
      }
    } catch (error) {
      dispatch({ type: "settingsFailed" });
      dispatch({ type: "message", message: formatUiError(error, "Load settings") });
    }
  }

  async function updateSettings(patch: CommandRequest<"settings.update">["patch"]) {
    dispatch({ type: "settingsSaving" });
    try {
      const response = await props.api.invoke(
        "settings.update",
        settingsUpdateRequestForState(state, patch),
      );
      if (response.ok) dispatch({ type: "settingsUpdated", settings: response.data });
      else {
        dispatch({ type: "settingsFailed" });
        dispatch({ type: "message", message: response.error.message });
      }
    } catch (error) {
      dispatch({ type: "settingsFailed" });
      dispatch({ type: "message", message: formatUiError(error, "Update settings") });
    }
  }

  useEffect(() => {
    void loadSettings();
  }, [props.api]);

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
        subscribeTask(response.data.taskId, (event) => {
          const action = scanActionForTaskEvent(event);
          if (action !== undefined) dispatch(action);
          const taskAction = taskActionForTaskEvent(event);
          if (taskAction !== undefined) dispatch({ type: "taskEvent", action: taskAction });
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

  async function refreshWorkspaceAfterScan(options: {
    readonly assetId?: CommandResponse<"assets.list">["items"][number]["id"];
    readonly previewRequest?: CommandRequest<"migration.preview">;
  }): Promise<void> {
    const assets = await refreshAssets(props.api);
    dispatch({ type: "assets", assets });

    let inspectedAssetId: CommandResponse<"assets.list">["items"][number]["id"] | undefined;
    if (options.assetId !== undefined && assets.some((asset) => asset.id === options.assetId)) {
      const detail = await refreshAssetDetail(props.api, options.assetId);
      if (detail !== undefined) {
        inspectedAssetId = options.assetId;
        dispatch({ type: "assetDetail", detail });
      }
    }

    const diagnostics = await refreshDiagnostics(props.api, inspectedAssetId);
    dispatch({
      type: "diagnostics",
      diagnostics: diagnostics.diagnostics,
      counts: diagnostics.diagnosticCounts,
    });
    dispatch({ type: "history", history: await refreshHistory(props.api) });

    const previousPreviewRequest = options.previewRequest;
    if (previousPreviewRequest === undefined) return;
    const availableAssetIds = new Set<string>(assets.map((asset) => asset.id));
    if (!previousPreviewRequest.sourceAssetIds.every((assetId) => availableAssetIds.has(assetId))) {
      dispatch({
        type: "message",
        message: "Selected migration sources changed after the rescan; create a new preview.",
      });
      return;
    }
    const previewResponse = await props.api.invoke("migration.preview", previousPreviewRequest);
    dispatch(
      previewResponse.ok
        ? { type: "preview", preview: previewResponse.data }
        : { type: "message", message: previewResponse.error.message },
    );
  }

  async function openSource() {
    await runAction("Open source", async () => {
      const request = openSourceRequestForState(state);
      if (request === undefined) {
        dispatch({ type: "message", message: "Inspect an asset before opening its source file." });
        return;
      }
      const response = await props.api.invoke("assets.openSource", request);
      dispatch({
        type: "message",
        message: response.ok ? "Source file opened." : response.error.message,
      });
    });
  }

  async function toggleAssetStatus(
    assetId: CommandResponse<"assets.list">["items"][number]["id"],
    nextStatus: CommandResponse<"assets.list">["items"][number]["status"],
  ) {
    await runAction(nextStatus === "disabled" ? "Disable asset" : "Enable asset", async () => {
      const response =
        nextStatus === "disabled"
          ? await props.api.invoke("assets.disable", { assetId })
          : await props.api.invoke("assets.enable", { assetId });
      if (!response.ok) {
        dispatch({ type: "message", message: response.error.message });
        return;
      }

      dispatch({ type: "assets", assets: await refreshAssets(props.api) });
      const detail = await refreshAssetDetail(props.api, assetId);
      if (detail !== undefined) dispatch({ type: "assetDetail", detail });
      const diagnostics = await refreshDiagnostics(props.api, assetId);
      dispatch({
        type: "diagnostics",
        diagnostics: diagnostics.diagnostics,
        counts: diagnostics.diagnosticCounts,
      });
    });
  }

  async function rescanAfterEdit() {
    await runAction("Rescan after edit", async () => {
      const assetId = state.assetDetail?.asset.id;
      const projectRoot = state.projectRoot;
      if (assetId === undefined || projectRoot === undefined) {
        dispatch({
          type: "message",
          message: "Inspect an asset with a selected project before rescanning after edit.",
        });
        return;
      }

      const previousPreviewRequest = previewRequestForState(state);
      const response = await props.api.invoke("scan.start", {
        mode: "full",
        roots: [projectRoot],
      });
      dispatch({
        type: "scan",
        status: response.ok ? "queued" : "error",
        message: response.ok ? `Queued ${response.data.taskId}` : response.error.message,
      });
      if (!response.ok) return;
      subscribeTask(response.data.taskId, (event) => {
        const action = scanActionForTaskEvent(event);
        if (action !== undefined) dispatch(action);
        const taskAction = taskActionForTaskEvent(event);
        if (taskAction !== undefined) dispatch({ type: "taskEvent", action: taskAction });
        if (event.type === "completed") {
          void refreshWorkspaceAfterScan({
            assetId,
            ...(previousPreviewRequest === undefined
              ? {}
              : { previewRequest: previousPreviewRequest }),
          });
        }
      });
    });
  }

  async function preview() {
    await runAction("Preview migration", async () => {
      const blockers = migrationPreviewBlockersForState(state);
      if (blockers.length > 0) {
        dispatch({ type: "message", message: blockers[0] });
        return;
      }
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
    const blockers = deploymentBlockersForState(state);
    if (blockers.length > 0) {
      dispatch({ type: "message", message: blockers[0] });
      return;
    }
    const previewPlan = state.preview;
    if (previewPlan === undefined) return;
    await runAction("Execute deployment", async () => {
      const response = await props.api.invoke("deployment.execute", {
        planId: previewPlan.planId,
        confirmedPlanHash: previewPlan.planHash,
        confirmations: deploymentConfirmationsForState(state),
      });
      const taskId = response.ok ? response.data.taskId : response.error.taskId;
      if (taskId !== undefined) subscribeOperationTask(taskId);
      dispatch({ type: "message", message: response.ok ? undefined : response.error.message });
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
      const taskId = response.ok ? response.data.taskId : response.error.taskId;
      if (taskId !== undefined) subscribeOperationTask(taskId);
      dispatch({ type: "message", message: response.ok ? undefined : response.error.message });
      dispatch({ type: "history", history: await refreshHistory(props.api) });
    });
  }

  function subscribeTask(taskId: string, onEvent: (event: TaskEvent) => void): void {
    props.api.subscribeTask(taskId, 0, onEvent);
  }

  function subscribeOperationTask(taskId: string): void {
    subscribeTask(taskId, (event) => {
      const action = taskActionForTaskEvent(event);
      if (action !== undefined) dispatch({ type: "taskEvent", action });
      if (event.type === "completed") {
        void refreshHistory(props.api).then((history) => dispatch({ type: "history", history }));
      }
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
          onLoadEffective={() => {
            void runAction("Resolve effective configuration", async () => {
              const request = effectiveRequestForState(state);
              if (request === undefined) {
                dispatch({
                  type: "message",
                  message:
                    "Inspect an asset with a selected project before resolving effective configuration.",
                });
                return;
              }
              const response = await props.api.invoke("effective.resolve", request);
              if (response.ok) dispatch({ type: "effective", effective: response.data });
              else dispatch({ type: "message", message: response.error.message });
            });
          }}
          onOpenSource={() => void openSource()}
          onToggleAssetStatus={(assetId, nextStatus) => {
            void toggleAssetStatus(assetId, nextStatus);
          }}
          onRescanAfterEdit={() => void rescanAfterEdit()}
          onCloseInspect={() => {
            dispatch({ type: "assetDetailClosed" });
            void runAction("Refresh diagnostics", async () => {
              const diagnostics = await refreshDiagnostics(props.api);
              dispatch({
                type: "diagnostics",
                diagnostics: diagnostics.diagnostics,
                counts: diagnostics.diagnosticCounts,
              });
            });
          }}
          onLocateDiagnostic={(assetId) => {
            void runAction("Locate diagnostic", async () => {
              const detail = await refreshAssetDetail(props.api, assetId);
              if (detail === undefined) {
                dispatch({ type: "message", message: "Diagnostic asset is unavailable." });
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
        <MigrationView
          state={state}
          onPreview={() => void preview()}
          onToggleSource={(assetId, selected) =>
            dispatch({ type: "migrationSource", assetId, selected })
          }
          onTargetTool={(targetToolKey) => dispatch({ type: "migrationTarget", targetToolKey })}
          onTargetProject={(targetScopeId) =>
            dispatch({ type: "migrationTargetProject", targetScopeId })
          }
          onConflictPolicy={(conflictPolicy) =>
            dispatch({ type: "migrationConflictPolicy", conflictPolicy })
          }
        />
      ) : null}
      {state.route === "deployment" ? (
        <DeploymentView
          state={state}
          onConfirm={(confirmed) => dispatch({ type: "deploymentConfirmation", confirmed })}
          onConfirmRequirement={(confirmation, granted) =>
            dispatch({ type: "deploymentConfirmationGrant", confirmation, granted })
          }
          onDeploy={() => void deploy()}
          onRollback={() => void rollback()}
          onReviewHistory={() => dispatch({ type: "route", route: "history" })}
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
          onLoadDetail={(id) => {
            void runAction("Load history detail", async () => {
              const response = await props.api.invoke(
                "history.get",
                historyDetailRequestForEntry(id),
              );
              if (response.ok) dispatch({ type: "historyDetail", detail: response.data });
              else dispatch({ type: "message", message: response.error.message });
            });
          }}
        />
      ) : null}
      {state.route === "settings" ? (
        <SettingsView
          state={state}
          onThemeChange={(theme) => void updateSettings({ theme })}
          onLanguageChange={(language) => void updateSettings({ language })}
          onReload={() => void loadSettings()}
        />
      ) : null}
    </AppShell>
  );
}
