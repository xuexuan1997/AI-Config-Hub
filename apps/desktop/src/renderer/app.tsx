import { useEffect, useReducer, useRef, useState } from "react";

import type { CommandRequest, CommandResponse, TaskEvent } from "@ai-config-hub/api";

import type { DesktopApi, DesktopIndexChangeEvent, TaskSubscription } from "../preload/api.js";
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
  type AppAction,
  type AppState,
  type ScanTaskScope,
} from "./model.js";
import { AssetsView } from "./views/assets.js";
import { MigrationView } from "./views/migration.js";
import { SettingsView } from "./views/settings.js";

type RuntimeActiveTask = Awaited<ReturnType<DesktopApi["runtimeState"]>>["activeTasks"][number];

export interface RestoredScanSelection {
  readonly scanScope: ScanTaskScope;
  readonly projectRoot: string;
}

export function scanStartRequestForContext(
  root: string,
  projectId: CommandRequest<"scan.start">["projectId"],
  clientContext: ScanTaskScope,
): CommandRequest<"scan.start"> {
  return {
    mode: "full",
    roots: [root],
    projectId,
    clientContext,
  };
}

export function restoredScanSelectionForTask(
  task: RuntimeActiveTask,
): RestoredScanSelection | undefined {
  if (task.taskKind !== "scan" || task.clientContext === undefined) return undefined;
  // Project ids are derived from the lexical root selected by the user. Keep
  // that identity across reloads; canonical roots are transport metadata and
  // remain a backward-compatible fallback for older main processes.
  const projectRoot = task.selectedRoots?.[0] ?? task.canonicalRoots?.[0];
  return projectRoot === undefined ? undefined : { scanScope: task.clientContext, projectRoot };
}

export function refreshRestoredScanSelection(
  selection: RestoredScanSelection,
  refreshers: {
    readonly assetReview: (root: string) => void;
    readonly migrationSource: (root: string) => void;
    readonly migrationTarget: (root: string) => void;
  },
): void {
  if (selection.scanScope === "asset-review") {
    refreshers.assetReview(selection.projectRoot);
  } else if (selection.scanScope === "migration-source") {
    refreshers.migrationSource(selection.projectRoot);
  } else {
    refreshers.migrationTarget(selection.projectRoot);
  }
}

export function App(props: { readonly api: DesktopApi }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [updateStatus, setUpdateStatus] =
    useState<Awaited<ReturnType<DesktopApi["updateStatus"]>>>();
  const [previewPending, setPreviewPending] = useState(false);
  const currentState = useRef(state);
  const assetDetailRequestVersion = useRef(0);
  const effectiveRequestVersion = useRef(0);
  const previewRequestVersion = useRef(0);
  const taskUnsubscribers = useRef(new Set<() => void>());
  const deploymentInFlight = useRef(false);
  const scanInFlight = useRef(false);
  const assetMutationInFlight = useRef(false);
  const projectSelectionInFlight = useRef(false);
  const indexedViewRoots = useRef<IndexedViewRoots>({});
  const indexRefreshGenerations = useRef(new Map<keyof IndexedViewRoots, number>());
  const indexSelectionEpoch = useRef(0);
  const runtimeAttachedTaskIds = useRef(new Set<string>());
  const runtimeStateRetryScheduler = useRef<ReturnType<typeof createSingleRetryScheduler>>(
    createSingleRetryScheduler(),
  );
  const runtimeStateFailureReported = useRef(false);
  const runtimeStateRequestVersion = useRef(0);
  const locale = localeForState(state);
  currentState.current = state;

  function invalidatePreviewRequest(): void {
    previewRequestVersion.current += 1;
    setPreviewPending(false);
  }

  function retirePreview(): void {
    invalidatePreviewRequest();
    dispatch({ type: "previewInvalidated" });
  }

  function invalidateAssetDetailRequests(): void {
    assetDetailRequestVersion.current += 1;
    effectiveRequestVersion.current += 1;
  }

  function claimIndexRefresh(kind: keyof IndexedViewRoots, root: string): () => boolean {
    const generation = retireIndexRefresh(kind);
    return () =>
      isCurrentIndexRefresh(
        indexRefreshGenerations.current,
        kind,
        generation,
        indexedViewRoots.current,
        root,
      );
  }

  function retireIndexRefresh(kind: keyof IndexedViewRoots): number {
    return advanceIndexRefreshGeneration(indexRefreshGenerations.current, kind);
  }

  function changeIndexedSelection(kind: keyof IndexedViewRoots): void {
    indexSelectionEpoch.current += 1;
    retireIndexRefresh(kind);
  }
  indexedViewRoots.current = {
    ...(state.projectRoot === undefined ? {} : { assetReview: state.projectRoot }),
    ...(state.migration.sourceProjectRoot === undefined
      ? {}
      : { migrationSource: state.migration.sourceProjectRoot }),
    ...(state.migration.targetScopeId === undefined
      ? {}
      : { migrationTarget: state.migration.targetScopeId }),
  };

  async function runAction(
    action: string,
    work: () => Promise<void>,
    shouldReportError: () => boolean = () => true,
  ) {
    await runGuardedAction(
      work,
      (error) =>
        dispatch({ type: "message", message: formatLocalizedUiError(locale, error, action) }),
      shouldReportError,
    );
  }

  function clearRuntimeStateRetry(): void {
    runtimeStateRetryScheduler.current.cancel();
  }

  function scheduleRuntimeStateRetry(): void {
    runtimeStateRetryScheduler.current.schedule(() => {
      void reconcileRuntimeState();
    });
  }

  async function reconcileRuntimeState(): Promise<void> {
    const requestVersion = ++runtimeStateRequestVersion.current;
    try {
      const runtimeState = await props.api.runtimeState();
      if (requestVersion !== runtimeStateRequestVersion.current) return;
      clearRuntimeStateRetry();
      runtimeStateFailureReported.current = false;
      dispatch({
        type: "runtimeRecovery",
        deploymentIds: runtimeState.recoveryDeploymentIds,
      });
      const task =
        runtimeState.activeTasks.find(({ taskKind }) => taskKind !== "scan") ??
        runtimeState.activeTasks.at(-1);
      if (task === undefined) {
        scanInFlight.current = false;
        deploymentInFlight.current = false;
        return;
      }
      if (runtimeAttachedTaskIds.current.has(task.taskId)) return;
      runtimeAttachedTaskIds.current.add(task.taskId);
      if (task.taskKind === "scan") {
        const restoredScan = restoredScanSelectionForTask(task);
        if (restoredScan !== undefined) {
          const restoredView = scanScopeView(restoredScan.scanScope);
          changeIndexedSelection(restoredView);
          indexedViewRoots.current = {
            ...indexedViewRoots.current,
            [restoredView]: restoredScan.projectRoot,
          };
          dispatch({ type: "runtimeScanRestored", ...restoredScan });
        }
        scanInFlight.current = true;
        subscribeTask(task.taskId, (event) => {
          const scanAction = scanActionForTaskEvent(event, restoredScan?.scanScope);
          if (scanAction !== undefined) {
            dispatch(
              restoredScan?.scanScope === "asset-review"
                ? { ...scanAction, projectRoot: restoredScan.projectRoot }
                : scanAction,
            );
          }
          const taskAction = taskActionForTaskEvent(event, restoredScan?.scanScope);
          if (taskAction !== undefined) dispatch({ type: "taskEvent", action: taskAction });
          if (isTerminalTaskEvent(event)) {
            scanInFlight.current = false;
            runtimeAttachedTaskIds.current.delete(task.taskId);
            if (restoredScan !== undefined) {
              refreshRestoredScanSelection(restoredScan, {
                assetReview: (root) => void refreshReviewProject(root),
                migrationSource: (root) => void refreshMigrationProjectAssets("source", root),
                migrationTarget: (root) => void refreshMigrationProjectAssets("target", root),
              });
            }
            void reconcileRuntimeState();
          }
        });
      } else {
        deploymentInFlight.current = true;
        subscribeOperationTask(task.taskId, undefined, () => {
          deploymentInFlight.current = false;
          runtimeAttachedTaskIds.current.delete(task.taskId);
          void reconcileRuntimeState();
        });
      }
    } catch (error) {
      if (requestVersion !== runtimeStateRequestVersion.current) return;
      if (!runtimeStateFailureReported.current) {
        runtimeStateFailureReported.current = true;
        dispatch({
          type: "message",
          message: formatLocalizedUiError(
            localeForState(currentState.current),
            error,
            "Restore task state",
          ),
        });
      }
      scheduleRuntimeStateRetry();
    }
  }

  async function selectProject() {
    if (rejectProjectChangeWhileBusy()) return;
    projectSelectionInFlight.current = true;
    try {
      await runAction("Select project", async () => {
        const root = await props.api.selectProjectRoot();
        if (root === undefined) return;
        projectSelectionInFlight.current = false;
        changeIndexedSelection("assetReview");
        invalidateAssetDetailRequests();
        indexedViewRoots.current = { ...indexedViewRoots.current, assetReview: root };
        dispatch({ type: "project", root });
        await scanReviewProject(root);
      });
    } finally {
      projectSelectionInFlight.current = false;
    }
  }

  async function selectMigrationSourceProject() {
    if (rejectProjectChangeWhileBusy()) return;
    projectSelectionInFlight.current = true;
    try {
      await runAction("Select migration source project", async () => {
        const sourceProjectRoot = await props.api.selectProjectRoot();
        if (sourceProjectRoot === undefined) return;
        projectSelectionInFlight.current = false;
        changeIndexedSelection("migrationSource");
        retirePreview();
        indexedViewRoots.current = {
          ...indexedViewRoots.current,
          migrationSource: sourceProjectRoot,
        };
        dispatch({
          type: "migrationSourceProject",
          sourceProjectRoot,
        });
        await scanMigrationSourceProject(sourceProjectRoot);
      });
    } finally {
      projectSelectionInFlight.current = false;
    }
  }

  async function selectMigrationTargetProject() {
    if (rejectProjectChangeWhileBusy()) return;
    projectSelectionInFlight.current = true;
    try {
      await runAction("Select migration target project", async () => {
        const targetScopeId = await props.api.selectProjectRoot();
        if (targetScopeId === undefined) return;
        projectSelectionInFlight.current = false;
        changeIndexedSelection("migrationTarget");
        retirePreview();
        indexedViewRoots.current = {
          ...indexedViewRoots.current,
          migrationTarget: targetScopeId,
        };
        dispatch({
          type: "migrationTargetProject",
          targetScopeId,
        });
        await scanMigrationTargetProject(targetScopeId);
      });
    } finally {
      projectSelectionInFlight.current = false;
    }
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
    dispatch({ type: "settingsSaving", patch });
    try {
      const response = await props.api.invoke(
        "settings.update",
        settingsUpdateRequestForState(state, patch),
      );
      if (response.ok) dispatch({ type: "settingsUpdated", settings: response.data });
      else {
        dispatch({ type: "settingsFailed" });
        dispatch({ type: "message", message: localizeUiMessage(locale, response.error.message) });
        await loadSettings();
      }
    } catch (error) {
      dispatch({ type: "settingsFailed" });
      dispatch({
        type: "message",
        message: formatLocalizedUiError(locale, error, "Update settings"),
      });
      await loadSettings();
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
    void reconcileRuntimeState();
    void props.api.updateStatus().then(setUpdateStatus);
    const unsubscribeUpdates = props.api.subscribeUpdates(setUpdateStatus);
    const unsubscribeIndexChanges = props.api.subscribeIndexChanges((event) => {
      const rootsAtStart = indexedViewRoots.current;
      const selectionEpoch = indexSelectionEpoch.current;
      if (indexChangeAffectsMigration(event, rootsAtStart)) retirePreview();
      void refreshAffectedIndexViews(
        props.api,
        event,
        rootsAtStart,
        (action) => {
          if (action.type === "assets") {
            invalidateAssetDetailRequests();
          }
          dispatch(action);
        },
        () => indexedViewRoots.current,
        claimIndexRefresh,
      ).catch((error: unknown) => {
        if (
          selectionEpoch !== indexSelectionEpoch.current ||
          !indexChangeAffectsVisibleRoot(event, indexedViewRoots.current)
        ) {
          return;
        }
        dispatch({
          type: "message",
          message: formatLocalizedUiError(
            localeForState(currentState.current),
            error,
            "Refresh assets",
          ),
        });
      });
    });
    return () => {
      unsubscribeUpdates();
      unsubscribeIndexChanges();
      clearRuntimeStateRetry();
      for (const unsubscribe of taskUnsubscribers.current) unsubscribe();
      taskUnsubscribers.current.clear();
    };
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

  function beginScan(): boolean {
    if (isTaskInFlight()) {
      rejectScanWhileTaskIsActive();
      return false;
    }
    scanInFlight.current = true;
    return true;
  }

  function isTaskInFlight(): boolean {
    return rendererWorkIsInFlight({
      scanInFlight: scanInFlight.current,
      deploymentInFlight: deploymentInFlight.current,
      assetMutationInFlight: assetMutationInFlight.current,
      activeTask: currentState.current.activeTask,
    });
  }

  function rejectScanWhileTaskIsActive(): boolean {
    if (!isTaskInFlight()) return false;
    dispatch({
      type: "message",
      message: t(locale, "Wait for the active task to finish before starting another scan."),
    });
    return true;
  }

  function rejectProjectChangeWhileBusy(): boolean {
    if (!projectSelectionInFlight.current && !isTaskInFlight()) return false;
    dispatch({
      type: "message",
      message: t(locale, "Wait for the active task to finish before changing projects."),
    });
    return true;
  }

  async function scanReviewProject(root: string) {
    if (!beginScan()) return;
    let awaitingTerminal = false;
    try {
      await runAction(
        "Start scan",
        async () => {
          const projectId = await projectIdForRoot(root);
          const response = await props.api.invoke(
            "scan.start",
            scanStartRequestForContext(root, projectId, "asset-review"),
          );
          if (!isCurrentScanRoot(indexedViewRoots.current, "asset-review", root)) return;
          dispatch({
            type: "scan",
            status: response.ok ? "queued" : "error",
            scanScope: "asset-review",
            projectRoot: root,
            ...(response.ok ? {} : { message: localizeUiMessage(locale, response.error.message) }),
          });
          if (response.ok) {
            awaitingTerminal = true;
            subscribeTask(response.data.taskId, (event) => {
              if (isTerminalTaskEvent(event)) scanInFlight.current = false;
              if (!isCurrentScanRoot(indexedViewRoots.current, "asset-review", root)) return;
              const action = scanActionForTaskEvent(event, "asset-review");
              if (action?.type === "scan") dispatch({ ...action, projectRoot: root });
              const taskAction = taskActionForTaskEvent(event, "asset-review");
              if (taskAction !== undefined) dispatch({ type: "taskEvent", action: taskAction });
              if (isTerminalTaskEvent(event)) {
                const isLatest = claimIndexRefresh("assetReview", root);
                void Promise.all([
                  refreshAssets(props.api, { projectRoot: root }),
                  refreshDiagnostics(props.api, { projectRoot: root }),
                ])
                  .then(([assets, { diagnostics, diagnosticCounts }]) => {
                    if (!isLatest()) return;
                    invalidateAssetDetailRequests();
                    dispatch({ type: "assets", assets, projectRoot: root });
                    dispatch({
                      type: "diagnostics",
                      diagnostics,
                      counts: diagnosticCounts,
                      projectRoot: root,
                    });
                  })
                  .catch((error: unknown) => {
                    if (!isLatest()) return;
                    dispatch({
                      type: "message",
                      message: formatLocalizedUiError(locale, error, "Refresh assets"),
                    });
                  });
              }
            });
          }
          const isLatest = claimIndexRefresh("assetReview", root);
          const [assets, diagnostics] = await Promise.all([
            refreshAssets(props.api, { projectRoot: root }),
            refreshDiagnostics(props.api, { projectRoot: root }),
          ]);
          if (!isLatest()) return;
          invalidateAssetDetailRequests();
          dispatch({
            type: "assets",
            assets,
            projectRoot: root,
          });
          dispatch({
            type: "diagnostics",
            diagnostics: diagnostics.diagnostics,
            counts: diagnostics.diagnosticCounts,
            projectRoot: root,
          });
        },
        () => isCurrentScanRoot(indexedViewRoots.current, "asset-review", root),
      );
    } finally {
      if (!awaitingTerminal) scanInFlight.current = false;
    }
  }

  async function refreshReviewProject(root: string) {
    const isLatest = claimIndexRefresh("assetReview", root);
    await runAction(
      "Refresh assets",
      async () => {
        const [assets, diagnostics] = await Promise.all([
          refreshAssets(props.api, { projectRoot: root }),
          refreshDiagnostics(props.api, { projectRoot: root }),
        ]);
        if (!isLatest()) return;
        invalidateAssetDetailRequests();
        dispatch({ type: "assets", assets, projectRoot: root });
        dispatch({
          type: "diagnostics",
          diagnostics: diagnostics.diagnostics,
          counts: diagnostics.diagnosticCounts,
          projectRoot: root,
        });
      },
      isLatest,
    );
  }

  async function scanMigrationSourceProject(root: string) {
    if (!beginScan()) return;
    let awaitingTerminal = false;
    try {
      await runAction(
        "Start source scan",
        async () => {
          const projectId = await projectIdForRoot(root);
          const response = await props.api.invoke(
            "scan.start",
            scanStartRequestForContext(root, projectId, "migration-source"),
          );
          if (!isCurrentScanRoot(indexedViewRoots.current, "migration-source", root)) return;
          dispatch({
            type: "scan",
            status: response.ok ? "queued" : "error",
            scanScope: "migration-source",
            ...(response.ok ? {} : { message: localizeUiMessage(locale, response.error.message) }),
          });
          if (response.ok) {
            awaitingTerminal = true;
            subscribeTask(response.data.taskId, (event) => {
              if (isTerminalTaskEvent(event)) scanInFlight.current = false;
              if (!isCurrentScanRoot(indexedViewRoots.current, "migration-source", root)) return;
              const action = scanActionForTaskEvent(event, "migration-source");
              if (action !== undefined) dispatch(action);
              const taskAction = taskActionForTaskEvent(event, "migration-source");
              if (taskAction !== undefined) dispatch({ type: "taskEvent", action: taskAction });
              if (isTerminalTaskEvent(event)) {
                void refreshMigrationProjectAssets("source", root);
              }
            });
          }
          await refreshMigrationProjectAssets("source", root);
        },
        () => isCurrentScanRoot(indexedViewRoots.current, "migration-source", root),
      );
    } finally {
      if (!awaitingTerminal) scanInFlight.current = false;
    }
  }

  async function scanMigrationTargetProject(root: string) {
    if (!beginScan()) return;
    let awaitingTerminal = false;
    try {
      await runAction(
        "Start target scan",
        async () => {
          const projectId = await projectIdForRoot(root);
          const response = await props.api.invoke(
            "scan.start",
            scanStartRequestForContext(root, projectId, "migration-target"),
          );
          if (!isCurrentScanRoot(indexedViewRoots.current, "migration-target", root)) return;
          dispatch({
            type: "scan",
            status: response.ok ? "queued" : "error",
            scanScope: "migration-target",
            ...(response.ok ? {} : { message: localizeUiMessage(locale, response.error.message) }),
          });
          if (response.ok) {
            awaitingTerminal = true;
            subscribeTask(response.data.taskId, (event) => {
              if (isTerminalTaskEvent(event)) scanInFlight.current = false;
              if (!isCurrentScanRoot(indexedViewRoots.current, "migration-target", root)) return;
              const action = scanActionForTaskEvent(event, "migration-target");
              if (action !== undefined) dispatch(action);
              const taskAction = taskActionForTaskEvent(event, "migration-target");
              if (taskAction !== undefined) dispatch({ type: "taskEvent", action: taskAction });
              if (isTerminalTaskEvent(event)) {
                void refreshMigrationProjectAssets("target", root);
              }
            });
          }
          await refreshMigrationProjectAssets("target", root);
        },
        () => isCurrentScanRoot(indexedViewRoots.current, "migration-target", root),
      );
    } finally {
      if (!awaitingTerminal) scanInFlight.current = false;
    }
  }

  async function refreshMigrationProjectAssets(kind: "source" | "target", root: string) {
    const viewKind = kind === "source" ? "migrationSource" : "migrationTarget";
    const isLatest = claimIndexRefresh(viewKind, root);
    const assets = await refreshAssets(props.api, { projectRoot: root });
    if (!isLatest()) return;
    invalidatePreviewRequest();
    dispatch(
      kind === "source"
        ? { type: "migrationSourceAssets", sourceProjectRoot: root, assets }
        : { type: "migrationTargetAssets", targetScopeId: root, assets },
    );
  }

  async function cancelScan(taskId: string) {
    const isCurrentTask = () => {
      const activeTask = currentState.current.activeTask;
      return (
        activeTask?.taskId === taskId &&
        activeTask.status === "running" &&
        activeTask.phase !== "completed"
      );
    };
    await runAction(
      "Cancel scan",
      async () => {
        const response = await props.api.invoke("scan.cancel", { taskId });
        if (!response.ok && isCurrentTask()) {
          dispatch({ type: "message", message: localizeUiMessage(locale, response.error.message) });
        }
      },
      isCurrentTask,
    );
  }

  async function openSource() {
    const assetId = state.assetDetail?.asset.id;
    const projectRoot = state.projectRoot;
    const requestVersion = assetDetailRequestVersion.current;
    const isCurrentRequest = () =>
      requestVersion === assetDetailRequestVersion.current &&
      assetId !== undefined &&
      projectRoot !== undefined &&
      sameIndexRoot(indexedViewRoots.current.assetReview, projectRoot) &&
      currentState.current.assetDetail?.asset.id === assetId;
    await runAction(
      "Open source",
      async () => {
        const request = openSourceRequestForState(state);
        if (request === undefined) {
          dispatch({
            type: "message",
            message: t(locale, "Inspect an asset before opening its source file."),
          });
          return;
        }
        const response = await props.api.invoke("assets.openSource", request);
        if (!isCurrentRequest()) return;
        dispatch({
          type: "message",
          message: response.ok
            ? t(locale, "Source file opened.")
            : localizeUiMessage(locale, response.error.message),
        });
      },
      isCurrentRequest,
    );
  }

  async function toggleAssetStatus(
    assetId: CommandResponse<"assets.list">["items"][number]["id"],
    nextStatus: CommandResponse<"assets.list">["items"][number]["status"],
    disablementMethod?: AssetDisablementMethod,
  ) {
    if (isTaskInFlight()) {
      dispatch({
        type: "message",
        message: t(locale, "Wait for the active task to finish before changing assets."),
      });
      return;
    }
    assetMutationInFlight.current = true;
    const projectRoot = state.projectRoot;
    const requestVersion = ++assetDetailRequestVersion.current;
    effectiveRequestVersion.current += 1;
    retirePreview();
    const isCurrentProject = () =>
      projectRoot !== undefined && sameIndexRoot(indexedViewRoots.current.assetReview, projectRoot);
    try {
      await runAction(
        nextStatus === "disabled" ? "Disable asset" : "Enable asset",
        async () => {
          const request = assetStatusChangeRequestFor(assetId, nextStatus, disablementMethod);
          const response =
            request.command === "assets.disable"
              ? await props.api.invoke(request.command, request.request)
              : await props.api.invoke(request.command, request.request);
          if (!response.ok) {
            if (isCurrentProject()) {
              dispatch({
                type: "message",
                message: localizeUiMessage(locale, response.error.message),
              });
            }
            return;
          }

          const statusAction = {
            type: "assetStatus",
            assetId: response.data.assetId,
            status: response.data.status,
          } as const;
          dispatch(statusAction);
          const detail = await refreshAssetDetail(props.api, assetId);
          if (
            requestVersion !== assetDetailRequestVersion.current ||
            projectRoot === undefined ||
            !sameIndexRoot(indexedViewRoots.current.assetReview, projectRoot)
          ) {
            return;
          }
          if (detail !== undefined) dispatch({ type: "assetDetail", detail });
          dispatch(statusAction);
          dispatch({
            type: "message",
            message: t(locale, nextStatus === "disabled" ? "Asset disabled." : "Asset enabled."),
          });
          const diagnostics = await refreshDiagnostics(props.api, {
            assetId,
            projectRoot,
          });
          if (
            requestVersion !== assetDetailRequestVersion.current ||
            !sameIndexRoot(indexedViewRoots.current.assetReview, projectRoot)
          ) {
            return;
          }
          dispatch({
            type: "diagnostics",
            diagnostics: diagnostics.diagnostics,
            counts: diagnostics.diagnosticCounts,
            projectRoot,
          });
        },
        isCurrentProject,
      );
    } finally {
      assetMutationInFlight.current = false;
    }
  }

  async function preview() {
    if (isTaskInFlight()) {
      dispatch({
        type: "message",
        message: t(
          locale,
          "Wait for the active task to finish before creating a migration preview.",
        ),
      });
      return;
    }
    const requestVersion = ++previewRequestVersion.current;
    setPreviewPending(true);
    try {
      await runAction(
        "Preview migration",
        async () => {
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
          const currentRequest = previewRequestForState(currentState.current);
          if (
            requestVersion !== previewRequestVersion.current ||
            currentRequest === undefined ||
            migrationPreviewRequestFingerprint(currentRequest) !==
              migrationPreviewRequestFingerprint(request)
          ) {
            return;
          }
          if (response.ok) dispatch({ type: "preview", preview: response.data });
          else
            dispatch({
              type: "message",
              message: localizeUiMessage(locale, response.error.message),
            });
        },
        () => requestVersion === previewRequestVersion.current,
      );
    } finally {
      if (requestVersion === previewRequestVersion.current) setPreviewPending(false);
    }
  }

  async function deploy() {
    if (isTaskInFlight()) {
      dispatch({
        type: "message",
        message: t(locale, "Wait for the active task to finish before migrating."),
      });
      return;
    }
    const blockers = deploymentBlockersForState(state);
    if (blockers.length > 0) {
      dispatch({ type: "message", message: t(locale, blockers[0] ?? "") });
      return;
    }
    const previewPlan = state.preview;
    if (previewPlan === undefined) return;
    deploymentInFlight.current = true;
    let awaitingTerminal = false;
    try {
      await runAction("Execute migration", async () => {
        const response = await props.api.invoke("deployment.execute", {
          planId: previewPlan.planId,
          confirmedPlanHash: previewPlan.planHash,
          confirmations: deploymentConfirmationsForState(state),
        });
        const taskId = response.ok ? response.data.taskId : response.error.taskId;
        if (taskId !== undefined) {
          const targetRoot = state.migration.targetScopeId;
          awaitingTerminal = true;
          try {
            subscribeOperationTask(taskId, undefined, () => {
              deploymentInFlight.current = false;
              void reconcileRuntimeState();
              if (targetRoot !== undefined) {
                void refreshMigrationProjectAssets("target", targetRoot);
              }
            });
          } catch (error) {
            awaitingTerminal = false;
            throw error;
          }
        }
        dispatch({
          type: "message",
          message: response.ok ? undefined : localizeUiMessage(locale, response.error.message),
        });
      });
    } finally {
      if (!awaitingTerminal) deploymentInFlight.current = false;
    }
  }

  async function resolveRecoveryLock() {
    if (isTaskInFlight()) return;
    const deploymentId = state.recoveryLock?.deploymentId;
    if (deploymentId === undefined) {
      dispatch({
        type: "message",
        message: t(locale, "Recovery details are unavailable; restart AI Config Hub and retry."),
      });
      return;
    }
    deploymentInFlight.current = true;
    let awaitingTerminal = false;
    try {
      await runAction("Roll back deployment", async () => {
        const response = await props.api.invoke("deployment.rollback", { deploymentId });
        const taskId = response.ok ? response.data.taskId : response.error.taskId;
        if (taskId !== undefined) {
          const targetRoot = state.migration.targetScopeId;
          awaitingTerminal = true;
          try {
            subscribeOperationTask(taskId, undefined, () => {
              deploymentInFlight.current = false;
              void reconcileRuntimeState();
              if (targetRoot !== undefined) {
                void refreshMigrationProjectAssets("target", targetRoot);
              }
            });
          } catch (error) {
            awaitingTerminal = false;
            throw error;
          }
        }
        if (!response.ok) {
          dispatch({
            type: "message",
            message: localizeUiMessage(locale, response.error.message),
          });
        }
      });
    } finally {
      if (!awaitingTerminal) deploymentInFlight.current = false;
    }
  }

  function subscribeTask(taskId: string, onEvent: (event: TaskEvent) => void): void {
    let stopped = false;
    let unsubscribeTransport = () => {
      stopped = true;
    };
    let reportedSubscriptionError = false;
    function stop() {
      if (stopped) return;
      stopped = true;
      taskUnsubscribers.current.delete(stop);
      unsubscribeTransport();
    }
    taskUnsubscribers.current.add(stop);
    unsubscribeTransport = subscribeTaskWithRetry({
      api: props.api,
      taskId,
      listener: (event) => {
        if (stopped) return;
        onEvent(event);
        if (isTerminalTaskEvent(event)) stop();
      },
      onError: (error) => {
        if (reportedSubscriptionError) return;
        reportedSubscriptionError = true;
        dispatch({
          type: "message",
          message: formatLocalizedUiError(
            localeForState(currentState.current),
            error,
            "Subscribe to task updates",
          ),
        });
      },
    });
    if (stopped) unsubscribeTransport();
  }

  function subscribeOperationTask(
    taskId: string,
    scanScope?: ScanTaskScope,
    onCompleted?: () => void,
  ): void {
    subscribeTask(taskId, (event) => {
      const action = taskActionForTaskEvent(event, scanScope);
      if (action !== undefined) dispatch({ type: "taskEvent", action });
      const failureMessage = operationTaskFailureMessage(event);
      if (failureMessage !== undefined) {
        dispatch({
          type: "message",
          message: localizeUiMessage(localeForState(currentState.current), failureMessage),
        });
      }
      if (isTerminalTaskEvent(event)) onCompleted?.();
    });
  }

  return (
    <AppShell
      state={state}
      onRoute={(route) => dispatch({ type: "route", route })}
      onDismissMessage={() => dispatch({ type: "message", message: undefined })}
    >
      {state.route === "assets" ? (
        <AssetsView
          state={state}
          onSelectProject={() => void selectProject()}
          onRefresh={() => {
            if (state.projectRoot !== undefined) void refreshReviewProject(state.projectRoot);
          }}
          onRescanAfterEdit={() => {
            if (state.projectRoot !== undefined) void scanReviewProject(state.projectRoot);
          }}
          onInspect={(assetId) => {
            const projectRoot = state.projectRoot;
            const requestVersion = ++assetDetailRequestVersion.current;
            effectiveRequestVersion.current += 1;
            const isCurrentRequest = () =>
              requestVersion === assetDetailRequestVersion.current &&
              projectRoot !== undefined &&
              sameIndexRoot(indexedViewRoots.current.assetReview, projectRoot);
            void runAction(
              "Inspect asset",
              async () => {
                const detail = await refreshAssetDetail(props.api, assetId);
                if (!isCurrentRequest() || projectRoot === undefined) return;
                if (detail === undefined) {
                  dispatch({ type: "message", message: t(locale, "Asset detail is unavailable.") });
                  return;
                }
                dispatch({ type: "assetDetail", detail });
                const diagnostics = await refreshDiagnostics(props.api, {
                  assetId,
                  projectRoot,
                });
                if (!isCurrentRequest()) return;
                dispatch({
                  type: "diagnostics",
                  diagnostics: diagnostics.diagnostics,
                  counts: diagnostics.diagnosticCounts,
                  projectRoot,
                });
              },
              isCurrentRequest,
            );
          }}
          onLoadEffective={() => {
            const assetId = state.assetDetail?.asset.id;
            const projectRoot = state.projectRoot;
            const requestVersion = ++effectiveRequestVersion.current;
            const isCurrentRequest = () => {
              const activeDetail = currentState.current.assetDetail;
              return (
                requestVersion === effectiveRequestVersion.current &&
                assetId !== undefined &&
                projectRoot !== undefined &&
                sameIndexRoot(indexedViewRoots.current.assetReview, projectRoot) &&
                activeDetail?.asset.id === assetId &&
                activeDetail.asset.status !== "disabled"
              );
            };
            void runAction(
              "Resolve effective configuration",
              async () => {
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
                if (!isCurrentRequest()) return;
                if (response.ok) dispatch({ type: "effective", effective: response.data });
                else {
                  dispatch({
                    type: "message",
                    message: localizeUiMessage(locale, response.error.message),
                  });
                }
              },
              isCurrentRequest,
            );
          }}
          onOpenSource={() => void openSource()}
          onToggleAssetStatus={(assetId, nextStatus, disablementMethod) => {
            void toggleAssetStatus(assetId, nextStatus, disablementMethod);
          }}
          onCloseInspect={() => {
            const requestVersion = ++assetDetailRequestVersion.current;
            effectiveRequestVersion.current += 1;
            dispatch({ type: "assetDetailClosed" });
            const projectRoot = state.projectRoot;
            const isCurrentRequest = () =>
              requestVersion === assetDetailRequestVersion.current &&
              projectRoot !== undefined &&
              sameIndexRoot(indexedViewRoots.current.assetReview, projectRoot);
            void runAction(
              "Refresh diagnostics",
              async () => {
                const diagnostics = await refreshDiagnostics(props.api, {
                  ...(projectRoot === undefined ? {} : { projectRoot }),
                });
                if (!isCurrentRequest() || projectRoot === undefined) return;
                dispatch({
                  type: "diagnostics",
                  diagnostics: diagnostics.diagnostics,
                  counts: diagnostics.diagnosticCounts,
                  projectRoot,
                });
              },
              isCurrentRequest,
            );
          }}
          onDismissMessage={() => dispatch({ type: "message", message: undefined })}
          onCancelScan={(taskId) => void cancelScan(taskId)}
          onLocateDiagnostic={(assetId) => {
            const projectRoot = state.projectRoot;
            const requestVersion = ++assetDetailRequestVersion.current;
            effectiveRequestVersion.current += 1;
            const isCurrentRequest = () =>
              requestVersion === assetDetailRequestVersion.current &&
              projectRoot !== undefined &&
              sameIndexRoot(indexedViewRoots.current.assetReview, projectRoot);
            void runAction(
              "Locate diagnostic",
              async () => {
                const detail = await refreshAssetDetail(props.api, assetId);
                if (!isCurrentRequest() || projectRoot === undefined) return;
                if (detail === undefined) {
                  dispatch({
                    type: "message",
                    message: t(locale, "Diagnostic asset is unavailable."),
                  });
                  return;
                }
                dispatch({ type: "assetDetail", detail });
                const diagnostics = await refreshDiagnostics(props.api, {
                  assetId,
                  projectRoot,
                });
                if (!isCurrentRequest()) return;
                dispatch({
                  type: "diagnostics",
                  diagnostics: diagnostics.diagnostics,
                  counts: diagnostics.diagnosticCounts,
                  projectRoot,
                });
              },
              isCurrentRequest,
            );
          }}
        />
      ) : null}
      {state.route === "migration" ? (
        <MigrationView
          state={state}
          previewPending={previewPending}
          onPreview={() => void preview()}
          onToggleSource={(assetId, selected) => {
            invalidatePreviewRequest();
            dispatch({ type: "migrationSource", assetId, selected });
          }}
          onSelectSourceProject={() => void selectMigrationSourceProject()}
          onSelectTargetProject={() => void selectMigrationTargetProject()}
          onSwapProjects={() => {
            if (rejectProjectChangeWhileBusy()) return;
            const {
              migrationSource: previousSource,
              migrationTarget: previousTarget,
              ...otherRoots
            } = indexedViewRoots.current;
            changeIndexedSelection("migrationSource");
            changeIndexedSelection("migrationTarget");
            indexedViewRoots.current = {
              ...otherRoots,
              ...(previousTarget === undefined ? {} : { migrationSource: previousTarget }),
              ...(previousSource === undefined ? {} : { migrationTarget: previousSource }),
            };
            retirePreview();
            dispatch({ type: "migrationSwapProjects" });
          }}
          onTargetTool={(targetToolKey) => {
            invalidatePreviewRequest();
            dispatch({ type: "migrationTarget", targetToolKey });
          }}
          onConflictPolicy={(conflictPolicy) => {
            invalidatePreviewRequest();
            dispatch({ type: "migrationConflictPolicy", conflictPolicy });
          }}
          onConfirmMigration={(confirmed) =>
            dispatch({ type: "deploymentConfirmation", confirmed })
          }
          onConfirmRequirement={(confirmation, granted) =>
            dispatch({ type: "deploymentConfirmationGrant", confirmation, granted })
          }
          onExecuteMigration={() => void deploy()}
          onResolveRecovery={() => void resolveRecoveryLock()}
          onCancelScan={(taskId) => void cancelScan(taskId)}
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

export interface IndexedViewRoots {
  readonly assetReview?: string;
  readonly migrationSource?: string;
  readonly migrationTarget?: string;
}

export function rendererWorkIsInFlight(input: {
  readonly scanInFlight: boolean;
  readonly deploymentInFlight: boolean;
  readonly assetMutationInFlight: boolean;
  readonly activeTask: AppState["activeTask"];
}): boolean {
  return (
    input.scanInFlight ||
    input.deploymentInFlight ||
    input.assetMutationInFlight ||
    (input.activeTask?.status === "running" && input.activeTask.phase !== "completed")
  );
}

export function advanceIndexRefreshGeneration(
  generations: Map<keyof IndexedViewRoots, number>,
  kind: keyof IndexedViewRoots,
): number {
  const generation = (generations.get(kind) ?? 0) + 1;
  generations.set(kind, generation);
  return generation;
}

export function isCurrentIndexRefresh(
  generations: ReadonlyMap<keyof IndexedViewRoots, number>,
  kind: keyof IndexedViewRoots,
  generation: number,
  roots: IndexedViewRoots,
  root: string,
): boolean {
  return generations.get(kind) === generation && sameIndexRoot(roots[kind], root);
}

export function isCurrentScanRoot(
  roots: IndexedViewRoots,
  scanScope: ScanTaskScope,
  root: string,
): boolean {
  const currentRoot =
    scanScope === "asset-review"
      ? roots.assetReview
      : scanScope === "migration-source"
        ? roots.migrationSource
        : roots.migrationTarget;
  return sameIndexRoot(currentRoot, root);
}

function scanScopeView(scanScope: ScanTaskScope): keyof IndexedViewRoots {
  if (scanScope === "asset-review") return "assetReview";
  return scanScope === "migration-source" ? "migrationSource" : "migrationTarget";
}

export function indexChangeAffectsMigration(
  event: DesktopIndexChangeEvent,
  roots: IndexedViewRoots,
): boolean {
  const affectedRoots = new Set(event.roots.map(normalizeIndexRoot));
  return [roots.migrationSource, roots.migrationTarget].some(
    (root) => root !== undefined && affectedRoots.has(normalizeIndexRoot(root)),
  );
}

export function indexChangeAffectsVisibleRoot(
  event: DesktopIndexChangeEvent,
  roots: IndexedViewRoots,
): boolean {
  const affectedRoots = new Set(event.roots.map(normalizeIndexRoot));
  return [roots.assetReview, roots.migrationSource, roots.migrationTarget].some(
    (root) => root !== undefined && affectedRoots.has(normalizeIndexRoot(root)),
  );
}

export async function refreshAffectedIndexViews(
  api: DesktopApi,
  event: DesktopIndexChangeEvent,
  roots: IndexedViewRoots,
  dispatch: (action: AppAction) => void,
  currentRoots: () => IndexedViewRoots = () => roots,
  claimRefresh: (kind: keyof IndexedViewRoots, root: string) => () => boolean = () => () => true,
): Promise<void> {
  const affectedRoots = new Set(event.roots.map(normalizeIndexRoot));
  const assetsByRoot = new Map<string, ReturnType<typeof refreshAssets>>();
  const assetsForRoot = (root: string) => {
    const key = normalizeIndexRoot(root);
    const pending = assetsByRoot.get(key) ?? refreshAssets(api, { projectRoot: root });
    assetsByRoot.set(key, pending);
    return pending;
  };
  const isAffected = (root: string | undefined): root is string =>
    root !== undefined && affectedRoots.has(normalizeIndexRoot(root));
  const isStillCurrent = (kind: keyof IndexedViewRoots, root: string): boolean =>
    sameIndexRoot(currentRoots()[kind], root);
  const refreshes: Promise<void>[] = [];

  if (isAffected(roots.assetReview)) {
    const root = roots.assetReview;
    const isLatest = claimRefresh("assetReview", root);
    refreshes.push(
      Promise.all([assetsForRoot(root), refreshDiagnostics(api, { projectRoot: root })]).then(
        ([assets, diagnostics]) => {
          if (!isStillCurrent("assetReview", root) || !isLatest()) return;
          dispatch({ type: "assets", assets, projectRoot: root });
          dispatch({
            type: "diagnostics",
            diagnostics: diagnostics.diagnostics,
            counts: diagnostics.diagnosticCounts,
            projectRoot: root,
          });
        },
      ),
    );
  }

  if (isAffected(roots.migrationSource)) {
    const root = roots.migrationSource;
    const isLatest = claimRefresh("migrationSource", root);
    refreshes.push(
      assetsForRoot(root).then((assets) => {
        if (!isStillCurrent("migrationSource", root) || !isLatest()) return;
        dispatch({ type: "migrationSourceAssets", sourceProjectRoot: root, assets });
      }),
    );
  }

  if (isAffected(roots.migrationTarget)) {
    const root = roots.migrationTarget;
    const isLatest = claimRefresh("migrationTarget", root);
    refreshes.push(
      assetsForRoot(root).then((assets) => {
        if (!isStillCurrent("migrationTarget", root) || !isLatest()) return;
        dispatch({ type: "migrationTargetAssets", targetScopeId: root, assets });
      }),
    );
  }

  await Promise.all(refreshes);
}

function sameIndexRoot(left: string | undefined, right: string): boolean {
  return left !== undefined && normalizeIndexRoot(left) === normalizeIndexRoot(right);
}

function normalizeIndexRoot(root: string): string {
  let normalized = root.replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalized.length === 0) normalized = "/";
  if (/^[A-Za-z]:$/.test(normalized)) normalized += "/";
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

export function migrationPreviewRequestFingerprint(
  request: CommandRequest<"migration.preview">,
): string {
  return JSON.stringify({
    sourceAssetIds: [...request.sourceAssetIds],
    targetToolKey: request.targetToolKey,
    targetScopeId: normalizeIndexRoot(request.targetScopeId),
    conflictPolicy: request.conflictPolicy,
  });
}

export async function runGuardedAction(
  work: () => Promise<void>,
  reportError: (error: unknown) => void,
  shouldReportError: () => boolean = () => true,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (shouldReportError()) reportError(error);
  }
}

export function operationTaskFailureMessage(event: TaskEvent): string | undefined {
  return event.type === "item.failed"
    ? (event.payload.message ?? event.payload.errorCode)
    : undefined;
}

export function createSingleRetryScheduler(delayMs = 1_000): {
  readonly schedule: (retry: () => void) => void;
  readonly cancel: () => void;
} {
  let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  return {
    schedule(retry) {
      if (retryTimer !== undefined) return;
      retryTimer = globalThis.setTimeout(() => {
        retryTimer = undefined;
        retry();
      }, delayMs);
    },
    cancel() {
      if (retryTimer === undefined) return;
      globalThis.clearTimeout(retryTimer);
      retryTimer = undefined;
    },
  };
}

export function subscribeTaskWithRetry(input: {
  readonly api: Pick<DesktopApi, "subscribeTask">;
  readonly taskId: string;
  readonly listener: (event: TaskEvent) => void;
  readonly onError?: (error: unknown) => void;
  readonly retryDelayMs?: number;
}): () => void {
  let active = true;
  let subscription: TaskSubscription | undefined;
  let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  const scheduleRetry = () => {
    if (!active || retryTimer !== undefined) return;
    retryTimer = globalThis.setTimeout(() => {
      retryTimer = undefined;
      attempt();
    }, input.retryDelayMs ?? 1_000);
  };
  const handleFailure = (error: unknown) => {
    if (!active) return;
    input.onError?.(error);
    scheduleRetry();
  };
  const attempt = () => {
    if (!active) return;
    let candidate: TaskSubscription;
    try {
      candidate = input.api.subscribeTask(input.taskId, 0, input.listener);
    } catch (error) {
      handleFailure(error);
      return;
    }
    subscription = candidate;
    void candidate.ready.catch((error: unknown) => {
      if (!active || subscription !== candidate) return;
      candidate.unsubscribe();
      subscription = undefined;
      handleFailure(error);
    });
  };

  attempt();
  return () => {
    if (!active) return;
    active = false;
    if (retryTimer !== undefined) globalThis.clearTimeout(retryTimer);
    retryTimer = undefined;
    subscription?.unsubscribe();
    subscription = undefined;
  };
}

function isTerminalTaskEvent(event: TaskEvent): boolean {
  return (
    event.type === "completed" || (event.type === "snapshot" && event.payload.status !== "running")
  );
}

function localDataClearedMessage(
  locale: ReturnType<typeof localeForState>,
  result: CommandResponse<"settings.clearLocalData">,
): string {
  const count = Object.values(result.counts).reduce((total, item) => total + item, 0);
  return t(locale, "Cleared selected local data ({count} records).", { count });
}
