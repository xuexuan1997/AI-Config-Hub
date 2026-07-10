import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, realpath as fsRealpath, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  createDefaultAdapterRegistry,
  enumerateSkillPackageSourceFiles,
  type AdapterRegistry,
} from "@ai-config-hub/adapters";
import {
  CHANGE_DETAIL_LIMIT,
  GROUP_TARGET_PATH_SAMPLE_LIMIT,
  DeploymentRecordSchema,
  DeploymentStatusSchema,
  EffectiveConfigSchema,
  ScanRunSummarySchema,
  operationGroupsForPlan,
} from "@ai-config-hub/core";
import type {
  AdapterLogger,
  AdapterEffectiveConfigDraft,
  AdapterReadApi,
  AdapterRegistration,
  Asset,
  ConversionResult,
  DeploymentFilePort,
  DeploymentOperation,
  DeploymentOperationGroup,
  DeploymentOperationType,
  DeploymentPlan,
  DeploymentRecord,
  Diagnostic,
  GitCommitSummary,
  Page,
  PublicSettings,
  Scope,
  ToolInstallation,
} from "@ai-config-hub/core";
import {
  AssetDisablementService,
  DeploymentExecutionService,
  DeploymentPreviewService,
  DeploymentRollbackService,
  NodeDeploymentFilePort,
  PathLockManager,
} from "@ai-config-hub/deployer";
import {
  createCancellationController,
  createNodeFileAccess,
  NodeFileWatcher,
  ScanService,
  stableId,
  WatchService,
  type NodeFileWatcherOptions,
  type ScanItemFailure,
  type WatchBatch,
} from "@ai-config-hub/scanner";
import {
  AbsolutePathSchema,
  AppError,
  AssetIdSchema,
  ContentHashSchema,
  CorrelationIdSchema,
  DeploymentPlanIdSchema,
  DeploymentRecordIdSchema,
  DiagnosticIdSchema,
  DiagnosticSeveritySchema,
  IsoDateTimeSchema,
  PaginationCursorSchema,
  ProjectIdSchema,
  ResourceKindSchema,
  ScanRunIdSchema,
  SemVerSchema,
  ScopeKindSchema,
  TaskIdSchema,
  ToolIdSchema,
  ToolInstallationIdSchema,
  type AbsolutePath,
  type ContentHash,
  type DeploymentRecordId,
  type ProjectId,
  type ScopeKind,
  type TaskId,
} from "@ai-config-hub/shared";
import {
  createDiagnosticReport,
  type ApiCommandName,
  type CommandRequest,
  type CommandServiceMap,
  type DiagnosticReportPathRoot,
} from "@ai-config-hub/api";
import { TaskEventSchema, type TaskEvent, type TaskPhase } from "@ai-config-hub/api";
import { LocalHistoryService, SystemLocalGitPort } from "@ai-config-hub/git";
import { createStorageRepositories, openDatabase } from "@ai-config-hub/storage";

const NOOP_ADAPTER_LOGGER = { debug() {}, warn() {} } satisfies AdapterLogger;
const INDEX_SNAPSHOT_READ_ATTEMPTS = 3;
const INTERNAL_PAGE_SIZE = 10_000;
const DIAGNOSTIC_EXPORT_ITEM_LIMIT = 10_000;
const DIAGNOSTIC_REPORT_MAX_BYTES = 1_000_000;
const EFFECTIVE_RESPONSE_ARRAY_LIMIT = 10_000;
const SOURCE_FILE_ROLE_ORDER = new Map([
  ["primary", 0],
  ["metadata", 1],
  ["support", 2],
] as const);

type DesktopFileWatcher = Pick<NodeFileWatcher, "start" | "close">;
type DesktopFileWatcherFactory = (options: NodeFileWatcherOptions) => DesktopFileWatcher;
type DesktopDeploymentFileFactory = (options: {
  readonly allowedRoots: readonly AbsolutePath[];
  readonly backupRoot: AbsolutePath;
}) => DeploymentFilePort;

export interface DesktopCommandServiceOptions {
  readonly userDataPath: string;
  readonly appVersion: string;
  readonly cwd?: string;
  readonly homeDirectory?: string;
  readonly now?: () => string;
  readonly sourceFileOpener?: SourceFileOpener;
  readonly watchService?: WatchService;
  readonly fileWatcherFactory?: DesktopFileWatcherFactory;
  readonly deploymentFileFactory?: DesktopDeploymentFileFactory;
}

export interface SourceFileOpener {
  openPath(path: AbsolutePath): Promise<void>;
}

export interface DesktopCommandServiceRuntime {
  readonly services: CommandServiceMap;
  readonly taskEvents: DesktopTaskEventPort;
  readonly indexChanges: DesktopIndexChangePort;
  runtimeState(): DesktopRuntimeState;
  close(): void;
}

export interface DesktopRuntimeState {
  readonly activeTasks: readonly {
    readonly taskId: string;
    readonly taskKind: "scan" | "deployment" | "rollback";
    readonly clientContext?: DesktopScanClientContext;
    readonly selectedRoots?: readonly string[];
    readonly canonicalRoots?: readonly string[];
  }[];
  readonly recoveryDeploymentIds: readonly string[];
}

type DesktopScanClientContext = NonNullable<CommandRequest<"scan.start">["clientContext"]>;

export interface DesktopTaskEventPort {
  subscribe(
    taskId: string,
    afterSequence: number,
    listener: (event: TaskEvent) => void,
  ): () => void;
}

export interface DesktopIndexChangeEvent {
  readonly roots: readonly string[];
}

export interface DesktopIndexChangePort {
  subscribe(listener: (event: DesktopIndexChangeEvent) => void): () => void;
}

interface DesktopRuntime {
  readonly repositories: ReturnType<typeof createStorageRepositories>;
  readonly databaseRecovery: boolean;
  readonly appDataRoot: AbsolutePath;
  readonly backupRoot: AbsolutePath;
  readonly disabledAssetsRoot: AbsolutePath;
  readonly historyRoot: AbsolutePath;
  readonly history: LocalHistoryService;
  readonly pathLocks: PathLockManager;
  readonly now: () => string;
  readonly sourceFileOpener?: SourceFileOpener;
  readonly watchService: WatchService;
  readonly fileWatcherFactory: DesktopFileWatcherFactory;
  readonly deploymentFileFactory: DesktopDeploymentFileFactory;
  readonly fileWatchers: Map<
    string,
    {
      readonly root: AbsolutePath;
      readonly scanRoots: Set<AbsolutePath>;
      readonly watcher: DesktopFileWatcher;
    }
  >;
  close(): void;
}

type SnapshotMetadata =
  | {
      readonly status: "recorded";
      readonly commitId: string;
      readonly authoredAt: string;
      readonly message: string;
    }
  | { readonly status: "missing" }
  | {
      readonly status: "failed" | "unavailable";
      readonly error: { readonly code: string; readonly message: string };
    };

export async function createDesktopCommandServices(
  options: DesktopCommandServiceOptions,
): Promise<DesktopCommandServiceRuntime> {
  const runtime = await createRuntime(options);
  const taskEvents = new DesktopTaskEvents();
  const taskRuntime = new DesktopTaskRuntimeRegistry(loadPersistedRecoveryLocks(runtime));
  taskEvents.onTerminal((taskId) => taskRuntime.markTerminal(taskId));
  const indexChanges = new DesktopIndexChanges();
  return {
    services: createServices(runtime, options, taskEvents, taskRuntime, indexChanges),
    taskEvents,
    indexChanges,
    runtimeState: () => taskRuntime.runtimeState(),
    close: () => runtime.close(),
  };
}

async function createRuntime(options: DesktopCommandServiceOptions): Promise<DesktopRuntime> {
  await ensurePrivateDirectory(options.userDataPath);
  const backupRoot = await ensurePrivateDirectory(
    join(options.userDataPath, "backups", "deployments"),
  );
  const disabledAssetsRoot = await ensurePrivateDirectory(
    join(options.userDataPath, "disabled-assets"),
  );
  const historyRoot = await ensurePrivateDirectory(
    join(options.userDataPath, "history", "local-git"),
  );
  const opened = await openDatabase({
    path: join(options.userDataPath, "ai-config-hub.sqlite"),
    appVersion: options.appVersion,
  });
  const repositories = createStorageRepositories(opened);
  const runtime: DesktopRuntime = {
    repositories,
    databaseRecovery: opened.mode === "read_only_recovery",
    appDataRoot: AbsolutePathSchema.parse(options.userDataPath),
    backupRoot,
    disabledAssetsRoot,
    historyRoot,
    history: new LocalHistoryService({
      git: new SystemLocalGitPort(),
      now: () => IsoDateTimeSchema.parse(options.now?.() ?? new Date().toISOString()),
    }),
    pathLocks: new PathLockManager(),
    now: options.now ?? (() => new Date().toISOString()),
    ...(options.sourceFileOpener === undefined
      ? {}
      : { sourceFileOpener: options.sourceFileOpener }),
    watchService: options.watchService ?? new WatchService(),
    fileWatcherFactory:
      options.fileWatcherFactory ?? ((watcherOptions) => new NodeFileWatcher(watcherOptions)),
    deploymentFileFactory:
      options.deploymentFileFactory ?? ((fileOptions) => new NodeDeploymentFilePort(fileOptions)),
    fileWatchers: new Map(),
    close() {
      closeFileWatchers(runtime);
      repositories.database.close();
    },
  };
  return runtime;
}

async function ensurePrivateDirectory(path: string): Promise<AbsolutePath> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (platform() !== "win32") await chmod(path, 0o700);
  return AbsolutePathSchema.parse(path);
}

function createServices(
  runtime: DesktopRuntime,
  options: DesktopCommandServiceOptions,
  taskEvents: DesktopTaskEvents,
  taskRuntime: DesktopTaskRuntimeRegistry,
  indexChanges: DesktopIndexChanges,
): CommandServiceMap {
  const cwd = AbsolutePathSchema.parse(resolve(options.cwd ?? process.cwd()));
  const homeDirectory = AbsolutePathSchema.parse(resolve(options.homeDirectory ?? homedir()));
  const registry = createDefaultAdapterRegistry();
  const assetDisablement = new AssetDisablementService({
    indexRepository: runtime.repositories.index,
    disabledAssetsRoot: runtime.disabledAssetsRoot,
    now: () => IsoDateTimeSchema.parse(now(runtime)),
  });

  const services: Record<ApiCommandName, (payload: unknown) => Promise<unknown>> = {
    "scan.start": async (payload) => {
      const request = payload as DesktopScanRequest;
      const allowedRoots = scanRoots(request.roots, cwd, homeDirectory);
      const canonicalRoots = await canonicalScanRoots(allowedRoots);
      const changedPaths = changedScanPaths(request.changedPaths, cwd);
      const taskId = TaskIdSchema.parse(`task:scan:${randomUUID()}`);
      const scanRunId = ScanRunIdSchema.parse(`scan:${randomUUID()}`);
      const acceptedAt = now(runtime);
      const cancellation = createCancellationController();
      taskRuntime.assertCanStart();
      const taskCreation = runtime.repositories.tasks.create({
        taskId,
        scanRunId,
        status: "queued",
      });
      taskRuntime.start({
        taskId,
        taskKind: "scan",
        cancellation,
        scanMetadata: {
          selectedRoots: allowedRoots,
          canonicalRoots,
          ...(request.clientContext === undefined ? {} : { clientContext: request.clientContext }),
        },
        run: async () => {
          await taskCreation;
          await executeDesktopScan({
            runtime,
            taskEvents,
            taskRuntime,
            indexChanges,
            services,
            registry,
            request,
            taskId,
            scanRunId,
            allowedRoots,
            changedPaths,
            homeDirectory,
            cancellation,
          });
        },
        onUnhandled: (error) =>
          recordUnhandledScanFailure(runtime, taskEvents, taskId, scanRunId, error),
      });
      taskEvents.record({
        taskId,
        emittedAt: acceptedAt,
        type: "accepted",
        payload: { taskKind: "scan", phase: "queued", acceptedAt },
      });
      await taskCreation;
      return { taskId, status: "queued", acceptedAt };
    },
    "scan.status": async (payload) => {
      const request = payload as { readonly taskId: string };
      const task = await runtime.repositories.tasks.get(TaskIdSchema.parse(request.taskId));
      if (task === undefined) throw notFound("Task not found");
      const terminal = task.summary;
      const phase =
        terminal === undefined ? apiPhase(task.progress?.phase ?? task.status) : "completed";
      return {
        taskId: task.taskId,
        status: apiScanStatus(task.status),
        phase,
        progress: {
          phase,
          completed: terminal?.succeededCount ?? task.progress?.completed ?? 0,
          total:
            terminal === undefined
              ? (task.progress?.total ?? null)
              : terminal.succeededCount + terminal.failedCount + terminal.skippedCount,
          unit: "items" as const,
        },
        ...(terminal === undefined
          ? {}
          : {
              resultSummary: {
                succeededCount: terminal.succeededCount,
                failedCount: terminal.failedCount,
                skippedCount: terminal.skippedCount,
                diagnosticIds: terminal.diagnosticIds,
              },
            }),
        lastSequence: task.progress?.sequence ?? (terminal === undefined ? 0 : 1),
        cancellable: terminal === undefined && taskRuntime.cancellation(task.taskId) !== undefined,
      };
    },
    "scan.cancel": async (payload) => {
      const request = payload as { readonly taskId: string };
      const taskId = TaskIdSchema.parse(request.taskId);
      const task = await runtime.repositories.tasks.get(taskId);
      if (task === undefined) throw notFound("Task not found");
      const cancellation = taskRuntime.cancellation(taskId);
      if (cancellation === undefined) throw taskNotCancellable(taskId);
      const effectiveAfterPhase = apiPhase(
        task.summary === undefined ? (task.progress?.phase ?? task.status) : "completed",
      );
      taskEvents.record({
        taskId: task.taskId,
        emittedAt: now(runtime),
        type: "cancel.requested",
        payload: { reason: "user", effectiveAfterPhase },
      });
      cancellation.abort();
      return {
        taskId,
        cancelRequested: true,
        effectiveAfterPhase,
      };
    },
    "assets.list": async (payload) => {
      const request = payload as {
        readonly projectId?: string;
        readonly toolKeys?: Parameters<typeof runtime.repositories.index.listAssets>[0]["toolIds"];
        readonly resourceTypes?: Parameters<
          typeof runtime.repositories.index.listAssets
        >[0]["resourceKinds"];
        readonly scopeKinds?: readonly string[];
        readonly diagnosticSeverity?: string;
        readonly query?: string;
        readonly cursor?: string;
        readonly limit?: number;
      };
      const requestedLimit = request.limit ?? 50;
      const requestedScopeKinds =
        request.scopeKinds === undefined
          ? undefined
          : new Set(request.scopeKinds.map((scopeKind) => ScopeKindSchema.parse(scopeKind)));
      const diagnosticSeverity =
        request.diagnosticSeverity === undefined
          ? undefined
          : DiagnosticSeveritySchema.parse(request.diagnosticSeverity);
      const scopeIds =
        request.projectId === undefined
          ? undefined
          : (await runtime.repositories.index.listScopes())
              .filter((scope) => scope.projectId === ProjectIdSchema.parse(request.projectId))
              .map((scope) => scope.scopeId);
      const requiresPostFilter =
        requestedScopeKinds !== undefined || diagnosticSeverity !== undefined;
      const page = await runtime.repositories.index.listAssets({
        ...(request.toolKeys === undefined ? {} : { toolIds: request.toolKeys }),
        ...(scopeIds === undefined ? {} : { scopeIds }),
        ...(request.resourceTypes === undefined ? {} : { resourceKinds: request.resourceTypes }),
        ...(request.query === undefined ? {} : { search: request.query }),
        ...(request.cursor === undefined
          ? {}
          : { cursor: PaginationCursorSchema.parse(request.cursor) }),
        limit: requiresPostFilter ? 10_000 : requestedLimit,
      });
      const loadStates = await assetLoadStates(runtime, page.items);
      const scopeKinds = scopeKindsForAssets(runtime, page.items);
      const filtered = page.items.filter((asset) => {
        const scopeKind = scopeKinds.get(asset.scopeId) ?? "project";
        if (requestedScopeKinds !== undefined && !requestedScopeKinds.has(scopeKind)) return false;
        if (diagnosticSeverity !== undefined && asset.diagnosticSummary[diagnosticSeverity] === 0) {
          return false;
        }
        return true;
      });
      const items = filtered.slice(0, requestedLimit);
      const last = items.at(-1);
      return {
        items: items.map((asset) => ({
          id: asset.assetId,
          toolKey: asset.toolId,
          resourceType: asset.resource.kind,
          scopeKind: scopeKinds.get(asset.scopeId) ?? "project",
          logicalKey: asset.locator,
          sourceDirectory: dirname(asset.canonicalSourcePath),
          sourceSummary: assetSourceSummary(asset),
          ...assetLoadStateFields(loadStates.get(asset.assetId)),
          contentHash: asset.contentHash,
          status: asset.status,
          diagnosticCounts: asset.diagnosticSummary,
        })),
        nextCursor:
          requiresPostFilter && filtered.length > items.length && last !== undefined
            ? PaginationCursorSchema.parse(last.assetId)
            : (page.nextCursor ?? null),
        snapshotRevision: page.snapshotRevision,
        stale: false,
      };
    },
    "assets.get": async (payload) => {
      const request = payload as { readonly assetId: string; readonly include?: readonly string[] };
      const include = request.include ?? [];
      const asset = await runtime.repositories.index.getAsset(AssetIdSchema.parse(request.assetId));
      if (asset === undefined) throw notFound("Asset not found");
      return {
        asset: {
          id: asset.assetId,
          toolKey: asset.toolId,
          resourceType: asset.resource.kind,
          scopeId: asset.scopeId,
          logicalKey: asset.locator,
          status: asset.status,
          disablementOptions: disablementOptionsForAsset(asset),
          ...(include.includes("normalized") ? { normalized: toJson(asset.resource) } : {}),
          ...(include.includes("references") ? { references: asset.references } : {}),
          ...(include.includes("diagnostics") ? { diagnosticIds: [] } : {}),
        },
        source: {
          pathDisplay: asset.canonicalSourcePath,
          contentHash: asset.contentHash,
          observedAt: asset.discoveredAt,
          sourceSummary: assetSourceSummary(asset),
          files: sourceFileViews(asset),
        },
        redactions: [],
      };
    },
    "assets.openSource": async (payload) => {
      const request = payload as CommandRequest<"assets.openSource">;
      const asset = await runtime.repositories.index.getAsset(AssetIdSchema.parse(request.assetId));
      if (asset === undefined) throw notFound("Asset not found");
      if (runtime.sourceFileOpener === undefined) {
        throw unsupported("External editor integration is unavailable in this runtime");
      }
      try {
        await runtime.sourceFileOpener.openPath(primarySourcePath(asset));
      } catch (error) {
        throw new AppError({
          code: "INTERNAL_ERROR",
          message: "The source file could not be opened in the external editor",
          retryable: true,
          suggestedActions: ["Check that the file exists and an editor is registered for it"],
          cause: error,
        });
      }
      return { assetId: asset.assetId, opened: true as const };
    },
    "assets.disable": async (payload) => {
      const request = payload as CommandRequest<"assets.disable">;
      return assetDisablement.disable({
        assetId: AssetIdSchema.parse(request.assetId),
        method: request.method,
      });
    },
    "assets.enable": async (payload) => {
      const request = payload as CommandRequest<"assets.enable">;
      return assetDisablement.enable({ assetId: AssetIdSchema.parse(request.assetId) });
    },
    "effective.resolve": async (payload) =>
      resolveEffectiveView(runtime, registry, payload as CommandRequest<"effective.resolve">),
    "diagnostics.list": async (payload) => {
      const request = payload as CommandRequest<"diagnostics.list">;
      const requestedLimit = request.limit ?? 50;
      const requiresPostFilter =
        request.projectId !== undefined ||
        request.toolKeys !== undefined ||
        request.codes !== undefined;
      const repositoryQuery = {
        ...(request.assetId === undefined ? {} : { assetId: AssetIdSchema.parse(request.assetId) }),
        ...(request.severities === undefined
          ? {}
          : {
              severity: request.severities.map((severity) =>
                DiagnosticSeveritySchema.parse(severity),
              ),
            }),
        ...(request.cursor === undefined
          ? {}
          : { cursor: PaginationCursorSchema.parse(request.cursor) }),
      };
      if (!requiresPostFilter) {
        const page = await runtime.repositories.index.listDiagnostics({
          ...repositoryQuery,
          limit: requestedLimit,
        });
        return diagnosticsPage(page);
      }
      const snapshot = await readFilteredDiagnosticsSnapshot(runtime, {
        repositoryQuery,
        filter: listFilterRequest(request),
        matchLimit: requestedLimit + 1,
      });
      const items = snapshot.items.slice(0, requestedLimit);
      const last = items.at(-1);
      const nextCursor =
        snapshot.items.length > requestedLimit && last !== undefined
          ? PaginationCursorSchema.parse(last.diagnosticId)
          : undefined;
      return diagnosticsPage({
        items,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        snapshotRevision: snapshot.snapshotRevision,
      });
    },
    "diagnostics.export": async (payload) => {
      const request = payload as CommandRequest<"diagnostics.export">;
      const taskDiagnosticIds =
        request.taskId === undefined
          ? undefined
          : new Set(
              (await runtime.repositories.tasks.get(TaskIdSchema.parse(request.taskId)))?.summary
                ?.diagnosticIds ?? [],
            );
      const snapshot = await readFilteredDiagnosticsSnapshot(runtime, {
        repositoryQuery: {
          ...(request.severities === undefined
            ? {}
            : {
                severity: request.severities.map((severity) =>
                  DiagnosticSeveritySchema.parse(severity),
                ),
              }),
        },
        filter: request,
        ...(taskDiagnosticIds === undefined ? {} : { taskDiagnosticIds }),
        matchLimit: DIAGNOSTIC_EXPORT_ITEM_LIMIT + 1,
      });
      if (snapshot.items.length > DIAGNOSTIC_EXPORT_ITEM_LIMIT) {
        throw diagnosticExportTooLarge(
          `Diagnostic export matches more than ${String(DIAGNOSTIC_EXPORT_ITEM_LIMIT)} items`,
        );
      }
      const items = snapshot.items.map(diagnosticView);
      const filters = compact({
        taskId: request.taskId === undefined ? undefined : TaskIdSchema.parse(request.taskId),
        projectId:
          request.projectId === undefined ? undefined : ProjectIdSchema.parse(request.projectId),
        toolKeys: request.toolKeys?.map((toolKey) => ToolIdSchema.parse(toolKey)),
        severities: request.severities,
        from: request.from,
        to: request.to,
      });
      const report = createDiagnosticReport({
        format: request.format,
        generatedAt: now(runtime),
        filters,
        items,
        homeDirectory,
        pathRoots: diagnosticReportPathRoots(runtime, cwd),
      });
      assertDiagnosticReportSize(report);
      return report;
    },
    "migration.preview": async (payload) => {
      const request = payload as {
        readonly sourceAssetIds: readonly string[];
        readonly targetToolKey: string;
        readonly targetScopeId: string;
        readonly conflictPolicy?: "fail" | "replace" | "merge";
      };
      const assets = await Promise.all(
        request.sourceAssetIds.map(async (assetId) => {
          const asset = await runtime.repositories.index.getAsset(AssetIdSchema.parse(assetId));
          if (asset === undefined) throw notFound(`Asset not found: ${assetId}`);
          return asset;
        }),
      );
      const first = assets[0];
      if (first === undefined) throw unsupported("Migration preview requires at least one asset");
      const disabled = assets.find((asset) => asset.status === "disabled");
      if (disabled !== undefined) {
        throw new AppError({
          code: "VALIDATION_FAILED",
          message: `Asset is disabled and cannot be used as a migration source: ${disabled.assetId}`,
          retryable: false,
          suggestedActions: ["Enable the asset before creating a migration preview"],
        });
      }
      if (new Set(assets.map((asset) => asset.resource.kind)).size > 1) {
        throw new AppError({
          code: "VALIDATION_FAILED",
          message: "Migration preview source assets must have the same resource type",
          retryable: false,
          suggestedActions: [
            "Select one resource type at a time and create separate migration previews",
          ],
        });
      }
      const targetRoot = AbsolutePathSchema.parse(resolve(request.targetScopeId));
      const targetToolId = ToolIdSchema.parse(request.targetToolKey);
      const targetAdapter = registry.create(targetToolId, NOOP_ADAPTER_LOGGER);
      const allowedRoots = [...new Set([targetRoot, ...sourcePackageRoots(assets)])].map((root) =>
        AbsolutePathSchema.parse(root),
      );
      const access = await createNodeFileAccess({ allowedRoots, platform: platform() });
      const service = new DeploymentPreviewService({
        registry,
        snapshots: access.snapshots,
        pathPolicy: access.pathPolicy,
        deploymentRepository: runtime.repositories.deployments,
      });
      const preview = await service.preview({
        assets,
        target: {
          toolId: targetToolId,
          resourceKind: ResourceKindSchema.parse(first.resource.kind),
          targetSchemaVersion: targetAdapter.capabilities.writtenSchemaVersion,
        },
        targetRoot,
        backupRoot: runtime.backupRoot,
        allowedRoots,
        conflictPolicy: request.conflictPolicy ?? "replace",
        now: now(runtime),
        correlationId: CorrelationIdSchema.parse(`correlation:desktop:${randomUUID()}`),
        projectId: projectIdForAbsoluteRoot(targetRoot),
        signal: AbortSignal.timeout(60_000),
      });
      return migrationPreviewResponse(preview.plan, preview.conversions, now(runtime));
    },
    "deployment.execute": async (payload) => {
      const request = payload as {
        readonly planId: string;
        readonly confirmedPlanHash: string;
        readonly confirmations?: readonly DeploymentPlan["requiredConfirmations"][number][];
      };
      const planId = DeploymentPlanIdSchema.parse(request.planId);
      taskRuntime.assertDeploymentAllowed();
      const found = deploymentRecordForPlan(runtime, planId);
      if (found === undefined) throw notFound("Deployment plan not found");
      const planPromise = runtime.repositories.deployments.getPlan(planId);
      const taskId = TaskIdSchema.parse(`task:deployment:${randomUUID()}`);
      const taskRecord = DeploymentRecordSchema.parse({ ...found, taskId });
      const bound = await runtime.repositories.deployments.compareAndSetRecord({
        expectedStatus: "planned",
        record: taskRecord,
      });
      if (!bound) throw deploymentStateChangedConflict(found.deploymentRecordId);
      const acceptedAt = now(runtime);
      const recorder = new DesktopOperationTaskRecorder({
        taskEvents,
        taskId,
        taskKind: "deployment",
        resultRef: taskRecord.deploymentRecordId,
        acceptedAt,
        operationTotal: taskRecord.operations.length,
        now: runtime.now,
        recoveryDeploymentId: taskRecord.deploymentRecordId,
        onRecoveryLockRequired: (deploymentRecordId) => {
          taskRuntime.requireRecovery(deploymentRecordId);
          try {
            persistRecoveryLock(runtime, deploymentRecordId);
          } catch {
            // Keep the in-memory lock when durable recovery metadata cannot be refreshed.
          }
        },
      });
      taskRuntime.start({
        taskId,
        taskKind: "deployment",
        operationKey: `deployment:${taskRecord.deploymentRecordId}`,
        run: () =>
          executeDesktopDeployment({
            runtime,
            registry,
            request,
            taskId,
            found: taskRecord,
            planPromise,
            recorder,
          }),
        onUnhandled: (error) => recordUnhandledOperationFailure(recorder, error),
      });
      recorder.accept();
      await Promise.resolve();
      return {
        taskId,
        status: "queued",
        acceptedAt,
        deploymentId: taskRecord.deploymentRecordId,
      };
    },
    "deployment.rollback": async (payload) => {
      const request = payload as { readonly deploymentId: string };
      const originalId = DeploymentRecordIdSchema.parse(request.deploymentId);
      taskRuntime.assertRollbackAllowed(originalId);
      const taskId = TaskIdSchema.parse(`task:rollback:${randomUUID()}`);
      const rollbackRecordId = DeploymentRecordIdSchema.parse(`rollback-record:${randomUUID()}`);
      const recoveryRollback = taskRuntime.isRecoveryRollback(originalId);
      const acceptedAt = now(runtime);
      const recorder = new DesktopOperationTaskRecorder({
        taskEvents,
        taskId,
        taskKind: "rollback",
        resultRef: rollbackRecordId,
        acceptedAt,
        operationTotal: 0,
        now: runtime.now,
        recoveryDeploymentId: originalId,
        onRecoveryLockRequired: (deploymentRecordId) => {
          taskRuntime.requireRecovery(deploymentRecordId);
          try {
            persistRecoveryLock(runtime, deploymentRecordId);
          } catch {
            // Keep the in-memory lock when durable recovery metadata cannot be refreshed.
          }
        },
        onRecoveryRollbackSucceeded: (deploymentRecordId) => {
          try {
            resolvePersistedRecoveryLock(runtime, deploymentRecordId);
            taskRuntime.resolveRecovery(deploymentRecordId);
          } catch {
            // Retain the lock if durable resolution could not be recorded.
          }
        },
      });
      taskRuntime.start({
        taskId,
        taskKind: "rollback",
        operationKey: `rollback:${originalId}`,
        run: () =>
          executeDesktopRollback({
            runtime,
            originalId,
            rollbackRecordId,
            recoveryRollback,
            taskId,
            recorder,
          }),
        onUnhandled: (error) => recordUnhandledOperationFailure(recorder, error),
      });
      recorder.accept();
      await Promise.resolve();
      return {
        taskId,
        status: "queued",
        acceptedAt,
        rollbackId: rollbackRecordId,
      };
    },
    "history.list": async (payload) => {
      const request = payload as {
        readonly kinds?: readonly ("deployment" | "rollback")[];
        readonly taskId?: string;
        readonly projectId?: string;
        readonly statuses?: readonly string[];
        readonly from?: string;
        readonly to?: string;
        readonly cursor?: string;
        readonly snapshotRevision?: string;
        readonly limit?: number;
      };
      const page = await runtime.repositories.deployments.listRecords({
        ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
        ...(request.statuses === undefined
          ? {}
          : { statuses: request.statuses.map((status) => DeploymentStatusSchema.parse(status)) }),
        ...(request.taskId === undefined ? {} : { taskId: TaskIdSchema.parse(request.taskId) }),
        ...(request.projectId === undefined
          ? {}
          : { projectId: ProjectIdSchema.parse(request.projectId) }),
        ...(request.from === undefined ? {} : { from: IsoDateTimeSchema.parse(request.from) }),
        ...(request.to === undefined ? {} : { to: IsoDateTimeSchema.parse(request.to) }),
        ...(request.cursor === undefined
          ? {}
          : { cursor: PaginationCursorSchema.parse(request.cursor) }),
        ...(request.snapshotRevision === undefined
          ? {}
          : { snapshotRevision: request.snapshotRevision }),
        limit: request.limit ?? 50,
      });
      const snapshots = await snapshotMetadataForRecords(runtime, page.items);
      return {
        items: page.items.map((record) =>
          historyEntry(record, snapshots.get(record.deploymentRecordId)),
        ),
        nextCursor: page.nextCursor ?? null,
        snapshotRevision: page.snapshotRevision,
      };
    },
    "history.get": async (payload) => {
      const request = payload as { readonly id: string };
      const recordId = DeploymentRecordIdSchema.parse(request.id);
      const record = await runtime.repositories.deployments.getRecord(recordId);
      if (record === undefined) throw notFound("Deployment record not found");
      const plan = await runtime.repositories.deployments.getPlan(record.deploymentPlanId);
      if (plan === undefined) throw notFound("Deployment plan not found");
      const snapshots = await snapshotMetadataForRecords(runtime, [record]);
      return historyDetail(record, plan, snapshots.get(record.deploymentRecordId));
    },
    "settings.get": async (payload) => {
      const request = payload as { readonly keys?: readonly string[] };
      const current = await runtime.repositories.settings.getPublic();
      const values = settingsValues(current.settings);
      const selected = request.keys === undefined ? values : selectSettings(request.keys, values);
      return {
        values: selected,
        revision: Number(current.revision),
        readOnlyRecovery: runtime.databaseRecovery,
      };
    },
    "settings.clearLocalData": async (payload) => {
      const request = payload as CommandRequest<"settings.clearLocalData">;
      const releaseCleanup = taskRuntime.beginCleanup(request.categories);
      try {
        const localHistoryDirectories = request.categories.includes("deployment_history")
          ? await clearLocalHistoryBeforeDatabaseCleanup(runtime, request.categories)
          : 0;
        const result = await runtime.repositories.maintenance.clearLocalData({
          categories: request.categories,
          now: now(runtime),
        });
        if (request.categories.includes("scan_cache")) taskEvents.purge("scan");
        return {
          ...result,
          counts: {
            ...result.counts,
            localHistoryDirectories,
          },
        };
      } finally {
        releaseCleanup();
      }
    },
    "settings.update": async (payload) => {
      const request = payload as {
        readonly expectedRevision: number;
        readonly patch: {
          readonly theme?: "system" | "light" | "dark";
          readonly language?: "system" | "en" | "zh-CN";
          readonly pathDisplay?: "full" | "abbreviated";
          readonly scanHints?: boolean;
          readonly fileWatching?: boolean;
        };
      };
      const current = await runtime.repositories.settings.getPublic();
      const next = await runtime.repositories.settings.updatePublic({
        expectedRevision: String(request.expectedRevision),
        settings: {
          ...current.settings,
          ...(request.patch.theme === undefined ? {} : { theme: request.patch.theme }),
          ...(request.patch.language === undefined ? {} : { language: request.patch.language }),
          ...(request.patch.pathDisplay === undefined
            ? {}
            : { pathDisplay: request.patch.pathDisplay }),
          ...(request.patch.scanHints === undefined ? {} : { scanHints: request.patch.scanHints }),
          ...(request.patch.fileWatching === undefined
            ? {}
            : { fileWatching: request.patch.fileWatching }),
        },
      });
      return {
        values: settingsValues(next.settings),
        revision: Number(next.revision),
        requiresRestart: false,
      };
    },
  };
  return services as unknown as CommandServiceMap;
}

type DesktopScanRequest = {
  readonly changedPaths?: readonly string[];
  readonly clientContext?: DesktopScanClientContext;
  readonly mode?: "full" | "incremental";
  readonly projectId?: string;
  readonly roots?: readonly string[];
  readonly toolKeys?: readonly string[];
};

async function executeDesktopScan(input: {
  readonly runtime: DesktopRuntime;
  readonly taskEvents: DesktopTaskEvents;
  readonly taskRuntime: DesktopTaskRuntimeRegistry;
  readonly indexChanges: DesktopIndexChanges;
  readonly services: Record<ApiCommandName, (payload: unknown) => Promise<unknown>>;
  readonly registry: AdapterRegistry;
  readonly request: DesktopScanRequest;
  readonly taskId: TaskId;
  readonly scanRunId: ReturnType<typeof ScanRunIdSchema.parse>;
  readonly allowedRoots: readonly AbsolutePath[];
  readonly changedPaths: readonly AbsolutePath[] | undefined;
  readonly homeDirectory: AbsolutePath;
  readonly cancellation: ReturnType<typeof createCancellationController>;
}): Promise<void> {
  // Attach native watchers before reading the scan snapshot. Any change that
  // lands during the scan is then queued and replayed once this task becomes
  // idle, closing the scan-to-watcher lost-change window.
  await syncFileWatcher(
    input.runtime,
    input.allowedRoots,
    input.services,
    input.taskRuntime,
    input.indexChanges,
  );
  const access = await createNodeFileAccess({
    allowedRoots: input.allowedRoots,
    platform: platform(),
  });
  const canonicalChangedPaths =
    input.changedPaths === undefined
      ? undefined
      : await Promise.all(
          input.changedPaths.map(async (path) => {
            try {
              return await access.read.realpath(path);
            } catch (error) {
              if (isMissingPathError(error)) return path;
              throw error;
            }
          }),
        );
  const scanner = new ScanService({
    registrations: scanRegistrations(input.registry.registrations, input.request.toolKeys),
    read: access.read,
    snapshots: access.snapshots,
    indexRepository: input.runtime.repositories.index,
    now: () => now(input.runtime),
  });
  let sequence = 0;
  let previousPhase:
    | "queued"
    | "discovering"
    | "reading"
    | "parsing"
    | "validating"
    | "committing"
    | "completed" = "queued";
  const result = await scanner.scan({
    scanRunId: input.scanRunId,
    candidateRoots: input.allowedRoots,
    ...(input.request.mode === "incremental" && canonicalChangedPaths !== undefined
      ? { changedPaths: canonicalChangedPaths }
      : {}),
    ...(input.request.projectId === undefined ? {} : { commitMode: "merge-scoped" as const }),
    homeDirectory: input.homeDirectory,
    platform: scannerPlatform(),
    signal: input.cancellation.signal,
    onPhase: (phase) => {
      if (phase === "committing") input.taskRuntime.makeNonCancellable(input.taskId);
      sequence += 1;
      input.taskEvents.record({
        taskId: input.taskId,
        emittedAt: now(input.runtime),
        type: "phase.changed",
        payload: { from: previousPhase, to: phase },
      });
      previousPhase = phase;
      void input.runtime.repositories.tasks
        .updateProgress({
          taskId: input.taskId,
          sequence,
          phase,
          completed: phase === "completed" ? 1 : 0,
          total: 1,
        })
        .catch(() => undefined);
    },
  });
  input.cancellation.signal.throwIfAborted();
  await input.runtime.repositories.tasks.finish(result.summary);
  await recordScanItemFailures(input.runtime, input.taskEvents, input.taskId, result.itemFailures);
  input.cancellation.signal.throwIfAborted();
  input.taskEvents.record({
    taskId: input.taskId,
    emittedAt: now(input.runtime),
    type: "completed",
    payload: {
      status: result.summary.status,
      succeededCount: result.summary.succeededCount,
      failedCount: result.summary.failedCount,
      skippedCount: result.summary.skippedCount,
      resultRef: result.summary.scanRunId,
      systemRecoveryLock: false,
    },
  });
}

async function recordUnhandledScanFailure(
  runtime: DesktopRuntime,
  taskEvents: DesktopTaskEvents,
  taskId: TaskId,
  scanRunId: ReturnType<typeof ScanRunIdSchema.parse>,
  error: unknown,
): Promise<void> {
  if (taskEvents.isTerminal(taskId)) return;
  const cancelled = error instanceof AppError && error.code === "USER_CANCELLED";
  const summary = ScanRunSummarySchema.parse({
    scanRunId,
    status: cancelled ? "cancelled" : "failed",
    succeededCount: 0,
    failedCount: cancelled ? 0 : 1,
    skippedCount: 0,
    diagnosticIds: [],
  });
  await runtime.repositories.tasks.finish(summary).catch(() => undefined);
  if (!cancelled) {
    taskEvents.record({
      taskId,
      emittedAt: now(runtime),
      type: "item.failed",
      payload: {
        itemRef: scanRunId,
        diagnosticId: DiagnosticIdSchema.parse("diagnostic:scan:runtime-failure"),
        errorCode: errorCode(error),
        retryable: isRetryable(error),
      },
    });
  }
  taskEvents.record({
    taskId,
    emittedAt: now(runtime),
    type: "completed",
    payload: {
      status: summary.status,
      succeededCount: summary.succeededCount,
      failedCount: summary.failedCount,
      skippedCount: summary.skippedCount,
      resultRef: scanRunId,
      systemRecoveryLock: false,
    },
  });
}

async function executeDesktopDeployment(input: {
  readonly runtime: DesktopRuntime;
  readonly registry: AdapterRegistry;
  readonly request: {
    readonly planId: string;
    readonly confirmedPlanHash: string;
    readonly confirmations?: readonly DeploymentPlan["requiredConfirmations"][number][];
  };
  readonly taskId: TaskId;
  readonly found: DeploymentRecord;
  readonly planPromise: Promise<DeploymentPlan | undefined>;
  readonly recorder: DesktopOperationTaskRecorder;
}): Promise<void> {
  try {
    const plan = await input.planPromise;
    if (plan === undefined) throw notFound("Deployment plan not found");
    input.recorder.setOperationTotal(plan.operations.length);
    input.recorder.changePhase("preflight");
    input.recorder.progress(0);
    const roots = deploymentRoots(input.found);
    const access = await createNodeFileAccess({ allowedRoots: roots, platform: platform() });
    const deploymentFiles = instrumentDeploymentFiles(
      input.runtime.deploymentFileFactory({
        allowedRoots: roots,
        backupRoot: input.runtime.backupRoot,
      }),
      input.recorder,
      "deployment",
    );
    const service = new DeploymentExecutionService({
      deploymentRepository: input.runtime.repositories.deployments,
      sourceHashes: {
        currentHash: (assetId) => currentAssetSourceHash(input.runtime, assetId),
      },
      snapshots: access.snapshots,
      deploymentFiles,
      locks: input.runtime.pathLocks,
      registry: input.registry,
      read: instrumentDeploymentRead(access.read, input.recorder),
    });
    const suppressedTargetPaths = plan.operations.map(({ targetPath }) => targetPath);
    input.runtime.watchService.suppressDeploymentPaths(suppressedTargetPaths);
    let record: DeploymentRecord;
    try {
      record = await service.execute({
        deploymentRecordId: input.found.deploymentRecordId,
        confirmedPlanHash: ContentHashSchema.parse(input.request.confirmedPlanHash),
        confirmations: input.request.confirmations ?? [],
        allowedRoots: roots,
        now: now(input.runtime),
      });
    } finally {
      input.runtime.watchService.clearDeploymentSuppression(suppressedTargetPaths);
    }
    if (record.status !== "succeeded") {
      input.recorder.failStatus(
        record.status === "rolled_back" ? "rolled_back" : "failed",
        record.deploymentRecordId,
      );
      return;
    }
    finishDeploymentWork(input.recorder);
    await recordDeploymentSnapshot(input.runtime, record, plan);
    input.recorder.succeed(record.deploymentRecordId, record.operations.length);
  } catch (error) {
    input.recorder.fail(error, input.found.deploymentRecordId);
  }
}

async function executeDesktopRollback(input: {
  readonly runtime: DesktopRuntime;
  readonly originalId: ReturnType<typeof DeploymentRecordIdSchema.parse>;
  readonly rollbackRecordId: ReturnType<typeof DeploymentRecordIdSchema.parse>;
  readonly recoveryRollback: boolean;
  readonly taskId: TaskId;
  readonly recorder: DesktopOperationTaskRecorder;
}): Promise<void> {
  input.recorder.changePhase("preflight");
  input.recorder.progress(0);
  let roots: readonly AbsolutePath[];
  let access: Awaited<ReturnType<typeof createNodeFileAccess>>;
  let plan: DeploymentPlan;
  let original: DeploymentRecord | undefined;
  try {
    original = deploymentRecordById(input.runtime, input.originalId);
    roots = rollbackRoots(input.runtime, input.originalId);
    access = await createNodeFileAccess({
      allowedRoots: [...roots, input.runtime.backupRoot],
      platform: platform(),
    });
    const service = new DeploymentRollbackService({
      deploymentRepository: input.runtime.repositories.deployments,
      snapshots: access.snapshots,
      deploymentFiles: input.runtime.deploymentFileFactory({
        allowedRoots: roots,
        backupRoot: input.runtime.backupRoot,
      }),
      locks: input.runtime.pathLocks,
    });
    plan = await service.preview(input.originalId, {
      allowFailedRecovery: input.recoveryRollback,
      attemptId: input.rollbackRecordId,
    });
  } catch (error) {
    if (input.recoveryRollback && isRecoveryAlreadyComplete(error)) {
      input.recorder.succeed(input.rollbackRecordId, 0);
      return;
    }
    input.recorder.fail(error, input.originalId);
    return;
  }

  input.recorder.setOperationTotal(plan.operations.length);
  const rollbackService = new DeploymentRollbackService({
    deploymentRepository: input.runtime.repositories.deployments,
    snapshots: access.snapshots,
    deploymentFiles: instrumentDeploymentFiles(
      input.runtime.deploymentFileFactory({
        allowedRoots: roots,
        backupRoot: input.runtime.backupRoot,
      }),
      input.recorder,
      "rollback",
    ),
    locks: input.runtime.pathLocks,
  });
  const suppressedTargetPaths = plan.operations.map(({ targetPath }) => targetPath);
  input.runtime.watchService.suppressDeploymentPaths(suppressedTargetPaths);
  let record: DeploymentRecord;
  try {
    record = await rollbackService.execute({
      deploymentRecordId: input.originalId,
      rollbackPlanHash: plan.planHash,
      rollbackRecordId: input.rollbackRecordId,
      allowFailedRecovery: input.recoveryRollback,
      taskId: input.taskId,
      now: now(input.runtime),
    });
  } catch (error) {
    input.recorder.fail(error, input.originalId);
    return;
  } finally {
    input.runtime.watchService.clearDeploymentSuppression(suppressedTargetPaths);
  }
  if (record.status !== "succeeded") {
    if (input.recorder.phase === "preflight") input.recorder.changePhase("restoring");
    input.recorder.progress(Object.keys(record.resultingHashes).length);
    input.recorder.failStatus("failed", input.originalId);
    return;
  }
  finishRollbackWork(input.recorder);
  const originalPlan =
    original === undefined
      ? undefined
      : await input.runtime.repositories.deployments.getPlan(original.deploymentPlanId);
  await recordDeploymentSnapshot(input.runtime, record, originalPlan);
  input.recorder.succeed(record.deploymentRecordId, record.operations.length);
}

function isRecoveryAlreadyComplete(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === "CONFLICT" &&
    error.safeContext?.["recoveryAlreadyComplete"] === true
  );
}

function recordUnhandledOperationFailure(
  recorder: DesktopOperationTaskRecorder,
  error: unknown,
): void {
  if (!recorder.completed) recorder.fail(error);
}

async function clearLocalHistoryBeforeDatabaseCleanup(
  runtime: DesktopRuntime,
  categories: readonly CommandRequest<"settings.clearLocalData">["categories"][number][],
): Promise<number> {
  await runtime.repositories.maintenance.assertCanClearLocalData({ categories });
  return resetLocalHistory({
    appDataRoot: runtime.appDataRoot,
    historyRoot: runtime.historyRoot,
  });
}

export async function resetLocalHistory(input: {
  readonly appDataRoot: AbsolutePath;
  readonly historyRoot: AbsolutePath;
}): Promise<number> {
  assertControlledLocalHistoryRoot(input);
  const hadEntries = await directoryHasEntries(input.historyRoot);
  await rm(input.historyRoot, { recursive: true, force: true });
  await ensurePrivateDirectory(input.historyRoot);
  return hadEntries ? 1 : 0;
}

function assertControlledLocalHistoryRoot(input: {
  readonly appDataRoot: AbsolutePath;
  readonly historyRoot: AbsolutePath;
}): void {
  const appDataRoot = resolve(input.appDataRoot);
  const historyRoot = resolve(input.historyRoot);
  const pathFromAppData = relative(appDataRoot, historyRoot);
  if (
    pathFromAppData !== join("history", "local-git") ||
    pathFromAppData.startsWith("..") ||
    isAbsolute(pathFromAppData)
  ) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "Local Git history path is outside the controlled app data directory",
      retryable: false,
      suggestedActions: ["Restart the app and retry clearing deployment history"],
      safeContext: { historyPath: historyRoot },
    });
  }
}

async function directoryHasEntries(path: AbsolutePath): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function recordScanItemFailures(
  runtime: DesktopRuntime,
  taskEvents: DesktopTaskEvents,
  taskId: string,
  itemFailures: readonly ScanItemFailure[],
): Promise<void> {
  for (const failure of itemFailures) {
    const diagnostic = await runtime.repositories.index.getDiagnostic(failure.diagnosticId);
    taskEvents.record({
      taskId,
      emittedAt: now(runtime),
      type: "item.failed",
      payload: {
        itemRef:
          diagnostic === undefined || diagnostic.severity !== "error"
            ? failure.itemRef
            : diagnosticItemRef(diagnostic),
        diagnosticId: failure.diagnosticId,
        errorCode: failure.errorCode,
        retryable: failure.retryable,
      },
    });
  }
}

function diagnosticItemRef(diagnostic: Diagnostic): string {
  if (diagnostic.location?.path !== undefined) return diagnostic.location.path;
  const sourcePath = diagnostic.evidence.sourcePath;
  if (typeof sourcePath === "string" && sourcePath.trim().length > 0) return sourcePath;
  return diagnostic.diagnosticId;
}

type DesktopRuntimeTaskKind = "scan" | "deployment" | "rollback";

type DesktopRuntimeTaskEntry = {
  readonly taskKind: DesktopRuntimeTaskKind;
  readonly completion: Promise<void>;
  readonly settle: () => void;
  readonly operationKey?: string;
  readonly cancellation?: ReturnType<typeof createCancellationController>;
  readonly scanMetadata?: {
    readonly clientContext?: DesktopScanClientContext;
    readonly selectedRoots: readonly AbsolutePath[];
    readonly canonicalRoots: readonly AbsolutePath[];
  };
};

class DesktopTaskRuntimeRegistry {
  readonly #active = new Map<TaskId, DesktopRuntimeTaskEntry>();
  readonly #activeOperationKeys = new Map<string, TaskId>();
  readonly #idleWaiters = new Set<() => void>();
  #cleanupActive = false;
  readonly #recoveryDeploymentIds = new Set<DeploymentRecordId>();

  constructor(recoveryDeploymentIds: readonly DeploymentRecordId[] = []) {
    for (const deploymentRecordId of recoveryDeploymentIds) {
      this.#recoveryDeploymentIds.add(deploymentRecordId);
    }
  }

  runtimeState(): DesktopRuntimeState {
    return {
      activeTasks: [...this.#active.entries()].map(([taskId, entry]) => ({
        taskId,
        taskKind: entry.taskKind,
        ...(entry.scanMetadata?.clientContext === undefined
          ? {}
          : { clientContext: entry.scanMetadata.clientContext }),
        ...(entry.scanMetadata === undefined
          ? {}
          : {
              selectedRoots: entry.scanMetadata.selectedRoots,
              canonicalRoots: entry.scanMetadata.canonicalRoots,
            }),
      })),
      recoveryDeploymentIds: [...this.#recoveryDeploymentIds].sort(),
    };
  }

  start(input: {
    readonly taskId: TaskId;
    readonly taskKind: DesktopRuntimeTaskKind;
    readonly operationKey?: string;
    readonly cancellation?: ReturnType<typeof createCancellationController>;
    readonly scanMetadata?: DesktopRuntimeTaskEntry["scanMetadata"];
    readonly run: () => Promise<void>;
    readonly onUnhandled: (error: unknown) => void | Promise<void>;
  }): void {
    this.assertCanStart();
    if (this.#active.has(input.taskId)) {
      throw new Error(`Task is already active: ${input.taskId}`);
    }
    if (input.operationKey !== undefined && this.#activeOperationKeys.has(input.operationKey)) {
      throw operationAlreadyRunningConflict(input.operationKey);
    }
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      this.#active.delete(input.taskId);
      if (
        input.operationKey !== undefined &&
        this.#activeOperationKeys.get(input.operationKey) === input.taskId
      ) {
        this.#activeOperationKeys.delete(input.operationKey);
      }
      resolveCompletion();
      this.#notifyIdle();
    };
    this.#active.set(input.taskId, {
      taskKind: input.taskKind,
      completion,
      settle,
      ...(input.operationKey === undefined ? {} : { operationKey: input.operationKey }),
      ...(input.cancellation === undefined ? {} : { cancellation: input.cancellation }),
      ...(input.scanMetadata === undefined ? {} : { scanMetadata: input.scanMetadata }),
    });
    if (input.operationKey !== undefined) {
      this.#activeOperationKeys.set(input.operationKey, input.taskId);
    }
    setTimeout(() => {
      void (async () => {
        try {
          await input.run();
        } catch (error) {
          try {
            await input.onUnhandled(error);
          } catch {
            // A failed event sink must not become an unhandled background rejection.
          }
        } finally {
          settle();
        }
      })();
    }, 0);
  }

  assertCanStart(): void {
    if (this.#cleanupActive) throw operationCleanupConflict("Local data cleanup is running");
    if (this.#active.size > 0) throw operationAlreadyRunningConflict("desktop-task");
  }

  assertDeploymentAllowed(): void {
    this.assertCanStart();
    if (this.#recoveryDeploymentIds.size > 0) {
      throw recoveryRequiredConflict([...this.#recoveryDeploymentIds]);
    }
  }

  assertRollbackAllowed(deploymentRecordId: DeploymentRecordId): void {
    this.assertCanStart();
    if (
      this.#recoveryDeploymentIds.size > 0 &&
      !this.#recoveryDeploymentIds.has(deploymentRecordId)
    ) {
      throw recoveryRequiredConflict([...this.#recoveryDeploymentIds]);
    }
  }

  requireRecovery(deploymentRecordId: DeploymentRecordId): void {
    this.#recoveryDeploymentIds.add(deploymentRecordId);
  }

  isRecoveryRollback(deploymentRecordId: DeploymentRecordId): boolean {
    return this.#recoveryDeploymentIds.has(deploymentRecordId);
  }

  resolveRecovery(deploymentRecordId: DeploymentRecordId): void {
    this.#recoveryDeploymentIds.delete(deploymentRecordId);
  }

  cancellation(taskId: TaskId): ReturnType<typeof createCancellationController> | undefined {
    const cancellation = this.#active.get(taskId)?.cancellation;
    return cancellation?.signal.aborted === true ? undefined : cancellation;
  }

  makeNonCancellable(taskId: TaskId): void {
    const entry = this.#active.get(taskId);
    if (entry?.cancellation === undefined) return;
    const { cancellation: discardedCancellation, ...nonCancellable } = entry;
    void discardedCancellation;
    this.#active.set(taskId, nonCancellable);
  }

  markTerminal(taskId: TaskId): void {
    this.#active.get(taskId)?.settle();
  }

  async waitForCompletion(taskId: string): Promise<void> {
    await this.#active.get(TaskIdSchema.parse(taskId))?.completion;
  }

  async waitForIdle(): Promise<void> {
    while (this.#active.size > 0 || this.#cleanupActive) {
      await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
    }
  }

  beginCleanup(
    categories: readonly CommandRequest<"settings.clearLocalData">["categories"][number][],
  ): () => void {
    if (this.#cleanupActive)
      throw operationCleanupConflict("Local data cleanup is already running");
    if (categories.includes("deployment_history") && this.#recoveryDeploymentIds.size > 0) {
      throw recoveryRequiredConflict([...this.#recoveryDeploymentIds]);
    }
    if (this.#active.size > 0) {
      const activeKinds = [...new Set([...this.#active.values()].map(({ taskKind }) => taskKind))]
        .sort()
        .join(",");
      throw operationCleanupConflict(
        "Wait for active tasks before clearing local data",
        activeKinds,
      );
    }
    this.#cleanupActive = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#cleanupActive = false;
      this.#notifyIdle();
    };
  }

  #notifyIdle(): void {
    if (this.#active.size > 0 || this.#cleanupActive) return;
    const waiters = [...this.#idleWaiters];
    this.#idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}

export class DesktopIndexChanges implements DesktopIndexChangePort {
  readonly #listeners = new Set<(event: DesktopIndexChangeEvent) => void>();

  subscribe(listener: (event: DesktopIndexChangeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  record(roots: readonly AbsolutePath[]): void {
    const event: DesktopIndexChangeEvent = { roots: uniquePaths(roots) };
    for (const listener of this.#listeners) listener(event);
  }
}

export class DesktopTaskEvents implements DesktopTaskEventPort {
  static readonly TERMINAL_TASK_LIMIT = 100;
  readonly #events = new Map<string, TaskEvent[]>();
  readonly #listeners = new Map<string, Set<(event: TaskEvent) => void>>();
  readonly #lastSequence = new Map<string, number>();
  readonly #states = new Map<string, TaskReplayState>();
  readonly #terminalTasks = new Map<string, true>();
  readonly #terminalListeners = new Set<(taskId: TaskId) => void>();

  onTerminal(listener: (taskId: TaskId) => void): () => void {
    this.#terminalListeners.add(listener);
    return () => this.#terminalListeners.delete(listener);
  }

  subscribe(
    taskId: string,
    afterSequence: number,
    listener: (event: TaskEvent) => void,
  ): () => void {
    const parsedTaskId = TaskIdSchema.parse(taskId);
    const events = this.#events.get(parsedTaskId) ?? [];
    const earliestSequence = events.find((event) => event.sequence !== null)?.sequence;
    const latestSequence = this.#lastSequence.get(parsedTaskId) ?? 0;
    const state = this.#states.get(parsedTaskId);
    if (
      earliestSequence !== undefined &&
      afterSequence < earliestSequence - 1 &&
      state !== undefined
    ) {
      listener(
        TaskEventSchema.parse({
          apiVersion: 1,
          eventVersion: 1,
          taskId: parsedTaskId,
          sequence: null,
          emittedAt: state.updatedAt,
          type: "cursor.reset",
          payload: {
            requestedAfterSequence: afterSequence,
            earliestAvailableSequence: earliestSequence,
            latestSequence,
          },
        }),
      );
      listener(
        TaskEventSchema.parse({
          apiVersion: 1,
          eventVersion: 1,
          taskId: parsedTaskId,
          sequence: null,
          emittedAt: state.updatedAt,
          type: "snapshot",
          payload: {
            taskKind: state.taskKind,
            phase: state.phase,
            status: state.status,
            progress: state.progress,
            lastSequence: latestSequence,
            cancellable: state.cancellable,
            systemRecoveryLock: state.systemRecoveryLock,
            ...(state.resultRef === undefined ? {} : { resultRef: state.resultRef }),
          },
        }),
      );
    } else {
      for (const event of events) {
        if (event.sequence !== null && event.sequence > afterSequence) listener(event);
      }
    }
    const listeners = this.#listeners.get(parsedTaskId) ?? new Set<(event: TaskEvent) => void>();
    listeners.add(listener);
    this.#listeners.set(parsedTaskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(parsedTaskId);
    };
  }

  record(input: {
    readonly taskId: string;
    readonly emittedAt: string;
    readonly type:
      | "accepted"
      | "phase.changed"
      | "progress"
      | "item.failed"
      | "cancel.requested"
      | "completed";
    readonly payload: unknown;
  }): TaskEvent {
    const taskId = TaskIdSchema.parse(input.taskId);
    const sequence = (this.#lastSequence.get(taskId) ?? 0) + 1;
    this.#lastSequence.set(taskId, sequence);
    const event = TaskEventSchema.parse({
      apiVersion: 1,
      eventVersion: 1,
      taskId,
      sequence,
      emittedAt: IsoDateTimeSchema.parse(input.emittedAt),
      type: input.type,
      payload: input.payload,
    }) as OrderedTaskEvent;
    const events = this.#events.get(taskId) ?? [];
    events.push(event);
    this.#events.set(taskId, events.slice(-200));
    this.#states.set(taskId, reduceTaskReplayState(this.#states.get(taskId), event));
    if (event.type === "completed") {
      this.#terminalTasks.delete(taskId);
      this.#terminalTasks.set(taskId, true);
      this.#pruneTerminalTasks();
      for (const listener of this.#terminalListeners) {
        try {
          listener(taskId);
        } catch {
          // Event consumers must not change a task's durable outcome.
        }
      }
    }
    for (const listener of this.#listeners.get(taskId) ?? []) {
      try {
        listener(event);
      } catch {
        // A renderer or test listener is observational and cannot fail the task.
      }
    }
    return event;
  }

  isTerminal(taskId: string): boolean {
    return this.#terminalTasks.has(TaskIdSchema.parse(taskId));
  }

  purge(taskKind: TaskReplayState["taskKind"]): void {
    for (const [taskId, state] of this.#states) {
      if (state.taskKind !== taskKind) continue;
      this.#deleteTask(taskId);
    }
  }

  #pruneTerminalTasks(): void {
    while (this.#terminalTasks.size > DesktopTaskEvents.TERMINAL_TASK_LIMIT) {
      const oldestTaskId = this.#terminalTasks.keys().next().value;
      if (oldestTaskId === undefined) return;
      this.#deleteTask(oldestTaskId);
    }
  }

  #deleteTask(taskId: string): void {
    this.#events.delete(taskId);
    this.#listeners.delete(taskId);
    this.#lastSequence.delete(taskId);
    this.#states.delete(taskId);
    this.#terminalTasks.delete(taskId);
  }
}

type TaskReplayState = {
  readonly taskKind: "scan" | "deployment" | "rollback";
  readonly phase: TaskPhase;
  readonly status:
    | "running"
    | "succeeded"
    | "partially_succeeded"
    | "cancelled"
    | "failed"
    | "rolled_back";
  readonly progress: {
    readonly phase: TaskPhase;
    readonly completed: number;
    readonly total: number | null;
    readonly unit: "files" | "operations" | "items";
  };
  readonly cancellable: boolean;
  readonly systemRecoveryLock: boolean;
  readonly resultRef?: string;
  readonly updatedAt: string;
};
type OrderedTaskEvent = Extract<TaskEvent, { readonly sequence: number }>;

function reduceTaskReplayState(
  current: TaskReplayState | undefined,
  event: OrderedTaskEvent,
): TaskReplayState {
  if (event.type === "accepted") {
    return {
      taskKind: event.payload.taskKind,
      phase: "queued",
      status: "running",
      progress: {
        phase: "queued",
        completed: 0,
        total: null,
        unit: event.payload.taskKind === "scan" ? "items" : "operations",
      },
      cancellable: true,
      systemRecoveryLock: false,
      updatedAt: event.emittedAt,
    };
  }
  const previous =
    current ??
    ({
      taskKind: "scan",
      phase: "queued",
      status: "running",
      progress: { phase: "queued", completed: 0, total: null, unit: "items" },
      cancellable: true,
      systemRecoveryLock: false,
      updatedAt: event.emittedAt,
    } satisfies TaskReplayState);
  if (event.type === "phase.changed") {
    return {
      ...previous,
      phase: event.payload.to,
      progress: { ...previous.progress, phase: event.payload.to },
      cancellable:
        previous.taskKind === "scan" && event.payload.to === "committing"
          ? false
          : previous.cancellable,
      updatedAt: event.emittedAt,
    };
  }
  if (event.type === "progress") {
    return {
      ...previous,
      phase: event.payload.phase,
      progress: event.payload,
      updatedAt: event.emittedAt,
    };
  }
  if (event.type === "cancel.requested") {
    return { ...previous, cancellable: false, updatedAt: event.emittedAt };
  }
  if (event.type === "completed") {
    const completed = event.payload.succeededCount + event.payload.failedCount;
    return {
      ...previous,
      phase: "completed",
      status: event.payload.status,
      progress: {
        ...previous.progress,
        phase: "completed",
        completed,
        total: completed + event.payload.skippedCount,
      },
      cancellable: false,
      systemRecoveryLock: event.payload.systemRecoveryLock,
      ...(event.payload.resultRef === undefined ? {} : { resultRef: event.payload.resultRef }),
      updatedAt: event.emittedAt,
    };
  }
  return { ...previous, updatedAt: event.emittedAt };
}

type OperationTaskKind = "deployment" | "rollback";
type OperationTaskPhase =
  | "queued"
  | "preflight"
  | "backing_up"
  | "writing"
  | "restoring"
  | "verifying"
  | "rolling_back"
  | "completed";

class DesktopOperationTaskRecorder {
  readonly #taskEvents: DesktopTaskEvents;
  readonly #taskId: TaskId;
  readonly #taskKind: OperationTaskKind;
  readonly #resultRef: string;
  readonly #acceptedAt: string;
  readonly #recoveryDeploymentId: DeploymentRecordId;
  readonly #onRecoveryLockRequired: (deploymentRecordId: DeploymentRecordId) => void;
  readonly #onRecoveryRollbackSucceeded: (deploymentRecordId: DeploymentRecordId) => void;
  #operationTotal: number;
  readonly #now: () => string;
  #phase: OperationTaskPhase = "queued";
  #completed = false;
  readonly #lastProgressByPhase = new Map<OperationTaskPhase, number>();

  constructor(options: {
    readonly taskEvents: DesktopTaskEvents;
    readonly taskId: string;
    readonly taskKind: OperationTaskKind;
    readonly resultRef: string;
    readonly acceptedAt: string;
    readonly operationTotal: number;
    readonly now: () => string;
    readonly recoveryDeploymentId: DeploymentRecordId;
    readonly onRecoveryLockRequired: (deploymentRecordId: DeploymentRecordId) => void;
    readonly onRecoveryRollbackSucceeded?: (deploymentRecordId: DeploymentRecordId) => void;
  }) {
    this.#taskEvents = options.taskEvents;
    this.#taskId = TaskIdSchema.parse(options.taskId);
    this.#taskKind = options.taskKind;
    this.#resultRef = options.resultRef;
    this.#acceptedAt = options.acceptedAt;
    this.#recoveryDeploymentId = options.recoveryDeploymentId;
    this.#onRecoveryLockRequired = options.onRecoveryLockRequired;
    this.#onRecoveryRollbackSucceeded = options.onRecoveryRollbackSucceeded ?? (() => undefined);
    this.#operationTotal = options.operationTotal;
    this.#now = options.now;
  }

  get phase(): OperationTaskPhase {
    return this.#phase;
  }

  get operationTotal(): number {
    return this.#operationTotal;
  }

  get completed(): boolean {
    return this.#completed;
  }

  setOperationTotal(operationTotal: number): void {
    this.#operationTotal = operationTotal;
  }

  accept(): void {
    this.#taskEvents.record({
      taskId: this.#taskId,
      emittedAt: this.#acceptedAt,
      type: "accepted",
      payload: {
        taskKind: this.#taskKind,
        phase: "queued",
        acceptedAt: this.#acceptedAt,
      },
    });
  }

  changePhase(to: OperationTaskPhase): void {
    if (this.#completed) return;
    if (this.#phase === to) return;
    const from = this.#phase;
    this.#phase = to;
    this.#taskEvents.record({
      taskId: this.#taskId,
      emittedAt: nowFrom(this.#now),
      type: "phase.changed",
      payload: { from, to },
    });
  }

  progress(completed: number): void {
    if (this.#completed) return;
    const nextCompleted = Math.min(completed, this.#operationTotal);
    if (this.#lastProgressByPhase.get(this.#phase) === nextCompleted) return;
    this.#lastProgressByPhase.set(this.#phase, nextCompleted);
    this.#taskEvents.record({
      taskId: this.#taskId,
      emittedAt: nowFrom(this.#now),
      type: "progress",
      payload: {
        phase: this.#phase,
        completed: nextCompleted,
        total: this.#operationTotal,
        unit: "operations",
      },
    });
  }

  succeed(resultRef: string, succeededCount: number): void {
    if (this.#completed) return;
    this.changePhase("completed");
    if (this.#taskKind === "rollback") {
      this.#onRecoveryRollbackSucceeded(this.#recoveryDeploymentId);
    }
    this.#completed = true;
    this.#taskEvents.record({
      taskId: this.#taskId,
      emittedAt: nowFrom(this.#now),
      type: "completed",
      payload: {
        status: "succeeded",
        succeededCount,
        failedCount: 0,
        skippedCount: 0,
        resultRef,
        systemRecoveryLock: false,
      },
    });
  }

  fail(error: unknown, itemRef = this.#resultRef): void {
    if (this.#completed) return;
    this.recordFailure(errorCode(error), isRetryable(error), itemRef, taskFailureMessage(error));
    this.completeFailure("failed", itemRef);
  }

  failStatus(status: "failed" | "rolled_back", itemRef = this.#resultRef): void {
    if (this.#completed) return;
    this.recordFailure(
      status === "rolled_back" ? "DEPLOYMENT_ROLLED_BACK" : "VALIDATION_FAILED",
      false,
      itemRef,
    );
    this.completeFailure(status, itemRef);
  }

  private recordFailure(
    errorCodeValue: string,
    retryable: boolean,
    itemRef: string,
    message?: string,
  ): void {
    this.#taskEvents.record({
      taskId: this.#taskId,
      emittedAt: nowFrom(this.#now),
      type: "item.failed",
      payload: {
        itemRef,
        diagnosticId: `diagnostic:${this.#taskKind}:failure`,
        errorCode: errorCodeValue,
        ...(message === undefined ? {} : { message }),
        retryable,
      },
    });
  }

  private completeFailure(status: "failed" | "rolled_back", resultRef: string): void {
    const failedAfterWriting =
      this.#taskKind === "deployment" &&
      (this.#phase === "writing" || this.#phase === "verifying" || this.#phase === "rolling_back");
    const failedDuringRollback =
      this.#taskKind === "rollback" && (this.#phase === "restoring" || this.#phase === "verifying");
    const systemRecoveryLock = status === "failed" && (failedAfterWriting || failedDuringRollback);
    if (systemRecoveryLock) this.#onRecoveryLockRequired(this.#recoveryDeploymentId);
    if (failedAfterWriting && this.#phase !== "rolling_back") {
      this.changePhase("rolling_back");
    }
    this.changePhase("completed");
    this.#completed = true;
    this.#taskEvents.record({
      taskId: this.#taskId,
      emittedAt: nowFrom(this.#now),
      type: "completed",
      payload: {
        status,
        succeededCount: 0,
        failedCount: 1,
        skippedCount: 0,
        resultRef,
        systemRecoveryLock,
      },
    });
  }
}

function taskFailureMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message.trim().slice(0, 2_000).trim();
  return message.length === 0 ? undefined : message;
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : "INTERNAL_ERROR";
}

function isRetryable(error: unknown): boolean {
  return error instanceof AppError ? error.retryable : false;
}

function nowFrom(source: () => string): string {
  return IsoDateTimeSchema.parse(source());
}

function instrumentDeploymentFiles(
  port: DeploymentFilePort,
  recorder: DesktopOperationTaskRecorder,
  taskKind: OperationTaskKind,
): DeploymentFilePort {
  let backupCompleted = 0;
  let writeCompleted = 0;

  const finishBackup = () => {
    if (taskKind !== "deployment") return;
    if (recorder.phase === "preflight") recorder.changePhase("backing_up");
    if (recorder.phase === "backing_up") recorder.progress(recorder.operationTotal);
  };

  const beginWrite = () => {
    if (taskKind === "deployment") {
      finishBackup();
      if (recorder.phase === "backing_up") recorder.changePhase("writing");
    } else if (recorder.phase === "preflight") {
      recorder.changePhase("restoring");
    }
  };

  const recordWrite = () => {
    writeCompleted += 1;
    recorder.progress(writeCompleted);
  };

  return {
    async createBackup(input) {
      if (taskKind === "deployment" && recorder.phase === "preflight") {
        recorder.changePhase("backing_up");
      }
      const result = await port.createBackup(input);
      if (taskKind === "deployment") {
        backupCompleted += 1;
        recorder.progress(backupCompleted);
      }
      return result;
    },
    async atomicReplace(input) {
      beginWrite();
      const result = await port.atomicReplace(input);
      recordWrite();
      return result;
    },
    async copy(input) {
      beginWrite();
      const result = await port.copy(input);
      recordWrite();
      return result;
    },
    async createSymlink(input) {
      beginWrite();
      const result = await port.createSymlink(input);
      recordWrite();
      return result;
    },
    async remove(input) {
      beginWrite();
      await port.remove(input);
      recordWrite();
    },
  };
}

function instrumentDeploymentRead(
  read: AdapterReadApi,
  recorder: DesktopOperationTaskRecorder,
): AdapterReadApi {
  const beginVerify = () => {
    finishDeploymentWrites(recorder);
    if (recorder.phase === "writing") recorder.changePhase("verifying");
  };
  return {
    async realpath(path) {
      beginVerify();
      return read.realpath(path);
    },
    async stat(path) {
      beginVerify();
      return read.stat(path);
    },
    async list(path) {
      beginVerify();
      return read.list(path);
    },
    async readText(path) {
      beginVerify();
      return read.readText(path);
    },
    async snapshotFile(path) {
      beginVerify();
      return read.snapshotFile(path);
    },
  };
}

function finishDeploymentWork(recorder: DesktopOperationTaskRecorder): void {
  finishDeploymentWrites(recorder);
  if (recorder.phase === "writing") recorder.changePhase("verifying");
  if (recorder.phase === "verifying") recorder.progress(recorder.operationTotal);
}

function finishDeploymentWrites(recorder: DesktopOperationTaskRecorder): void {
  if (recorder.phase === "preflight") {
    recorder.changePhase("backing_up");
    recorder.progress(recorder.operationTotal);
  }
  if (recorder.phase === "backing_up") {
    recorder.progress(recorder.operationTotal);
    recorder.changePhase("writing");
  }
  if (recorder.phase === "writing") recorder.progress(recorder.operationTotal);
}

function finishRollbackWork(recorder: DesktopOperationTaskRecorder): void {
  if (recorder.phase === "preflight") recorder.changePhase("restoring");
  if (recorder.phase === "restoring") {
    recorder.progress(recorder.operationTotal);
    recorder.changePhase("verifying");
  }
  if (recorder.phase === "verifying") recorder.progress(recorder.operationTotal);
}

async function syncFileWatcher(
  runtime: DesktopRuntime,
  roots: readonly AbsolutePath[],
  services: Record<ApiCommandName, (payload: unknown) => Promise<unknown>>,
  taskRuntime: DesktopTaskRuntimeRegistry,
  indexChanges: DesktopIndexChanges,
): Promise<void> {
  const settings = await runtime.repositories.settings.getPublic();
  if (!settings.settings.fileWatching) {
    closeFileWatchers(runtime);
    return;
  }

  for (const requestedRoot of uniquePaths(roots)) {
    const root = AbsolutePathSchema.parse(await fsRealpath(requestedRoot));
    const key = watcherRootKey(root);
    const existing = runtime.fileWatchers.get(key);
    if (existing !== undefined) {
      existing.scanRoots.add(requestedRoot);
      continue;
    }
    const watcher = runtime.fileWatcherFactory({
      roots: [root],
      platform: scannerPlatform(),
      service: runtime.watchService.fork(),
      onBatch: (batch) =>
        handleWatchBatch(batch, key, runtime, services, taskRuntime, indexChanges),
    });
    runtime.fileWatchers.set(key, {
      root,
      scanRoots: new Set([requestedRoot]),
      watcher,
    });
    try {
      await watcher.start();
    } catch (error) {
      runtime.fileWatchers.delete(key);
      watcher.close();
      throw error;
    }
  }
}

function closeFileWatchers(runtime: DesktopRuntime): void {
  for (const { watcher } of runtime.fileWatchers.values()) watcher.close();
  runtime.fileWatchers.clear();
}

function watcherRootKey(root: AbsolutePath): string {
  const normalized = resolve(root);
  return platform() === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

async function handleWatchBatch(
  batch: WatchBatch,
  watcherKey: string,
  runtime: DesktopRuntime,
  services: Record<ApiCommandName, (payload: unknown) => Promise<unknown>>,
  taskRuntime: DesktopTaskRuntimeRegistry,
  indexChanges: DesktopIndexChanges,
): Promise<void> {
  const owner = runtime.fileWatchers.get(watcherKey);
  if (owner === undefined) return;
  if (batch.kind === "changes") {
    const changedPaths = batch.changedPaths.filter((changedPath) =>
      containsPath(owner.root, changedPath),
    );
    if (changedPaths.length === 0) return;
    const completedRoots: AbsolutePath[] = [];
    try {
      for (const scanRoot of owner.scanRoots) {
        await runWatcherScanWhenIdle(taskRuntime, services, {
          mode: "incremental",
          roots: [scanRoot],
          projectId: projectIdForAbsoluteRoot(scanRoot),
          changedPaths,
        });
        completedRoots.push(scanRoot);
      }
    } finally {
      publishIndexChanges(indexChanges, completedRoots);
    }
    return;
  }
  const completedRoots: AbsolutePath[] = [];
  try {
    for (const scanRoot of owner.scanRoots) {
      await runWatcherScanWhenIdle(taskRuntime, services, {
        mode: "full",
        roots: [scanRoot],
        projectId: projectIdForAbsoluteRoot(scanRoot),
      });
      completedRoots.push(scanRoot);
    }
  } finally {
    publishIndexChanges(indexChanges, completedRoots);
  }
}

async function runWatcherScanWhenIdle(
  taskRuntime: DesktopTaskRuntimeRegistry,
  services: Record<ApiCommandName, (payload: unknown) => Promise<unknown>>,
  request: DesktopScanRequest,
): Promise<void> {
  for (;;) {
    await taskRuntime.waitForIdle();
    try {
      const accepted = await services["scan.start"](request);
      await taskRuntime.waitForCompletion(taskIdFromAcceptedTask(accepted));
      return;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "CONFLICT") throw error;
    }
  }
}

function taskIdFromAcceptedTask(value: unknown): TaskId {
  if (typeof value !== "object" || value === null || !("taskId" in value)) {
    throw new TypeError("Task acceptance response is missing a task id");
  }
  return TaskIdSchema.parse(value.taskId);
}

function publishIndexChanges(
  indexChanges: DesktopIndexChanges,
  roots: readonly AbsolutePath[],
): void {
  if (roots.length === 0) return;
  indexChanges.record(roots);
}

function scanRoots(
  requestRoots: readonly string[] | undefined,
  cwd: AbsolutePath,
  homeDirectory: AbsolutePath,
): readonly AbsolutePath[] {
  if ((requestRoots?.length ?? 0) > 0) {
    return uniquePaths((requestRoots ?? []).map((root) => AbsolutePathSchema.parse(resolve(root))));
  }
  return uniquePaths([...projectRootChain(cwd), homeDirectory]);
}

async function canonicalScanRoots(
  roots: readonly AbsolutePath[],
): Promise<readonly AbsolutePath[]> {
  return uniquePaths(
    await Promise.all(roots.map(async (root) => AbsolutePathSchema.parse(await fsRealpath(root)))),
  );
}

function changedScanPaths(
  requestPaths: readonly string[] | undefined,
  cwd: AbsolutePath,
): readonly AbsolutePath[] | undefined {
  if (requestPaths === undefined || requestPaths.length === 0) return undefined;
  return uniquePaths(requestPaths.map((path) => AbsolutePathSchema.parse(resolve(cwd, path))));
}

function uniquePaths(paths: readonly AbsolutePath[]): readonly AbsolutePath[] {
  return [...new Set(paths)].sort();
}

function projectRootChain(cwd: AbsolutePath): readonly AbsolutePath[] {
  const gitRoot = nearestGitRoot(cwd);
  if (gitRoot === undefined) return [cwd];

  const roots: AbsolutePath[] = [];
  let cursor = cwd;
  for (;;) {
    roots.push(cursor);
    if (cursor === gitRoot) return roots;
    const parent = AbsolutePathSchema.parse(dirname(cursor));
    if (parent === cursor) return roots;
    cursor = parent;
  }
}

function nearestGitRoot(cwd: AbsolutePath): AbsolutePath | undefined {
  let cursor = cwd;
  for (;;) {
    if (existsSync(join(cursor, ".git"))) return cursor;
    const parent = AbsolutePathSchema.parse(dirname(cursor));
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function scopeKindsForAssets(
  runtime: DesktopRuntime,
  assets: readonly { readonly scopeId: string }[],
): ReadonlyMap<string, ScopeKind> {
  if (assets.length === 0) return new Map();
  const scopeIds = new Set(assets.map(({ scopeId }) => scopeId));
  const rows = runtime.repositories.database
    .prepare("SELECT domain_id, scope_kind FROM scopes")
    .all() as {
    domain_id: string;
    scope_kind: string;
  }[];
  return new Map(
    rows
      .filter(({ domain_id }) => scopeIds.has(domain_id))
      .map(({ domain_id, scope_kind }) => [domain_id, ScopeKindSchema.parse(scope_kind)]),
  );
}

type AssetDisablementOption = {
  readonly method: "native" | "move_file" | "remove_config_entry" | "hub_ignore";
  readonly label: string;
  readonly description: string;
  readonly recommended: boolean;
};

function disablementOptionsForAsset(asset: Asset): readonly AssetDisablementOption[] {
  const hubIgnore = {
    method: "hub_ignore",
    label: "Ignore inside AI Config Hub only",
    description: "Keep the tool configuration unchanged and ignore the asset in Hub.",
  } as const satisfies Omit<AssetDisablementOption, "recommended">;
  const options: Omit<AssetDisablementOption, "recommended">[] = [hubIgnore];
  const native = nativeDisablementOption(asset);
  if (native !== undefined) options.push(native);
  if (asset.resource.kind === "mcp") {
    options.push({
      method: "remove_config_entry",
      label: "Remove the configuration entry",
      description:
        "Remove this server entry from the tool configuration and keep a Hub manifest record for recovery.",
    });
  } else if (isFileDisablementAsset(asset)) {
    options.push({
      method: "move_file",
      ...(asset.resource.kind === "skill"
        ? {
            label: "Move package out of the tool load path",
            description:
              "Move the Skill package directory into the AI Config Hub disabled-assets area.",
          }
        : {
            label: "Move file out of the tool load path",
            description: "Move the source file into the AI Config Hub disabled-assets area.",
          }),
    });
  }

  return options.map((option, index) => ({ ...option, recommended: index === 0 }));
}

function nativeDisablementOption(
  asset: Asset,
): Omit<AssetDisablementOption, "recommended"> | undefined {
  if (!isOpenCodeConfigAsset(asset)) return undefined;
  if (asset.resource.kind === "agent") {
    return {
      method: "native",
      label: "Set OpenCode Agent disable to true",
      description: "Write disable=true for this Agent in the OpenCode configuration.",
    };
  }
  if (asset.resource.kind === "mcp") {
    return {
      method: "native",
      label: "Set OpenCode MCP enabled to false",
      description: "Write enabled=false for this MCP server in the OpenCode configuration.",
    };
  }
  return undefined;
}

function isOpenCodeConfigAsset(asset: Asset): boolean {
  return (
    asset.toolId === "opencode" &&
    (asset.resource.kind === "agent" || asset.resource.kind === "mcp") &&
    basename(asset.canonicalSourcePath).startsWith("opencode.json")
  );
}

function isFileDisablementAsset(asset: Asset): boolean {
  return (
    (asset.resource.kind === "rule" ||
      asset.resource.kind === "agent" ||
      asset.resource.kind === "skill") &&
    !isOpenCodeConfigAsset(asset)
  );
}

type AssetListLoadState = {
  readonly loadState: "loaded" | "covered" | "disabled";
  readonly coveredByAssetId?: Asset["assetId"];
  readonly coveredByLogicalKey?: string;
};

async function assetLoadStates(
  runtime: DesktopRuntime,
  listedAssets: readonly Asset[],
): Promise<ReadonlyMap<string, AssetListLoadState>> {
  const allAssets = await listAllAssets(runtime);
  const assetsById = new Map(
    [...allAssets, ...listedAssets].map((asset) => [asset.assetId, asset]),
  );
  const states = new Map<string, AssetListLoadState>();
  for (const asset of assetsById.values()) {
    if (asset.status === "disabled") states.set(asset.assetId, { loadState: "disabled" });
  }

  for (const config of latestEffectiveConfigs(runtime)) {
    for (const step of config.steps) {
      const asset = assetsById.get(step.assetId);
      if (asset === undefined) continue;
      const current = states.get(asset.assetId);
      if (current?.loadState === "disabled") continue;
      if (step.action === "ignore") {
        const coveredByAsset =
          step.coveredByAssetId === undefined ? undefined : assetsById.get(step.coveredByAssetId);
        states.set(asset.assetId, {
          loadState: "covered",
          ...(step.coveredByAssetId === undefined
            ? {}
            : { coveredByAssetId: step.coveredByAssetId }),
          ...(coveredByAsset === undefined ? {} : { coveredByLogicalKey: coveredByAsset.locator }),
        });
      } else if (current === undefined) {
        states.set(asset.assetId, { loadState: "loaded" });
      }
    }
  }

  for (const asset of listedAssets) {
    if (!states.has(asset.assetId)) states.set(asset.assetId, { loadState: "loaded" });
  }
  return states;
}

function latestEffectiveConfigs(runtime: DesktopRuntime) {
  const rows = runtime.repositories.database
    .prepare("SELECT effective_configs_json FROM scan_runs ORDER BY started_at DESC, rowid DESC")
    .all() as { readonly effective_configs_json: string }[];
  const latestByInstallationTarget = new Map<
    string,
    ReturnType<typeof EffectiveConfigSchema.parse>
  >();
  for (const row of rows) {
    const configs = EffectiveConfigSchema.array().parse(JSON.parse(row.effective_configs_json));
    for (const config of configs) {
      const key = `${config.toolInstallationId}\0${config.canonicalTargetPath}`;
      if (!latestByInstallationTarget.has(key)) latestByInstallationTarget.set(key, config);
    }
  }
  return [...latestByInstallationTarget.values()];
}

function assetLoadStateFields(state: AssetListLoadState | undefined): AssetListLoadState {
  return state ?? { loadState: "loaded" };
}

function sourceFileViews(asset: Asset) {
  return [...asset.sourceFiles].sort(compareSourceFiles).map((sourceFile) => ({
    pathDisplay: sourceFile.path,
    relativePath: sourceFile.relativePath,
    role: sourceFile.role,
    mediaType: sourceFile.mediaType,
    isText: sourceFile.isText,
    contentHash: sourceFile.contentHash,
  }));
}

function assetSourceSummary(asset: Asset) {
  const primary = asset.sourceFiles.find(({ role }) => role === "primary") ?? asset.sourceFiles[0];
  if (primary === undefined) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: `Asset has no source files: ${asset.assetId}`,
      retryable: false,
      suggestedActions: ["Run a fresh scan before reviewing this asset"],
    });
  }
  if (asset.sourceFiles.length === 1) {
    return {
      kind: "file" as const,
      fileName: basename(primary.path),
      mediaType: primary.mediaType,
      isText: primary.isText,
    };
  }

  const roleCounts = { primary: 0, metadata: 0, support: 0 };
  let textCount = 0;
  const folders = new Set<string>();
  for (const sourceFile of asset.sourceFiles) {
    roleCounts[sourceFile.role] += 1;
    if (sourceFile.isText) textCount += 1;
    const segments = sourceFile.relativePath.split(/[\\/]/).slice(0, -1);
    for (let index = 1; index <= segments.length; index += 1) {
      folders.add(segments.slice(0, index).join("/"));
    }
  }

  return {
    kind: "package" as const,
    rootName: asset.nativeIdentity.directoryName ?? basename(dirname(primary.path)),
    fileCount: asset.sourceFiles.length,
    folderCount: folders.size,
    textCount,
    binaryCount: asset.sourceFiles.length - textCount,
    roleCounts,
  };
}

function compareSourceFiles(
  left: Asset["sourceFiles"][number],
  right: Asset["sourceFiles"][number],
): number {
  const leftRole = SOURCE_FILE_ROLE_ORDER.get(left.role) ?? SOURCE_FILE_ROLE_ORDER.size;
  const rightRole = SOURCE_FILE_ROLE_ORDER.get(right.role) ?? SOURCE_FILE_ROLE_ORDER.size;
  return leftRole === rightRole
    ? left.relativePath.localeCompare(right.relativePath)
    : leftRole - rightRole;
}

function primarySourcePath(asset: Asset): AbsolutePath {
  return AbsolutePathSchema.parse(
    asset.sourceFiles.find((sourceFile) => sourceFile.role === "primary")?.path ??
      asset.canonicalSourcePath,
  );
}

function sourcePackageRoots(assets: readonly Asset[]): readonly AbsolutePath[] {
  return [
    ...new Set(
      assets.map((asset) => {
        const primary = asset.sourceFiles.find((sourceFile) => sourceFile.role === "primary");
        return dirname(primary?.path ?? asset.canonicalSourcePath);
      }),
    ),
  ].map((root) => AbsolutePathSchema.parse(root));
}

async function currentAssetSourceHash(
  runtime: DesktopRuntime,
  assetId: string,
): Promise<ContentHash | undefined> {
  const asset = await runtime.repositories.index.getAsset(AssetIdSchema.parse(assetId));
  if (asset === undefined) return undefined;
  return asset.resource.kind === "skill"
    ? currentSkillPackageHash(asset)
    : currentSourceFileHash(primarySourcePath(asset));
}

async function currentSourceFileHash(path: AbsolutePath): Promise<ContentHash | undefined> {
  const allowedRoot = existingAncestor(dirname(path));
  const access = await createNodeFileAccess({
    allowedRoots: [allowedRoot],
    platform: platform(),
  });
  return (await access.read.snapshotFile(path))?.contentHash;
}

async function currentSkillPackageHash(asset: Asset): Promise<ContentHash | undefined> {
  const packageRoot = AbsolutePathSchema.parse(dirname(primarySourcePath(asset)));
  if (!isExistingDirectory(packageRoot)) return undefined;
  const access = await createNodeFileAccess({
    allowedRoots: [packageRoot],
    platform: platform(),
  });
  try {
    const enumeration = await enumerateSkillPackageSourceFiles({
      packageRoot,
      read: access.read,
      signal: createCancellationController().signal,
    });
    return enumeration.status === "complete" ? enumeration.contentHash : undefined;
  } catch (error) {
    if (isMissingSourceError(error)) return undefined;
    throw error;
  }
}

function isExistingDirectory(path: AbsolutePath): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (isMissingSourceError(error)) return false;
    throw error;
  }
}

function isMissingSourceError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function scanRegistrations(
  registrations: Readonly<Partial<Record<string, AdapterRegistration>>>,
  toolKeys: readonly string[] | undefined,
): readonly AdapterRegistration[] {
  const selected = toolKeys === undefined ? undefined : new Set(toolKeys);
  return Object.values(registrations).filter(
    (item): item is AdapterRegistration =>
      item !== undefined && (selected === undefined || selected.has(item.toolId)),
  );
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (item === undefined) return false;
      return !Array.isArray(item) || item.length > 0;
    }),
  ) as T;
}

function now(runtime: DesktopRuntime): string {
  return IsoDateTimeSchema.parse(runtime.now());
}

function notFound(message: string): AppError {
  return new AppError({
    code: "NOT_FOUND",
    message,
    retryable: false,
    suggestedActions: ["Refresh the local index and retry"],
  });
}

function taskNotCancellable(taskId: TaskId): AppError {
  return new AppError({
    code: "TASK_NOT_CANCELLABLE",
    message: "The scan task is no longer cancellable",
    retryable: false,
    suggestedActions: ["Start a new scan if another refresh is needed"],
    taskId,
  });
}

function operationCleanupConflict(message: string, activeTaskKinds?: string): AppError {
  return new AppError({
    code: "CONFLICT",
    message,
    retryable: true,
    suggestedActions: ["Wait for the active operation to finish, then retry"],
    ...(activeTaskKinds === undefined ? {} : { safeContext: { activeTaskKinds } }),
  });
}

function operationAlreadyRunningConflict(operationKey: string): AppError {
  return new AppError({
    code: "CONFLICT",
    message: "The requested operation is already running",
    retryable: true,
    suggestedActions: ["Wait for the active operation to finish, then retry"],
    safeContext: { operationKey },
  });
}

function deploymentStateChangedConflict(deploymentRecordId: DeploymentRecordId): AppError {
  return new AppError({
    code: "CONFLICT",
    message: "The deployment plan is no longer ready to execute",
    retryable: true,
    suggestedActions: ["Create a fresh deployment preview and retry"],
    safeContext: { deploymentRecordId },
  });
}

function recoveryRequiredConflict(deploymentRecordIds: readonly DeploymentRecordId[]): AppError {
  return new AppError({
    code: "CONFLICT",
    message: "A recovery rollback must succeed before another deployment can start",
    retryable: true,
    suggestedActions: ["Roll back the failed deployment, then retry the new deployment"],
    safeContext: { recoveryDeploymentId: [...deploymentRecordIds].sort().join(",") },
  });
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function unsupported(message: string): AppError {
  return new AppError({
    code: "UNSUPPORTED_CONVERSION",
    message,
    retryable: false,
    suggestedActions: ["Run a fresh scan and use a supported command"],
  });
}

function apiScanStatus(status: string) {
  if (status === "queued") return "queued";
  if (["succeeded", "partially_succeeded", "cancelled", "failed"].includes(status)) return status;
  return "running";
}

function scannerPlatform(): "linux" | "darwin" | "win32" {
  const current = platform();
  if (current === "darwin" || current === "win32") return current;
  return "linux";
}

function apiPhase(phase: string) {
  if (
    ["discovering", "reading", "parsing", "validating", "committing", "completed"].includes(phase)
  ) {
    return phase as
      | "discovering"
      | "reading"
      | "parsing"
      | "validating"
      | "committing"
      | "completed";
  }
  return phase === "queued" ? "queued" : "discovering";
}

function diagnosticsPage(page: Page<Diagnostic>) {
  const countsBySeverity = { info: 0, warning: 0, error: 0 };
  for (const item of page.items) countsBySeverity[item.severity] += 1;
  return {
    items: page.items.map(diagnosticView),
    nextCursor: page.nextCursor ?? null,
    countsBySeverity,
    snapshotRevision: page.snapshotRevision,
  };
}

function diagnosticView(item: Diagnostic) {
  return {
    id: item.diagnosticId,
    code: item.code,
    severity: item.severity,
    ...(item.subject.kind === "asset" ? { assetId: AssetIdSchema.parse(item.subject.id) } : {}),
    ...(item.location === undefined
      ? {}
      : {
          location: {
            pathDisplay: item.location.path,
            ...(item.location.line === undefined ? {} : { line: item.location.line }),
            ...(item.location.column === undefined ? {} : { column: item.location.column }),
          },
        }),
    message: item.message,
    suggestedAction: item.suggestedActions[0] ?? "Review the diagnostic",
    blocking: item.blocking,
  };
}

function assertDiagnosticReportSize(report: ReturnType<typeof createDiagnosticReport>): void {
  const contentBytes = Buffer.byteLength(report.content, "utf8");
  const responseBytes = Buffer.byteLength(JSON.stringify(report), "utf8");
  if (
    report.content.length > DIAGNOSTIC_REPORT_MAX_BYTES ||
    contentBytes > DIAGNOSTIC_REPORT_MAX_BYTES ||
    responseBytes > DIAGNOSTIC_REPORT_MAX_BYTES
  ) {
    throw diagnosticExportTooLarge(
      `Diagnostic export exceeds the ${String(DIAGNOSTIC_REPORT_MAX_BYTES)} byte response limit`,
    );
  }
}

function diagnosticExportTooLarge(message: string): AppError {
  return new AppError({
    code: "PREVIEW_TOO_LARGE",
    message,
    retryable: false,
    suggestedActions: ["Narrow the diagnostic filters and export again"],
  });
}

type DiagnosticFilterRequest = Pick<
  CommandRequest<"diagnostics.export">,
  "from" | "projectId" | "taskId" | "to" | "toolKeys"
> & {
  readonly codes?: readonly string[];
};

interface DiagnosticFilterContext {
  readonly assetsById: ReadonlyMap<string, Asset>;
  readonly assetsByPath: ReadonlyMap<string, Asset>;
  readonly scopeOwnership: readonly DiagnosticScopeOwnership[];
  readonly diagnosticOwnership: ReadonlyMap<string, DiagnosticOwnership>;
}

interface DiagnosticScopeOwnership {
  readonly rootPath: AbsolutePath;
  readonly toolId: ReturnType<typeof ToolIdSchema.parse>;
  readonly projectId: ProjectId | null;
}

interface DiagnosticOwnership {
  readonly taskId?: ReturnType<typeof TaskIdSchema.parse>;
  readonly toolId?: ReturnType<typeof ToolIdSchema.parse>;
  readonly projectId?: ProjectId;
}

interface DiagnosticRepositoryQuery {
  readonly assetId?: ReturnType<typeof AssetIdSchema.parse>;
  readonly severity?: readonly ReturnType<typeof DiagnosticSeveritySchema.parse>[];
  readonly cursor?: ReturnType<typeof PaginationCursorSchema.parse>;
}

interface FilteredDiagnosticsSnapshot {
  readonly items: readonly Diagnostic[];
  readonly snapshotRevision: string;
}

async function readFilteredDiagnosticsSnapshot(
  runtime: DesktopRuntime,
  input: {
    readonly repositoryQuery: DiagnosticRepositoryQuery;
    readonly filter: DiagnosticFilterRequest;
    readonly taskDiagnosticIds?: ReadonlySet<string>;
    readonly matchLimit: number;
  },
): Promise<FilteredDiagnosticsSnapshot> {
  for (let attempt = 0; attempt < INDEX_SNAPSHOT_READ_ATTEMPTS; attempt += 1) {
    const expectedRevision = databaseRevision(runtime);
    const assets = await tryListAllAssetsAtRevision(runtime, expectedRevision);
    if (assets === undefined) continue;
    const context = diagnosticFilterContext(runtime, assets);
    if (databaseRevision(runtime) !== expectedRevision) continue;

    const items: Diagnostic[] = [];
    const seenCursors = new Set<string>();
    let cursor = input.repositoryQuery.cursor;
    if (cursor !== undefined) seenCursors.add(cursor);
    let changedDuringRead = false;
    while (items.length < input.matchLimit) {
      const page = await runtime.repositories.index.listDiagnostics({
        ...(input.repositoryQuery.assetId === undefined
          ? {}
          : { assetId: input.repositoryQuery.assetId }),
        ...(input.repositoryQuery.severity === undefined
          ? {}
          : { severity: input.repositoryQuery.severity }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: INTERNAL_PAGE_SIZE,
      });
      if (page.snapshotRevision !== expectedRevision) {
        changedDuringRead = true;
        break;
      }
      for (const diagnostic of page.items) {
        if (includeDiagnostic(diagnostic, input.filter, context, input.taskDiagnosticIds)) {
          items.push(diagnostic);
          if (items.length === input.matchLimit) break;
        }
      }
      if (items.length === input.matchLimit || page.nextCursor === undefined) break;
      if (seenCursors.has(page.nextCursor)) throw repeatedPaginationCursor("diagnostic");
      cursor = page.nextCursor;
      seenCursors.add(cursor);
    }
    if (changedDuringRead || databaseRevision(runtime) !== expectedRevision) continue;
    return { items, snapshotRevision: expectedRevision };
  }
  throw indexChangedDuringRead("diagnostic");
}

async function listAllAssets(runtime: DesktopRuntime): Promise<readonly Asset[]> {
  for (let attempt = 0; attempt < INDEX_SNAPSHOT_READ_ATTEMPTS; attempt += 1) {
    const expectedRevision = databaseRevision(runtime);
    const assets = await tryListAllAssetsAtRevision(runtime, expectedRevision);
    if (assets !== undefined && databaseRevision(runtime) === expectedRevision) return assets;
  }
  throw indexChangedDuringRead("asset");
}

async function tryListAllAssetsAtRevision(
  runtime: DesktopRuntime,
  expectedRevision: string,
): Promise<readonly Asset[] | undefined> {
  const assets: Asset[] = [];
  const seenCursors = new Set<string>();
  let cursor: ReturnType<typeof PaginationCursorSchema.parse> | undefined;
  do {
    const page = await runtime.repositories.index.listAssets({
      limit: 10_000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page.snapshotRevision !== expectedRevision) return undefined;
    assets.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined && seenCursors.has(cursor)) {
      throw repeatedPaginationCursor("asset");
    }
    if (cursor !== undefined) seenCursors.add(cursor);
  } while (cursor !== undefined);
  return assets;
}

function repeatedPaginationCursor(kind: "asset" | "diagnostic"): AppError {
  return new AppError({
    code: "INTERNAL_ERROR",
    message: `The ${kind} repository returned a repeated pagination cursor`,
    retryable: true,
    suggestedActions: ["Run a fresh scan and try again"],
  });
}

function indexChangedDuringRead(kind: "asset" | "diagnostic" | "effective"): AppError {
  return new AppError({
    code: "CONFLICT",
    message: `The ${kind} index changed repeatedly while it was being read`,
    retryable: true,
    suggestedActions: ["Wait for active scans to finish and try again"],
  });
}

function diagnosticFilterContext(
  runtime: DesktopRuntime,
  assets: readonly Asset[],
): DiagnosticFilterContext {
  const diagnosticRows = runtime.repositories.database
    .prepare(
      `SELECT
        diagnostics.id AS diagnostic_id,
        scan_runs.task_id AS task_id,
        scan_projects.domain_id AS scan_project_id,
        asset_tools.tool_key AS asset_tool_key,
        asset_projects.domain_id AS asset_project_id
      FROM diagnostics
      LEFT JOIN scan_runs ON scan_runs.id = diagnostics.scan_run_id
      LEFT JOIN projects AS scan_projects ON scan_projects.id = scan_runs.project_id
      LEFT JOIN assets ON assets.id = diagnostics.asset_id
      LEFT JOIN tools AS asset_tools ON asset_tools.id = assets.tool_id
      LEFT JOIN scopes AS asset_scopes ON asset_scopes.id = assets.scope_id
      LEFT JOIN projects AS asset_projects ON asset_projects.id = asset_scopes.project_id`,
    )
    .all() as {
    readonly diagnostic_id: string;
    readonly task_id: string | null;
    readonly scan_project_id: string | null;
    readonly asset_tool_key: string | null;
    readonly asset_project_id: string | null;
  }[];
  const scopeRows = runtime.repositories.database
    .prepare(
      `SELECT
        scopes.root_path_normalized AS root_path,
        tools.tool_key AS tool_key,
        projects.domain_id AS project_id
      FROM scopes
      JOIN tools ON tools.id = scopes.tool_id
      LEFT JOIN projects ON projects.id = scopes.project_id`,
    )
    .all() as {
    readonly root_path: string;
    readonly tool_key: string;
    readonly project_id: string | null;
  }[];
  return {
    assetsById: new Map(assets.map((asset) => [asset.assetId, asset])),
    assetsByPath: new Map(assets.map((asset) => [asset.canonicalSourcePath, asset])),
    diagnosticOwnership: new Map(
      diagnosticRows.map((row) => [
        row.diagnostic_id,
        {
          ...(row.task_id === null ? {} : { taskId: TaskIdSchema.parse(row.task_id) }),
          ...(row.asset_tool_key === null
            ? {}
            : { toolId: ToolIdSchema.parse(row.asset_tool_key) }),
          ...(row.asset_project_id === null && row.scan_project_id === null
            ? {}
            : { projectId: ProjectIdSchema.parse(row.asset_project_id ?? row.scan_project_id) }),
        },
      ]),
    ),
    scopeOwnership: scopeRows
      .map((row) => ({
        rootPath: AbsolutePathSchema.parse(row.root_path),
        toolId: ToolIdSchema.parse(row.tool_key),
        projectId: row.project_id === null ? null : ProjectIdSchema.parse(row.project_id),
      }))
      .sort((left, right) => right.rootPath.length - left.rootPath.length),
  };
}

function includeDiagnostic(
  diagnostic: Diagnostic,
  request: DiagnosticFilterRequest,
  context: DiagnosticFilterContext,
  taskDiagnosticIds: ReadonlySet<string> | undefined,
): boolean {
  const ownership = diagnosticOwnership(diagnostic, context);
  if (
    taskDiagnosticIds !== undefined &&
    ownership.taskId !== request.taskId &&
    !taskDiagnosticIds.has(diagnostic.diagnosticId)
  ) {
    return false;
  }
  const createdAt = Date.parse(diagnostic.createdAt);
  if (request.from !== undefined && createdAt < Date.parse(request.from)) return false;
  if (request.to !== undefined && createdAt > Date.parse(request.to)) return false;
  if (request.codes !== undefined && !request.codes.includes(diagnostic.code)) return false;
  if (request.toolKeys !== undefined) {
    const tools = new Set(request.toolKeys);
    if (ownership.toolId === undefined || !tools.has(ownership.toolId)) return false;
  }
  if (request.projectId !== undefined) {
    if (ownership.projectId !== request.projectId) return false;
  }
  return true;
}

function diagnosticOwnership(
  diagnostic: Diagnostic,
  context: DiagnosticFilterContext,
): DiagnosticOwnership {
  const stored = context.diagnosticOwnership.get(diagnostic.diagnosticId) ?? {};
  const evidenced = evidenceDiagnosticOwnership(diagnostic);
  const asset =
    diagnostic.subject.kind === "asset"
      ? context.assetsById.get(diagnostic.subject.id)
      : diagnostic.location === undefined
        ? undefined
        : context.assetsByPath.get(diagnostic.location.path);
  if (asset !== undefined) {
    const scopedProjectId = scopeOwnershipForPath(asset.canonicalSourcePath, context)?.projectId;
    const projectId = scopedProjectId ?? stored.projectId ?? evidenced.projectId;
    return {
      ...stored,
      ...evidenced,
      toolId: asset.toolId,
      ...(projectId === undefined ? {} : { projectId }),
    };
  }
  const scoped =
    diagnostic.location === undefined
      ? undefined
      : scopeOwnershipForPath(diagnostic.location.path, context);
  const toolId = stored.toolId ?? evidenced.toolId ?? scoped?.toolId;
  const projectId =
    stored.projectId ??
    evidenced.projectId ??
    (scoped?.projectId === null ? undefined : scoped?.projectId);
  return {
    ...stored,
    ...(toolId === undefined ? {} : { toolId }),
    ...(projectId === undefined ? {} : { projectId }),
  };
}

function evidenceDiagnosticOwnership(diagnostic: Diagnostic): DiagnosticOwnership {
  const evidence = diagnostic.evidence;
  const toolId =
    typeof evidence["toolId"] === "string" ? ToolIdSchema.safeParse(evidence["toolId"]) : undefined;
  const projectRoot =
    typeof evidence["projectRoot"] === "string"
      ? projectIdFromEvidenceRoot(evidence["projectRoot"])
      : undefined;
  return {
    ...(toolId?.success === true ? { toolId: toolId.data } : {}),
    ...(projectRoot === undefined ? {} : { projectId: projectRoot }),
  };
}

function projectIdFromEvidenceRoot(value: string): ProjectId | undefined {
  const absoluteRoot = AbsolutePathSchema.safeParse(value);
  if (absoluteRoot.success) return projectIdForAbsoluteRoot(absoluteRoot.data);
  const existing = ProjectIdSchema.safeParse(value);
  return existing.success ? existing.data : undefined;
}

function projectIdForAbsoluteRoot(root: AbsolutePath): ProjectId {
  return ProjectIdSchema.parse(stableId("project", [root]));
}

function scopeOwnershipForPath(
  path: string,
  context: DiagnosticFilterContext,
): DiagnosticScopeOwnership | undefined {
  return context.scopeOwnership.find(
    (scope) => path === scope.rootPath || path.startsWith(`${scope.rootPath}/`),
  );
}

function listFilterRequest(request: CommandRequest<"diagnostics.list">): DiagnosticFilterRequest {
  return {
    ...(request.projectId === undefined
      ? {}
      : { projectId: ProjectIdSchema.parse(request.projectId) }),
    ...(request.toolKeys === undefined ? {} : { toolKeys: request.toolKeys }),
    ...(request.codes === undefined ? {} : { codes: request.codes }),
  };
}

function diagnosticReportPathRoots(
  runtime: DesktopRuntime,
  cwd: AbsolutePath,
): readonly DiagnosticReportPathRoot[] {
  const projectRows = runtime.repositories.database
    .prepare("SELECT root_path_normalized FROM projects")
    .all() as { readonly root_path_normalized: string }[];
  const roots = [
    { label: "<project>", path: cwd },
    ...projectRows.map((row) => ({ label: "<project>", path: row.root_path_normalized })),
    { label: "<backup-root>", path: runtime.backupRoot },
    { label: "<app-data>", path: runtime.appDataRoot },
  ];
  return uniqueReportPathRoots(roots);
}

function uniqueReportPathRoots(
  roots: readonly DiagnosticReportPathRoot[],
): readonly DiagnosticReportPathRoot[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = `${root.label}\0${root.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveEffectiveView(
  runtime: DesktopRuntime,
  registry: AdapterRegistry,
  request: CommandRequest<"effective.resolve">,
) {
  const targetPath = AbsolutePathSchema.parse(resolve(request.targetScopeId));
  const resourceKinds =
    request.resourceTypes === undefined
      ? undefined
      : request.resourceTypes.map((resourceType) => ResourceKindSchema.parse(resourceType));
  for (let attempt = 0; attempt < INDEX_SNAPSHOT_READ_ATTEMPTS; attempt += 1) {
    const expectedRevision = databaseRevision(runtime);
    const matchingTools = toolInstallations(runtime).filter(
      (installation) => installation.toolId === request.toolKey,
    );
    const allScopes = await runtime.repositories.index.listScopes();
    const allAssets = await tryListAllAssetsAtRevision(runtime, expectedRevision);
    if (allAssets === undefined || databaseRevision(runtime) !== expectedRevision) continue;
    const tool =
      matchingTools.find((installation) =>
        installation.configRoots.some(
          (root) => containsPath(root, targetPath) || containsPath(targetPath, root),
        ),
      ) ?? matchingTools[0];
    if (tool === undefined) throw notFound("Effective configuration not found");
    const scopes = allScopes.filter((scope) => scope.toolId === tool.toolId);
    const assets = allAssets.filter((asset) => asset.toolId === tool.toolId);
    const enabledAssets = assets.filter((asset) => asset.status !== "disabled");
    const adapter = registry.create(tool.toolId, { debug() {}, warn() {} });
    const cancellation = createCancellationController();
    const resolution = await adapter.resolveEffective({
      tool,
      targetPath,
      assets: enabledAssets,
      scopes,
      ...(resourceKinds === undefined ? {} : { resourceKinds }),
      signal: cancellation.signal,
    });
    if (databaseRevision(runtime) !== expectedRevision) continue;
    const draft = withDisabledAssetsAsIgnored(
      resolution.draft,
      disabledApplicableAssets(assets, scopes, tool.toolId, targetPath, resourceKinds),
    );
    const resources =
      resourceKinds === undefined
        ? draft.resolvedResources
        : draft.resolvedResources.filter((resource) => resourceKinds.includes(resource.kind));
    const contributors = draft.steps
      .filter((step) => step.action !== "ignore")
      .map((step) => ({
        assetId: step.assetId,
        action: step.action,
        reasonCode: reasonCode(step.reason),
      }));
    const ignored = draft.steps
      .filter((step) => step.action === "ignore")
      .map((step) => ({
        assetId: step.assetId,
        reasonCode: reasonCode(step.reason),
        ...(step.coveredByAssetId === undefined ? {} : { coveredByAssetId: step.coveredByAssetId }),
      }));
    assertEffectiveResponseArrayBound("contributors", contributors.length);
    assertEffectiveResponseArrayBound("ignored", ignored.length);
    return {
      effective: toJson(resources),
      contributors,
      ignored,
      diagnostics: [],
      snapshotRevision: expectedRevision,
    };
  }
  throw indexChangedDuringRead("effective");
}

export function assertEffectiveResponseArrayBound(name: string, count: number): void {
  if (count <= EFFECTIVE_RESPONSE_ARRAY_LIMIT) return;
  throw new AppError({
    code: "PREVIEW_TOO_LARGE",
    message: `Effective configuration has more than ${String(EFFECTIVE_RESPONSE_ARRAY_LIMIT)} ${name}`,
    retryable: false,
    suggestedActions: ["Narrow the selected resource types or target scope and try again"],
  });
}

function toolInstallations(runtime: DesktopRuntime): readonly ToolInstallation[] {
  const rows = runtime.repositories.database
    .prepare(
      `SELECT tool_key, tool_installation_id, canonical_config_root, detected_version, capabilities_json
       FROM tools
       WHERE is_detected = 1
       ORDER BY tool_installation_id`,
    )
    .all() as {
    readonly tool_key: string;
    readonly tool_installation_id: string;
    readonly canonical_config_root: string;
    readonly detected_version: string | null;
    readonly capabilities_json: string;
  }[];
  return rows.map((row) => ({
    toolId: ToolIdSchema.parse(row.tool_key),
    installationId: ToolInstallationIdSchema.parse(row.tool_installation_id),
    ...(row.detected_version === null
      ? {}
      : { detectedVersion: SemVerSchema.parse(row.detected_version) }),
    configRoots: [AbsolutePathSchema.parse(row.canonical_config_root)],
    evidence: JSON.parse(row.capabilities_json) as Readonly<Record<string, unknown>>,
  }));
}

function disabledApplicableAssets(
  assets: readonly Asset[],
  scopes: readonly Scope[],
  toolId: string,
  targetPath: AbsolutePath,
  resourceKinds: readonly string[] | undefined,
): readonly Asset[] {
  const scopesById = new Map(scopes.map((scope) => [scope.scopeId, scope]));
  return assets
    .filter((asset) => asset.status === "disabled")
    .filter((asset) => resourceKinds === undefined || resourceKinds.includes(asset.resource.kind))
    .filter((asset) => {
      const scope = scopesById.get(asset.scopeId);
      return (
        scope !== undefined &&
        scope.toolId === toolId &&
        containsPath(scope.canonicalRootPath, targetPath)
      );
    })
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
}

function withDisabledAssetsAsIgnored(
  draft: AdapterEffectiveConfigDraft,
  disabledAssets: readonly Asset[],
): AdapterEffectiveConfigDraft {
  if (disabledAssets.length === 0) return draft;
  const ignored = new Set(draft.ignoredAssetIds);
  const stepKeys = new Set(draft.steps.map((step) => `${step.action}:${step.assetId}`));
  const ignoredAssetIds = disabledAssets
    .map((asset) => AssetIdSchema.parse(asset.assetId))
    .filter((assetId) => !ignored.has(assetId));
  return {
    ...draft,
    ignoredAssetIds: [...draft.ignoredAssetIds, ...ignoredAssetIds],
    steps: [
      ...draft.steps,
      ...ignoredAssetIds
        .filter((assetId) => !stepKeys.has(`ignore:${assetId}`))
        .map((assetId) => ({
          action: "ignore" as const,
          assetId,
          reason: "Asset disabled",
        })),
    ],
  };
}

function containsPath(root: AbsolutePath, target: AbsolutePath): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith("../") &&
      !pathFromRoot.startsWith("..\\"))
  );
}

function databaseRevision(runtime: DesktopRuntime): string {
  return String(
    (runtime.repositories.database.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
}

function reasonCode(reason: string): string {
  if (reason === "The asset applies to the selected target scope") {
    return "TARGET_SCOPE_APPLIES";
  }
  if (reason === "Asset disabled") return "ASSET_DISABLED";
  if (reason.startsWith("A more specific scope overrides this resource")) {
    return "MORE_SPECIFIC_SCOPE_OVERRIDE";
  }
  return "UNSPECIFIED_RESOLUTION_REASON";
}

function migrationPreviewResponse(
  plan: DeploymentPlan,
  conversions: readonly ConversionResult[],
  generatedAt: string,
) {
  const groups = operationGroupsForPlan(plan);
  const operationGroupIds = groupIdsByTargetPath(groups);
  const boundedOperations = plan.operations.slice(0, CHANGE_DETAIL_LIMIT);
  const changes = boundedOperations.map((operation) => {
    const diff = plan.diffs.find(({ targetPath }) => targetPath === operation.targetPath);
    return plannedChangeView(
      operation,
      diff?.unifiedText ?? "",
      operationGroupIds.get(operation.targetPath) ??
        `group:operation:${encodeURIComponent(operation.targetPath)}`,
    );
  });
  const visibleDetailsByGroup = visibleDetailCounts(changes);
  return {
    planId: plan.deploymentPlanId,
    planHash: plan.planHash,
    compatibility: plan.requiredConfirmations.includes("partial_conversion")
      ? ("partial" as const)
      : ("full" as const),
    fieldLosses: conversions
      .filter(
        (conversion): conversion is Extract<ConversionResult, { readonly level: "partial" }> =>
          conversion.level === "partial",
      )
      .map((conversion) => ({
        assetId: conversion.sourceAssetId,
        droppedFields: conversion.droppedFields,
        retainedFields: conversion.retainedFields,
        transformedFields: conversion.transformedFields,
        warnings: conversion.warnings,
      })),
    changeGroups: groups.map((group) =>
      migrationChangeGroupView(group, visibleDetailsByGroup.get(group.groupId) ?? 0),
    ),
    differenceSummary: migrationDifferenceSummary(plan, groups),
    requiredConfirmations: plan.requiredConfirmations,
    changes,
    changesTruncated: plan.operations.length > CHANGE_DETAIL_LIMIT,
    changeDetailLimit: CHANGE_DETAIL_LIMIT,
    warnings: plan.warnings.map((warning, index) => ({
      id: DiagnosticIdSchema.parse(`diagnostic:migration:${index}`),
      code: "PARTIAL_CONVERSION",
      severity: "warning" as const,
      message: warning,
      suggestedAction: "Review the generated plan before deployment",
      blocking: false,
    })),
    sourceHashes: plan.expectedSourceHashes,
    targetHashes: Object.fromEntries(
      Object.entries(plan.expectedTargetHashes).map(([path, hash]) => [
        path,
        hash === "absent" ? null : hash,
      ]),
    ),
    expiresAt:
      plan.expiresAt ??
      IsoDateTimeSchema.parse(new Date(Date.parse(generatedAt) + 10 * 60 * 1_000).toISOString()),
  };
}

function groupIdsByTargetPath(
  groups: readonly DeploymentOperationGroup[],
): ReadonlyMap<string, string> {
  return new Map(
    groups.flatMap((group) => group.targetPaths.map((targetPath) => [targetPath, group.groupId])),
  );
}

function visibleDetailCounts(
  changes: readonly ReturnType<typeof plannedChangeView>[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const change of changes) {
    if (change.groupId === undefined) continue;
    counts.set(change.groupId, (counts.get(change.groupId) ?? 0) + 1);
  }
  return counts;
}

function migrationChangeGroupView(group: DeploymentOperationGroup, visibleDetailCount: number) {
  return {
    groupId: group.groupId,
    operation: group.operation,
    ...(group.resourceKind === undefined ? {} : { resourceType: group.resourceKind }),
    ...(group.sourceAssetId === undefined ? {} : { sourceAssetId: group.sourceAssetId }),
    targetRootPathDisplay: group.targetRootPath,
    targetRootRelativePath: group.targetRootRelativePath ?? group.targetRootPath,
    operationCount: group.operationCount,
    createCount: group.createCount,
    replaceCount: group.replaceCount,
    deleteCount: group.deleteCount,
    generatedFileCount: group.generatedFileCount,
    copyCount: group.copyCount,
    symlinkCount: group.symlinkCount,
    changedTargetCount: group.targetPaths.length,
    targetPathSample: targetPathSampleForGroup(group),
    ...(group.packageOutputCount === undefined
      ? {}
      : { packageOutputCount: group.packageOutputCount }),
    ...(group.packagePathSample === undefined
      ? {}
      : { packagePathSample: group.packagePathSample }),
    visibleDetailCount,
    detailsTruncated: visibleDetailCount < group.operationCount,
  };
}

function targetPathSampleForGroup(group: DeploymentOperationGroup): readonly string[] {
  return [...group.targetPaths]
    .sort()
    .slice(0, GROUP_TARGET_PATH_SAMPLE_LIMIT)
    .map((targetPath) => displayPathForGroupTarget(group, targetPath));
}

function displayPathForGroupTarget(group: DeploymentOperationGroup, targetPath: string): string {
  if (group.targetRootRelativePath === undefined) return targetPath;
  const suffix = relative(group.targetRootPath, targetPath);
  return suffix === "" ? group.targetRootRelativePath : join(group.targetRootRelativePath, suffix);
}

function migrationDifferenceSummary(
  plan: DeploymentPlan,
  groups: readonly DeploymentOperationGroup[],
) {
  const operationTargets = new Set(plan.operations.map(({ targetPath }) => targetPath));
  const issueSummary = plan.issueSummary ?? {
    planWarningCount: plan.warnings.length,
    conversionWarningCount: 0,
    partialConversionCount: plan.requiredConfirmations.includes("partial_conversion") ? 1 : 0,
  };
  return {
    addedToTarget: groups.reduce((sum, group) => sum + group.createCount, 0),
    overwrittenInTarget: groups.reduce((sum, group) => sum + group.replaceCount, 0),
    unchangedPlannedTargetOutputs: Object.entries(plan.expectedTargetHashes).filter(
      ([targetPath, hash]) => hash !== "absent" && !operationTargets.has(targetPath),
    ).length,
    conflictsOrWarnings: issueSummary.planWarningCount + issueSummary.partialConversionCount,
    changedGroupCount: groups.length,
    changedFileCount: plan.operations.length,
  };
}

async function assetsForPlan(
  runtime: DesktopRuntime,
  plan: DeploymentPlan,
): Promise<readonly Asset[]> {
  const assets = await Promise.all(
    Object.keys(plan.expectedSourceHashes)
      .sort()
      .map(async (id) => runtime.repositories.index.getAsset(AssetIdSchema.parse(id))),
  );
  return assets.filter((asset): asset is Asset => asset !== undefined);
}

async function recordDeploymentSnapshot(
  runtime: DesktopRuntime,
  record: DeploymentRecord,
  plan: DeploymentPlan | undefined,
): Promise<SnapshotMetadata> {
  try {
    const assets = plan === undefined ? [] : await assetsForPlan(runtime, plan);
    const summary = await runtime.history.recordDeployment({
      root: runtime.historyRoot,
      deployment: record,
      assets,
    });
    return snapshotRecorded(summary);
  } catch (error) {
    return { status: "failed", error: snapshotError(error, "Local Git snapshot failed") };
  }
}

async function snapshotMetadataForRecords(
  runtime: DesktopRuntime,
  records: readonly DeploymentRecord[],
): Promise<ReadonlyMap<string, SnapshotMetadata>> {
  const succeeded = records.filter((record) => record.status === "succeeded");
  if (succeeded.length === 0) return new Map();

  if (!existsSync(join(runtime.historyRoot, ".git"))) {
    return new Map(
      succeeded.map((record) => [record.deploymentRecordId, { status: "missing" as const }]),
    );
  }

  try {
    const commits = await runtime.history.list(runtime.historyRoot, 200);
    const byRecordId = new Map<string, SnapshotMetadata>();
    for (const commit of commits) {
      const recordId = recordIdFromSnapshotSubject(commit.subject);
      if (recordId !== undefined && !byRecordId.has(recordId)) {
        byRecordId.set(recordId, snapshotRecorded(commit));
      }
    }
    return new Map(
      succeeded.map((record) => [
        record.deploymentRecordId,
        byRecordId.get(record.deploymentRecordId) ?? { status: "missing" as const },
      ]),
    );
  } catch (error) {
    const unavailable = {
      status: "unavailable" as const,
      error: snapshotError(error, "Local Git history could not be read"),
    };
    return new Map(succeeded.map((record) => [record.deploymentRecordId, unavailable]));
  }
}

function snapshotRecorded(summary: GitCommitSummary): SnapshotMetadata {
  return {
    status: "recorded",
    commitId: summary.commitId,
    authoredAt: summary.authoredAt,
    message: summary.subject,
  };
}

function recordIdFromSnapshotSubject(subject: string): string | undefined {
  const prefix = "record deployment ";
  return subject.startsWith(prefix) ? subject.slice(prefix.length) : undefined;
}

function snapshotError(
  error: unknown,
  fallbackMessage: string,
): { readonly code: string; readonly message: string } {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: fallbackMessage };
}

function historyEntry(record: DeploymentRecord, snapshot: SnapshotMetadata | undefined) {
  return {
    id: record.deploymentRecordId,
    kind: record.rollbackOfRecordId === undefined ? ("deployment" as const) : ("rollback" as const),
    status: record.status,
    ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
    createdAt: record.createdAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    phase:
      record.status === "succeeded" || record.status === "failed"
        ? ("completed" as const)
        : ("writing" as const),
    progress: {
      phase: "completed" as const,
      completed: record.operations.length,
      total: record.operations.length,
      unit: "operations" as const,
    },
    cancellable: false,
    ...(snapshot === undefined ? {} : { snapshot }),
  };
}

function historyDetail(
  record: DeploymentRecord,
  plan: DeploymentPlan,
  snapshot: SnapshotMetadata | undefined,
) {
  const groups = operationGroupsForPlan(plan);
  const operationGroupIds = groupIdsByTargetPath(groups);
  const boundedOperations = plan.operations.slice(0, CHANGE_DETAIL_LIMIT);
  const changes = boundedOperations.map((operation) => {
    const diff = plan.diffs.find(({ targetPath }) => targetPath === operation.targetPath);
    return plannedChangeView(
      operation,
      diff?.unifiedText ?? "",
      operationGroupIds.get(operation.targetPath) ??
        `group:operation:${encodeURIComponent(operation.targetPath)}`,
    );
  });
  const visibleDetailsByGroup = visibleDetailCounts(changes);
  return {
    entry: historyEntry(record, snapshot),
    plan: {
      planId: plan.deploymentPlanId,
      planHash: plan.planHash,
      requiredConfirmations: plan.requiredConfirmations,
    },
    changeGroups: groups.map((group) =>
      migrationChangeGroupView(group, visibleDetailsByGroup.get(group.groupId) ?? 0),
    ),
    differenceSummary: migrationDifferenceSummary(plan, groups),
    changes,
    changesTruncated: plan.operations.length > CHANGE_DETAIL_LIMIT,
    changeDetailLimit: CHANGE_DETAIL_LIMIT,
  };
}

function plannedChangeView(operation: DeploymentOperation, diff: string, groupId?: string) {
  const deploymentType = operation.deploymentType ?? "generated_file";
  return {
    ...(groupId === undefined ? {} : { groupId }),
    operation: operation.kind,
    deploymentType,
    pathDisplay: operation.targetPath,
    ...(isSourceDeployment(deploymentType) && operation.sourcePath !== undefined
      ? { sourcePathDisplay: operation.sourcePath }
      : {}),
    beforeHash: operation.expectedTargetHash === "absent" ? null : operation.expectedTargetHash,
    afterHash: operationAfterHash(operation, deploymentType),
    diff,
  };
}

function operationAfterHash(
  operation: DeploymentOperation,
  deploymentType: DeploymentOperationType,
): ContentHash | null {
  if (operation.kind === "delete") return null;
  if (isSourceDeployment(deploymentType)) {
    if (operation.sourceHash === undefined) {
      throw new Error("Source deployment operation is missing sourceHash");
    }
    return operation.sourceHash;
  }
  if (operation.nextText === undefined) {
    throw new Error("Generated deployment operation is missing nextText");
  }
  return contentHash(operation.nextText);
}

function isSourceDeployment(deploymentType: DeploymentOperationType): boolean {
  return deploymentType === "copy" || deploymentType === "symlink";
}

function deploymentRecordForPlan(
  runtime: DesktopRuntime,
  planId: ReturnType<typeof DeploymentPlanIdSchema.parse>,
): DeploymentRecord | undefined {
  const row = runtime.repositories.database
    .prepare(
      "SELECT verification_json FROM deployments WHERE plan_id = ? ORDER BY requested_at DESC LIMIT 1",
    )
    .get(planId) as { verification_json: string } | undefined;
  if (row === undefined) return undefined;
  return JSON.parse(row.verification_json) as DeploymentRecord;
}

function deploymentRecordById(
  runtime: DesktopRuntime,
  deploymentRecordId: string,
): DeploymentRecord | undefined {
  const row = runtime.repositories.database
    .prepare("SELECT verification_json FROM deployments WHERE domain_id = ?")
    .get(DeploymentRecordIdSchema.parse(deploymentRecordId)) as
    | { verification_json: string }
    | undefined;
  return row === undefined ? undefined : (JSON.parse(row.verification_json) as DeploymentRecord);
}

function loadPersistedRecoveryLocks(runtime: DesktopRuntime): readonly DeploymentRecordId[] {
  const lockRows = runtime.repositories.database
    .prepare(
      `SELECT deployments.domain_id, recovery_locks.resolved_at,
              recovery_locks.resolution_evidence_json
       FROM recovery_locks
       JOIN deployments ON deployments.id = recovery_locks.deployment_id
       ORDER BY deployments.domain_id`,
    )
    .all() as {
    readonly domain_id: string;
    readonly resolved_at: number | null;
    readonly resolution_evidence_json: string | null;
  }[];
  const deploymentRecordIds = new Set(
    lockRows
      .filter(({ resolved_at }) => resolved_at === null)
      .map(({ domain_id }) => DeploymentRecordIdSchema.parse(domain_id)),
  );
  const persistedUnresolvedDeploymentIds = new Set(deploymentRecordIds);
  const resolvedThroughStorageOrder = new Map(
    lockRows.flatMap((row) => {
      if (row.resolved_at === null) return [];
      const evidence = resolvedRecoveryEvidence(row.resolution_evidence_json);
      return [
        [
          DeploymentRecordIdSchema.parse(row.domain_id),
          evidence?.resolvedThroughStorageOrder,
        ] as const,
      ];
    }),
  );
  const records = runtime.repositories.database
    .prepare(
      `SELECT rowid AS storage_order, verification_json
       FROM deployments
       WHERE status IN ('failed', 'writing', 'verifying', 'rolling_back', 'succeeded')
       ORDER BY rowid`,
    )
    .all() as { readonly storage_order: number; readonly verification_json: string }[];
  const latestRecoveryEvents = new Map<
    DeploymentRecordId,
    { readonly state: "required" | "recovered"; readonly storageOrder: number }
  >();
  for (const { storage_order, verification_json } of records) {
    const record = JSON.parse(verification_json) as DeploymentRecord;
    const event = recoveryEventForRecord(record);
    if (event === undefined) continue;
    latestRecoveryEvents.set(event.deploymentRecordId, {
      state: event.state,
      storageOrder: storage_order,
    });
  }
  for (const [deploymentRecordId, event] of latestRecoveryEvents) {
    const resolvedThrough = resolvedThroughStorageOrder.get(deploymentRecordId);
    // A resolved durable row can cover zero-operation recovery, which has no
    // successful rollback record. A later failed/interrupted record must win.
    if (
      !persistedUnresolvedDeploymentIds.has(deploymentRecordId) &&
      resolvedThrough !== undefined &&
      resolvedThrough >= event.storageOrder
    ) {
      deploymentRecordIds.delete(deploymentRecordId);
      continue;
    }
    if (event.state === "recovered") {
      deploymentRecordIds.delete(deploymentRecordId);
      try {
        resolvePersistedRecoveryLock(runtime, deploymentRecordId);
      } catch {
        // The successful rollback record still prevents a false in-memory lock.
      }
    } else {
      deploymentRecordIds.add(deploymentRecordId);
      try {
        persistRecoveryLock(runtime, deploymentRecordId);
      } catch {
        // The failed record still reconstructs an in-memory lock for this runtime.
      }
    }
  }
  return [...deploymentRecordIds].sort();
}

function resolvedRecoveryEvidence(
  text: string | null,
): { readonly resolvedThroughStorageOrder: number } | undefined {
  if (text === null) return undefined;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const resolvedThroughStorageOrder = value["resolvedThroughStorageOrder"];
    return typeof resolvedThroughStorageOrder === "number" &&
      Number.isSafeInteger(resolvedThroughStorageOrder) &&
      resolvedThroughStorageOrder >= 0
      ? { resolvedThroughStorageOrder }
      : undefined;
  } catch {
    return undefined;
  }
}

function recoveryEventForRecord(
  record: DeploymentRecord,
):
  | { readonly deploymentRecordId: DeploymentRecordId; readonly state: "required" | "recovered" }
  | undefined {
  if (record.rollbackOfRecordId !== undefined && record.status === "succeeded") {
    return { deploymentRecordId: record.rollbackOfRecordId, state: "recovered" };
  }
  const interruptedWrite = ["writing", "verifying", "rolling_back"].includes(record.status);
  if (record.rollbackOfRecordId !== undefined) {
    return interruptedWrite || (record.status === "failed" && record.startedAt !== undefined)
      ? { deploymentRecordId: record.rollbackOfRecordId, state: "required" }
      : undefined;
  }
  return interruptedWrite ||
    (record.status === "failed" && record.rollbackResults.some(({ status }) => status === "failed"))
    ? { deploymentRecordId: record.deploymentRecordId, state: "required" }
    : undefined;
}

function persistRecoveryLock(
  runtime: DesktopRuntime,
  deploymentRecordId: DeploymentRecordId,
): void {
  const row = runtime.repositories.database
    .prepare("SELECT id, verification_json FROM deployments WHERE domain_id = ?")
    .get(deploymentRecordId) as
    | { readonly id: string; readonly verification_json: string }
    | undefined;
  if (row === undefined) return;
  const record = JSON.parse(row.verification_json) as DeploymentRecord;
  const statement = runtime.repositories.database.prepare(
    `INSERT INTO recovery_locks(
       canonical_target_key, deployment_id, reason, created_at, recovery_fence_token
     ) VALUES(?, ?, 'failed_deployment', ?, 1)
     ON CONFLICT(canonical_target_key) DO UPDATE SET
       deployment_id = excluded.deployment_id,
       reason = excluded.reason,
       created_at = excluded.created_at,
       resolved_at = NULL,
       resolution_evidence_json = NULL,
       recovery_owner_id = NULL,
       recovery_claim_expires_at = NULL,
       recovery_fence_token = recovery_locks.recovery_fence_token + 1`,
  );
  const createdAt = Date.parse(now(runtime));
  for (const targetPath of new Set(record.operations.map(({ targetPath }) => targetPath))) {
    statement.run(watcherRootKey(targetPath), row.id, createdAt);
  }
}

function resolvePersistedRecoveryLock(
  runtime: DesktopRuntime,
  deploymentRecordId: DeploymentRecordId,
): void {
  const resolvedThroughStorageOrder = (
    runtime.repositories.database
      .prepare("SELECT COALESCE(MAX(rowid), 0) AS storage_order FROM deployments")
      .get() as { readonly storage_order: number }
  ).storage_order;
  runtime.repositories.database
    .prepare(
      `UPDATE recovery_locks
       SET resolved_at = ?, resolution_evidence_json = ?
       WHERE resolved_at IS NULL
         AND deployment_id = (SELECT id FROM deployments WHERE domain_id = ?)`,
    )
    .run(
      Date.parse(now(runtime)),
      JSON.stringify({
        resolution: "successful_rollback",
        deploymentRecordId,
        resolvedThroughStorageOrder,
      }),
      deploymentRecordId,
    );
}

function rollbackRoots(
  runtime: DesktopRuntime,
  deploymentRecordId: string,
): readonly AbsolutePath[] {
  const record = deploymentRecordById(runtime, deploymentRecordId);
  if (record === undefined) throw notFound("Deployment record not found");
  return deploymentRoots(record);
}

function deploymentRoots(record: DeploymentRecord): readonly AbsolutePath[] {
  const roots = record.operations.flatMap((operation) => [
    existingAncestor(dirname(operation.targetPath)),
    ...(operation.sourcePath === undefined
      ? []
      : [existingAncestor(dirname(operation.sourcePath))]),
  ]);
  return [...new Set(roots)];
}

function existingAncestor(path: string): AbsolutePath {
  let cursor = resolve(path);
  for (;;) {
    if (existsSync(cursor) && statSync(cursor).isDirectory()) {
      return AbsolutePathSchema.parse(cursor);
    }
    const parent = dirname(cursor);
    if (parent === cursor) return AbsolutePathSchema.parse(parent);
    cursor = parent;
  }
}

function settingsValues(settings: PublicSettings) {
  return {
    theme: settings.theme,
    language: settings.language,
    pathDisplay: settings.pathDisplay,
    scanHints: settings.scanHints,
    fileWatching: settings.fileWatching,
  };
}

function selectSettings(
  keys: readonly string[],
  values: ReturnType<typeof settingsValues>,
): Partial<ReturnType<typeof settingsValues>> {
  const selected: Partial<ReturnType<typeof settingsValues>> = {};
  for (const key of keys) {
    if (key === "theme") selected.theme = values.theme;
    if (key === "language") selected.language = values.language;
    if (key === "pathDisplay") selected.pathDisplay = values.pathDisplay;
    if (key === "scanHints") selected.scanHints = values.scanHints;
    if (key === "fileWatching") selected.fileWatching = values.fileWatching;
  }
  return selected;
}

function toJson(value: unknown): unknown {
  const parsed: unknown = JSON.parse(
    JSON.stringify(value, (_key: string, item: unknown): unknown => {
      if (typeof item === "bigint") return String(item);
      return item;
    }),
  );
  return parsed;
}

export function contentHash(text: string): ContentHash {
  return ContentHashSchema.parse(`sha256:${createHash("sha256").update(text).digest("hex")}`);
}
