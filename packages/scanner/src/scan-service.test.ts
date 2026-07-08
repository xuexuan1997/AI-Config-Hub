import type {
  AdapterRegistration,
  DiscoveredResource,
  FileSnapshotPort,
  IndexRepository,
  ToolAdapter,
} from "@ai-config-hub/core";
import { AssetSchema, ScopeSchema } from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AdapterIdSchema,
  ContentHashSchema,
  SemVerRangeSchema,
  SemVerSchema,
  ToolInstallationIdSchema,
} from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { createCancellationController } from "./cancellation.js";
import { ScanService, type ScanPhase } from "./scan-service.js";

const root = AbsolutePathSchema.parse("/project");
const candidates: DiscoveredResource[] = ["good", "broken"].map((name) => ({
  toolId: "codex",
  sourcePath: AbsolutePathSchema.parse(`/project/${name}.md`),
  sourceFormat: "markdown",
  resourceKindHint: "rule",
  scope: {
    kind: "project",
    canonicalRootPath: root,
    projectRoot: root,
    depth: 0,
    precedence: 100,
  },
}));

function adapter(): AdapterRegistration {
  const capabilities = {
    supportedToolVersions: SemVerRangeSchema.parse(">=0.1.0"),
    testedToolVersions: [SemVerSchema.parse("0.101.0")],
    readableSchemaVersions: [SemVerRangeSchema.parse("^1.0.0")],
    writtenSchemaVersion: SemVerSchema.parse("1.0.0"),
    resourceKinds: ["rule"] as const,
    scopeKinds: ["project"] as const,
    supportsNestedScopes: true,
    conversions: [],
  };
  const instance = {
    adapterId: AdapterIdSchema.parse("fake-codex"),
    adapterVersion: SemVerSchema.parse("0.1.0"),
    toolId: "codex" as const,
    capabilities,
    detect: () =>
      Promise.resolve({
        installations: [
          {
            toolId: "codex" as const,
            installationId: ToolInstallationIdSchema.parse("codex-project"),
            configRoots: [root],
            evidence: { marker: "AGENTS.md" },
          },
        ],
        diagnostics: [],
      }),
    discover: () => Promise.resolve({ candidates, diagnostics: [] }),
    parse: ({ candidate, snapshot }: Parameters<ToolAdapter["parse"]>[0]) =>
      Promise.resolve(
        candidate.sourcePath.endsWith("broken.md")
          ? {
              status: "rejected" as const,
              assets: [],
              diagnostics: [
                {
                  code: "ADAPTER_PARSE_INVALID",
                  severity: "error" as const,
                  message: "Invalid fixture",
                  location: { path: candidate.sourcePath, line: 1 },
                  evidence: {},
                  suggestedActions: ["Fix the file"],
                  blocking: true,
                },
              ],
            }
          : {
              status: "parsed" as const,
              assets: [
                {
                  toolId: "codex" as const,
                  canonicalSourcePath: candidate.sourcePath,
                  locator: "rule:good",
                  scope: candidate.scope,
                  sourceFormat: candidate.sourceFormat,
                  sourceContentHash: snapshot.contentHash,
                  contentHash: snapshot.contentHash,
                  sourceFiles: [primarySourceFile(candidate.sourcePath, snapshot.contentHash)],
                  nativeIdentity: { nativeId: "rule:good", displayName: "good" },
                  resource: {
                    kind: "rule" as const,
                    data: { name: "good", instructions: "Use tests.", globs: [], extensions: {} },
                  },
                  references: [],
                  extensions: {},
                },
              ],
              diagnostics: [],
            },
      ),
    resolveEffective: ({ assets, targetPath }: Parameters<ToolAdapter["resolveEffective"]>[0]) =>
      Promise.resolve({
        draft: {
          canonicalTargetPath: targetPath,
          resourceKinds: ["rule"],
          resolvedResources: assets.map(({ resource }) => resource),
          contributingAssetIds: assets.map(({ assetId }) => assetId),
          ignoredAssetIds: [],
          steps: assets.map(({ assetId }) => ({
            action: "inherit" as const,
            assetId,
            reason: "Test fixture applies",
          })),
          resolutionInputHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
        },
        diagnostics: [],
      }),
    diagnose: () => Promise.resolve({ diagnostics: [] }),
  } as unknown as ToolAdapter;
  return {
    contractVersion: 1,
    adapterId: instance.adapterId,
    adapterVersion: instance.adapterVersion,
    toolId: instance.toolId,
    capabilities,
    create: () => instance,
  };
}

function adapterWithNativeDisabledAsset(): AdapterRegistration {
  const registration = adapter();
  const instance = registration.create({ logger: { debug() {}, warn() {} } });
  return {
    ...registration,
    create: () =>
      ({
        ...instance,
        discover: () => Promise.resolve({ candidates: [candidates[0]], diagnostics: [] }),
        parse: ({ candidate, snapshot }: Parameters<ToolAdapter["parse"]>[0]) =>
          Promise.resolve({
            status: "parsed" as const,
            assets: [
              {
                toolId: "codex" as const,
                canonicalSourcePath: candidate.sourcePath,
                locator: "rule:enabled",
                scope: candidate.scope,
                sourceFormat: candidate.sourceFormat,
                sourceContentHash: snapshot.contentHash,
                contentHash: snapshot.contentHash,
                sourceFiles: [primarySourceFile(candidate.sourcePath, snapshot.contentHash)],
                nativeIdentity: { nativeId: "rule:enabled", displayName: "enabled" },
                resource: {
                  kind: "rule" as const,
                  data: {
                    name: "enabled",
                    instructions: "Enabled rule",
                    globs: [],
                    extensions: {},
                  },
                },
                references: [],
                extensions: {},
              },
              {
                toolId: "codex" as const,
                canonicalSourcePath: candidate.sourcePath,
                locator: "rule:disabled",
                scope: candidate.scope,
                sourceFormat: candidate.sourceFormat,
                sourceContentHash: snapshot.contentHash,
                contentHash: snapshot.contentHash,
                sourceFiles: [primarySourceFile(candidate.sourcePath, snapshot.contentHash)],
                nativeIdentity: { nativeId: "rule:disabled", displayName: "disabled" },
                resource: {
                  kind: "rule" as const,
                  data: {
                    name: "disabled",
                    instructions: "Disabled rule",
                    globs: [],
                    extensions: {},
                  },
                },
                references: [],
                extensions: {},
                status: "disabled",
              },
            ],
            diagnostics: [],
          }),
      }) as ToolAdapter,
  };
}

const scopeFixture = ScopeSchema.parse({
  scopeId: "scope-project",
  toolId: "codex",
  scopeKind: "project",
  canonicalRootPath: root,
  projectId: "project-1",
  depth: 0,
  precedence: 100,
  discoveryEvidence: { installationId: "codex-project" },
});

const cachedAsset = AssetSchema.parse({
  assetId: "asset-cached",
  toolId: "codex",
  resource: {
    kind: "rule",
    data: {
      name: "cached",
      instructions: "Cached rule",
      globs: [],
      extensions: {},
    },
  },
  scopeId: scopeFixture.scopeId,
  canonicalSourcePath: "/project/cached.md",
  locator: "rule:cached",
  sourceFormat: "markdown",
  contentHash: `sha256:${"d".repeat(64)}`,
  sourceFiles: [
    {
      path: "/project/cached.md",
      relativePath: "cached.md",
      role: "primary",
      mediaType: "text/markdown",
      isText: true,
      contentHash: `sha256:${"d".repeat(64)}`,
    },
  ],
  nativeIdentity: { nativeId: "rule:cached", displayName: "cached" },
  normalizedSchemaVersion: "1.0.0",
  adapterId: "fake-codex",
  adapterVersion: "0.1.0",
  discoveredAt: "2026-06-21T08:00:00.000Z",
  references: [],
  diagnosticSummary: { info: 0, warning: 0, error: 0 },
});

function repository(
  seed: {
    readonly assets?: readonly ReturnType<typeof AssetSchema.parse>[];
    readonly scopes?: readonly ReturnType<typeof ScopeSchema.parse>[];
  } = {},
) {
  const calls: Parameters<IndexRepository["replaceDerivedIndex"]>[0][] = [];
  const index = {
    replaceDerivedIndex: (replacement: Parameters<IndexRepository["replaceDerivedIndex"]>[0]) => {
      calls.push(replacement);
      return Promise.resolve({ revision: String(calls.length) });
    },
    mergeIncrementalIndex: (
      replacement: Parameters<IndexRepository["mergeIncrementalIndex"]>[0],
    ) => {
      calls.push(replacement);
      return Promise.resolve({ revision: String(calls.length) });
    },
    listAssets: () =>
      Promise.resolve({
        items: seed.assets ?? [],
        snapshotRevision: "seed",
      }),
    getAssetStatuses: (assetIds: Parameters<IndexRepository["getAssetStatuses"]>[0]) =>
      Promise.resolve(
        new Map(
          assetIds.flatMap((assetId) => {
            const status = seed.assets?.find((asset) => asset.assetId === assetId)?.status;
            return status === undefined ? [] : [[assetId, status]];
          }),
        ),
      ),
    listScopes: () => Promise.resolve(seed.scopes ?? []),
  } as unknown as IndexRepository;
  return { index, calls };
}

const snapshots: FileSnapshotPort = {
  snapshot: ({ path }) =>
    Promise.resolve({
      canonicalPath: path,
      text: path.endsWith("broken.md") ? "broken" : "Use tests.",
      contentHash: ContentHashSchema.parse(
        `sha256:${path.endsWith("broken.md") ? "b".repeat(64) : "a".repeat(64)}`,
      ),
      modifiedAt: "2026-06-21T08:00:00.000Z",
      size: 10,
    }),
};

const read = {
  realpath: (path: typeof root) => Promise.resolve(path),
  stat: () =>
    Promise.resolve({
      kind: "file" as const,
      size: 10,
      modifiedAt: "2026-06-21T08:00:00.000Z",
    }),
  list: () => Promise.resolve([]),
  readText: () => Promise.resolve(""),
  snapshotFile: () => Promise.resolve(undefined),
};

function primarySourceFile(path: string, contentHash: ReturnType<typeof ContentHashSchema.parse>) {
  return {
    path,
    relativePath: path.replace(/^\/project\//, ""),
    role: "primary" as const,
    mediaType: "text/markdown",
    isText: true,
    contentHash,
  };
}

describe("ScanService", () => {
  it("preserves adapter-reported disabled status and excludes disabled assets from effective config", async () => {
    const target = repository();
    const service = new ScanService({
      registrations: [adapterWithNativeDisabledAsset()],
      read,
      snapshots,
      indexRepository: target.index,
    });

    await service.scan({
      scanRunId: "scan-native-disabled",
      candidateRoots: [root],
      homeDirectory: root,
      platform: "linux",
      signal: createCancellationController().signal,
    });

    const committedAssets = target.calls[0]?.assets ?? [];
    expect(
      committedAssets
        .map(({ locator, status }) => ({ locator, status }))
        .sort((left, right) => left.locator.localeCompare(right.locator)),
    ).toEqual([
      { locator: "rule:disabled", status: "disabled" },
      { locator: "rule:enabled", status: "enabled" },
    ]);
    const resources = target.calls[0]?.effectiveConfigs[0]?.resolvedResources ?? [];
    expect(
      resources.map((resource) => {
        if (resource.kind !== "rule") throw new Error("Expected rule resource");
        return resource.data.instructions;
      }),
    ).toEqual(["Enabled rule"]);
  });

  it("commits one deterministic partial-success replacement after ordered phases", async () => {
    const firstRepository = repository();
    const phases: ScanPhase[] = [];
    const service = new ScanService({
      registrations: [adapter()],
      read,
      snapshots,
      indexRepository: firstRepository.index,
    });
    const controller = createCancellationController();
    const first = await service.scan({
      scanRunId: "scan-1",
      candidateRoots: [root],
      homeDirectory: root,
      platform: "linux",
      signal: controller.signal,
      onPhase: (phase) => phases.push(phase),
    });
    expect(phases).toEqual([
      "discovering",
      "reading",
      "parsing",
      "validating",
      "committing",
      "completed",
    ]);
    expect(first.summary).toMatchObject({
      status: "partially_succeeded",
      succeededCount: 1,
      failedCount: 1,
    });
    expect(first.itemFailures).toEqual([
      {
        itemRef: "/project/broken.md",
        diagnosticId: expect.stringMatching(/^diagnostic:/),
        errorCode: "ADAPTER_PARSE_INVALID",
        retryable: false,
      },
    ]);
    expect(firstRepository.calls).toHaveLength(1);
    expect(firstRepository.calls[0]?.effectiveConfigs).toHaveLength(1);

    const secondRepository = repository();
    const second = new ScanService({
      registrations: [adapter()],
      read,
      snapshots,
      indexRepository: secondRepository.index,
    });
    await second.scan({
      scanRunId: "scan-2",
      candidateRoots: [root],
      homeDirectory: root,
      platform: "linux",
      signal: createCancellationController().signal,
    });
    expect(secondRepository.calls[0]?.assets.map(({ assetId }) => assetId)).toEqual(
      firstRepository.calls[0]?.assets.map(({ assetId }) => assetId),
    );
  });

  it("honors cancellation immediately before commit and preserves the previous snapshot", async () => {
    const target = repository({ assets: [cachedAsset], scopes: [scopeFixture] });
    const controller = createCancellationController();
    const service = new ScanService({
      registrations: [adapter()],
      read,
      snapshots,
      indexRepository: target.index,
    });
    await expect(
      service.scan({
        scanRunId: "scan-cancelled",
        candidateRoots: [root],
        homeDirectory: root,
        platform: "linux",
        signal: controller.signal,
        onPhase: (phase) => {
          if (phase === "validating") controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: "USER_CANCELLED" });
    expect(target.calls).toHaveLength(0);
  });

  it("narrows incremental read and parse work to changed candidate files while resolving affected tools", async () => {
    const target = repository({ assets: [cachedAsset], scopes: [scopeFixture] });
    const snapshotPaths: string[] = [];
    const parsePaths: string[] = [];
    const resolvingTargets: string[] = [];
    const registration = adapter();
    const created = registration.create({ logger: { debug() {}, warn() {} } });
    const trackingRegistration: AdapterRegistration = {
      ...registration,
      create: () => ({
        ...created,
        parse: (context: Parameters<ToolAdapter["parse"]>[0]) => {
          parsePaths.push(context.candidate.sourcePath);
          return created.parse(context);
        },
        resolveEffective: (context: Parameters<ToolAdapter["resolveEffective"]>[0]) => {
          resolvingTargets.push(context.targetPath);
          return created.resolveEffective(context);
        },
      }),
    };
    const service = new ScanService({
      registrations: [trackingRegistration],
      read,
      snapshots: {
        snapshot: (request) => {
          snapshotPaths.push(request.path);
          return snapshots.snapshot(request);
        },
      },
      indexRepository: target.index,
    });

    const result = await service.scan({
      scanRunId: "scan-incremental",
      candidateRoots: [root],
      changedPaths: [AbsolutePathSchema.parse("/project/good.md")],
      homeDirectory: root,
      platform: "linux",
      signal: createCancellationController().signal,
    });

    expect(snapshotPaths).toEqual(["/project/good.md"]);
    expect(parsePaths).toEqual(["/project/good.md"]);
    expect(resolvingTargets).toEqual(["/project"]);
    expect(target.calls[0]?.assets).toHaveLength(1);
    expect(target.calls[0]?.effectiveConfigs).toHaveLength(1);
    const resources = target.calls[0]?.effectiveConfigs[0]?.resolvedResources ?? [];
    expect(
      resources.map((resource) => {
        if (resource.kind !== "rule") throw new Error("Expected rule resource");
        return resource.data.instructions;
      }),
    ).toEqual(["Cached rule", "Use tests."]);
    expect(result.summary).toMatchObject({
      status: "succeeded",
      succeededCount: 1,
      failedCount: 0,
    });
  });

  it("commits a consistent zero-work summary when incremental paths match no candidate files", async () => {
    const target = repository();
    const snapshotPaths: string[] = [];
    const service = new ScanService({
      registrations: [adapter()],
      read,
      snapshots: {
        snapshot: (request) => {
          snapshotPaths.push(request.path);
          return snapshots.snapshot(request);
        },
      },
      indexRepository: target.index,
    });

    const result = await service.scan({
      scanRunId: "scan-incremental-empty",
      candidateRoots: [root],
      changedPaths: [AbsolutePathSchema.parse("/project/notes.txt")],
      homeDirectory: root,
      platform: "linux",
      signal: createCancellationController().signal,
    });

    expect(snapshotPaths).toEqual([]);
    expect(target.calls).toHaveLength(1);
    expect(target.calls[0]).toMatchObject({
      tools: [
        {
          installationId: "codex-project",
        },
      ],
      scopes: [],
      assets: [],
      diagnostics: [],
    });
    expect(target.calls[0]?.effectiveConfigs).toHaveLength(1);
    expect(target.calls[0]?.effectiveConfigs[0]?.resolvedResources).toEqual([]);
    expect(result.summary).toMatchObject({
      status: "succeeded",
      succeededCount: 0,
      failedCount: 0,
    });
  });
});
