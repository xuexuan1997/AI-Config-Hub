import type {
  AdapterDiagnostic,
  AdapterReadApi,
  AdapterRegistration,
  CancellationSignal,
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
  AssetIdSchema,
  DiagnosticIdSchema,
  EffectiveConfigIdSchema,
  IsoDateTimeSchema,
  PaginationCursorSchema,
  ProjectIdSchema,
  ScanRunIdSchema,
  ScopeIdSchema,
  type AbsolutePath,
} from "@ai-config-hub/shared";

import { normalizeAdapterDiagnostic } from "./diagnostics.js";
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

export interface ScanInput {
  readonly scanRunId: string;
  readonly candidateRoots: readonly AbsolutePath[];
  readonly changedPaths?: readonly AbsolutePath[];
  readonly homeDirectory: AbsolutePath;
  readonly platform: "linux" | "darwin" | "win32";
  readonly signal: CancellationSignal;
  readonly onPhase?: (phase: ScanPhase) => void;
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

export class ScanService {
  private readonly maxConcurrency: number;
  private readonly now: () => string;

  constructor(private readonly options: ScanServiceOptions) {
    this.maxConcurrency = Math.max(1, Math.min(16, options.maxConcurrency ?? 16));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async scan(
    input: ScanInput,
  ): Promise<{ readonly summary: ScanRunSummary; readonly revision: string }> {
    const scanRunId = ScanRunIdSchema.parse(input.scanRunId);
    const createdAt = IsoDateTimeSchema.parse(this.now());
    this.phase(input, "discovering");
    const adapters = [...this.options.registrations]
      .sort((left, right) => left.toolId.localeCompare(right.toolId))
      .map((registration) => registration.create({ logger: { debug() {}, warn() {} } }));
    const tools: ToolInstallation[] = [];
    const work: WorkItem[] = [];
    const adapterDiagnostics: AdapterDiagnostic[] = [];
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
        const discovery = await adapter.discover({
          tool,
          allowedRoots: tool.configRoots,
          read: this.options.read,
          signal: input.signal,
        });
        adapterDiagnostics.push(...discovery.diagnostics);
        for (const candidate of discovery.candidates) work.push({ adapter, tool, candidate });
      }
    }
    const changedPaths = input.changedPaths;
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
          return snapshot === undefined ? item : { ...item, snapshot };
        } catch {
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
            canonicalSourcePath: parsed.canonicalSourcePath,
            locator: parsed.locator,
            sourceFormat: parsed.sourceFormat,
            contentHash: parsed.sourceContentHash,
            normalizedSchemaVersion: item.adapter.capabilities.writtenSchemaVersion,
            adapterId: item.adapter.adapterId,
            adapterVersion: item.adapter.adapterVersion,
            discoveredAt: createdAt,
            references: parsed.references,
            diagnosticSummary: { info: 0, warning: 0, error: 0 },
          }),
        ),
      )
      .sort((left, right) => left.assetId.localeCompare(right.assetId));
    const cached =
      changedPaths === undefined || affectedInstallationIds === undefined
        ? { assets: [], scopes: [] }
        : await cachedClosure({
            repository: this.options.indexRepository,
            changedPaths,
            affectedInstallationIds,
          });
    const scopes = uniqueScopes([...cached.scopes, ...parsedScopes]);
    const assetsForResolution = uniqueAssets([...cached.assets, ...parsedAssets]);
    const assetsForCommit = changedPaths === undefined ? assetsForResolution : parsedAssets;
    const effectiveConfigs = [];
    const resolvedInstallations =
      affectedInstallationIds === undefined
        ? uniqueResolutionTargets(parsedItems)
        : uniqueDetectedResolutionTargets(adapters, tools, affectedInstallationIds);
    for (const { adapter, tool } of resolvedInstallations) {
      input.signal.throwIfAborted();
      const toolAssets = assetsForResolution.filter(({ toolId }) => toolId === tool.toolId);
      const toolScopes = scopes.filter(({ toolId }) => toolId === tool.toolId);
      for (const targetPath of tool.configRoots) {
        const resolution = await adapter.resolveEffective({
          tool,
          targetPath,
          assets: toolAssets,
          scopes: toolScopes,
          signal: input.signal,
        });
        const diagnosis = await adapter.diagnose({
          tool,
          assets: toolAssets,
          effectiveConfigDraft: resolution.draft,
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
            ...resolution.draft,
            effectiveConfigId: EffectiveConfigIdSchema.parse(
              stableId("effective", [
                tool.installationId,
                targetPath,
                resolution.draft.resolutionInputHash,
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
    const succeededCount = parsedItems.filter(({ status }) => status === "parsed").length;
    const failedCount = parsedItems.length - succeededCount;
    const status =
      failedCount === 0 ? "succeeded" : succeededCount === 0 ? "failed" : "partially_succeeded";

    input.signal.throwIfAborted();
    this.phase(input, "committing");
    input.signal.throwIfAborted();
    const replacement = {
      scanRunId,
      tools: uniqueTools(tools),
      scopes,
      assets: assetsForCommit,
      effectiveConfigs,
      diagnostics,
    };
    const committed =
      input.changedPaths === undefined
        ? await this.options.indexRepository.replaceDerivedIndex(replacement)
        : await this.options.indexRepository.mergeIncrementalIndex({
            ...replacement,
            changedPaths: input.changedPaths,
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
    return { summary, revision: committed.revision };
  }

  private phase(input: ScanInput, phase: ScanPhase): void {
    input.signal.throwIfAborted();
    input.onPhase?.(phase);
  }
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

function uniqueAdapterDiagnostics(
  diagnostics: readonly AdapterDiagnostic[],
): readonly AdapterDiagnostic[] {
  const seen = new Set<string>();
  const unique: AdapterDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.code,
      diagnostic.location?.path ?? "",
      diagnostic.location?.line ?? "",
      diagnostic.location?.column ?? "",
      diagnostic.message,
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(diagnostic);
  }
  return unique;
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
      scopeIds.has(asset.scopeId) && !changed.has(normalizePath(asset.canonicalSourcePath)),
  );
  return { assets, scopes };
}

async function listAllAssets(repository: IndexRepository) {
  const assets = [];
  let cursor: ReturnType<typeof PaginationCursorSchema.parse> | undefined;
  for (;;) {
    const page = await repository.listAssets({
      ...(cursor === undefined ? {} : { cursor }),
      limit: 200,
    });
    assets.push(...page.items);
    if (page.nextCursor === undefined) return assets;
    cursor = PaginationCursorSchema.parse(page.nextCursor);
  }
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

function pathMatchesAnyChangedPath(
  candidatePath: AbsolutePath,
  changedPaths: readonly AbsolutePath[],
): boolean {
  return changedPaths.some(
    (changedPath) => normalizePath(changedPath) === normalizePath(candidatePath),
  );
}

function normalizePath(path: AbsolutePath): string {
  return path.replaceAll("\\", "/");
}

function pathWithinRoot(path: AbsolutePath, root: AbsolutePath): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
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
