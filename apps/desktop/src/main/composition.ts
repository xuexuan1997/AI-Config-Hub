import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createDefaultAdapterRegistry } from "@ai-config-hub/adapters";
import { DeploymentStatusSchema, EffectiveConfigSchema } from "@ai-config-hub/core";
import type {
  AdapterReadApi,
  AdapterRegistration,
  Asset,
  DeploymentFilePort,
  DeploymentPlan,
  DeploymentRecord,
  Diagnostic,
  EffectiveConfig,
  GitCommitSummary,
  Page,
  PublicSettings,
} from "@ai-config-hub/core";
import {
  DeploymentExecutionService,
  DeploymentPreviewService,
  DeploymentRollbackService,
  NodeDeploymentFilePort,
  PathLockManager,
} from "@ai-config-hub/deployer";
import {
  createCancellationController,
  createNodeFileAccess,
  ScanService,
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
  ResourceKindSchema,
  ScanRunIdSchema,
  SemVerSchema,
  ScopeKindSchema,
  TaskIdSchema,
  ToolIdSchema,
  type AbsolutePath,
  type ContentHash,
  type ScopeKind,
  type TaskId,
} from "@ai-config-hub/shared";
import type { ApiCommandName, CommandServiceMap } from "@ai-config-hub/api";
import { TaskEventSchema, type TaskEvent, type TaskPhase } from "@ai-config-hub/api";
import { LocalHistoryService, SystemLocalGitPort } from "@ai-config-hub/git";
import { createStorageRepositories, openDatabase } from "@ai-config-hub/storage";

export interface DesktopCommandServiceOptions {
  readonly userDataPath: string;
  readonly appVersion: string;
  readonly cwd?: string;
  readonly homeDirectory?: string;
  readonly now?: () => string;
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
  readonly backupRoot: AbsolutePath;
  readonly historyRoot: AbsolutePath;
  readonly history: LocalHistoryService;
  readonly now: () => string;
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
  const historyRoot = await ensurePrivateDirectory(
    join(options.userDataPath, "history", "local-git"),
  );
  const opened = await openDatabase({
    path: join(options.userDataPath, "ai-config-hub.sqlite"),
    appVersion: options.appVersion,
  });
  const repositories = createStorageRepositories(opened);
  return {
    repositories,
    databaseRecovery: opened.mode === "read_only_recovery",
    backupRoot,
    historyRoot,
    history: new LocalHistoryService({
      git: new SystemLocalGitPort(),
      now: () => IsoDateTimeSchema.parse(options.now?.() ?? new Date().toISOString()),
    }),
    now: options.now ?? (() => new Date().toISOString()),
    close() {
      repositories.database.close();
    },
  };
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

  const services: Record<ApiCommandName, (payload: unknown) => Promise<unknown>> = {
    "scan.start": async (payload) => {
      const request = payload as {
        readonly roots?: readonly string[];
        readonly toolKeys?: readonly string[];
      };
      const allowedRoots = scanRoots(request.roots, cwd, homeDirectory);
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
      const scanner = new ScanService({
        registrations: scanRegistrations(registry.registrations, request.toolKeys),
        read: access.read,
        snapshots: access.snapshots,
        indexRepository: runtime.repositories.index,
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
      return {
        taskId: TaskIdSchema.parse(request.taskId),
        cancelRequested: true,
        effectiveAfterPhase: apiPhase(task.progress?.phase ?? task.status),
      };
    },
    "assets.list": async (payload) => {
      const request = payload as {
        readonly toolKeys?: Parameters<typeof runtime.repositories.index.listAssets>[0]["toolIds"];
        readonly resourceTypes?: Parameters<
          typeof runtime.repositories.index.listAssets
        >[0]["resourceKinds"];
        readonly query?: string;
        readonly cursor?: string;
        readonly limit?: number;
      };
      const page = await runtime.repositories.index.listAssets({
        ...(request.toolKeys === undefined ? {} : { toolIds: request.toolKeys }),
        ...(request.resourceTypes === undefined ? {} : { resourceKinds: request.resourceTypes }),
        ...(request.query === undefined ? {} : { search: request.query }),
        ...(request.cursor === undefined
          ? {}
          : { cursor: PaginationCursorSchema.parse(request.cursor) }),
        limit: request.limit ?? 50,
      });
      const scopeKinds = scopeKindsForAssets(runtime, page.items);
      return {
        items: page.items.map((asset) => ({
          id: asset.assetId,
          toolKey: asset.toolId,
          resourceType: asset.resource.kind,
          scopeKind: scopeKinds.get(asset.scopeId) ?? "project",
          logicalKey: asset.locator,
          contentHash: asset.contentHash,
          diagnosticCounts: asset.diagnosticSummary,
        })),
        nextCursor: page.nextCursor ?? null,
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
          ...(include.includes("normalized") ? { normalized: toJson(asset.resource) } : {}),
          ...(include.includes("references") ? { references: asset.references } : {}),
          ...(include.includes("diagnostics") ? { diagnosticIds: [] } : {}),
        },
        source: {
          pathDisplay: asset.canonicalSourcePath,
          contentHash: asset.contentHash,
          observedAt: asset.discoveredAt,
        },
        redactions: [],
      };
    },
    "effective.resolve": (payload) => {
      const request = payload as {
        readonly toolKey: string;
        readonly targetScopeId: string;
        readonly resourceTypes?: readonly string[];
      };
      const configs = effectiveConfigs(runtime);
      const targetPath = resolve(request.targetScopeId);
      const found = configs.find(
        (config) =>
          config.toolInstallationId.startsWith(`${request.toolKey}:`) &&
          (config.canonicalTargetPath === targetPath ||
            config.effectiveConfigId === request.targetScopeId),
      );
      if (found === undefined) throw notFound("Effective configuration not found");
      const resourceTypes = new Set(request.resourceTypes ?? []);
      const resources =
        resourceTypes.size === 0
          ? found.resolvedResources
          : found.resolvedResources.filter((resource) => resourceTypes.has(resource.kind));
      return Promise.resolve({
        effective: toJson(resources),
        contributors: found.steps
          .filter((step) => step.action !== "ignore")
          .map((step) => ({
            assetId: step.assetId,
            action: step.action,
            reasonCode: reasonCode(step.reason),
          })),
        ignored: found.steps
          .filter((step) => step.action === "ignore")
          .map((step) => ({ assetId: step.assetId, reasonCode: reasonCode(step.reason) })),
        diagnostics: found.diagnostics.map(diagnosticView),
        snapshotRevision: databaseRevision(runtime),
      });
    },
    "diagnostics.list": async (payload) => {
      const request = payload as {
        readonly assetId?: string;
        readonly severities?: readonly string[];
        readonly cursor?: string;
        readonly limit?: number;
      };
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
        limit: request.limit ?? 50,
      });
      return diagnosticsPage(page);
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
      const allowedRoots = [
        ...new Set([targetRoot, ...assets.map((asset) => dirname(asset.canonicalSourcePath))]),
      ].map((root) => AbsolutePathSchema.parse(root));
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
          toolId: ToolIdSchema.parse(request.targetToolKey),
          resourceKind: ResourceKindSchema.parse(first.resource.kind),
          targetSchemaVersion: SemVerSchema.parse("1.0.0"),
        },
        targetRoot,
        backupRoot: runtime.backupRoot,
        allowedRoots,
        conflictPolicy: request.conflictPolicy ?? "replace",
        now: now(runtime),
        correlationId: CorrelationIdSchema.parse(`correlation:desktop:${randomUUID()}`),
        signal: AbortSignal.timeout(60_000),
      });
      return migrationPreviewResponse(preview.plan, now(runtime));
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
        locks: new PathLockManager(),
        registry,
        read: instrumentDeploymentRead(access.read, recorder),
      });
      recorder.accept();
      recorder.changePhase("preflight");
      recorder.progress(0);
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
          locks: new PathLockManager(),
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
        locks: new PathLockManager(),
      });
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
    readonly type: "accepted" | "phase.changed" | "progress" | "item.failed" | "completed";
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

function scanRoots(
  requestRoots: readonly string[] | undefined,
  cwd: AbsolutePath,
  homeDirectory: AbsolutePath,
): readonly AbsolutePath[] {
  if ((requestRoots?.length ?? 0) > 0) {
    return uniquePaths((requestRoots ?? []).map((root) => AbsolutePathSchema.parse(resolve(root))));
  }
  return uniquePaths([cwd, homeDirectory]);
}

function uniquePaths(paths: readonly AbsolutePath[]): readonly AbsolutePath[] {
  return [...new Set(paths)].sort();
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

function effectiveConfigs(runtime: DesktopRuntime): readonly EffectiveConfig[] {
  const rows = runtime.repositories.database
    .prepare("SELECT effective_configs_json FROM scan_runs ORDER BY started_at DESC")
    .all() as { readonly effective_configs_json: string }[];
  return rows.flatMap((row) =>
    EffectiveConfigSchema.array().parse(JSON.parse(row.effective_configs_json)),
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

function migrationPreviewResponse(plan: DeploymentPlan, generatedAt: string) {
  return {
    planId: plan.deploymentPlanId,
    planHash: plan.planHash,
    compatibility: plan.requiredConfirmations.includes("partial_conversion")
      ? ("partial" as const)
      : ("full" as const),
    requiredConfirmations: plan.requiredConfirmations,
    changes: plan.operations.map((operation) => {
      const diff = plan.diffs.find(({ targetPath }) => targetPath === operation.targetPath);
      return {
        operation: operation.kind,
        pathDisplay: operation.targetPath,
        beforeHash: operation.expectedTargetHash === "absent" ? null : operation.expectedTargetHash,
        afterHash: operation.kind === "delete" ? null : contentHash(operation.nextText),
        diff: diff?.unifiedText ?? "",
      };
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
  const roots = record.operations.map((operation) =>
    existingAncestor(dirname(operation.targetPath)),
  );
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
