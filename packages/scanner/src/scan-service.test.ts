import type {
  AdapterRegistration,
  DiscoveredResource,
  FileSnapshotPort,
  IndexRepository,
  ToolAdapter,
} from "@ai-config-hub/core";
import { AdapterDiscoveryLimitError } from "@ai-config-hub/adapters";
import { AssetSchema, DiagnosticSchema, ScopeSchema } from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AdapterIdSchema,
  ContentHashSchema,
  PaginationCursorSchema,
  SemVerRangeSchema,
  SemVerSchema,
  ToolInstallationIdSchema,
} from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { createCancellationController } from "./cancellation.js";
import { FileSnapshotLimitError } from "./file-reader.js";
import { ScanService, summarizeAssetDiagnostics, type ScanPhase } from "./scan-service.js";

const root = AbsolutePathSchema.parse("/project");
const oversizedDiscoveryRoot = AbsolutePathSchema.parse("/oversized/.codex/agents");
const skillPrimaryPath = AbsolutePathSchema.parse("/project/.agents/skills/release/SKILL.md");
const oldSkillSupportPath = AbsolutePathSchema.parse(
  "/project/.agents/skills/release/references/old.md",
);
const newSkillSupportPath = AbsolutePathSchema.parse(
  "/project/.agents/skills/release/references/new.md",
);
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

function adapterWithOversizedInstallation(): AdapterRegistration {
  const registration = adapter();
  const instance = registration.create({ logger: { debug() {}, warn() {} } });
  const oversizedInstallationId = ToolInstallationIdSchema.parse("codex-oversized");
  return {
    ...registration,
    create: () => ({
      ...instance,
      detect: () =>
        Promise.resolve({
          installations: [
            {
              toolId: "codex" as const,
              installationId: oversizedInstallationId,
              configRoots: [AbsolutePathSchema.parse("/oversized")],
              evidence: { marker: "AGENTS.md" },
            },
            {
              toolId: "codex" as const,
              installationId: ToolInstallationIdSchema.parse("codex-project"),
              configRoots: [root],
              evidence: { marker: "AGENTS.md" },
            },
          ],
          diagnostics: [],
        }),
      discover: ({ tool }: Parameters<ToolAdapter["discover"]>[0]) =>
        tool.installationId === oversizedInstallationId
          ? Promise.reject(new AdapterDiscoveryLimitError(oversizedDiscoveryRoot, 10_000, 10_001))
          : Promise.resolve({ candidates: [candidates[0]!], diagnostics: [] }),
    }),
  };
}

function adapterWithSkillCandidate(): AdapterRegistration {
  const registration = adapter();
  const instance = registration.create({ logger: { debug() {}, warn() {} } });
  const skillCandidate: DiscoveredResource = {
    toolId: "codex",
    sourcePath: skillPrimaryPath,
    sourceFormat: "yaml-frontmatter-markdown",
    resourceKindHint: "skill",
    scope: {
      kind: "project",
      canonicalRootPath: root,
      projectRoot: root,
      depth: 0,
      precedence: 100,
    },
  };
  return {
    ...registration,
    create: () => ({
      ...instance,
      discover: () => Promise.resolve({ candidates: [skillCandidate], diagnostics: [] }),
      parse: () => Promise.reject(new Error("A rejected primary must not reach adapter parsing")),
    }),
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

const cachedParsingDiagnostic = DiagnosticSchema.parse({
  diagnosticId: "diagnostic-cached-parse",
  code: "SKILL_NAME_DIRECTORY_MISMATCH",
  severity: "warning",
  category: "parsing",
  message: "The cached asset has parse-only metadata warning",
  subject: { kind: "scan", id: "scan-previous" },
  location: { path: cachedAsset.canonicalSourcePath },
  impact: "The configuration may require attention",
  evidence: {
    toolId: "codex",
    toolInstallationId: "codex-project",
    sourcePath: cachedAsset.canonicalSourcePath,
    scopeRoot: root,
    diagnosticPhase: "parsing",
  },
  suggestedActions: ["Review the cached asset metadata"],
  blocking: false,
  createdAt: "2026-07-09T00:00:00.000Z",
});

const cachedSkillAsset = AssetSchema.parse({
  ...cachedAsset,
  assetId: "asset-cached-skill",
  resource: {
    kind: "skill",
    data: {
      name: "release",
      description: "Release safely",
      instructions: "Use the old checklist.",
      references: [],
      extensions: {},
    },
  },
  canonicalSourcePath: skillPrimaryPath,
  locator: "skill:.agents/skills/release",
  sourceFormat: "yaml-frontmatter-markdown",
  sourceFiles: [
    primarySourceFile(skillPrimaryPath, ContentHashSchema.parse(`sha256:${"a".repeat(64)}`)),
    {
      path: oldSkillSupportPath,
      relativePath: "references/old.md",
      role: "support",
      mediaType: "text/markdown",
      isText: true,
      contentHash: ContentHashSchema.parse(`sha256:${"b".repeat(64)}`),
    },
  ],
  nativeIdentity: {
    nativeId: "skill:.agents/skills/release",
    displayName: "release",
    directoryName: "release",
    invocationName: "release",
  },
});

const oversizedScope = ScopeSchema.parse({
  ...scopeFixture,
  scopeId: "scope-oversized",
  canonicalRootPath: "/oversized",
  projectId: "project-oversized",
  discoveryEvidence: { installationId: "codex-oversized" },
});

const oversizedCachedAsset = AssetSchema.parse({
  ...cachedAsset,
  assetId: "asset-oversized-cached",
  scopeId: oversizedScope.scopeId,
  canonicalSourcePath: "/oversized/cached.md",
  locator: "rule:oversized-cached",
  sourceFiles: [
    {
      path: "/oversized/cached.md",
      relativePath: "cached.md",
      role: "primary",
      mediaType: "text/markdown",
      isText: true,
      contentHash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
    },
  ],
  contentHash: `sha256:${"f".repeat(64)}`,
});

const otherProjectScope = ScopeSchema.parse({
  ...scopeFixture,
  scopeId: "scope-other-project",
  canonicalRootPath: "/other-project",
  projectId: "project-2",
});

const otherProjectDisabledAsset = AssetSchema.parse({
  ...cachedAsset,
  assetId: "asset-other-disabled",
  scopeId: otherProjectScope.scopeId,
  canonicalSourcePath: "/other-project/disabled.md",
  locator: "rule:other-disabled",
  sourceFiles: [
    {
      path: "/other-project/disabled.md",
      relativePath: "disabled.md",
      role: "primary",
      mediaType: "text/markdown",
      isText: true,
      contentHash: ContentHashSchema.parse(`sha256:${"e".repeat(64)}`),
    },
  ],
  contentHash: `sha256:${"e".repeat(64)}`,
  status: "disabled",
});

function repository(
  seed: {
    readonly assets?: readonly ReturnType<typeof AssetSchema.parse>[];
    readonly scopes?: readonly ReturnType<typeof ScopeSchema.parse>[];
    readonly diagnostics?: readonly ReturnType<typeof DiagnosticSchema.parse>[];
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
    listDiagnostics: () =>
      Promise.resolve({
        items: seed.diagnostics ?? [],
        snapshotRevision: "seed",
      }),
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
  it("records an oversized installation as a bounded failure and continues healthy discovery", async () => {
    const target = repository();
    const service = new ScanService({
      registrations: [adapterWithOversizedInstallation()],
      read,
      snapshots,
      indexRepository: target.index,
    });

    const result = await service.scan({
      scanRunId: "scan-discovery-limit",
      candidateRoots: [root],
      homeDirectory: root,
      platform: "linux",
      signal: createCancellationController().signal,
    });

    expect(result.summary).toMatchObject({
      status: "partially_succeeded",
      succeededCount: 1,
      failedCount: 1,
      skippedCount: 0,
    });
    expect(result.itemFailures).toEqual([
      expect.objectContaining({
        itemRef: oversizedDiscoveryRoot,
        errorCode: "ADAPTER_DISCOVERY_LIMIT_EXCEEDED",
        retryable: false,
      }),
    ]);
    expect(target.calls).toHaveLength(1);
    expect(target.calls[0]?.assets).toHaveLength(1);
    expect(target.calls[0]?.diagnostics[0]).toMatchObject({
      code: "ADAPTER_DISCOVERY_LIMIT_EXCEEDED",
      blocking: true,
      location: { path: oversizedDiscoveryRoot },
      evidence: {
        toolId: "codex",
        toolInstallationId: "codex-oversized",
        limitEntries: 10_000,
        observedEntriesAtLeast: 10_001,
      },
    });
  });

  it("preserves last-known-good assets for an installation whose discovery exceeds the limit", async () => {
    const target = repository({
      assets: [oversizedCachedAsset],
      scopes: [oversizedScope],
    });
    const service = new ScanService({
      registrations: [adapterWithOversizedInstallation()],
      read,
      snapshots,
      indexRepository: target.index,
    });

    const result = await service.scan({
      scanRunId: "scan-discovery-limit-preserves-cache",
      candidateRoots: [root],
      homeDirectory: root,
      platform: "linux",
      signal: createCancellationController().signal,
    });

    expect(result.summary.status).toBe("partially_succeeded");
    expect(target.calls).toHaveLength(1);
    expect(target.calls[0]?.assets.map(({ assetId }) => assetId).sort()).toEqual([
      "asset-oversized-cached",
      expect.stringMatching(/^asset:/),
    ]);
    expect(target.calls[0]?.scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scopeId: oversizedScope.scopeId,
          discoveryEvidence: { installationId: "codex-oversized" },
        }),
      ]),
    );
    expect(target.calls[0]?.effectiveConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolInstallationId: "codex-oversized",
          contributingAssetIds: ["asset-oversized-cached"],
        }),
      ]),
    );
  });

  it.each([
    {
      name: "missing",
      snapshots: {
        snapshot: () => Promise.resolve(undefined),
      } satisfies FileSnapshotPort,
      code: "SKILL_PRIMARY_FILE_MISSING",
      evidence: { relativePath: "SKILL.md" },
    },
    {
      name: "oversized",
      snapshots: {
        snapshot: () =>
          Promise.reject(
            new FileSnapshotLimitError(skillPrimaryPath, 5 * 1024 * 1024, 6 * 1024 * 1024),
          ),
      } satisfies FileSnapshotPort,
      code: "SKILL_PRIMARY_FILE_TOO_LARGE",
      evidence: {
        relativePath: "SKILL.md",
        limitBytes: 5 * 1024 * 1024,
        observedBytes: 6 * 1024 * 1024,
      },
    },
  ])("records a $name Skill primary as a structured rejected item", async (fixture) => {
    const target = repository();
    const service = new ScanService({
      registrations: [adapterWithSkillCandidate()],
      read,
      snapshots: fixture.snapshots,
      indexRepository: target.index,
    });

    const result = await service.scan({
      scanRunId: `scan-skill-primary-${fixture.name}`,
      candidateRoots: [root],
      homeDirectory: root,
      platform: "linux",
      signal: createCancellationController().signal,
    });

    expect(result.summary).toMatchObject({
      status: "failed",
      succeededCount: 0,
      failedCount: 1,
    });
    expect(result.itemFailures).toEqual([
      expect.objectContaining({ itemRef: skillPrimaryPath, errorCode: fixture.code }),
    ]);
    expect(target.calls[0]?.diagnostics).toEqual([
      expect.objectContaining({
        code: fixture.code,
        blocking: true,
        evidence: expect.objectContaining(fixture.evidence) as unknown,
      }),
    ]);
  });

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
    expect(target.calls[0]?.effectiveConfigs[0]?.ignoredAssetIds).toHaveLength(1);
  });

  it("does not apply a disabled asset from another project to the current target", async () => {
    const target = repository({
      assets: [cachedAsset, otherProjectDisabledAsset],
      scopes: [scopeFixture, otherProjectScope],
    });
    const service = new ScanService({
      registrations: [adapter()],
      read,
      snapshots,
      indexRepository: target.index,
    });

    await service.scan({
      scanRunId: "scan-disabled-project-isolation",
      candidateRoots: [root],
      changedPaths: [AbsolutePathSchema.parse("/project/notes.txt")],
      homeDirectory: root,
      platform: "linux",
      signal: createCancellationController().signal,
    });

    expect(target.calls[0]?.effectiveConfigs[0]?.ignoredAssetIds).toEqual([]);
    expect(target.calls[0]?.effectiveConfigs[0]?.steps).toEqual([
      expect.objectContaining({ assetId: cachedAsset.assetId, action: "inherit" }),
    ]);
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
        diagnosticId: first.itemFailures[0]?.diagnosticId,
        errorCode: "ADAPTER_PARSE_INVALID",
        retryable: false,
      },
    ]);
    expect(first.itemFailures[0]?.diagnosticId).toMatch(/^diagnostic:/);
    expect(firstRepository.calls).toHaveLength(1);
    expect(firstRepository.calls[0]?.scanCoverage).toEqual({
      roots: [root],
      toolIds: ["codex"],
    });
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
    expect(target.calls[0]?.assets).toHaveLength(2);
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

  it("commits refreshed diagnostic summaries for unchanged assets diagnosed incrementally", async () => {
    const target = repository({ assets: [cachedAsset], scopes: [scopeFixture] });
    const registration = adapter();
    const created = registration.create({ logger: { debug() {}, warn() {} } });
    const diagnosticRegistration: AdapterRegistration = {
      ...registration,
      create: () => ({
        ...created,
        discover: () => Promise.resolve({ candidates: [candidates[0]!], diagnostics: [] }),
        diagnose: ({ assets }: Parameters<ToolAdapter["diagnose"]>[0]) =>
          Promise.resolve({
            diagnostics: assets
              .filter(({ assetId }) => assetId === cachedAsset.assetId)
              .map((asset) => ({
                code: "UNCHANGED_ASSET_WARNING",
                severity: "warning" as const,
                message: "The unchanged cached asset still needs attention",
                location: { path: asset.canonicalSourcePath },
                evidence: {},
                suggestedActions: ["Review the cached asset"],
                blocking: false,
              })),
          }),
      }),
    };
    const service = new ScanService({
      registrations: [diagnosticRegistration],
      read,
      snapshots,
      indexRepository: target.index,
    });

    await service.scan({
      scanRunId: "scan-incremental-unchanged-diagnostic",
      candidateRoots: [root],
      changedPaths: [AbsolutePathSchema.parse("/project/good.md")],
      homeDirectory: root,
      platform: "linux",
      signal: createCancellationController().signal,
    });

    expect(target.calls[0]?.assets).toHaveLength(2);
    expect(
      target.calls[0]?.assets.find(({ assetId }) => assetId === cachedAsset.assetId)
        ?.diagnosticSummary,
    ).toEqual({ info: 0, warning: 1, error: 0 });
    expect(target.calls[0]?.diagnostics).toEqual([
      expect.objectContaining({
        code: "UNCHANGED_ASSET_WARNING",
        evidence: expect.objectContaining({
          toolInstallationId: "codex-project",
        }) as unknown,
      }),
    ]);
  });

  it("preserves parse-only diagnostics for unchanged cached assets during an incremental scan", async () => {
    const target = repository({
      assets: [cachedAsset],
      scopes: [scopeFixture],
      diagnostics: [cachedParsingDiagnostic],
    });
    const service = new ScanService({
      registrations: [adapter()],
      read,
      snapshots,
      indexRepository: target.index,
    });

    await service.scan({
      scanRunId: "scan-incremental-preserve-parse-diagnostic",
      candidateRoots: [root],
      changedPaths: [AbsolutePathSchema.parse("/project/good.md")],
      homeDirectory: root,
      platform: "linux",
      signal: createCancellationController().signal,
    });

    expect(
      target.calls[0]?.diagnostics.map(({ code, evidence }) => ({
        code,
        phase: evidence["diagnosticPhase"],
        installationId: evidence["toolInstallationId"],
      })),
    ).toContainEqual({
      code: "SKILL_NAME_DIRECTORY_MISMATCH",
      phase: "parsing",
      installationId: "codex-project",
    });
    expect(
      target.calls[0]?.assets.find(({ assetId }) => assetId === cachedAsset.assetId)
        ?.diagnosticSummary,
    ).toEqual({ info: 0, warning: 1, error: 0 });
  });

  it("counts same-path diagnostics only for assets owned by the matching installation", () => {
    const opencodeScope = ScopeSchema.parse({
      ...scopeFixture,
      scopeId: "scope-opencode-project",
      toolId: "opencode",
      discoveryEvidence: { installationId: "opencode-project" },
    });
    const opencodeAsset = AssetSchema.parse({
      ...cachedAsset,
      assetId: "asset-opencode-cached",
      toolId: "opencode",
      scopeId: opencodeScope.scopeId,
      adapterId: "fake-opencode",
    });
    const diagnosticFor = (toolId: "codex" | "opencode", installationId: string) =>
      DiagnosticSchema.parse({
        ...cachedParsingDiagnostic,
        diagnosticId: `diagnostic-${toolId}-same-path`,
        evidence: {
          ...cachedParsingDiagnostic.evidence,
          toolId,
          toolInstallationId: installationId,
        },
      });

    const summarized = summarizeAssetDiagnostics(
      [cachedAsset, opencodeAsset],
      [diagnosticFor("codex", "codex-project"), diagnosticFor("opencode", "opencode-project")],
      [scopeFixture, opencodeScope],
    );

    expect(
      Object.fromEntries(
        summarized.map(({ assetId, diagnosticSummary }) => [assetId, diagnosticSummary]),
      ),
    ).toEqual({
      "asset-cached": { info: 0, warning: 1, error: 0 },
      "asset-opencode-cached": { info: 0, warning: 1, error: 0 },
    });
  });

  it("replaces an indexed asset when a directory watcher event covers its source path", async () => {
    const indexedAsset = AssetSchema.parse({
      ...cachedAsset,
      assetId: "asset-old-good",
      canonicalSourcePath: "/project/good.md",
      locator: "rule:good",
      sourceFiles: [
        primarySourceFile("/project/good.md", ContentHashSchema.parse(`sha256:${"d".repeat(64)}`)),
      ],
      nativeIdentity: { nativeId: "rule:good", displayName: "good" },
    });
    const target = repository({ assets: [indexedAsset], scopes: [scopeFixture] });
    const registration = adapter();
    const created = registration.create({ logger: { debug() {}, warn() {} } });
    const parsePaths: string[] = [];
    const directoryRegistration: AdapterRegistration = {
      ...registration,
      create: () => ({
        ...created,
        discover: () => Promise.resolve({ candidates: [candidates[0]!], diagnostics: [] }),
        parse: async (context: Parameters<ToolAdapter["parse"]>[0]) => {
          parsePaths.push(context.candidate.sourcePath);
          const parsed = await created.parse(context);
          if (parsed.status !== "parsed") return parsed;
          return {
            ...parsed,
            assets: parsed.assets.map((asset) => ({
              ...asset,
              locator: "rule:GOOD",
              nativeIdentity: { nativeId: "rule:GOOD", displayName: "GOOD" },
              resource: {
                kind: "rule" as const,
                data: {
                  name: "GOOD",
                  instructions: "Use replacement rules.",
                  globs: [],
                  extensions: {},
                },
              },
            })),
          };
        },
      }),
    };
    const service = new ScanService({
      registrations: [directoryRegistration],
      read,
      snapshots,
      indexRepository: target.index,
    });

    await service.scan({
      scanRunId: "scan-incremental-directory",
      candidateRoots: [root],
      changedPaths: [root],
      homeDirectory: root,
      platform: "linux",
      signal: createCancellationController().signal,
    });

    expect(parsePaths).toEqual(["/project/good.md"]);
    expect(target.calls[0]?.assets.map(({ locator }) => locator)).toEqual(["rule:GOOD"]);
    expect(target.calls[0]).toMatchObject({
      changedPaths: ["/project", "/project/good.md"],
    });
    const resources = target.calls[0]?.effectiveConfigs[0]?.resolvedResources ?? [];
    expect(
      resources.map((resource) => {
        if (resource.kind !== "rule") throw new Error("Expected rule resource");
        return resource.data.name;
      }),
    ).toEqual(["GOOD"]);
  });

  it("reparses a Skill package when an incremental path is a newly added support file", async () => {
    const target = repository({ assets: [cachedSkillAsset], scopes: [scopeFixture] });
    const registration = adapter();
    const created = registration.create({ logger: { debug() {}, warn() {} } });
    const parsedPaths: string[] = [];
    const skillCandidate: DiscoveredResource = {
      toolId: "codex",
      sourcePath: skillPrimaryPath,
      sourceFormat: "yaml-frontmatter-markdown",
      resourceKindHint: "skill",
      scope: {
        kind: "project",
        canonicalRootPath: root,
        projectRoot: root,
        depth: 0,
        precedence: 100,
      },
    };
    const skillRegistration: AdapterRegistration = {
      ...registration,
      create: () => ({
        ...created,
        discover: () => Promise.resolve({ candidates: [skillCandidate], diagnostics: [] }),
        parse: ({ candidate, snapshot }: Parameters<ToolAdapter["parse"]>[0]) => {
          parsedPaths.push(candidate.sourcePath);
          return Promise.resolve({
            status: "parsed" as const,
            assets: [
              {
                toolId: "codex" as const,
                canonicalSourcePath: candidate.sourcePath,
                locator: "skill:.agents/skills/release",
                scope: candidate.scope,
                sourceFormat: candidate.sourceFormat,
                sourceContentHash: snapshot.contentHash,
                contentHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
                sourceFiles: [
                  primarySourceFile(candidate.sourcePath, snapshot.contentHash),
                  {
                    path: newSkillSupportPath,
                    relativePath: "references/new.md",
                    role: "support" as const,
                    mediaType: "text/markdown",
                    isText: true,
                    contentHash: ContentHashSchema.parse(`sha256:${"c".repeat(64)}`),
                  },
                ],
                nativeIdentity: {
                  nativeId: "skill:.agents/skills/release",
                  displayName: "release",
                  directoryName: "release",
                  invocationName: "release",
                },
                resource: {
                  kind: "skill" as const,
                  data: {
                    name: "release",
                    description: "Release safely",
                    instructions: "Use the new checklist.",
                    references: [],
                    extensions: {},
                  },
                },
                references: [],
                extensions: {},
              },
            ],
            diagnostics: [],
          });
        },
      }),
    };
    const service = new ScanService({
      registrations: [skillRegistration],
      read,
      snapshots,
      indexRepository: target.index,
    });

    await service.scan({
      scanRunId: "scan-incremental-new-skill-support",
      candidateRoots: [root],
      changedPaths: [newSkillSupportPath],
      homeDirectory: root,
      platform: "linux",
      signal: createCancellationController().signal,
    });

    expect(parsedPaths).toEqual([skillPrimaryPath]);
    expect(target.calls[0]).toMatchObject({
      changedPaths: [newSkillSupportPath, skillPrimaryPath],
    });
    expect(target.calls[0]?.assets).toHaveLength(1);
    expect(target.calls[0]?.assets[0]?.sourceFiles.map(({ path }) => path)).toEqual([
      skillPrimaryPath,
      newSkillSupportPath,
    ]);
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

  it("retries a paginated cached read when the snapshot revision changes", async () => {
    const target = repository({ assets: [cachedAsset], scopes: [scopeFixture] });
    let listCalls = 0;
    target.index.listAssets = () => {
      listCalls += 1;
      if (listCalls === 1) {
        return Promise.resolve({
          items: [cachedAsset],
          nextCursor: PaginationCursorSchema.parse("asset-cached"),
          snapshotRevision: "revision-1",
        });
      }
      if (listCalls === 2) {
        return Promise.resolve({ items: [], snapshotRevision: "revision-2" });
      }
      return Promise.resolve({ items: [cachedAsset], snapshotRevision: "revision-2" });
    };
    const service = new ScanService({
      registrations: [adapter()],
      read,
      snapshots,
      indexRepository: target.index,
    });

    await service.scan({
      scanRunId: "scan-pagination-revision-retry",
      candidateRoots: [root],
      changedPaths: [AbsolutePathSchema.parse("/project/notes.txt")],
      homeDirectory: root,
      platform: "linux",
      signal: createCancellationController().signal,
    });

    expect(listCalls).toBeGreaterThanOrEqual(4);
    expect(target.calls[0]?.effectiveConfigs[0]?.resolvedResources).toHaveLength(1);
  });

  it("rejects a repeated cached asset cursor instead of looping", async () => {
    const target = repository({ assets: [cachedAsset], scopes: [scopeFixture] });
    target.index.listAssets = () =>
      Promise.resolve({
        items: [cachedAsset],
        nextCursor: PaginationCursorSchema.parse("asset-cached"),
        snapshotRevision: "revision-1",
      });
    const service = new ScanService({
      registrations: [adapter()],
      read,
      snapshots,
      indexRepository: target.index,
    });

    await expect(
      service.scan({
        scanRunId: "scan-pagination-repeated-cursor",
        candidateRoots: [root],
        changedPaths: [AbsolutePathSchema.parse("/project/notes.txt")],
        homeDirectory: root,
        platform: "linux",
        signal: createCancellationController().signal,
      }),
    ).rejects.toMatchObject({ code: "STALE_INDEX" });
    expect(target.calls).toHaveLength(0);
  });
});
