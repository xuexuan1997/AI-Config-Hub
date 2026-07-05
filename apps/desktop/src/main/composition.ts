import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { createDefaultAdapterRegistry, type AdapterRegistry } from "@ai-config-hub/adapters";
import { DeploymentStatusSchema, EffectiveConfigSchema } from "@ai-config-hub/core";
import type {
  AdapterLogger,
  AdapterEffectiveConfigDraft,
  AdapterReadApi,
  AdapterRegistration,
  Asset,
  ConversionResult,
  DeploymentFilePort,
  DeploymentOperation,
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
  WatchService,
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
const SOURCE_FILE_ROLE_ORDER = new Map([
  ["primary", 0],
  ["metadata", 1],
  ["support", 2],
] as const);

export interface DesktopCommandServiceOptions {
  readonly userDataPath: string;
  readonly appVersion: string;
  readonly cwd?: string;
  readonly homeDirectory?: string;
  readonly now?: () => string;
  readonly sourceFileOpener?: SourceFileOpener;
  readonly watchService?: WatchService;
}

export interface SourceFileOpener {
  openPath(path: AbsolutePath): Promise<void>;
}

export interface DesktopCommandServiceRuntime {
  readonly services: CommandServiceMap;
  readonly taskEvents: DesktopTaskEventPort;
  close(): void;
}

export interface DesktopTaskEventPort {
  subscribe(
    taskId: string,
    afterSequence: number,
    listener: (event: TaskEvent) => void,
  ): () => void;
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
  readonly fileWatchers: Set<NodeFileWatcher>;
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
  return {
    services: createServices(runtime, options, taskEvents),
    taskEvents,
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
    fileWatchers: new Set<NodeFileWatcher>(),
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
      const request = payload as {
        readonly changedPaths?: readonly string[];
        readonly mode?: "full" | "incremental";
        readonly projectId?: string;
        readonly roots?: readonly string[];
        readonly toolKeys?: readonly string[];
      };
      const allowedRoots = scanRoots(request.roots, cwd, homeDirectory);
      const changedPaths = changedScanPaths(request.changedPaths, cwd);
      const taskId = TaskIdSchema.parse(`task:scan:${randomUUID()}`);
      const scanRunId = ScanRunIdSchema.parse(`scan:${randomUUID()}`);
      const acceptedAt = now(runtime);
      taskEvents.record({
        taskId,
        emittedAt: acceptedAt,
        type: "accepted",
        payload: { taskKind: "scan", phase: "queued", acceptedAt },
      });
      await runtime.repositories.tasks.create({ taskId, scanRunId, status: "queued" });

      const access = await createNodeFileAccess({ allowedRoots, platform: platform() });
      const canonicalChangedPaths =
        changedPaths === undefined
          ? undefined
          : await Promise.all(changedPaths.map((path) => access.read.realpath(path)));
      const scanner = new ScanService({
        registrations: scanRegistrations(registry.registrations, request.toolKeys),
        read: access.read,
        snapshots: access.snapshots,
        indexRepository: runtime.repositories.index,
        now: () => now(runtime),
      });
      const cancellation = createCancellationController();
      let sequence = 0;
      let previousPhase:
        | "queued"
        | "discovering"
        | "reading"
        | "parsing"
        | "validating"
        | "committing"
        | "completed" = "queued";
      const summary = await scanner.scan({
        scanRunId,
        candidateRoots: allowedRoots,
        ...(request.mode === "incremental" && canonicalChangedPaths !== undefined
          ? { changedPaths: canonicalChangedPaths }
          : {}),
        ...(request.projectId === undefined ? {} : { commitMode: "merge-scoped" as const }),
        homeDirectory,
        platform: scannerPlatform(),
        signal: cancellation.signal,
        onPhase: (phase) => {
          sequence += 1;
          taskEvents.record({
            taskId,
            emittedAt: now(runtime),
            type: "phase.changed",
            payload: { from: previousPhase, to: phase },
          });
          previousPhase = phase;
          void runtime.repositories.tasks.updateProgress({
            taskId,
            sequence,
            phase,
            completed: phase === "completed" ? 1 : 0,
            total: 1,
          });
        },
      });
      await runtime.repositories.tasks.finish(summary.summary);
      await syncFileWatcher(runtime, allowedRoots, services);
      taskEvents.record({
        taskId,
        emittedAt: now(runtime),
        type: "completed",
        payload: {
          status: summary.summary.status,
          succeededCount: summary.summary.succeededCount,
          failedCount: summary.summary.failedCount,
          skippedCount: summary.summary.skippedCount,
          resultRef: summary.summary.scanRunId,
          systemRecoveryLock: false,
        },
      });
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
        cancellable: !["succeeded", "partially_succeeded", "cancelled", "failed"].includes(
          task.status,
        ),
      };
    },
    "scan.cancel": async (payload) => {
      const request = payload as { readonly taskId: string };
      const task = await runtime.repositories.tasks.get(TaskIdSchema.parse(request.taskId));
      if (task === undefined) throw notFound("Task not found");
      const effectiveAfterPhase = apiPhase(
        task.summary === undefined ? (task.progress?.phase ?? task.status) : "completed",
      );
      taskEvents.record({
        taskId: task.taskId,
        emittedAt: now(runtime),
        type: "cancel.requested",
        payload: { reason: "user", effectiveAfterPhase },
      });
      return {
        taskId: TaskIdSchema.parse(request.taskId),
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
      const page = await runtime.repositories.index.listDiagnostics({
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
        limit:
          request.projectId === undefined &&
          request.toolKeys === undefined &&
          request.codes === undefined
            ? (request.limit ?? 50)
            : 10_000,
      });
      const context = diagnosticFilterContext(runtime, await diagnosticFilterAssets(runtime));
      const filtered = page.items.filter((diagnostic) =>
        includeDiagnostic(diagnostic, listFilterRequest(request), context, undefined),
      );
      return diagnosticsPage({
        items: filtered.slice(0, request.limit ?? 50),
        snapshotRevision: page.snapshotRevision,
      });
    },
    "diagnostics.export": async (payload) => {
      const request = payload as CommandRequest<"diagnostics.export">;
      const page = await runtime.repositories.index.listDiagnostics({
        ...(request.severities === undefined
          ? {}
          : {
              severity: request.severities.map((severity) =>
                DiagnosticSeveritySchema.parse(severity),
              ),
            }),
        limit: 10_000,
      });
      const context = diagnosticFilterContext(runtime, await diagnosticFilterAssets(runtime));
      const taskDiagnosticIds =
        request.taskId === undefined
          ? undefined
          : new Set(
              (await runtime.repositories.tasks.get(TaskIdSchema.parse(request.taskId)))?.summary
                ?.diagnosticIds ?? [],
            );
      const items = page.items
        .filter((diagnostic) => includeDiagnostic(diagnostic, request, context, taskDiagnosticIds))
        .map(diagnosticView);
      const filters = compact({
        taskId: request.taskId === undefined ? undefined : TaskIdSchema.parse(request.taskId),
        projectId:
          request.projectId === undefined ? undefined : ProjectIdSchema.parse(request.projectId),
        toolKeys: request.toolKeys?.map((toolKey) => ToolIdSchema.parse(toolKey)),
        severities: request.severities,
        from: request.from,
        to: request.to,
      });
      return createDiagnosticReport({
        format: request.format,
        generatedAt: now(runtime),
        filters,
        items,
        homeDirectory,
        pathRoots: diagnosticReportPathRoots(runtime, cwd),
      });
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
      const found = deploymentRecordForPlan(runtime, planId);
      const plan = await runtime.repositories.deployments.getPlan(planId);
      if (found === undefined || plan === undefined) throw notFound("Deployment plan not found");
      const roots = deploymentRoots(found);
      const access = await createNodeFileAccess({ allowedRoots: roots, platform: platform() });
      const taskId = TaskIdSchema.parse(`task:deployment:${randomUUID()}`);
      const acceptedAt = now(runtime);
      const recorder = new DesktopOperationTaskRecorder({
        taskEvents,
        taskId,
        taskKind: "deployment",
        resultRef: found.deploymentRecordId,
        acceptedAt,
        operationTotal: plan.operations.length,
        now: runtime.now,
      });
      const deploymentFiles = instrumentDeploymentFiles(
        new NodeDeploymentFilePort({
          allowedRoots: roots,
          backupRoot: runtime.backupRoot,
        }),
        recorder,
        "deployment",
      );
      const service = new DeploymentExecutionService({
        deploymentRepository: runtime.repositories.deployments,
        sourceHashes: {
          currentHash: async (assetId) =>
            (await runtime.repositories.index.getAsset(AssetIdSchema.parse(assetId)))?.contentHash,
        },
        snapshots: access.snapshots,
        deploymentFiles,
        locks: runtime.pathLocks,
        registry,
        read: instrumentDeploymentRead(access.read, recorder),
      });
      recorder.accept();
      recorder.changePhase("preflight");
      recorder.progress(0);
      const suppressedTargetPaths = plan.operations.map(({ targetPath }) => targetPath);
      runtime.watchService.suppressDeploymentPaths(suppressedTargetPaths);
      let record: DeploymentRecord;
      try {
        record = await service.execute({
          deploymentRecordId: found.deploymentRecordId,
          confirmedPlanHash: ContentHashSchema.parse(request.confirmedPlanHash),
          confirmations: request.confirmations ?? [],
          allowedRoots: roots,
          now: now(runtime),
        });
      } catch (error) {
        recorder.fail(error, found.deploymentRecordId);
        throw taskScopedError(error, taskId, "Deployment failed");
      } finally {
        runtime.watchService.clearDeploymentSuppression(suppressedTargetPaths);
      }
      if (record.status !== "succeeded") {
        recorder.failStatus(
          record.status === "rolled_back" ? "rolled_back" : "failed",
          record.deploymentRecordId,
        );
        throw new AppError({
          code: "VALIDATION_FAILED",
          message: `Deployment did not succeed: ${record.status}`,
          retryable: false,
          suggestedActions: [
            "Review deployment diagnostics and create a fresh preview before retrying",
          ],
          taskId,
        });
      }
      finishDeploymentWork(recorder);
      recorder.succeed(record.deploymentRecordId, record.operations.length);
      const snapshot = await recordDeploymentSnapshot(runtime, record, plan);
      return {
        taskId,
        status: "queued",
        acceptedAt,
        deploymentId: record.deploymentRecordId,
        snapshot,
      };
    },
    "deployment.rollback": async (payload) => {
      const request = payload as { readonly deploymentId: string };
      const originalId = DeploymentRecordIdSchema.parse(request.deploymentId);
      const taskId = TaskIdSchema.parse(`task:rollback:${randomUUID()}`);
      const acceptedAt = now(runtime);
      const recorder = new DesktopOperationTaskRecorder({
        taskEvents,
        taskId,
        taskKind: "rollback",
        resultRef: originalId,
        acceptedAt,
        operationTotal: 0,
        now: runtime.now,
      });
      recorder.accept();
      recorder.changePhase("preflight");
      recorder.progress(0);

      let roots: readonly AbsolutePath[];
      let access: Awaited<ReturnType<typeof createNodeFileAccess>>;
      let plan: DeploymentPlan;
      let original: DeploymentRecord | undefined;
      try {
        original = deploymentRecordById(runtime, originalId);
        roots = rollbackRoots(runtime, originalId);
        access = await createNodeFileAccess({
          allowedRoots: [...roots, runtime.backupRoot],
          platform: platform(),
        });
        const service = new DeploymentRollbackService({
          deploymentRepository: runtime.repositories.deployments,
          snapshots: access.snapshots,
          deploymentFiles: new NodeDeploymentFilePort({
            allowedRoots: roots,
            backupRoot: runtime.backupRoot,
          }),
          locks: runtime.pathLocks,
        });
        plan = await service.preview(originalId);
      } catch (error) {
        recorder.fail(error, originalId);
        throw taskScopedError(error, taskId, "Rollback failed");
      }

      recorder.setOperationTotal(plan.operations.length);
      const rollbackRecordId = DeploymentRecordIdSchema.parse(
        `rollback-record:${plan.planHash.slice("sha256:".length)}`,
      );
      const rollbackService = new DeploymentRollbackService({
        deploymentRepository: runtime.repositories.deployments,
        snapshots: access.snapshots,
        deploymentFiles: instrumentDeploymentFiles(
          new NodeDeploymentFilePort({
            allowedRoots: roots,
            backupRoot: runtime.backupRoot,
          }),
          recorder,
          "rollback",
        ),
        locks: runtime.pathLocks,
      });
      const suppressedTargetPaths = plan.operations.map(({ targetPath }) => targetPath);
      runtime.watchService.suppressDeploymentPaths(suppressedTargetPaths);
      let record: DeploymentRecord;
      try {
        record = await rollbackService.execute({
          deploymentRecordId: originalId,
          rollbackPlanHash: plan.planHash,
          now: now(runtime),
        });
      } catch (error) {
        recorder.fail(error, rollbackRecordId);
        throw taskScopedError(error, taskId, "Rollback failed");
      } finally {
        runtime.watchService.clearDeploymentSuppression(suppressedTargetPaths);
      }
      if (record.status === "succeeded") {
        finishRollbackWork(recorder);
        recorder.succeed(record.deploymentRecordId, record.operations.length);
      } else {
        if (recorder.phase === "preflight") recorder.changePhase("restoring");
        recorder.progress(Object.keys(record.resultingHashes).length);
        recorder.failStatus("failed", record.deploymentRecordId);
      }
      if (record.status !== "succeeded") {
        throw new AppError({
          code: "VALIDATION_FAILED",
          message: `Rollback did not succeed: ${record.status}`,
          retryable: false,
          suggestedActions: ["Review rollback diagnostics before retrying"],
          taskId,
        });
      }
      const originalPlan =
        original === undefined
          ? undefined
          : await runtime.repositories.deployments.getPlan(original.deploymentPlanId);
      const snapshot = await recordDeploymentSnapshot(runtime, record, originalPlan);
      return {
        taskId,
        status: "queued",
        acceptedAt,
        rollbackId: record.deploymentRecordId,
        snapshot,
      };
    },
    "history.list": async (payload) => {
      const request = payload as {
        readonly kinds?: readonly ("deployment" | "rollback")[];
        readonly statuses?: readonly string[];
        readonly from?: string;
        readonly to?: string;
        readonly cursor?: string;
        readonly limit?: number;
      };
      const page = await runtime.repositories.deployments.listRecords({
        ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
        ...(request.statuses === undefined
          ? {}
          : { statuses: request.statuses.map((status) => DeploymentStatusSchema.parse(status)) }),
        ...(request.from === undefined ? {} : { from: IsoDateTimeSchema.parse(request.from) }),
        ...(request.to === undefined ? {} : { to: IsoDateTimeSchema.parse(request.to) }),
        ...(request.cursor === undefined
          ? {}
          : { cursor: PaginationCursorSchema.parse(request.cursor) }),
        limit: request.limit ?? 50,
      });
      const snapshots = await snapshotMetadataForRecords(runtime, page.items);
      return {
        items: page.items.map((record) =>
          historyEntry(record, snapshots.get(record.deploymentRecordId)),
        ),
        nextCursor: page.nextCursor ?? null,
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

export class DesktopTaskEvents implements DesktopTaskEventPort {
  readonly #events = new Map<string, TaskEvent[]>();
  readonly #listeners = new Map<string, Set<(event: TaskEvent) => void>>();
  readonly #lastSequence = new Map<string, number>();
  readonly #states = new Map<string, TaskReplayState>();

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
    for (const listener of this.#listeners.get(taskId) ?? []) listener(event);
    return event;
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
      updatedAt: event.emittedAt,
    } satisfies TaskReplayState);
  if (event.type === "phase.changed") {
    return {
      ...previous,
      phase: event.payload.to,
      progress: { ...previous.progress, phase: event.payload.to },
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
  #operationTotal: number;
  readonly #now: () => string;
  #phase: OperationTaskPhase = "queued";
  readonly #lastProgressByPhase = new Map<OperationTaskPhase, number>();

  constructor(options: {
    readonly taskEvents: DesktopTaskEvents;
    readonly taskId: string;
    readonly taskKind: OperationTaskKind;
    readonly resultRef: string;
    readonly acceptedAt: string;
    readonly operationTotal: number;
    readonly now: () => string;
  }) {
    this.#taskEvents = options.taskEvents;
    this.#taskId = TaskIdSchema.parse(options.taskId);
    this.#taskKind = options.taskKind;
    this.#resultRef = options.resultRef;
    this.#acceptedAt = options.acceptedAt;
    this.#operationTotal = options.operationTotal;
    this.#now = options.now;
  }

  get phase(): OperationTaskPhase {
    return this.#phase;
  }

  get operationTotal(): number {
    return this.#operationTotal;
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
    this.changePhase("completed");
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
    this.recordFailure(errorCode(error), isRetryable(error), itemRef);
    this.completeFailure("failed", itemRef);
  }

  failStatus(status: "failed" | "rolled_back", itemRef = this.#resultRef): void {
    this.recordFailure(
      status === "rolled_back" ? "DEPLOYMENT_ROLLED_BACK" : "VALIDATION_FAILED",
      false,
      itemRef,
    );
    this.completeFailure(status, itemRef);
  }

  private recordFailure(errorCodeValue: string, retryable: boolean, itemRef: string): void {
    this.#taskEvents.record({
      taskId: this.#taskId,
      emittedAt: nowFrom(this.#now),
      type: "item.failed",
      payload: {
        itemRef,
        diagnosticId: `diagnostic:${this.#taskKind}:failure`,
        errorCode: errorCodeValue,
        retryable,
      },
    });
  }

  private completeFailure(status: "failed" | "rolled_back", resultRef: string): void {
    if (
      this.#taskKind === "deployment" &&
      (this.#phase === "writing" || this.#phase === "verifying")
    ) {
      this.changePhase("rolling_back");
    }
    this.changePhase("completed");
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
        systemRecoveryLock: status === "failed",
      },
    });
  }
}

function taskScopedError(error: unknown, taskId: string, fallbackMessage: string): AppError {
  const parsedTaskId = TaskIdSchema.parse(taskId);
  if (error instanceof AppError) {
    return new AppError({ ...error.toJSON(), taskId: parsedTaskId, cause: error });
  }
  return new AppError({
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : fallbackMessage,
    retryable: false,
    suggestedActions: ["Review deployment history before retrying"],
    taskId: parsedTaskId,
    cause: error,
  });
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
): Promise<void> {
  const settings = await runtime.repositories.settings.getPublic();
  closeFileWatchers(runtime);
  if (!settings.settings.fileWatching || roots.length === 0) return;
  const watcher = new NodeFileWatcher({
    roots,
    platform: scannerPlatform(),
    service: runtime.watchService,
    onBatch: (batch) => handleWatchBatch(batch, roots, services),
  });
  runtime.fileWatchers.add(watcher);
  await watcher.start();
}

function closeFileWatchers(runtime: DesktopRuntime): void {
  for (const watcher of runtime.fileWatchers) watcher.close();
  runtime.fileWatchers.clear();
}

async function handleWatchBatch(
  batch: WatchBatch,
  roots: readonly AbsolutePath[],
  services: Record<ApiCommandName, (payload: unknown) => Promise<unknown>>,
): Promise<void> {
  if (batch.kind === "changes") {
    await services["scan.start"]({
      mode: "incremental",
      roots,
      changedPaths: batch.changedPaths,
    });
    return;
  }
  await services["scan.start"]({ mode: "full", roots });
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
              "Move the skill package directory into the AI Config Hub disabled-assets area.",
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
      label: "Set OpenCode agent disable to true",
      description: "Write disable=true for this agent in the OpenCode configuration.",
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
  const allAssets = await runtime.repositories.index.listAssets({ limit: 10_000 });
  const assetsById = new Map(
    [...allAssets.items, ...listedAssets].map((asset) => [asset.assetId, asset]),
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
  const row = runtime.repositories.database
    .prepare(
      "SELECT effective_configs_json FROM scan_runs ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get() as { readonly effective_configs_json: string } | undefined;
  if (row === undefined) return [];
  return EffectiveConfigSchema.array().parse(JSON.parse(row.effective_configs_json));
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

async function diagnosticFilterAssets(runtime: DesktopRuntime): Promise<readonly Asset[]> {
  return (await runtime.repositories.index.listAssets({ limit: 10_000 })).items;
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
  return {
    ...stored,
    ...evidenced,
    ...(scoped === undefined ? {} : { toolId: scoped.toolId }),
    ...(scoped?.projectId === undefined || scoped.projectId === null
      ? {}
      : { projectId: scoped.projectId }),
  };
}

function evidenceDiagnosticOwnership(diagnostic: Diagnostic): DiagnosticOwnership {
  const evidence = diagnostic.evidence;
  const toolId =
    typeof evidence["toolId"] === "string" ? ToolIdSchema.safeParse(evidence["toolId"]) : undefined;
  const projectRoot =
    typeof evidence["projectRoot"] === "string"
      ? ProjectIdSchema.safeParse(evidence["projectRoot"])
      : undefined;
  return {
    ...(toolId?.success === true ? { toolId: toolId.data } : {}),
    ...(projectRoot?.success === true ? { projectId: projectRoot.data } : {}),
  };
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
  const tool = toolInstallations(runtime)
    .filter((installation) => installation.toolId === request.toolKey)
    .find((installation) =>
      installation.configRoots.some((root) => containsPath(root, targetPath)),
    );
  if (tool === undefined) throw notFound("Effective configuration not found");

  const resourceKinds =
    request.resourceTypes === undefined
      ? undefined
      : request.resourceTypes.map((resourceType) => ResourceKindSchema.parse(resourceType));
  const scopes = (await runtime.repositories.index.listScopes()).filter(
    (scope) => scope.toolId === tool.toolId,
  );
  const assets = (await diagnosticFilterAssets(runtime)).filter(
    (asset) => asset.toolId === tool.toolId,
  );
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
  const draft = withDisabledAssetsAsIgnored(
    resolution.draft,
    disabledApplicableAssets(assets, scopes, tool.toolId, targetPath, resourceKinds),
  );
  const resources =
    resourceKinds === undefined
      ? draft.resolvedResources
      : draft.resolvedResources.filter((resource) => resourceKinds.includes(resource.kind));
  return {
    effective: toJson(resources),
    contributors: draft.steps
      .filter((step) => step.action !== "ignore")
      .map((step) => ({
        assetId: step.assetId,
        action: step.action,
        reasonCode: reasonCode(step.reason),
      })),
    ignored: draft.steps
      .filter((step) => step.action === "ignore")
      .map((step) => ({
        assetId: step.assetId,
        reasonCode: reasonCode(step.reason),
        ...(step.coveredByAssetId === undefined ? {} : { coveredByAssetId: step.coveredByAssetId }),
      })),
    diagnostics: [],
    snapshotRevision: databaseRevision(runtime),
  };
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
      void targetPath;
      return scope === undefined || scope.toolId === toolId;
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
  return reason
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
}

function migrationPreviewResponse(
  plan: DeploymentPlan,
  conversions: readonly ConversionResult[],
  generatedAt: string,
) {
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
    requiredConfirmations: plan.requiredConfirmations,
    changes: plan.operations.map((operation) => {
      const diff = plan.diffs.find(({ targetPath }) => targetPath === operation.targetPath);
      return plannedChangeView(operation, diff?.unifiedText ?? "");
    }),
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
  return {
    entry: historyEntry(record, snapshot),
    plan: {
      planId: plan.deploymentPlanId,
      planHash: plan.planHash,
      requiredConfirmations: plan.requiredConfirmations,
    },
    changes: plan.operations.map((operation) => {
      const diff = plan.diffs.find(({ targetPath }) => targetPath === operation.targetPath);
      return plannedChangeView(operation, diff?.unifiedText ?? "");
    }),
  };
}

function plannedChangeView(operation: DeploymentOperation, diff: string) {
  const deploymentType = operation.deploymentType ?? "generated_file";
  return {
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
