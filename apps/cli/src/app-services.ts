import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { createDefaultAdapterRegistry, type AdapterRegistry } from "@ai-config-hub/adapters";
import { DeploymentStatusSchema } from "@ai-config-hub/core";
import type {
  AdapterRegistration,
  AdapterEffectiveConfigDraft,
  Asset,
  ConversionResult,
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
  DeploymentPreviewService,
  DeploymentExecutionService,
  DeploymentRollbackService,
  NodeDeploymentFilePort,
  PathLockManager,
} from "@ai-config-hub/deployer";
import {
  createCancellationController,
  createNodeFileAccess,
  ScanService,
} from "@ai-config-hub/scanner";
import { LocalHistoryService, SystemLocalGitPort } from "@ai-config-hub/git";
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
} from "@ai-config-hub/shared";
import { createStorageRepositories, openDatabase } from "@ai-config-hub/storage";
import {
  createDiagnosticReport,
  type ApiCommandName,
  type CommandRequest,
  type CommandServiceMap,
  type DiagnosticReportPathRoot,
} from "@ai-config-hub/api";

const APP_VERSION = "0.2.4";

export interface CliServiceOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly now?: () => string;
}

interface CliRuntime {
  readonly repositories: ReturnType<typeof createStorageRepositories>;
  readonly databaseRecovery: boolean;
  readonly appDataRoot: AbsolutePath;
  readonly backupRoot: AbsolutePath;
  readonly historyRoot: AbsolutePath;
  readonly history: LocalHistoryService;
  readonly pathLocks: PathLockManager;
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

export async function createCliCommandServices(
  options: CliServiceOptions = {},
): Promise<{ readonly services: CommandServiceMap; readonly close: () => void }> {
  const runtime = await createRuntime(options);
  return {
    services: createServices(runtime, options),
    close: () => runtime.close(),
  };
}

async function createRuntime(options: CliServiceOptions): Promise<CliRuntime> {
  const env = options.env ?? process.env;
  const userData = dataRoot(env);
  await ensurePrivateDirectory(userData);
  const backupRoot = await ensurePrivateDirectory(join(userData, "backups", "deployments"));
  const historyRoot = await ensurePrivateDirectory(join(userData, "history", "local-git"));
  const opened = await openDatabase({
    path: join(userData, "ai-config-hub.sqlite"),
    appVersion: APP_VERSION,
  });
  const repositories = createStorageRepositories(opened);
  return {
    repositories,
    databaseRecovery: opened.mode === "read_only_recovery",
    appDataRoot: AbsolutePathSchema.parse(userData),
    backupRoot,
    historyRoot,
    history: new LocalHistoryService({
      git: new SystemLocalGitPort(),
      now: () => IsoDateTimeSchema.parse(options.now?.() ?? new Date().toISOString()),
    }),
    pathLocks: new PathLockManager(),
    now: options.now ?? (() => new Date().toISOString()),
    close() {
      repositories.database.close();
    },
  };
}

function createServices(runtime: CliRuntime, options: CliServiceOptions): CommandServiceMap {
  const cwd = AbsolutePathSchema.parse(resolve(options.cwd ?? process.cwd()));
  const homeDirectory = AbsolutePathSchema.parse(resolve(options.homeDirectory ?? homedir()));
  const registry = createDefaultAdapterRegistry();

  const services: Record<ApiCommandName, (payload: unknown) => Promise<unknown>> = {
    "scan.start": async (payload) => {
      const request = payload as {
        readonly changedPaths?: readonly string[];
        readonly mode?: "full" | "incremental";
        readonly roots?: readonly string[];
        readonly toolKeys?: readonly string[];
      };
      const allowedRoots = scanRoots(request.roots, cwd, homeDirectory);
      const changedPaths = changedScanPaths(request.changedPaths, cwd);
      const taskId = TaskIdSchema.parse(`task:scan:${randomUUID()}`);
      const scanRunId = ScanRunIdSchema.parse(`scan:${randomUUID()}`);
      const acceptedAt = now(runtime);
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
      const summary = await scanner.scan({
        scanRunId,
        candidateRoots: allowedRoots,
        ...(request.mode === "incremental" && canonicalChangedPaths !== undefined
          ? { changedPaths: canonicalChangedPaths }
          : {}),
        homeDirectory,
        platform: scannerPlatform(),
        signal: cancellation.signal,
        onPhase: (phase) => {
          sequence += 1;
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
      const requiresPostFilter =
        requestedScopeKinds !== undefined || diagnosticSeverity !== undefined;
      const page = await runtime.repositories.index.listAssets({
        ...(request.toolKeys === undefined ? {} : { toolIds: request.toolKeys }),
        ...(request.resourceTypes === undefined ? {} : { resourceKinds: request.resourceTypes }),
        ...(request.query === undefined ? {} : { search: request.query }),
        ...(request.cursor === undefined
          ? {}
          : { cursor: PaginationCursorSchema.parse(request.cursor) }),
        limit: requiresPostFilter ? 10_000 : requestedLimit,
      });
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
    "assets.openSource": () => {
      return Promise.reject(
        unsupported("Opening source files in an external editor is available in the desktop app"),
      );
    },
    "assets.disable": async (payload) => {
      const request = payload as CommandRequest<"assets.disable">;
      const result = await runtime.repositories.index.setAssetStatus(
        AssetIdSchema.parse(request.assetId),
        "disabled",
      );
      return { assetId: result.assetId, status: "disabled" as const };
    },
    "assets.enable": async (payload) => {
      const request = payload as CommandRequest<"assets.enable">;
      const result = await runtime.repositories.index.setAssetStatus(
        AssetIdSchema.parse(request.assetId),
        "enabled",
      );
      return { assetId: result.assetId, status: "enabled" as const };
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
        conflictPolicy: request.conflictPolicy ?? "fail",
        now: now(runtime),
        correlationId: CorrelationIdSchema.parse(`correlation:cli:${randomUUID()}`),
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
        locks: runtime.pathLocks,
        registry,
        read: access.read,
      });
      const record = await service.execute({
        deploymentRecordId: found.deploymentRecordId,
        confirmedPlanHash: ContentHashSchema.parse(request.confirmedPlanHash),
        confirmations: request.confirmations ?? [],
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
      const snapshot = await recordDeploymentSnapshot(runtime, record, plan);
      return {
        taskId: TaskIdSchema.parse(`task:deployment:${record.deploymentRecordId}`),
        status: "queued",
        acceptedAt: record.createdAt,
        deploymentId: record.deploymentRecordId,
        snapshot,
      };
    },
    "deployment.rollback": async (payload) => {
      const request = payload as { readonly deploymentId: string };
      const originalId = DeploymentRecordIdSchema.parse(request.deploymentId);
      const original = deploymentRecordById(runtime, originalId);
      const roots = rollbackRoots(runtime, originalId);
      const access = await createNodeFileAccess({
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
      const plan = await service.preview(originalId);
      const record = await service.execute({
        deploymentRecordId: originalId,
        rollbackPlanHash: plan.planHash,
        now: now(runtime),
      });
      if (record.status !== "succeeded") {
        throw new AppError({
          code: "VALIDATION_FAILED",
          message: `Rollback did not succeed: ${record.status}`,
          retryable: false,
          suggestedActions: ["Review rollback diagnostics before retrying"],
        });
      }
      const originalPlan =
        original === undefined
          ? undefined
          : await runtime.repositories.deployments.getPlan(original.deploymentPlanId);
      const snapshot = await recordDeploymentSnapshot(runtime, record, originalPlan);
      return {
        taskId: TaskIdSchema.parse(`task:rollback:${record.deploymentRecordId}`),
        status: "queued",
        acceptedAt: record.createdAt,
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

function dataRoot(env: NodeJS.ProcessEnv): string {
  if (env["AI_CONFIG_HUB_USER_DATA"] !== undefined) return resolve(env["AI_CONFIG_HUB_USER_DATA"]);
  if (platform() === "darwin")
    return join(homedir(), "Library", "Application Support", "AI Config Hub");
  if (platform() === "win32") {
    return join(env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "AI Config Hub");
  }
  return join(env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), "ai-config-hub");
}

async function ensurePrivateDirectory(path: string): Promise<AbsolutePath> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (platform() !== "win32") await chmod(path, 0o700);
  return AbsolutePathSchema.parse(path);
}

function now(runtime: CliRuntime): string {
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
    suggestedActions: ["Run a fresh scan and use a supported CLI command"],
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

async function diagnosticFilterAssets(runtime: CliRuntime): Promise<readonly Asset[]> {
  return (await runtime.repositories.index.listAssets({ limit: 10_000 })).items;
}

function diagnosticFilterContext(
  runtime: CliRuntime,
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
  runtime: CliRuntime,
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
  runtime: CliRuntime,
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
      .map((step) => ({ assetId: step.assetId, reasonCode: reasonCode(step.reason) })),
    diagnostics: [],
    snapshotRevision: databaseRevision(runtime),
  };
}

function toolInstallations(runtime: CliRuntime): readonly ToolInstallation[] {
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

function databaseRevision(runtime: CliRuntime): string {
  return String(
    (runtime.repositories.database.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
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

function scopeKindsForAssets(
  runtime: CliRuntime,
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

async function assetsForPlan(runtime: CliRuntime, plan: DeploymentPlan): Promise<readonly Asset[]> {
  const assets = await Promise.all(
    Object.keys(plan.expectedSourceHashes)
      .sort()
      .map(async (id) => runtime.repositories.index.getAsset(AssetIdSchema.parse(id))),
  );
  return assets.filter((asset): asset is Asset => asset !== undefined);
}

async function recordDeploymentSnapshot(
  runtime: CliRuntime,
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
  runtime: CliRuntime,
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
      return {
        operation: operation.kind,
        pathDisplay: operation.targetPath,
        beforeHash: operation.expectedTargetHash === "absent" ? null : operation.expectedTargetHash,
        afterHash: operation.kind === "delete" ? null : contentHash(operation.nextText),
        diff: diff?.unifiedText ?? "",
      };
    }),
  };
}

function deploymentRecordForPlan(
  runtime: CliRuntime,
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
  runtime: CliRuntime,
  deploymentRecordId: string,
): DeploymentRecord | undefined {
  const row = runtime.repositories.database
    .prepare("SELECT verification_json FROM deployments WHERE domain_id = ?")
    .get(DeploymentRecordIdSchema.parse(deploymentRecordId)) as
    | { verification_json: string }
    | undefined;
  return row === undefined ? undefined : (JSON.parse(row.verification_json) as DeploymentRecord);
}

function rollbackRoots(runtime: CliRuntime, deploymentRecordId: string): readonly AbsolutePath[] {
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
