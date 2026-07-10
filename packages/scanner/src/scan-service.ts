import { dirname } from "node:path";

import { AdapterDiscoveryLimitError } from "@ai-config-hub/adapters";
import type {
  AdapterDiagnostic,
  AdapterEffectiveConfigDraft,
  AdapterReadApi,
  AdapterRegistration,
  Asset,
  CancellationSignal,
  Diagnostic,
  DiscoveredResource,
  FileSnapshot,
  FileSnapshotPort,
  IndexRepository,
  ParsedAsset,
  Scope,
  ScanRunSummary,
  ToolAdapter,
  ToolInstallation,
} from "@ai-config-hub/core";
import {
  AssetSchema,
  EffectiveConfigSchema,
  ScanRunSummarySchema,
  ScopeSchema,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AppError,
  AssetIdSchema,
  DiagnosticIdSchema,
  EffectiveConfigIdSchema,
  IsoDateTimeSchema,
  JsonPointerSchema,
  PaginationCursorSchema,
  ProjectIdSchema,
  ScanRunIdSchema,
  ScopeIdSchema,
  type AbsolutePath,
} from "@ai-config-hub/shared";

import { normalizeAdapterDiagnostic, uniqueAdapterDiagnostics } from "./diagnostics.js";
import { FileSnapshotLimitError } from "./file-reader.js";
import { stableId } from "./identity.js";

export type ScanPhase =
  | "discovering"
  | "reading"
  | "parsing"
  | "validating"
  | "committing"
  | "completed";

export interface ScanServiceOptions {
  readonly registrations: readonly AdapterRegistration[];
  readonly read: AdapterReadApi;
  readonly snapshots: FileSnapshotPort;
  readonly indexRepository: IndexRepository;
  readonly maxConcurrency?: number;
  readonly now?: () => string;
}

export type ScanCommitMode = "replace-all" | "merge-scoped";

export interface ScanInput {
  readonly scanRunId: string;
  readonly candidateRoots: readonly AbsolutePath[];
  readonly changedPaths?: readonly AbsolutePath[];
  readonly commitMode?: ScanCommitMode;
  readonly homeDirectory: AbsolutePath;
  readonly platform: "linux" | "darwin" | "win32";
  readonly signal: CancellationSignal;
  readonly onPhase?: (phase: ScanPhase) => void;
}

export interface ScanItemFailure {
  readonly itemRef: AbsolutePath;
  readonly diagnosticId: Diagnostic["diagnosticId"];
  readonly errorCode: Diagnostic["code"];
  readonly retryable: boolean;
}

interface WorkItem {
  readonly adapter: ToolAdapter;
  readonly tool: ToolInstallation;
  readonly candidate: DiscoveredResource;
}

interface ReadItem extends WorkItem {
  readonly snapshot?: FileSnapshot;
  readonly readDiagnostic?: AdapterDiagnostic;
}

interface ParsedItem extends ReadItem {
  readonly status: "parsed" | "rejected";
  readonly parsedAssets: readonly ParsedAsset[];
  readonly diagnostics: readonly AdapterDiagnostic[];
}

interface DiscoveryFailure {
  readonly itemRef: AbsolutePath;
  readonly diagnostic: AdapterDiagnostic;
  readonly tool: ToolInstallation;
}

export class ScanService {
  private readonly maxConcurrency: number;
  private readonly now: () => string;

  constructor(private readonly options: ScanServiceOptions) {
    this.maxConcurrency = Math.max(1, Math.min(16, options.maxConcurrency ?? 16));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async scan(input: ScanInput): Promise<{
    readonly summary: ScanRunSummary;
    readonly revision: string;
    readonly itemFailures: readonly ScanItemFailure[];
  }> {
    const scanRunId = ScanRunIdSchema.parse(input.scanRunId);
    const createdAt = IsoDateTimeSchema.parse(this.now());
    this.phase(input, "discovering");
    const adapters = [...this.options.registrations]
      .sort((left, right) => left.toolId.localeCompare(right.toolId))
      .map((registration) => registration.create({ logger: { debug() {}, warn() {} } }));
    const tools: ToolInstallation[] = [];
    const work: WorkItem[] = [];
    const adapterDiagnostics: AdapterDiagnostic[] = [];
    const discoveryFailures: DiscoveryFailure[] = [];
    for (const adapter of adapters) {
      input.signal.throwIfAborted();
      const detection = await adapter.detect({
        platform: input.platform,
        homeDirectory: input.homeDirectory,
        candidateRoots: input.candidateRoots,
        read: this.options.read,
        signal: input.signal,
      });
      adapterDiagnostics.push(...detection.diagnostics);
      for (const tool of [...detection.installations].sort((left, right) =>
        left.installationId.localeCompare(right.installationId),
      )) {
        tools.push(tool);
        try {
          const discovery = await adapter.discover({
            tool,
            allowedRoots: tool.configRoots,
            read: this.options.read,
            signal: input.signal,
          });
          adapterDiagnostics.push(...discovery.diagnostics);
          for (const candidate of discovery.candidates) work.push({ adapter, tool, candidate });
        } catch (error) {
          input.signal.throwIfAborted();
          if (!(error instanceof AdapterDiscoveryLimitError)) throw error;
          const diagnostic = discoveryLimitDiagnostic(error, tool);
          adapterDiagnostics.push(diagnostic);
          discoveryFailures.push({ itemRef: error.root, diagnostic, tool });
        }
      }
    }
    const failedInstallationIds = new Set<string>(
      discoveryFailures.map(({ tool }) => tool.installationId),
    );
    const indexedAssets =
      input.changedPaths === undefined && failedInstallationIds.size === 0
        ? []
        : await listAllAssets(this.options.indexRepository);
    const indexedScopes =
      failedInstallationIds.size === 0 ? [] : await this.options.indexRepository.listScopes();
    const preservedScopes = indexedScopes.filter((scope) => {
      const installationId = scope.discoveryEvidence["installationId"];
      return typeof installationId === "string" && failedInstallationIds.has(installationId);
    });
    const preservedScopeIds = new Set(preservedScopes.map(({ scopeId }) => scopeId));
    const preservedAssets = indexedAssets.filter(({ scopeId }) => preservedScopeIds.has(scopeId));
    const changedPaths =
      input.changedPaths === undefined
        ? undefined
        : expandChangedPaths(input.changedPaths, indexedAssets);
    const affectedInstallationIds =
      changedPaths === undefined ? undefined : affectedInstallations(tools, work, changedPaths);
    const narrowedWork =
      changedPaths === undefined
        ? work
        : work.filter((item) => pathMatchesAnyChangedPath(item.candidate.sourcePath, changedPaths));
    narrowedWork.sort((left, right) =>
      `${left.tool.installationId}:${left.candidate.sourcePath}:${left.candidate.resourceKindHint ?? ""}`.localeCompare(
        `${right.tool.installationId}:${right.candidate.sourcePath}:${right.candidate.resourceKindHint ?? ""}`,
      ),
    );

    this.phase(input, "reading");
    const readItems = await mapLimit(
      narrowedWork,
      this.maxConcurrency,
      async (item): Promise<ReadItem> => {
        input.signal.throwIfAborted();
        try {
          const snapshot = await this.options.snapshots.snapshot({
            path: item.candidate.sourcePath,
            allowedRoots: item.tool.configRoots,
          });
          if (snapshot !== undefined) return { ...item, snapshot };
          return item.candidate.resourceKindHint === "skill"
            ? {
                ...item,
                readDiagnostic: skillPrimaryDiagnostic(
                  item.candidate.sourcePath,
                  "SKILL_PRIMARY_FILE_MISSING",
                  {},
                ),
              }
            : item;
        } catch (error) {
          if (
            item.candidate.resourceKindHint === "skill" &&
            error instanceof FileSnapshotLimitError
          ) {
            return {
              ...item,
              readDiagnostic: skillPrimaryDiagnostic(
                item.candidate.sourcePath,
                "SKILL_PRIMARY_FILE_TOO_LARGE",
                {
                  limitBytes: error.limit,
                  observedBytes: error.observed,
                },
              ),
            };
          }
          return {
            ...item,
            readDiagnostic: {
              code: "SCAN_READ_FAILED",
              severity: "error",
              message: "The configuration file could not be read safely",
              location: { path: item.candidate.sourcePath },
              evidence: {},
              suggestedActions: ["Check file permissions and retry the scan"],
              blocking: true,
            },
          };
        }
      },
    );

    this.phase(input, "parsing");
    const parsedItems = await mapLimit(
      readItems,
      this.maxConcurrency,
      async (item): Promise<ParsedItem> => {
        input.signal.throwIfAborted();
        if (item.snapshot === undefined) {
          return {
            ...item,
            status: "rejected",
            parsedAssets: [],
            diagnostics: item.readDiagnostic === undefined ? [] : [item.readDiagnostic],
          };
        }
        const result = await item.adapter.parse({
          tool: item.tool,
          candidate: item.candidate,
          snapshot: item.snapshot,
          read: this.options.read,
          signal: input.signal,
        });
        return {
          ...item,
          status: result.status,
          parsedAssets: result.assets,
          diagnostics: result.diagnostics,
        };
      },
    );

    this.phase(input, "validating");
    const allAdapterDiagnostics = [
      ...adapterDiagnostics,
      ...parsedItems.flatMap((item) =>
        item.diagnostics.map((diagnostic) => withDiagnosticOwnership(diagnostic, item)),
      ),
    ];
    const parsedScopes = buildScopes(parsedItems);
    const parsedAssets = parsedItems
      .flatMap((item) =>
        item.parsedAssets.map((parsed) =>
          AssetSchema.parse({
            assetId: AssetIdSchema.parse(
              stableId("asset", [
                item.tool.installationId,
                scopeId(item.tool.installationId, parsed),
                parsed.canonicalSourcePath,
                parsed.locator,
              ]),
            ),
            toolId: parsed.toolId,
            resource: parsed.resource,
            scopeId: ScopeIdSchema.parse(scopeId(item.tool.installationId, parsed)),
            canonicalSourcePath:
              parsed.sourceFiles.find((sourceFile) => sourceFile.role === "primary")?.path ??
              parsed.canonicalSourcePath,
            locator: parsed.locator,
            sourceFormat: parsed.sourceFormat,
            contentHash: parsed.contentHash,
            sourceFiles: parsed.sourceFiles,
            nativeIdentity: parsed.nativeIdentity,
            normalizedSchemaVersion: item.adapter.capabilities.writtenSchemaVersion,
            adapterId: item.adapter.adapterId,
            adapterVersion: item.adapter.adapterVersion,
            discoveredAt: createdAt,
            references: parsed.references,
            ...(parsed.status === undefined ? {} : { status: parsed.status }),
            diagnosticSummary: { info: 0, warning: 0, error: 0 },
          }),
        ),
      )
      .sort((left, right) => left.assetId.localeCompare(right.assetId));
    const parsedAssetsWithStatuses = await applyStoredAssetStatuses(
      this.options.indexRepository,
      parsedAssets,
    );
    const cached =
      changedPaths === undefined || affectedInstallationIds === undefined
        ? { assets: [], scopes: [] }
        : await cachedClosure({
            repository: this.options.indexRepository,
            changedPaths,
            affectedInstallationIds,
          });
    if (changedPaths !== undefined && cached.assets.length > 0) {
      allAdapterDiagnostics.push(
        ...(await cachedParsingDiagnostics({
          repository: this.options.indexRepository,
          assets: cached.assets,
          scopes: cached.scopes,
        })),
      );
    }
    const scopes = uniqueScopes([...preservedScopes, ...cached.scopes, ...parsedScopes]);
    const assetsForResolution = uniqueAssets([
      ...preservedAssets,
      ...cached.assets,
      ...parsedAssetsWithStatuses,
    ]);
    // Incremental diagnosis evaluates the complete affected installation, so
    // commit those cached assets too. Storage can then replace their diagnostic
    // summaries and retire diagnostics that disappeared instead of accumulating
    // one copy per scan run.
    const assetsForCommit = assetsForResolution;
    const effectiveConfigs = [];
    const resolvedInstallations = mergeResolutionTargets(
      affectedInstallationIds === undefined
        ? uniqueResolutionTargets(parsedItems)
        : uniqueDetectedResolutionTargets(adapters, tools, affectedInstallationIds),
      uniqueDetectedResolutionTargets(adapters, tools, failedInstallationIds),
    );
    for (const { adapter, tool } of resolvedInstallations) {
      input.signal.throwIfAborted();
      const toolScopes = scopes.filter(
        (scope) =>
          scope.toolId === tool.toolId &&
          scope.discoveryEvidence["installationId"] === tool.installationId,
      );
      const toolScopeIds = new Set(toolScopes.map(({ scopeId }) => scopeId));
      const toolAssets = assetsForResolution.filter(({ scopeId }) => toolScopeIds.has(scopeId));
      const enabledToolAssets = toolAssets.filter(({ status }) => status !== "disabled");
      for (const targetPath of tool.configRoots) {
        const resolution = await adapter.resolveEffective({
          tool,
          targetPath,
          assets: enabledToolAssets,
          scopes: toolScopes,
          signal: input.signal,
        });
        const draft = withDisabledAssetsAsIgnored(
          resolution.draft,
          disabledApplicableAssets(toolAssets, toolScopes, tool.toolId, targetPath),
        );
        const diagnosis = await adapter.diagnose({
          tool,
          assets: enabledToolAssets,
          effectiveConfigDraft: draft,
          signal: input.signal,
        });
        allAdapterDiagnostics.push(
          ...resolution.diagnostics.map((diagnostic) =>
            withToolDiagnosticOwnership(diagnostic, tool),
          ),
          ...diagnosis.diagnostics.map((diagnostic) =>
            withToolDiagnosticOwnership(diagnostic, tool),
          ),
        );
        effectiveConfigs.push(
          EffectiveConfigSchema.parse({
            ...draft,
            effectiveConfigId: EffectiveConfigIdSchema.parse(
              stableId("effective", [
                tool.installationId,
                targetPath,
                draft.resolutionInputHash,
                adapter.adapterVersion,
              ]),
            ),
            toolInstallationId: tool.installationId,
            adapterId: adapter.adapterId,
            adapterVersion: adapter.adapterVersion,
            diagnostics: [],
            resolvedAt: createdAt,
          }),
        );
      }
    }
    const diagnostics = uniqueAdapterDiagnostics(allAdapterDiagnostics).map((diagnostic) =>
      normalizeAdapterDiagnostic({ diagnostic, scanRunId, createdAt }),
    );
    const itemFailures = [
      ...scanItemFailures({ parsedItems, scanRunId, createdAt }),
      ...discoveryItemFailures({ discoveryFailures, scanRunId, createdAt }),
    ].sort((left, right) => left.itemRef.localeCompare(right.itemRef));
    const assetsWithDiagnosticSummaries = summarizeAssetDiagnostics(
      assetsForCommit,
      diagnostics,
      scopes,
    );
    const succeededCount = parsedItems.filter(({ status }) => status === "parsed").length;
    const failedCount = parsedItems.length - succeededCount + discoveryFailures.length;
    const status =
      failedCount === 0 ? "succeeded" : succeededCount === 0 ? "failed" : "partially_succeeded";

    input.signal.throwIfAborted();
    this.phase(input, "committing");
    input.signal.throwIfAborted();
    const replacement = {
      scanRunId,
      scanCoverage: {
        roots: input.candidateRoots,
        toolIds: adapters.map(({ toolId }) => toolId),
      },
      tools: uniqueTools(tools),
      scopes,
      assets: assetsWithDiagnosticSummaries,
      effectiveConfigs,
      diagnostics,
    };
    const commitChangedPaths =
      changedPaths ??
      (input.commitMode === "merge-scoped"
        ? await scopedCommitChangedPaths({
            repository: this.options.indexRepository,
            candidateRoots: input.candidateRoots,
            parsedItems,
          })
        : undefined);
    const committed =
      commitChangedPaths === undefined
        ? await this.options.indexRepository.replaceDerivedIndex(replacement)
        : await this.options.indexRepository.mergeIncrementalIndex({
            ...replacement,
            changedPaths: commitChangedPaths,
          });
    const summary = ScanRunSummarySchema.parse({
      scanRunId,
      status,
      succeededCount,
      failedCount,
      skippedCount: 0,
      diagnosticIds: diagnostics.map(({ diagnosticId }) => DiagnosticIdSchema.parse(diagnosticId)),
    });
    this.phase(input, "completed");
    return { summary, revision: committed.revision, itemFailures };
  }

  private phase(input: ScanInput, phase: ScanPhase): void {
    input.signal.throwIfAborted();
    input.onPhase?.(phase);
  }
}

function scanItemFailures(input: {
  readonly parsedItems: readonly ParsedItem[];
  readonly scanRunId: string;
  readonly createdAt: string;
}): readonly ScanItemFailure[] {
  return input.parsedItems.flatMap((item) => {
    if (item.status !== "rejected") return [];
    const diagnostic = item.diagnostics.find(({ severity }) => severity === "error");
    if (diagnostic === undefined) {
      return [
        {
          itemRef: item.candidate.sourcePath,
          diagnosticId: DiagnosticIdSchema.parse(
            stableId("diagnostic", [
              input.scanRunId,
              "SCAN_ITEM_REJECTED",
              item.candidate.sourcePath,
            ]),
          ),
          errorCode: "SCAN_ITEM_REJECTED",
          retryable: false,
        },
      ];
    }
    const normalized = normalizeAdapterDiagnostic({
      diagnostic: withDiagnosticOwnership(diagnostic, item),
      scanRunId: input.scanRunId,
      createdAt: input.createdAt,
    });
    return [
      {
        itemRef: item.candidate.sourcePath,
        diagnosticId: normalized.diagnosticId,
        errorCode: normalized.code,
        retryable: !normalized.blocking,
      },
    ];
  });
}

function discoveryLimitDiagnostic(
  error: AdapterDiscoveryLimitError,
  tool: ToolInstallation,
): AdapterDiagnostic {
  return withToolDiagnosticOwnership(
    {
      code: error.code,
      severity: "error",
      message: `Configuration discovery stopped after ${String(error.limit)} entries`,
      location: { path: error.root },
      evidence: {
        limitEntries: error.limit,
        observedEntriesAtLeast: error.observedAtLeast,
      },
      suggestedActions: [
        "Reduce the configuration search scope or remove generated directories, then scan again",
      ],
      blocking: true,
    },
    tool,
  );
}

function skillPrimaryDiagnostic(
  path: AbsolutePath,
  code: "SKILL_PRIMARY_FILE_MISSING" | "SKILL_PRIMARY_FILE_TOO_LARGE",
  evidence: Readonly<Record<string, unknown>>,
): AdapterDiagnostic {
  return {
    code,
    severity: "error",
    message:
      code === "SKILL_PRIMARY_FILE_MISSING"
        ? "The Skill package primary file no longer exists"
        : "The Skill package primary file exceeds the safe snapshot limit",
    location: { path },
    evidence: { relativePath: "SKILL.md", ...evidence },
    suggestedActions:
      code === "SKILL_PRIMARY_FILE_MISSING"
        ? ["Restore SKILL.md or remove the incomplete Skill package, then scan again"]
        : ["Reduce SKILL.md below the reported byte limit, then scan again"],
    blocking: true,
  };
}

function discoveryItemFailures(input: {
  readonly discoveryFailures: readonly DiscoveryFailure[];
  readonly scanRunId: string;
  readonly createdAt: string;
}): readonly ScanItemFailure[] {
  return input.discoveryFailures.map(({ itemRef, diagnostic }) => {
    const normalized = normalizeAdapterDiagnostic({
      diagnostic,
      scanRunId: input.scanRunId,
      createdAt: input.createdAt,
    });
    return {
      itemRef,
      diagnosticId: normalized.diagnosticId,
      errorCode: normalized.code,
      retryable: false,
    };
  });
}

function withDiagnosticOwnership(
  diagnostic: AdapterDiagnostic,
  item: ParsedItem,
): AdapterDiagnostic {
  return {
    ...diagnostic,
    evidence: {
      ...diagnostic.evidence,
      toolId: item.tool.toolId,
      toolInstallationId: item.tool.installationId,
      sourcePath: item.candidate.sourcePath,
      scopeKind: item.candidate.scope.kind,
      scopeRoot: item.candidate.scope.canonicalRootPath,
      diagnosticPhase: "parsing",
      ...(item.candidate.scope.projectRoot === undefined
        ? {}
        : { projectRoot: item.candidate.scope.projectRoot }),
    },
  };
}

function withToolDiagnosticOwnership(
  diagnostic: AdapterDiagnostic,
  tool: ToolInstallation,
): AdapterDiagnostic {
  return {
    ...diagnostic,
    evidence: {
      ...diagnostic.evidence,
      toolId: tool.toolId,
      toolInstallationId: tool.installationId,
    },
  };
}

export function summarizeAssetDiagnostics(
  assets: readonly Asset[],
  diagnostics: readonly Diagnostic[],
  scopes: readonly Scope[],
): readonly Asset[] {
  const diagnosticsByAsset = new Map(
    assets.map((asset) => [
      asset.assetId,
      { info: 0, warning: 0, error: 0 } satisfies Asset["diagnosticSummary"],
    ]),
  );
  const assetsByPath = new Map<string, Asset[]>();
  const installationByScope = new Map(
    scopes.flatMap((scope) => {
      const installationId = scope.discoveryEvidence["installationId"];
      return typeof installationId === "string" ? [[scope.scopeId, installationId] as const] : [];
    }),
  );
  for (const asset of assets) {
    const paths =
      asset.sourceFiles.length === 0
        ? [asset.canonicalSourcePath]
        : asset.sourceFiles.map((sourceFile) => sourceFile.path);
    for (const path of paths) {
      const current = assetsByPath.get(path) ?? [];
      current.push(asset);
      assetsByPath.set(path, current);
    }
  }

  for (const diagnostic of diagnostics) {
    const paths = new Set<string>();
    if (diagnostic.location?.path !== undefined) paths.add(diagnostic.location.path);
    const sourcePath = diagnostic.evidence.sourcePath;
    if (typeof sourcePath === "string") paths.add(sourcePath);
    const diagnosticToolId = diagnostic.evidence["toolId"];
    const diagnosticInstallationId = diagnostic.evidence["toolInstallationId"];

    const countedAssetIds = new Set<string>();
    for (const path of paths) {
      for (const asset of assetsByPath.get(path) ?? []) {
        if (countedAssetIds.has(asset.assetId)) continue;
        if (typeof diagnosticToolId === "string" && asset.toolId !== diagnosticToolId) continue;
        if (
          typeof diagnosticInstallationId === "string" &&
          installationByScope.get(asset.scopeId) !== diagnosticInstallationId
        ) {
          continue;
        }
        countedAssetIds.add(asset.assetId);
        const summary = diagnosticsByAsset.get(asset.assetId);
        if (summary !== undefined) summary[diagnostic.severity] += 1;
      }
    }
  }

  return assets.map((asset) =>
    AssetSchema.parse({
      ...asset,
      diagnosticSummary: diagnosticsByAsset.get(asset.assetId) ?? asset.diagnosticSummary,
    }),
  );
}

async function applyStoredAssetStatuses(
  repository: IndexRepository,
  assets: readonly Asset[],
): Promise<readonly Asset[]> {
  const statuses = await repository.getAssetStatuses(
    assets.map(({ assetId }) => AssetIdSchema.parse(assetId)),
  );
  return assets.map((asset) =>
    AssetSchema.parse({
      ...asset,
      status: statuses.get(asset.assetId) ?? asset.status,
    }),
  );
}

function disabledApplicableAssets(
  assets: readonly Asset[],
  scopes: readonly Scope[],
  toolId: string,
  targetPath: AbsolutePath,
): readonly Asset[] {
  const scopesById = new Map(scopes.map((scope) => [scope.scopeId, scope]));
  return assets
    .filter(({ status }) => status === "disabled")
    .filter((asset) => {
      const scope = scopesById.get(asset.scopeId);
      return (
        scope !== undefined &&
        scope.toolId === toolId &&
        pathWithinRoot(targetPath, scope.canonicalRootPath)
      );
    })
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
}

function withDisabledAssetsAsIgnored(
  draft: AdapterEffectiveConfigDraft,
  disabledAssets: readonly Asset[],
): AdapterEffectiveConfigDraft {
  if (disabledAssets.length === 0) return draft;
  const existingIgnored = new Set(draft.ignoredAssetIds);
  const existingStepAssetIds = new Set(
    draft.steps.filter((step) => step.action === "ignore").map(({ assetId }) => assetId),
  );
  const additionalIgnored = disabledAssets
    .map(({ assetId }) => AssetIdSchema.parse(assetId))
    .filter((assetId) => !existingIgnored.has(assetId));
  const additionalSteps = additionalIgnored
    .filter((assetId) => !existingStepAssetIds.has(assetId))
    .map((assetId) => ({
      action: "ignore" as const,
      assetId,
      reason: "Asset disabled",
    }));
  return {
    ...draft,
    ignoredAssetIds: [...draft.ignoredAssetIds, ...additionalIgnored],
    steps: [...draft.steps, ...additionalSteps],
  };
}

function scopeId(installationId: string, parsed: ParsedAsset): string {
  return stableId("scope", [installationId, parsed.scope.kind, parsed.scope.canonicalRootPath]);
}

function buildScopes(items: readonly ParsedItem[]) {
  const scopes = new Map<string, ReturnType<typeof ScopeSchema.parse>>();
  for (const item of items) {
    for (const parsed of item.parsedAssets) {
      const id = ScopeIdSchema.parse(scopeId(item.tool.installationId, parsed));
      const projectId =
        parsed.scope.projectRoot === undefined
          ? undefined
          : ProjectIdSchema.parse(stableId("project", [parsed.scope.projectRoot]));
      scopes.set(
        id,
        ScopeSchema.parse({
          scopeId: id,
          toolId: parsed.toolId,
          scopeKind: parsed.scope.kind,
          canonicalRootPath: parsed.scope.canonicalRootPath,
          ...(projectId === undefined ? {} : { projectId }),
          depth: parsed.scope.depth,
          precedence: parsed.scope.precedence,
          discoveryEvidence: { installationId: item.tool.installationId },
        }),
      );
    }
  }
  return [...scopes.values()].sort((left, right) => left.scopeId.localeCompare(right.scopeId));
}

function uniqueTools(tools: readonly ToolInstallation[]): readonly ToolInstallation[] {
  return [...new Map(tools.map((tool) => [tool.installationId, tool])).values()].sort(
    (left, right) => left.installationId.localeCompare(right.installationId),
  );
}

function uniqueScopes(scopes: readonly Scope[]): readonly Scope[] {
  return [...new Map(scopes.map((scope) => [scope.scopeId, scope])).values()].sort((left, right) =>
    left.scopeId.localeCompare(right.scopeId),
  );
}

function uniqueAssets<T extends { readonly assetId: string }>(assets: readonly T[]): readonly T[] {
  return [...new Map(assets.map((asset) => [asset.assetId, asset])).values()].sort((left, right) =>
    left.assetId.localeCompare(right.assetId),
  );
}

async function cachedClosure(input: {
  readonly repository: IndexRepository;
  readonly changedPaths: readonly AbsolutePath[];
  readonly affectedInstallationIds: ReadonlySet<string>;
}) {
  const changed = new Set(input.changedPaths.map(normalizePath));
  const scopes = (await input.repository.listScopes()).filter((scope) => {
    const installationId = scope.discoveryEvidence["installationId"];
    return typeof installationId === "string" && input.affectedInstallationIds.has(installationId);
  });
  const scopeIds = new Set(scopes.map(({ scopeId }) => scopeId));
  const assets = (await listAllAssets(input.repository)).filter(
    (asset) =>
      scopeIds.has(asset.scopeId) &&
      !assetSourcePaths(asset).some(
        (sourcePath) =>
          changed.has(normalizePath(sourcePath)) ||
          pathMatchesAnyChangedPath(sourcePath, input.changedPaths),
      ),
  );
  return { assets, scopes };
}

async function cachedParsingDiagnostics(input: {
  readonly repository: IndexRepository;
  readonly assets: readonly Asset[];
  readonly scopes: readonly Scope[];
}): Promise<readonly AdapterDiagnostic[]> {
  const installationByScope = new Map(
    input.scopes.flatMap((scope) => {
      const installationId = scope.discoveryEvidence["installationId"];
      return typeof installationId === "string" ? [[scope.scopeId, installationId] as const] : [];
    }),
  );
  const pathsByInstallation = new Map<string, Set<string>>();
  for (const asset of input.assets) {
    const installationId = installationByScope.get(asset.scopeId);
    if (installationId === undefined) continue;
    const paths = pathsByInstallation.get(installationId) ?? new Set<string>();
    for (const path of assetSourcePaths(asset)) paths.add(normalizePath(path));
    pathsByInstallation.set(installationId, paths);
  }

  return (await listAllDiagnostics(input.repository)).flatMap((diagnostic) => {
    const installationId = diagnostic.evidence["toolInstallationId"];
    if (typeof installationId !== "string") return [];
    const paths = pathsByInstallation.get(installationId);
    if (paths === undefined) return [];
    const diagnosticPhase = diagnostic.evidence["diagnosticPhase"];
    const isParsingDiagnostic =
      diagnosticPhase === "parsing" ||
      (diagnosticPhase === undefined &&
        typeof diagnostic.evidence["scopeRoot"] === "string" &&
        typeof diagnostic.evidence["sourcePath"] === "string");
    if (!isParsingDiagnostic) return [];
    const diagnosticPaths = [diagnostic.location?.path, diagnostic.evidence["sourcePath"]].filter(
      (path): path is AbsolutePath => typeof path === "string",
    );
    if (!diagnosticPaths.some((path) => paths.has(normalizePath(path)))) return [];
    const location =
      diagnostic.location === undefined
        ? undefined
        : {
            path: AbsolutePathSchema.parse(diagnostic.location.path),
            ...(diagnostic.location.line === undefined ? {} : { line: diagnostic.location.line }),
            ...(diagnostic.location.column === undefined
              ? {}
              : { column: diagnostic.location.column }),
            ...(diagnostic.location.pointer === undefined
              ? {}
              : { pointer: JsonPointerSchema.parse(diagnostic.location.pointer) }),
          };
    return [
      {
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(location === undefined ? {} : { location }),
        evidence: diagnostic.evidence,
        suggestedActions: diagnostic.suggestedActions,
        blocking: diagnostic.blocking,
      },
    ];
  });
}

async function listAllAssets(repository: IndexRepository) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const assets = [];
    const visitedCursors = new Set<string>();
    let cursor: ReturnType<typeof PaginationCursorSchema.parse> | undefined;
    let snapshotRevision: string | undefined;
    for (;;) {
      const page = await repository.listAssets({
        ...(cursor === undefined ? {} : { cursor }),
        limit: 200,
      });
      snapshotRevision ??= page.snapshotRevision;
      if (page.snapshotRevision !== snapshotRevision) {
        break;
      }
      assets.push(...page.items);
      if (page.nextCursor === undefined) return assets;
      const nextCursor = PaginationCursorSchema.parse(page.nextCursor);
      if (visitedCursors.has(nextCursor)) {
        throw new AppError({
          code: "STALE_INDEX",
          message: "Asset pagination returned a repeated cursor",
          retryable: true,
          suggestedActions: ["Retry the scan after the current index update completes"],
        });
      }
      visitedCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }
  throw new AppError({
    code: "STALE_INDEX",
    message: "Asset index changed repeatedly while the scan was reading it",
    retryable: true,
    suggestedActions: ["Retry the scan after the current index update completes"],
  });
}

async function listAllDiagnostics(repository: IndexRepository) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const diagnostics = [];
    const visitedCursors = new Set<string>();
    let cursor: ReturnType<typeof PaginationCursorSchema.parse> | undefined;
    let snapshotRevision: string | undefined;
    for (;;) {
      const page = await repository.listDiagnostics({
        ...(cursor === undefined ? {} : { cursor }),
        limit: 200,
      });
      snapshotRevision ??= page.snapshotRevision;
      if (page.snapshotRevision !== snapshotRevision) break;
      diagnostics.push(...page.items);
      if (page.nextCursor === undefined) return diagnostics;
      const nextCursor = PaginationCursorSchema.parse(page.nextCursor);
      if (visitedCursors.has(nextCursor)) {
        throw new AppError({
          code: "STALE_INDEX",
          message: "Diagnostic pagination returned a repeated cursor",
          retryable: true,
          suggestedActions: ["Retry the scan after the current index update completes"],
        });
      }
      visitedCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }
  throw new AppError({
    code: "STALE_INDEX",
    message: "Diagnostic index changed repeatedly while the scan was reading it",
    retryable: true,
    suggestedActions: ["Retry the scan after the current index update completes"],
  });
}

async function scopedCommitChangedPaths(input: {
  readonly repository: IndexRepository;
  readonly candidateRoots: readonly AbsolutePath[];
  readonly parsedItems: readonly ParsedItem[];
}): Promise<readonly AbsolutePath[]> {
  const indexedAssets = await listAllAssets(input.repository);
  return uniqueChangedPaths([
    ...indexedAssets
      .filter((asset) => pathWithinAnyRoot(asset.canonicalSourcePath, input.candidateRoots))
      .flatMap((asset) => assetSourcePaths(asset)),
    ...input.parsedItems.flatMap((item) =>
      item.parsedAssets.length === 0
        ? [item.candidate.sourcePath]
        : item.parsedAssets.flatMap((asset) => assetSourcePaths(asset)),
    ),
  ]);
}

function uniqueChangedPaths(paths: readonly AbsolutePath[]): readonly AbsolutePath[] {
  const byNormalizedPath = new Map<string, AbsolutePath>();
  for (const path of paths) byNormalizedPath.set(normalizePath(path), path);
  return [...byNormalizedPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, path]) => path);
}

function affectedInstallations(
  tools: readonly ToolInstallation[],
  work: readonly WorkItem[],
  changedPaths: readonly AbsolutePath[],
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const item of work) {
    if (pathMatchesAnyChangedPath(item.candidate.sourcePath, changedPaths)) {
      result.add(item.tool.installationId);
    }
  }
  for (const tool of tools) {
    if (
      changedPaths.some((changedPath) =>
        tool.configRoots.some((root) => pathWithinRoot(changedPath, root)),
      )
    ) {
      result.add(tool.installationId);
    }
  }
  return result;
}

function expandChangedPaths(
  changedPaths: readonly AbsolutePath[],
  indexedAssets: readonly Asset[],
): readonly AbsolutePath[] {
  const expanded = new Map(changedPaths.map((path) => [normalizePath(path), path]));
  for (const asset of indexedAssets) {
    const existingSourceChanged = assetSourcePaths(asset).some((sourcePath) =>
      pathMatchesAnyChangedPath(sourcePath, changedPaths),
    );
    const newSkillPackageEntry =
      asset.resource.kind === "skill" &&
      changedPaths.some((changedPath) =>
        pathWithinRoot(changedPath, dirname(primaryAssetSourcePath(asset))),
      );
    if (!existingSourceChanged && !newSkillPackageEntry) continue;
    expanded.set(normalizePath(asset.canonicalSourcePath), asset.canonicalSourcePath);
  }
  return [...expanded.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, path]) => path);
}

function primaryAssetSourcePath(asset: Pick<Asset, "canonicalSourcePath" | "sourceFiles">) {
  return (
    asset.sourceFiles.find(({ role }) => role === "primary")?.path ?? asset.canonicalSourcePath
  );
}

function pathMatchesAnyChangedPath(
  candidatePath: AbsolutePath,
  changedPaths: readonly AbsolutePath[],
): boolean {
  return changedPaths.some((changedPath) => pathWithinRoot(candidatePath, changedPath));
}

function normalizePath(path: AbsolutePath): string {
  return path.replaceAll("\\", "/");
}

function assetSourcePaths(asset: Pick<Asset, "canonicalSourcePath" | "sourceFiles">) {
  return asset.sourceFiles.length === 0
    ? [asset.canonicalSourcePath]
    : asset.sourceFiles.map((sourceFile) => sourceFile.path);
}

function pathWithinRoot(path: AbsolutePath, root: AbsolutePath): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`)
  );
}

function pathWithinAnyRoot(path: AbsolutePath, roots: readonly AbsolutePath[]): boolean {
  return roots.some((root) => pathWithinRoot(path, root));
}

function uniqueResolutionTargets(items: readonly ParsedItem[]) {
  return [
    ...new Map(
      items.map((item) => [
        `${item.adapter.adapterId}:${item.tool.installationId}`,
        { adapter: item.adapter, tool: item.tool },
      ]),
    ).values(),
  ].sort((left, right) => left.tool.installationId.localeCompare(right.tool.installationId));
}

function uniqueDetectedResolutionTargets(
  adapters: readonly ToolAdapter[],
  tools: readonly ToolInstallation[],
  affectedInstallationIds: ReadonlySet<string>,
) {
  const adaptersByToolId = new Map(adapters.map((adapter) => [adapter.toolId, adapter]));
  return tools
    .filter((tool) => affectedInstallationIds.has(tool.installationId))
    .flatMap((tool) => {
      const adapter = adaptersByToolId.get(tool.toolId);
      return adapter === undefined ? [] : [{ adapter, tool }];
    })
    .sort((left, right) => left.tool.installationId.localeCompare(right.tool.installationId));
}

function mergeResolutionTargets(
  ...groups: readonly (readonly {
    readonly adapter: ToolAdapter;
    readonly tool: ToolInstallation;
  }[])[]
) {
  return [
    ...new Map(
      groups.flat().map((target) => [target.tool.installationId, target] as const),
    ).values(),
  ].sort((left, right) => left.tool.installationId.localeCompare(right.tool.installationId));
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      const value = values[index];
      if (value === undefined) return;
      result[index] = await action(value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}
