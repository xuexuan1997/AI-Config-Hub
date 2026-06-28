import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createDefaultAdapterRegistry } from "@ai-config-hub/adapters";
import { EffectiveConfigSchema } from "@ai-config-hub/core";
import type {
  AdapterRegistration,
  DeploymentPlan,
  DeploymentRecord,
  Diagnostic,
  EffectiveConfig,
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
  TaskIdSchema,
  ToolIdSchema,
  type AbsolutePath,
  type ContentHash,
} from "@ai-config-hub/shared";
import type { ApiCommandName, CommandServiceMap } from "@ai-config-hub/api";
import { TaskEventSchema, type TaskEvent } from "@ai-config-hub/api";
import { createStorageRepositories, openDatabase } from "@ai-config-hub/storage";

export interface DesktopCommandServiceOptions {
  readonly userDataPath: string;
  readonly appVersion: string;
  readonly cwd?: string;
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
  readonly now: () => string;
  close(): void;
}

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
  await mkdir(options.userDataPath, { recursive: true, mode: 0o700 });
  const opened = await openDatabase({
    path: join(options.userDataPath, "ai-config-hub.sqlite"),
    appVersion: options.appVersion,
  });
  const repositories = createStorageRepositories(opened);
  return {
    repositories,
    databaseRecovery: opened.mode === "read_only_recovery",
    backupRoot: AbsolutePathSchema.parse(join(options.userDataPath, "backups", "deployments")),
    now: options.now ?? (() => new Date().toISOString()),
    close() {
      repositories.database.close();
    },
  };
}

function createServices(
  runtime: DesktopRuntime,
  options: DesktopCommandServiceOptions,
  taskEvents: DesktopTaskEvents,
): CommandServiceMap {
  const cwd = AbsolutePathSchema.parse(resolve(options.cwd ?? process.cwd()));
  const registry = createDefaultAdapterRegistry();

  const services: Record<ApiCommandName, (payload: unknown) => Promise<unknown>> = {
    "scan.start": async (payload) => {
      const request = payload as {
        readonly roots?: readonly string[];
        readonly toolKeys?: readonly string[];
      };
      const roots = (request.roots?.length ?? 0) > 0 ? (request.roots ?? []) : [cwd];
      const allowedRoots = roots.map((root) => AbsolutePathSchema.parse(resolve(root)));
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
        homeDirectory: AbsolutePathSchema.parse(homedir()),
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
      return {
        items: page.items.map((asset) => ({
          id: asset.assetId,
          toolKey: asset.toolId,
          resourceType: asset.resource.kind,
          scopeKind: "project" as const,
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
        now: now(runtime),
        correlationId: CorrelationIdSchema.parse(`correlation:desktop:${randomUUID()}`),
        signal: AbortSignal.timeout(60_000),
      });
      return migrationPreviewResponse(preview.plan, now(runtime));
    },
    "deployment.execute": async (payload) => {
      const request = payload as { readonly planId: string };
      const planId = DeploymentPlanIdSchema.parse(request.planId);
      const found = deploymentRecordForPlan(runtime, planId);
      const plan = await runtime.repositories.deployments.getPlan(planId);
      if (found === undefined || plan === undefined) throw notFound("Deployment plan not found");
      const roots = deploymentRoots(found);
      const access = await createNodeFileAccess({ allowedRoots: roots, platform: platform() });
      const service = new DeploymentExecutionService({
        deploymentRepository: runtime.repositories.deployments,
        sourceHashes: {
          currentHash: async (assetId) =>
            (await runtime.repositories.index.getAsset(AssetIdSchema.parse(assetId)))?.contentHash,
        },
        snapshots: access.snapshots,
        deploymentFiles: new NodeDeploymentFilePort({
          allowedRoots: roots,
          backupRoot: runtime.backupRoot,
        }),
        locks: new PathLockManager(),
        registry,
        read: access.read,
      });
      const record = await service.execute({
        deploymentRecordId: found.deploymentRecordId,
        confirmedPlanHash: plan.planHash,
        confirmations: plan.requiredConfirmations,
        allowedRoots: roots,
        now: now(runtime),
      });
      if (record.status !== "succeeded") {
        throw new AppError({
          code: "VALIDATION_FAILED",
          message: `Deployment did not succeed: ${record.status}`,
          retryable: false,
          suggestedActions: [
            "Review deployment diagnostics and create a fresh preview before retrying",
          ],
        });
      }
      const taskId = TaskIdSchema.parse(`task:deployment:${record.deploymentRecordId}`);
      taskEvents.record({
        taskId,
        emittedAt: record.createdAt,
        type: "accepted",
        payload: { taskKind: "deployment", phase: "queued", acceptedAt: record.createdAt },
      });
      taskEvents.record({
        taskId,
        emittedAt: record.finishedAt ?? now(runtime),
        type: "completed",
        payload: {
          status: "succeeded",
          succeededCount: record.operations.length,
          failedCount: 0,
          skippedCount: 0,
          resultRef: record.deploymentRecordId,
          systemRecoveryLock: false,
        },
      });
      return {
        taskId,
        status: "queued",
        acceptedAt: record.createdAt,
        deploymentId: record.deploymentRecordId,
      };
    },
    "deployment.rollback": async (payload) => {
      const request = payload as { readonly deploymentId: string };
      const originalId = DeploymentRecordIdSchema.parse(request.deploymentId);
      const roots = rollbackRoots(runtime, originalId);
      const access = await createNodeFileAccess({ allowedRoots: roots, platform: platform() });
      const service = new DeploymentRollbackService({
        deploymentRepository: runtime.repositories.deployments,
        snapshots: access.snapshots,
        deploymentFiles: new NodeDeploymentFilePort({
          allowedRoots: roots,
          backupRoot: runtime.backupRoot,
        }),
        locks: new PathLockManager(),
      });
      const plan = await service.preview(originalId);
      const record = await service.execute({
        deploymentRecordId: originalId,
        rollbackPlanHash: plan.planHash,
        now: now(runtime),
      });
      const taskId = TaskIdSchema.parse(`task:rollback:${record.deploymentRecordId}`);
      taskEvents.record({
        taskId,
        emittedAt: record.createdAt,
        type: "accepted",
        payload: { taskKind: "rollback", phase: "queued", acceptedAt: record.createdAt },
      });
      taskEvents.record({
        taskId,
        emittedAt: record.finishedAt ?? now(runtime),
        type: "completed",
        payload: {
          status: record.status === "succeeded" ? "succeeded" : "failed",
          succeededCount: record.status === "succeeded" ? record.operations.length : 0,
          failedCount: record.status === "succeeded" ? 0 : 1,
          skippedCount: 0,
          resultRef: record.deploymentRecordId,
          systemRecoveryLock: record.status !== "succeeded",
        },
      });
      return {
        taskId,
        status: "queued",
        acceptedAt: record.createdAt,
        rollbackId: record.deploymentRecordId,
      };
    },
    "history.list": async (payload) => {
      const request = payload as { readonly cursor?: string; readonly limit?: number };
      const page = await runtime.repositories.deployments.listRecords({
        ...(request.cursor === undefined
          ? {}
          : { cursor: PaginationCursorSchema.parse(request.cursor) }),
        limit: request.limit ?? 50,
      });
      return {
        items: page.items.map(historyEntry),
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
          readonly pathDisplay?: "full" | "abbreviated";
          readonly fileWatching?: boolean;
        };
      };
      const current = await runtime.repositories.settings.getPublic();
      const next = await runtime.repositories.settings.updatePublic({
        expectedRevision: String(request.expectedRevision),
        settings: {
          ...current.settings,
          ...(request.patch.pathDisplay === undefined
            ? {}
            : { pathDisplay: request.patch.pathDisplay }),
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

class DesktopTaskEvents implements DesktopTaskEventPort {
  readonly #events = new Map<string, TaskEvent[]>();
  readonly #listeners = new Map<string, Set<(event: TaskEvent) => void>>();
  readonly #lastSequence = new Map<string, number>();

  subscribe(
    taskId: string,
    afterSequence: number,
    listener: (event: TaskEvent) => void,
  ): () => void {
    const parsedTaskId = TaskIdSchema.parse(taskId);
    for (const event of this.#events.get(parsedTaskId) ?? []) {
      if (event.sequence !== null && event.sequence > afterSequence) listener(event);
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
    readonly type: "accepted" | "phase.changed" | "completed";
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
    });
    const events = this.#events.get(taskId) ?? [];
    events.push(event);
    this.#events.set(taskId, events.slice(-200));
    for (const listener of this.#listeners.get(taskId) ?? []) listener(event);
    return event;
  }
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
    expiresAt: IsoDateTimeSchema.parse(
      new Date(Date.parse(generatedAt) + 10 * 60 * 1_000).toISOString(),
    ),
  };
}

function historyEntry(record: DeploymentRecord) {
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

function rollbackRoots(
  runtime: DesktopRuntime,
  deploymentRecordId: string,
): readonly AbsolutePath[] {
  const record = runtime.repositories.database
    .prepare("SELECT verification_json FROM deployments WHERE domain_id = ?")
    .get(DeploymentRecordIdSchema.parse(deploymentRecordId)) as
    | { verification_json: string }
    | undefined;
  if (record === undefined) throw notFound("Deployment record not found");
  return deploymentRoots(JSON.parse(record.verification_json) as DeploymentRecord);
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
    pathDisplay: settings.pathDisplay,
    fileWatching: settings.fileWatching,
  };
}

function selectSettings(
  keys: readonly string[],
  values: ReturnType<typeof settingsValues>,
): Partial<ReturnType<typeof settingsValues>> {
  const selected: Partial<ReturnType<typeof settingsValues>> = {};
  for (const key of keys) {
    if (key === "pathDisplay") selected.pathDisplay = values.pathDisplay;
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
