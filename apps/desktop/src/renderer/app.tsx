import { useEffect, useReducer } from "react";

import type { CommandRequest, CommandResponse, TaskEvent } from "@ai-config-hub/api";

import type { DesktopApi } from "../preload/api.js";
import { AppShell } from "./components/app-shell.js";
import { localeForState, t } from "./i18n.js";
import {
  deploymentBlockersForState,
  deploymentConfirmationsForState,
  effectiveRequestForState,
  formatUiError,
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
import { MigrationView } from "./views/migration.js";
import { SettingsView } from "./views/settings.js";

export function App(props: { readonly api: DesktopApi }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const locale = localeForState(state);

  async function runAction(action: string, work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      dispatch({ type: "message", message: formatUiError(error, action) });
    }
  }

  async function selectProject() {
    await runAction("Select project", async () => {
      const root = await props.api.selectProjectRoot();
      if (root === undefined) return;
      dispatch({ type: "project", root });
      await scanReviewProject(root);
    });
  }

  async function selectMigrationSourceProject() {
    await runAction("Select migration source project", async () => {
      const sourceProjectRoot = await props.api.selectProjectRoot();
      if (sourceProjectRoot === undefined) return;
      dispatch({
        type: "migrationSourceProject",
        sourceProjectRoot,
      });
      await scanMigrationProject("source", sourceProjectRoot);
    });
  }

  async function selectMigrationTargetProject() {
    await runAction("Select migration target project", async () => {
      const targetScopeId = await props.api.selectProjectRoot();
      if (targetScopeId === undefined) return;
      dispatch({
        type: "migrationTargetProject",
        targetScopeId,
      });
      await scanMigrationProject("target", targetScopeId);
    });
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

  async function scanReviewProject(root: string) {
    await runAction("Start scan", async () => {
      const response = await props.api.invoke("scan.start", {
        mode: "full",
        roots: [root],
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

  async function scanMigrationProject(kind: "source" | "target", root: string) {
    await runAction(kind === "source" ? "Start source scan" : "Start target scan", async () => {
      const response = await props.api.invoke("scan.start", {
        mode: "full",
        roots: [root],
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
            void refreshAssets(props.api).then((assets) =>
              dispatch({
                type: kind === "source" ? "migrationSourceAssets" : "migrationTargetAssets",
                assets,
              }),
            );
          }
        });
      }
    });
  }

  async function openSource() {
    await runAction("Open source", async () => {
      const request = openSourceRequestForState(state);
      if (request === undefined) {
        dispatch({
          type: "message",
          message: t(locale, "Inspect an asset before opening its source file."),
        });
        return;
      }
      const response = await props.api.invoke("assets.openSource", request);
      dispatch({
        type: "message",
        message: response.ok ? t(locale, "Source file opened.") : response.error.message,
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

      const statusAction = {
        type: "assetStatus",
        assetId: response.data.assetId,
        status: response.data.status,
      } as const;
      dispatch(statusAction);
      const detail = await refreshAssetDetail(props.api, assetId);
      if (detail !== undefined) dispatch({ type: "assetDetail", detail });
      dispatch(statusAction);
      const diagnostics = await refreshDiagnostics(props.api, assetId);
      dispatch({
        type: "diagnostics",
        diagnostics: diagnostics.diagnostics,
        counts: diagnostics.diagnosticCounts,
      });
    });
  }

  async function preview() {
    await runAction("Preview migration", async () => {
      const blockers = migrationPreviewBlockersForState(state);
      if (blockers.length > 0) {
        dispatch({ type: "message", message: t(locale, blockers[0] ?? "") });
        return;
      }
      const request = previewRequestForState(state);
      if (request === undefined) {
        dispatch({
          type: "message",
          message: t(locale, "Select a project and scan at least one asset first."),
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
      dispatch({ type: "message", message: t(locale, blockers[0] ?? "") });
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
          message: t(locale, "No succeeded deployment is available to roll back."),
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
    <AppShell state={state} onRoute={(route) => dispatch({ type: "route", route })}>
      {state.route === "assets" ? (
        <AssetsView
          state={state}
          onSelectProject={() => void selectProject()}
          onInspect={(assetId) => {
            void runAction("Inspect asset", async () => {
              const detail = await refreshAssetDetail(props.api, assetId);
              if (detail === undefined) {
                dispatch({ type: "message", message: t(locale, "Asset detail is unavailable.") });
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
                  message: t(
                    locale,
                    "Inspect an asset with a selected project before resolving effective configuration.",
                  ),
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
                dispatch({
                  type: "message",
                  message: t(locale, "Diagnostic asset is unavailable."),
                });
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
          onSelectSourceProject={() => void selectMigrationSourceProject()}
          onSelectTargetProject={() => void selectMigrationTargetProject()}
          onSwapProjects={() => dispatch({ type: "migrationSwapProjects" })}
          onTargetTool={(targetToolKey) => dispatch({ type: "migrationTarget", targetToolKey })}
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
