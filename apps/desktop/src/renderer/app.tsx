import { useEffect, useReducer, useState } from "react";

import type { CommandRequest, CommandResponse, TaskEvent } from "@ai-config-hub/api";

import type { DesktopApi } from "../preload/api.js";
import { AppShell } from "./components/app-shell.js";
import { formatLocalizedUiError, localeForState, localizeUiMessage, t } from "./i18n.js";
import {
  assetStatusChangeRequestFor,
  deploymentBlockersForState,
  deploymentConfirmationsForState,
  effectiveRequestForState,
  initialState,
  migrationPreviewBlockersForState,
  openSourceRequestForState,
  previewRequestForState,
  projectIdForRoot,
  reducer,
  refreshAssetDetail,
  refreshAssets,
  refreshDiagnostics,
  scanActionForTaskEvent,
  settingsClearLocalDataRequestForState,
  settingsUpdateRequestForState,
  taskActionForTaskEvent,
  type AssetDisablementMethod,
  type ScanTaskScope,
} from "./model.js";
import { AssetsView } from "./views/assets.js";
import { MigrationView } from "./views/migration.js";
import { SettingsView } from "./views/settings.js";

export function App(props: { readonly api: DesktopApi }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [updateStatus, setUpdateStatus] =
    useState<Awaited<ReturnType<DesktopApi["updateStatus"]>>>();
  const locale = localeForState(state);

  async function runAction(action: string, work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      dispatch({ type: "message", message: formatLocalizedUiError(locale, error, action) });
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
      await scanMigrationSourceProject(sourceProjectRoot);
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
      await scanMigrationTargetProject(targetScopeId);
    });
  }

  async function loadSettings() {
    dispatch({ type: "settingsLoading" });
    try {
      const response = await props.api.invoke("settings.get", { keys: ["theme", "language"] });
      if (response.ok) dispatch({ type: "settingsLoaded", settings: response.data });
      else {
        dispatch({ type: "settingsFailed" });
        dispatch({ type: "message", message: localizeUiMessage(locale, response.error.message) });
      }
    } catch (error) {
      dispatch({ type: "settingsFailed" });
      dispatch({
        type: "message",
        message: formatLocalizedUiError(locale, error, "Load settings"),
      });
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
        dispatch({ type: "message", message: localizeUiMessage(locale, response.error.message) });
      }
    } catch (error) {
      dispatch({ type: "settingsFailed" });
      dispatch({
        type: "message",
        message: formatLocalizedUiError(locale, error, "Update settings"),
      });
    }
  }

  async function clearLocalData() {
    const request = settingsClearLocalDataRequestForState(state);
    if (request === undefined) {
      dispatch({
        type: "message",
        message: t(locale, "Select local data and confirm clearing before continuing."),
      });
      return;
    }

    dispatch({ type: "settingsClearLocalDataStarted" });
    try {
      const response = await props.api.invoke("settings.clearLocalData", request);
      if (response.ok) {
        dispatch({ type: "settingsClearLocalDataCompleted", result: response.data });
        dispatch({
          type: "message",
          message: localDataClearedMessage(locale, response.data),
        });
        if (response.data.categories.includes("settings")) await loadSettings();
      } else {
        dispatch({ type: "settingsClearLocalDataFailed" });
        dispatch({ type: "message", message: localizeUiMessage(locale, response.error.message) });
      }
    } catch (error) {
      dispatch({ type: "settingsClearLocalDataFailed" });
      dispatch({
        type: "message",
        message: formatLocalizedUiError(locale, error, "Clear local data"),
      });
    }
  }

  useEffect(() => {
    void loadSettings();
    void props.api.updateStatus().then(setUpdateStatus);
    const unsubscribeUpdates = props.api.subscribeUpdates(setUpdateStatus);
    return unsubscribeUpdates;
  }, [props.api]);

  async function checkForUpdates() {
    await runAction("Check for updates", async () => {
      setUpdateStatus(await props.api.checkForUpdates());
    });
  }

  async function downloadUpdate() {
    await runAction("Download update", async () => {
      setUpdateStatus(await props.api.downloadUpdate());
    });
  }

  async function installUpdate() {
    await runAction("Install update", async () => {
      await props.api.installUpdate();
    });
  }

  async function scanReviewProject(root: string) {
    await runAction("Start scan", async () => {
      const response = await props.api.invoke("scan.start", {
        mode: "full",
        roots: [root],
      });
      dispatch({
        type: "scan",
        status: response.ok ? "queued" : "error",
        scanScope: "asset-review",
        ...(response.ok ? {} : { message: localizeUiMessage(locale, response.error.message) }),
      });
      if (response.ok) {
        subscribeTask(response.data.taskId, (event) => {
          const action = scanActionForTaskEvent(event, "asset-review");
          if (action !== undefined) dispatch(action);
          const taskAction = taskActionForTaskEvent(event, "asset-review");
          if (taskAction !== undefined) dispatch({ type: "taskEvent", action: taskAction });
          if (event.type === "completed") {
            void refreshAssets(props.api).then((assets) => dispatch({ type: "assets", assets }));
            void refreshDiagnostics(props.api).then(({ diagnostics, diagnosticCounts }) =>
              dispatch({ type: "diagnostics", diagnostics, counts: diagnosticCounts }),
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
    });
  }

  async function scanMigrationSourceProject(root: string) {
    await runAction("Start source scan", async () => {
      const projectId = await projectIdForRoot(root);
      const response = await props.api.invoke("scan.start", {
        mode: "full",
        roots: [root],
        projectId,
      });
      dispatch({
        type: "scan",
        status: response.ok ? "queued" : "error",
        scanScope: "migration-source",
        ...(response.ok ? {} : { message: localizeUiMessage(locale, response.error.message) }),
      });
      if (response.ok) {
        subscribeTask(response.data.taskId, (event) => {
          const action = scanActionForTaskEvent(event, "migration-source");
          if (action !== undefined) dispatch(action);
          const taskAction = taskActionForTaskEvent(event, "migration-source");
          if (taskAction !== undefined) dispatch({ type: "taskEvent", action: taskAction });
          if (event.type === "completed") {
            void refreshMigrationProjectAssets("source", root);
          }
        });
      }
      await refreshMigrationProjectAssets("source", root);
    });
  }

  async function scanMigrationTargetProject(root: string) {
    await runAction("Start target scan", async () => {
      const projectId = await projectIdForRoot(root);
      const response = await props.api.invoke("scan.start", {
        mode: "full",
        roots: [root],
        projectId,
      });
      dispatch({
        type: "scan",
        status: response.ok ? "queued" : "error",
        scanScope: "migration-target",
        ...(response.ok ? {} : { message: localizeUiMessage(locale, response.error.message) }),
      });
      if (response.ok) {
        subscribeTask(response.data.taskId, (event) => {
          const action = scanActionForTaskEvent(event, "migration-target");
          if (action !== undefined) dispatch(action);
          const taskAction = taskActionForTaskEvent(event, "migration-target");
          if (taskAction !== undefined) dispatch({ type: "taskEvent", action: taskAction });
          if (event.type === "completed") {
            void refreshMigrationProjectAssets("target", root);
          }
        });
      }
      await refreshMigrationProjectAssets("target", root);
    });
  }

  async function refreshMigrationProjectAssets(kind: "source" | "target", root: string) {
    const assets = await refreshAssets(props.api, { projectRoot: root });
    dispatch(
      kind === "source"
        ? { type: "migrationSourceAssets", sourceProjectRoot: root, assets }
        : { type: "migrationTargetAssets", targetScopeId: root, assets },
    );
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
        message: response.ok
          ? t(locale, "Source file opened.")
          : localizeUiMessage(locale, response.error.message),
      });
    });
  }

  async function toggleAssetStatus(
    assetId: CommandResponse<"assets.list">["items"][number]["id"],
    nextStatus: CommandResponse<"assets.list">["items"][number]["status"],
    disablementMethod?: AssetDisablementMethod,
  ) {
    await runAction(nextStatus === "disabled" ? "Disable asset" : "Enable asset", async () => {
      const request = assetStatusChangeRequestFor(assetId, nextStatus, disablementMethod);
      const response =
        request.command === "assets.disable"
          ? await props.api.invoke(request.command, request.request)
          : await props.api.invoke(request.command, request.request);
      if (!response.ok) {
        dispatch({ type: "message", message: localizeUiMessage(locale, response.error.message) });
        return;
      }

      const statusAction = {
        type: "assetStatus",
        assetId: response.data.assetId,
        status: response.data.status,
      } as const;
      dispatch(statusAction);
      dispatch({
        type: "message",
        message: t(locale, nextStatus === "disabled" ? "Asset disabled." : "Asset enabled."),
      });
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
        dispatch({ type: "message", message: localizeUiMessage(locale, blockers[0] ?? "") });
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
      else
        dispatch({ type: "message", message: localizeUiMessage(locale, response.error.message) });
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
    await runAction("Execute migration", async () => {
      const response = await props.api.invoke("deployment.execute", {
        planId: previewPlan.planId,
        confirmedPlanHash: previewPlan.planHash,
        confirmations: deploymentConfirmationsForState(state),
      });
      const taskId = response.ok ? response.data.taskId : response.error.taskId;
      if (taskId !== undefined) subscribeOperationTask(taskId);
      dispatch({
        type: "message",
        message: response.ok ? undefined : localizeUiMessage(locale, response.error.message),
      });
    });
  }

  function subscribeTask(taskId: string, onEvent: (event: TaskEvent) => void): void {
    props.api.subscribeTask(taskId, 0, onEvent);
  }

  function subscribeOperationTask(taskId: string, scanScope?: ScanTaskScope): void {
    subscribeTask(taskId, (event) => {
      const action = taskActionForTaskEvent(event, scanScope);
      if (action !== undefined) dispatch({ type: "taskEvent", action });
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
              else {
                dispatch({
                  type: "message",
                  message: localizeUiMessage(locale, response.error.message),
                });
              }
            });
          }}
          onOpenSource={() => void openSource()}
          onToggleAssetStatus={(assetId, nextStatus, disablementMethod) => {
            void toggleAssetStatus(assetId, nextStatus, disablementMethod);
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
          onConfirmMigration={(confirmed) =>
            dispatch({ type: "deploymentConfirmation", confirmed })
          }
          onConfirmRequirement={(confirmation, granted) =>
            dispatch({ type: "deploymentConfirmationGrant", confirmation, granted })
          }
          onExecuteMigration={() => void deploy()}
        />
      ) : null}
      {state.route === "settings" ? (
        <SettingsView
          state={state}
          {...(updateStatus === undefined ? {} : { updateStatus })}
          onThemeChange={(theme) => void updateSettings({ theme })}
          onLanguageChange={(language) => void updateSettings({ language })}
          onReload={() => void loadSettings()}
          onLocalDataCategoryChange={(category, selected) =>
            dispatch({ type: "settingsClearLocalDataCategory", category, selected })
          }
          onLocalDataConfirmationChange={(confirmed) =>
            dispatch({ type: "settingsClearLocalDataConfirmation", confirmed })
          }
          onClearLocalData={() => void clearLocalData()}
          onCheckUpdates={() => void checkForUpdates()}
          onDownloadUpdate={() => void downloadUpdate()}
          onInstallUpdate={() => void installUpdate()}
        />
      ) : null}
    </AppShell>
  );
}

function localDataClearedMessage(
  locale: ReturnType<typeof localeForState>,
  result: CommandResponse<"settings.clearLocalData">,
): string {
  const count = Object.values(result.counts).reduce((total, item) => total + item, 0);
  return t(locale, "Cleared selected local data ({count} records).", { count });
}
