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
    work.sort((left, right) =>
      `${left.tool.installationId}:${left.candidate.sourcePath}:${left.candidate.resourceKindHint ?? ""}`.localeCompare(
        `${right.tool.installationId}:${right.candidate.sourcePath}:${right.candidate.resourceKindHint ?? ""}`,
      ),
    );

    this.phase(input, "reading");
    const readItems = await mapLimit(work, this.maxConcurrency, async (item): Promise<ReadItem> => {
      input.signal.throwIfAborted();
      try {
        return {
          ...item,
          snapshot: await this.options.snapshots.snapshot({
            path: item.candidate.sourcePath,
            allowedRoots: item.tool.configRoots,
          }),
        };
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
    });

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
      ...parsedItems.flatMap(({ diagnostics }) => diagnostics),
    ];
    const scopes = buildScopes(parsedItems);
    const assets = parsedItems
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
    const effectiveConfigs = [];
    const resolvedInstallations = uniqueResolutionTargets(parsedItems);
    for (const { adapter, tool } of resolvedInstallations) {
      input.signal.throwIfAborted();
      const toolAssets = assets.filter(({ toolId }) => toolId === tool.toolId);
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
        allAdapterDiagnostics.push(...resolution.diagnostics, ...diagnosis.diagnostics);
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
    const diagnostics = allAdapterDiagnostics.map((diagnostic) =>
      normalizeAdapterDiagnostic({ diagnostic, scanRunId, createdAt }),
    );
    const succeededCount = parsedItems.filter(({ status }) => status === "parsed").length;
    const failedCount = parsedItems.length - succeededCount;
    const status =
      failedCount === 0 ? "succeeded" : succeededCount === 0 ? "failed" : "partially_succeeded";

    input.signal.throwIfAborted();
    this.phase(input, "committing");
    input.signal.throwIfAborted();
    const committed = await this.options.indexRepository.replaceDerivedIndex({
      scanRunId,
      tools: uniqueTools(tools),
      scopes,
      assets,
      effectiveConfigs,
      diagnostics,
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
