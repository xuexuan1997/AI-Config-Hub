import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { AdapterRegistry } from "@ai-config-hub/adapters";
import {
  codexRegistration,
  createAdapterRegistry,
  cursorRegistration,
} from "@ai-config-hub/adapters";
import {
  AssetSchema,
  type AdapterFileSnapshot,
  type ConvertedOutput,
  type ConversionResult,
  type DeploymentPlan,
  type DeploymentRecord,
  type DeploymentRepository,
  type FileSnapshotPort,
  type NormalizedResource,
  type PathPolicyPort,
  type ToolAdapter,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AssetIdSchema,
  ContentHashSchema,
  ConversionResultIdSchema,
  CorrelationIdSchema,
  IsoDateTimeSchema,
  type AbsolutePath,
  type ContentHash,
} from "@ai-config-hub/shared";
import { describe, expect, it, vi } from "vitest";

import { DeploymentPreviewService, type PreviewRequest } from "./preview-service.js";

const NOW = IsoDateTimeSchema.parse("2026-06-22T08:00:00.000Z");
const ROOT = AbsolutePathSchema.parse("/target");
const BACKUP_ROOT = AbsolutePathSchema.parse("/backups");

function hash(text: string): ContentHash {
  return ContentHashSchema.parse(`sha256:${createHash("sha256").update(text).digest("hex")}`);
}

function hashBytes(bytes: Uint8Array): ContentHash {
  return ContentHashSchema.parse(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}

function expectGeneratedOutput(
  output: ConvertedOutput | undefined,
): Extract<ConvertedOutput, { readonly deploymentType: "generated_file" }> {
  if (output?.deploymentType !== "generated_file") throw new Error("expected generated output");
  return output;
}

function asset(
  id: string,
  resource: NormalizedResource = {
    kind: "rule",
    data: { name: id, instructions: `Instruction for ${id}.`, globs: [], extensions: {} },
  },
) {
  const canonicalSourcePath = AbsolutePathSchema.parse(`/source/${id}.md`);
  const sourceHash = hash(`source:${id}:primary`);
  return AssetSchema.parse({
    assetId: id,
    toolId: "claude-code",
    resource,
    scopeId: "scope-project",
    canonicalSourcePath,
    locator: `rule:${id}`,
    sourceFormat: "markdown",
    contentHash: hash(`source:${id}`),
    sourceFiles: [
      {
        path: canonicalSourcePath,
        relativePath: `${id}.md`,
        role: "primary",
        mediaType: "text/markdown",
        isText: true,
        contentHash: sourceHash,
      },
    ],
    nativeIdentity: {
      nativeId: `rule:${id}`,
      displayName: id,
    },
    normalizedSchemaVersion: "1.0.0",
    adapterId: "fixture-adapter",
    adapterVersion: "1.0.0",
    discoveredAt: NOW,
    references: [],
    diagnosticSummary: { info: 0, warning: 0, error: 0 },
  });
}

class MemoryDeploymentRepository implements DeploymentRepository {
  readonly savePlanAndRecord = vi.fn(
    (input: { readonly plan: DeploymentPlan; readonly record: DeploymentRecord }) => {
      this.plan = structuredClone(input.plan);
      this.record = structuredClone(input.record);
      return Promise.resolve();
    },
  );
  plan?: DeploymentPlan;
  record?: DeploymentRecord;

  getPlan(): Promise<DeploymentPlan | undefined> {
    return Promise.resolve(this.plan);
  }
  getRecord(): Promise<DeploymentRecord | undefined> {
    return Promise.resolve(this.record);
  }
  compareAndSetRecord(): Promise<boolean> {
    throw new Error("Preview must not update records");
  }
  listRecords(): never {
    throw new Error("Preview must not list records");
  }
}

function fixture(
  current: Readonly<Record<string, string | Uint8Array>> = {},
  options: {
    readonly registry?: AdapterRegistry;
    readonly snapshot?: FileSnapshotPort["snapshot"];
    readonly snapshotFile?: (input: {
      readonly path: AbsolutePath;
      readonly allowedRoots: readonly AbsolutePath[];
    }) => Promise<AdapterFileSnapshot | undefined>;
  } = {},
) {
  const repository = new MemoryDeploymentRepository();
  const snapshot = vi.fn<FileSnapshotPort["snapshot"]>(
    options.snapshot ??
      (({ path }) => {
        const content = current[path];
        if (content === undefined) return Promise.resolve(undefined);
        if (content instanceof Uint8Array) {
          return Promise.reject(
            Object.assign(new Error("Configuration file is not valid UTF-8"), {
              code: "VALIDATION_FAILED",
            }),
          );
        }
        return Promise.resolve({
          canonicalPath: path,
          text: content,
          contentHash: hash(content),
          modifiedAt: NOW,
          size: Buffer.byteLength(content),
        });
      }),
  );
  const snapshotFile = vi.fn(
    options.snapshotFile ??
      (({ path }) => {
        const content = current[path];
        if (content === undefined) return Promise.resolve(undefined);
        if (content instanceof Uint8Array) {
          return Promise.resolve({
            canonicalPath: path,
            contentHash: hashBytes(content),
            modifiedAt: NOW,
            size: content.byteLength,
            isText: false,
          });
        }
        return Promise.resolve({
          canonicalPath: path,
          contentHash: hash(content),
          modifiedAt: NOW,
          size: Buffer.byteLength(content),
          isText: true,
          text: content,
        });
      }),
  );
  const canonicalize = vi.fn<PathPolicyPort["canonicalize"]>(({ path, allowedRoots }) => {
    const resolved = posix.resolve(toPosixFixturePath(path));
    const allowed = allowedRoots.some((root) => {
      const relative = posix.relative(toPosixFixturePath(root), resolved);
      return relative === "" || (!relative.startsWith("../") && relative !== "..");
    });
    if (!allowed)
      throw Object.assign(new Error("outside root"), { code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    const absolute = AbsolutePathSchema.parse(resolved);
    return Promise.resolve({ path: absolute, comparisonKey: absolute, displayPath: path });
  });
  const service = new DeploymentPreviewService({
    registry: options.registry ?? createAdapterRegistry([codexRegistration, cursorRegistration]),
    snapshots: { snapshot, snapshotFile },
    pathPolicy: { canonicalize },
    deploymentRepository: repository,
  });
  return { service, repository, snapshot, canonicalize };
}

function toPosixFixturePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
}

function registryWithConversion(
  convert: ToolAdapter["convert"],
  toolId: "codex" | "cursor" = "codex",
): AdapterRegistry {
  const base = createAdapterRegistry([toolId === "codex" ? codexRegistration : cursorRegistration]);
  return {
    ...base,
    create(requestedToolId, logger) {
      const adapter = base.create(requestedToolId, logger);
      Object.defineProperty(adapter, "convert", { value: convert });
      return adapter;
    },
  };
}

function registryWithConvertedOutputs(
  outputs: readonly ConvertedOutput[],
  toolId: "codex" | "cursor" = "codex",
): AdapterRegistry {
  return registryWithConversion(
    (input) =>
      Promise.resolve({
        conversionResultId: ConversionResultIdSchema.parse(`conversion:${input.asset.assetId}`),
        sourceAssetId: input.asset.assetId,
        sourceContentHash: input.asset.contentHash,
        targetToolId: input.target.toolId,
        targetResourceKind: input.target.resourceKind,
        targetSchemaVersion: input.target.targetSchemaVersion,
        adapterId: toolId === "codex" ? codexRegistration.adapterId : cursorRegistration.adapterId,
        adapterVersion:
          toolId === "codex" ? codexRegistration.adapterVersion : cursorRegistration.adapterVersion,
        level: "full" as const,
        outputs,
        diagnostics: [],
      } satisfies ConversionResult),
    toolId,
  );
}

type PlanningResult = Awaited<ReturnType<ToolAdapter["planDeployment"]>>;

function registryWithPlanningMutation(
  mutate: (result: PlanningResult) => PlanningResult,
  toolId: "codex" | "cursor" = "codex",
): AdapterRegistry {
  const base = createAdapterRegistry([toolId === "codex" ? codexRegistration : cursorRegistration]);
  return {
    ...base,
    create(requestedToolId, logger) {
      const adapter = base.create(requestedToolId, logger);
      const originalPlanDeployment = adapter.planDeployment.bind(adapter);
      Object.defineProperty(adapter, "planDeployment", {
        value: async (context: Parameters<ToolAdapter["planDeployment"]>[0]) =>
          mutate(await originalPlanDeployment(context)),
      });
      return adapter;
    },
  };
}

function request(assets: readonly ReturnType<typeof asset>[], targetRoot = ROOT): PreviewRequest {
  return {
    assets,
    target: { toolId: "codex", resourceKind: "rule", targetSchemaVersion: "1.0.0" },
    targetRoot,
    backupRoot: BACKUP_ROOT,
    allowedRoots: [ROOT],
    now: NOW,
    correlationId: CorrelationIdSchema.parse("correlation-preview"),
    signal: new AbortController().signal,
  };
}

function generatedOutput(input: {
  readonly relativePath: string;
  readonly text: string;
  readonly contentHash?: ContentHash;
}): ConvertedOutput {
  return {
    deploymentType: "generated_file",
    relativePath: input.relativePath,
    mediaType: "text/markdown",
    text: input.text,
    contentHash: input.contentHash ?? hash(input.text),
  };
}

function sourceOutput(input: {
  readonly deploymentType: "copy" | "symlink";
  readonly relativePath: string;
  readonly sourcePath: string;
  readonly sourceText: string;
  readonly sourceHash?: ContentHash;
}): ConvertedOutput {
  const sourceHash = input.sourceHash ?? hash(input.sourceText);
  return {
    deploymentType: input.deploymentType,
    relativePath: input.relativePath,
    mediaType: "text/markdown",
    sourcePath: AbsolutePathSchema.parse(input.sourcePath),
    sourceHash,
    contentHash: sourceHash,
  };
}

function binarySourceOutput(input: {
  readonly deploymentType: "copy" | "symlink";
  readonly relativePath: string;
  readonly sourcePath: string;
  readonly sourceBytes: Uint8Array;
}): ConvertedOutput {
  const sourceHash = hashBytes(input.sourceBytes);
  return {
    deploymentType: input.deploymentType,
    relativePath: input.relativePath,
    mediaType: "application/octet-stream",
    sourcePath: AbsolutePathSchema.parse(input.sourcePath),
    sourceHash,
    contentHash: sourceHash,
  };
}

describe("DeploymentPreviewService", () => {
  it("uses adapter planning for Codex rule to Cursor previews and emits generated-file metadata", async () => {
    const base = createAdapterRegistry([cursorRegistration]);
    const planDeployment = vi.fn<ToolAdapter["planDeployment"]>();
    const registry: AdapterRegistry = {
      ...base,
      create(requestedToolId, logger) {
        const adapter = base.create(requestedToolId, logger);
        const originalPlanDeployment = adapter.planDeployment.bind(adapter);
        planDeployment.mockImplementation((context) => originalPlanDeployment(context));
        Object.defineProperty(adapter, "planDeployment", { value: planDeployment });
        return adapter;
      },
    };
    const baseSource = asset("codex-rule");
    const sourcePath = AbsolutePathSchema.parse("/source/AGENTS.md");
    const source = AssetSchema.parse({
      ...baseSource,
      toolId: "codex",
      adapterId: codexRegistration.adapterId,
      adapterVersion: codexRegistration.adapterVersion,
      canonicalSourcePath: sourcePath,
      locator: "rule:AGENTS.md",
      sourceFiles: baseSource.sourceFiles.map((sourceFile, index) =>
        index === 0 ? { ...sourceFile, path: sourcePath, relativePath: "AGENTS.md" } : sourceFile,
      ),
    });
    const context = fixture({}, { registry });

    const result = await context.service.preview({
      ...request([source]),
      target: { toolId: "cursor", resourceKind: "rule", targetSchemaVersion: "1.0.0" },
    });

    expect(planDeployment).toHaveBeenCalledTimes(1);
    expect(result.plan.operations).toEqual([
      expect.objectContaining({
        kind: "create",
        targetPath: "/target/.cursor/rules/codex-rule.mdc",
        deploymentType: "generated_file",
        targetResourceKind: "rule",
      }),
    ]);
    expect(result.record.operations).toEqual(result.plan.operations);
  });

  it("creates an immutable plan with deterministic identities and exact source/target hashes", async () => {
    const first = fixture();
    const source = asset("asset-create");
    const result = await first.service.preview(request([source]));
    const second = await fixture().service.preview(request([source]));

    expect(result.plan).toMatchObject({
      deploymentPlanId: second.plan.deploymentPlanId,
      planHash: second.plan.planHash,
      expectedSourceHashes: { "asset-create": source.contentHash },
      expectedTargetHashes: { "/target/AGENTS.md": "absent" },
      operations: [
        { kind: "create", targetPath: "/target/AGENTS.md", expectedTargetHash: "absent" },
      ],
      requiredConfirmations: [],
      createdAt: NOW,
      expiresAt: "2026-06-22T08:10:00.000Z",
    });
    expect(result.record).toMatchObject({
      deploymentPlanId: result.plan.deploymentPlanId,
      deploymentRecordId: second.record.deploymentRecordId,
      status: "planned",
      operations: result.plan.operations,
      verificationResult: { status: "not_started", diagnostics: [] },
    });
    expect(first.repository.savePlanAndRecord).toHaveBeenCalledTimes(1);
    expect(first.repository.plan).toEqual(result.plan);
    expect(first.repository.record).toEqual(result.record);
  });

  it("creates a replace operation with overwrite confirmation, exact target hash, and a bounded diff", async () => {
    const existing = "Old instruction.\n";
    const large = asset("asset-replace", {
      kind: "rule",
      data: { name: "large", instructions: "x".repeat(300 * 1024), globs: [], extensions: {} },
    });
    const { service } = fixture({ "/target/AGENTS.md": existing });

    const { plan, conversions } = await service.preview(request([large]));
    const [conversion] = conversions;
    const expectedText =
      conversion?.level === "unsupported" ? "" : expectGeneratedOutput(conversion?.outputs[0]).text;

    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: "replace",
        targetPath: "/target/AGENTS.md",
        deploymentType: "generated_file",
        targetResourceKind: "rule",
        expectedTargetHash: hash(existing),
        nextText: expectedText,
      }),
    ]);
    expect(plan.expectedTargetHashes).toEqual({ "/target/AGENTS.md": hash(existing) });
    expect(plan.requiredConfirmations).toContain("overwrite");
    expect(Buffer.byteLength(plan.diffs[0]?.unifiedText ?? "", "utf8")).toBeLessThanOrEqual(
      200 * 1024,
    );
  });

  it("rejects generated converted outputs whose content hash does not match text", async () => {
    const context = fixture(
      {},
      {
        registry: registryWithConvertedOutputs([
          generatedOutput({
            relativePath: "AGENTS.md",
            text: "Actual output.\n",
            contentHash: hash("Different output.\n"),
          }),
        ]),
      },
    );

    await expect(
      context.service.preview(request([asset("bad-output-hash")])),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects source converted outputs whose source bytes drift before planning", async () => {
    const sourcePath = "/source/shared-rule.md";
    const context = fixture(
      { [sourcePath]: "Changed rule.\n" },
      {
        registry: registryWithConvertedOutputs([
          sourceOutput({
            deploymentType: "copy",
            relativePath: "copied.md",
            sourcePath,
            sourceText: "Shared rule.\n",
          }),
        ]),
      },
    );

    await expect(
      context.service.preview({
        ...request([asset("source-drift")]),
        allowedRoots: [ROOT, AbsolutePathSchema.parse("/source")],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("plans source converted outputs with confined source metadata and no nextText", async () => {
    const sourcePath = AbsolutePathSchema.parse("/source/shared-rule.md");
    const sourceHash = hash("Shared rule.\n");
    for (const deploymentType of ["copy", "symlink"] as const) {
      const planDeployment = vi.fn<ToolAdapter["planDeployment"]>();
      const base = createAdapterRegistry([codexRegistration]);
      const context = fixture(
        { [sourcePath]: "Shared rule.\n" },
        {
          registry: {
            ...base,
            create(requestedToolId, logger) {
              const adapter = base.create(requestedToolId, logger);
              const originalPlanDeployment = adapter.planDeployment.bind(adapter);
              Object.defineProperty(adapter, "convert", {
                value: () =>
                  Promise.resolve({
                    conversionResultId: ConversionResultIdSchema.parse(
                      `conversion:${deploymentType}`,
                    ),
                    sourceAssetId: AssetIdSchema.parse(`asset-${deploymentType}`),
                    sourceContentHash: hash(`source:asset-${deploymentType}`),
                    targetToolId: "codex",
                    targetResourceKind: "rule",
                    targetSchemaVersion: "1.0.0",
                    adapterId: codexRegistration.adapterId,
                    adapterVersion: codexRegistration.adapterVersion,
                    level: "full" as const,
                    outputs: [
                      sourceOutput({
                        deploymentType,
                        relativePath: "copied.md",
                        sourcePath,
                        sourceText: "Shared rule.\n",
                      }),
                    ],
                    diagnostics: [],
                  } satisfies ConversionResult),
              });
              planDeployment.mockImplementation((planningContext) => {
                const resolved = planningContext.resolvedOutputs.get("copied.md");
                expect(resolved).toMatchObject({
                  deploymentType,
                  contentHash: sourceHash,
                  sourcePath,
                  sourceHash,
                  previewText: "Shared rule.\n",
                });
                return originalPlanDeployment(planningContext);
              });
              Object.defineProperty(adapter, "planDeployment", { value: planDeployment });
              return adapter;
            },
          },
        },
      );

      const result = await context.service.preview({
        ...request([asset(`asset-${deploymentType}`)]),
        allowedRoots: [ROOT, AbsolutePathSchema.parse("/source")],
      });

      expect(result.plan.operations).toEqual([
        expect.objectContaining({
          kind: "create",
          deploymentType,
          sourcePath,
          sourceHash,
          targetPath: "/target/copied.md",
        }),
      ]);
      expect(result.plan.operations[0]).not.toHaveProperty("nextText");
      expect(result.plan.diffs[0]?.unifiedText).toContain("+Shared rule.");
      expect(planDeployment).toHaveBeenCalledTimes(1);
      expect(context.repository.savePlanAndRecord).toHaveBeenCalledTimes(1);
    }
  });

  it("plans binary source copy outputs using byte snapshots instead of UTF-8 snapshots", async () => {
    const sourcePath = AbsolutePathSchema.parse("/source/logo.png");
    const sourceBytes = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]);
    const sourceHash = hashBytes(sourceBytes);
    const context = fixture(
      { [sourcePath]: sourceBytes },
      {
        registry: registryWithConvertedOutputs([
          binarySourceOutput({
            deploymentType: "copy",
            relativePath: ".agents/skills/release/assets/logo.png",
            sourcePath,
            sourceBytes,
          }),
        ]),
      },
    );

    const result = await context.service.preview({
      ...request([asset("binary-copy")]),
      allowedRoots: [ROOT, AbsolutePathSchema.parse("/source")],
    });

    expect(result.plan.operations).toEqual([
      expect.objectContaining({
        kind: "create",
        deploymentType: "copy",
        sourcePath,
        sourceHash,
        targetPath: "/target/.agents/skills/release/assets/logo.png",
      }),
    ]);
    expect(result.plan.diffs[0]?.unifiedText).toContain("+Binary source");
    expect(context.snapshot).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: sourcePath }),
    );
  });

  it("plans binary source copy replacements over existing binary targets", async () => {
    const sourcePath = AbsolutePathSchema.parse("/source/logo.png");
    const targetPath = AbsolutePathSchema.parse("/target/.agents/skills/release/assets/logo.png");
    const sourceBytes = new Uint8Array([137, 80, 78, 71, 1]);
    const targetBytes = new Uint8Array([137, 80, 78, 71, 0]);
    const context = fixture(
      { [sourcePath]: sourceBytes, [targetPath]: targetBytes },
      {
        registry: registryWithConvertedOutputs([
          binarySourceOutput({
            deploymentType: "copy",
            relativePath: ".agents/skills/release/assets/logo.png",
            sourcePath,
            sourceBytes,
          }),
        ]),
      },
    );

    const result = await context.service.preview({
      ...request([asset("binary-replace")]),
      allowedRoots: [ROOT, AbsolutePathSchema.parse("/source")],
    });

    expect(result.plan.operations).toEqual([
      expect.objectContaining({
        kind: "replace",
        deploymentType: "copy",
        targetPath,
        sourcePath,
        expectedTargetHash: hashBytes(targetBytes),
      }),
    ]);
    expect(result.plan.diffs[0]?.unifiedText).toContain("-Binary target");
    expect(result.plan.diffs[0]?.unifiedText).toContain("+Binary source");
  });

  it("rejects adapter-planned copy and symlink operations outside allowed source roots", async () => {
    const sourcePath = AbsolutePathSchema.parse("/outside/shared-rule.md");
    const context = fixture(
      {},
      {
        registry: registryWithPlanningMutation((planning) => ({
          ...planning,
          draft: {
            ...planning.draft,
            operations: planning.draft.operations.map((operation) =>
              operation.kind === "create" || operation.kind === "replace"
                ? {
                    ...operation,
                    deploymentType: "copy" as const,
                    sourcePath,
                    sourceHash: hash("Shared rule.\n"),
                  }
                : operation,
            ),
          },
        })),
      },
    );

    await expect(
      context.service.preview(request([asset("bad-copy-source")])),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects adapter-planned operations whose nextText does not match the converted output hash", async () => {
    const context = fixture(
      {},
      {
        registry: registryWithPlanningMutation((planning) => ({
          ...planning,
          draft: {
            ...planning.draft,
            operations: planning.draft.operations.map((operation) =>
              operation.kind === "create" || operation.kind === "replace"
                ? { ...operation, nextText: "tampered text\n" }
                : operation,
            ),
          },
        })),
      },
    );

    await expect(context.service.preview(request([asset("bad-next-text")]))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects adapter-planned operations with stale expected target hashes", async () => {
    const existing = "Old instruction.\n";
    const context = fixture(
      { "/target/AGENTS.md": existing },
      {
        registry: registryWithPlanningMutation((planning) => ({
          ...planning,
          draft: {
            ...planning.draft,
            operations: planning.draft.operations.map((operation) =>
              operation.kind === "replace"
                ? { ...operation, expectedTargetHash: hash("stale target\n") }
                : operation,
            ),
          },
        })),
      },
    );

    await expect(
      context.service.preview(request([asset("bad-expected-hash")])),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects adapter planning that omits a changed converted output", async () => {
    const twoOutputText = {
      first: "First generated output.\n",
      second: "Second generated output.\n",
    };
    const base = createAdapterRegistry([codexRegistration]);
    const context = fixture(
      {},
      {
        registry: {
          ...base,
          create(requestedToolId, logger) {
            const adapter = base.create(requestedToolId, logger);
            const originalPlanDeployment = adapter.planDeployment.bind(adapter);
            Object.defineProperty(adapter, "convert", {
              value: (input: Parameters<ToolAdapter["convert"]>[0]) =>
                Promise.resolve({
                  conversionResultId: ConversionResultIdSchema.parse("conversion:two-outputs"),
                  sourceAssetId: input.asset.assetId,
                  sourceContentHash: input.asset.contentHash,
                  targetToolId: input.target.toolId,
                  targetResourceKind: input.target.resourceKind,
                  targetSchemaVersion: input.target.targetSchemaVersion,
                  adapterId: adapter.adapterId,
                  adapterVersion: adapter.adapterVersion,
                  level: "full" as const,
                  outputs: [
                    {
                      deploymentType: "generated_file",
                      relativePath: "first.md",
                      mediaType: "text/markdown",
                      text: twoOutputText.first,
                      contentHash: hash(twoOutputText.first),
                    },
                    {
                      deploymentType: "generated_file",
                      relativePath: "second.md",
                      mediaType: "text/markdown",
                      text: twoOutputText.second,
                      contentHash: hash(twoOutputText.second),
                    },
                  ],
                  diagnostics: [],
                }),
            });
            Object.defineProperty(adapter, "planDeployment", {
              value: async (planningInput: Parameters<ToolAdapter["planDeployment"]>[0]) => {
                const planning = await originalPlanDeployment(planningInput);
                return {
                  ...planning,
                  draft: {
                    ...planning.draft,
                    operations: planning.draft.operations.slice(0, 1),
                    diffs: planning.draft.diffs.slice(0, 1),
                  },
                };
              },
            });
            return adapter;
          },
        },
      },
    );

    await expect(context.service.preview(request([asset("multi-output")]))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects adapter-planned operations for targets not produced by the conversion", async () => {
    const context = fixture(
      {},
      {
        registry: registryWithPlanningMutation((planning) => ({
          ...planning,
          draft: {
            ...planning.draft,
            operations: [
              ...planning.draft.operations,
              {
                kind: "delete",
                targetPath: AbsolutePathSchema.parse("/target/extra.md"),
                expectedTargetHash: hash("extra\n"),
                deploymentType: "generated_file",
              },
            ],
          },
        })),
      },
    );

    await expect(
      context.service.preview(request([asset("bad-extra-target")])),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects adapter-planned generated operations with mismatched target resource kind", async () => {
    const context = fixture(
      {},
      {
        registry: registryWithPlanningMutation((planning) => ({
          ...planning,
          draft: {
            ...planning.draft,
            operations: planning.draft.operations.map((operation) =>
              operation.kind === "create" || operation.kind === "replace"
                ? { ...operation, targetResourceKind: "agent" as const }
                : operation,
            ),
          },
        })),
      },
    );

    await expect(context.service.preview(request([asset("bad-kind")]))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects adapter-provided diffs for unknown targets", async () => {
    const context = fixture(
      {},
      {
        registry: registryWithPlanningMutation((planning) => ({
          ...planning,
          draft: {
            ...planning.draft,
            diffs: [
              ...planning.draft.diffs,
              {
                targetPath: AbsolutePathSchema.parse("/target/unknown.md"),
                summary: "Unknown target",
                unifiedText: "--- /dev/null\n+++ /target/unknown.md",
              },
            ],
          },
        })),
      },
    );

    await expect(
      context.service.preview(request([asset("bad-unknown-diff")])),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects adapter-provided diffs outside the target root", async () => {
    const context = fixture(
      {},
      {
        registry: registryWithPlanningMutation((planning) => ({
          ...planning,
          draft: {
            ...planning.draft,
            diffs: [
              {
                targetPath: AbsolutePathSchema.parse("/outside/evil.md"),
                summary: "Outside target",
                unifiedText: "--- /dev/null\n+++ /outside/evil.md",
              },
            ],
          },
        })),
      },
    );

    await expect(
      context.service.preview(request([asset("bad-outside-diff")])),
    ).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ALLOWED_ROOT",
    });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects adapter-provided diffs larger than the preview limit", async () => {
    const context = fixture(
      {},
      {
        registry: registryWithPlanningMutation((planning) => ({
          ...planning,
          draft: {
            ...planning.draft,
            diffs: planning.draft.diffs.map((diff) => ({
              ...diff,
              unifiedText: "x".repeat(200 * 1024 + 1),
            })),
          },
        })),
      },
    );

    await expect(
      context.service.preview(request([asset("bad-oversized-diff")])),
    ).rejects.toMatchObject({
      code: "PREVIEW_TOO_LARGE",
    });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("surfaces non-blocking adapter planning diagnostics as plan warnings", async () => {
    const context = fixture(
      {},
      {
        registry: registryWithPlanningMutation((planning) => ({
          ...planning,
          diagnostics: [
            ...planning.diagnostics,
            {
              code: "PLANNING_NOTE",
              severity: "warning",
              message: "Adapter planned with a conservative fallback",
              evidence: {},
              suggestedActions: ["Review the preview"],
              blocking: false,
            },
          ],
        })),
      },
    );

    const result = await context.service.preview(request([asset("planning-warning")]));

    expect(result.plan.warnings).toEqual(
      expect.arrayContaining(["Adapter planned with a conservative fallback"]),
    );
    expect(context.repository.savePlanAndRecord).toHaveBeenCalledTimes(1);
  });

  it("applies conflict policies before persistence", async () => {
    const existing = "Old instruction.\n";
    const failContext = fixture({ "/target/AGENTS.md": existing });

    await expect(
      failContext.service.preview({
        ...request([asset("asset-conflict-fail")]),
        conflictPolicy: "fail",
      }),
    ).rejects.toMatchObject({ code: "TARGET_CONFLICT" });
    expect(failContext.repository.savePlanAndRecord).not.toHaveBeenCalled();

    const mergeContext = fixture({ "/target/AGENTS.md": existing });
    await expect(
      mergeContext.service.preview({
        ...request([asset("asset-conflict-merge")]),
        conflictPolicy: "merge",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CONVERSION" });
    expect(mergeContext.snapshot).not.toHaveBeenCalled();
    expect(mergeContext.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("omits byte-identical targets while retaining changed outputs and performs no file writes", async () => {
    const unchanged = asset("asset-unchanged", {
      kind: "agent",
      data: {
        name: "asset-unchanged",
        instructions: "Instruction for asset-unchanged.",
        allowedTools: [],
        extensions: {},
      },
    });
    const changed = asset("asset-changed", {
      kind: "agent",
      data: {
        name: "changed",
        instructions: "Run checks.",
        allowedTools: [],
        extensions: {},
      },
    });
    const unchangedText = "---\nname: asset-unchanged\n---\nInstruction for asset-unchanged.\n";
    const { service, snapshot } = fixture({
      "/target/.cursor/agents/asset-unchanged.md": unchangedText,
    });
    const mixedRequest = {
      ...request([unchanged, changed]),
      target: { toolId: "cursor", resourceKind: "agent", targetSchemaVersion: "1.0.0" } as const,
    };

    const result = await service.preview(mixedRequest);

    expect(result.plan.operations).toHaveLength(1);
    expect(result.plan.operations[0]?.targetPath).toBe("/target/.cursor/agents/changed.md");
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(result.record.backupLocations).toEqual({});
    expect(result.record.resultingHashes).toEqual({});
  });

  it("requires partial-conversion confirmation and records adapter warnings", async () => {
    const partial = asset("asset-partial", {
      kind: "rule",
      data: {
        name: "partial",
        instructions: "Keep the supported portion.",
        globs: [],
        extensions: { vendorFlag: true },
      },
    });

    const result = await fixture().service.preview(request([partial]));

    expect(result.conversions[0]?.level).toBe("partial");
    expect(result.plan.requiredConfirmations).toContain("partial_conversion");
    expect(result.plan.warnings).toEqual(expect.arrayContaining([expect.any(String)]));
  });

  it("rejects redacted MCP values before persistence", async () => {
    const redacted = asset("asset-redacted", {
      kind: "mcp",
      data: {
        name: "private",
        transport: {
          kind: "stdio",
          command: "node",
          args: [{ kind: "redacted", digest: hash("secret"), deployable: false }],
          env: {},
        },
        extensions: {},
      },
    });
    const context = fixture();

    await expect(
      context.service.preview({
        ...request([redacted]),
        target: { toolId: "codex", resourceKind: "mcp", targetSchemaVersion: "1.0.0" },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CONVERSION" });
    expect(context.snapshot).not.toHaveBeenCalled();
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects targets outside authorized roots before reading or persistence", async () => {
    const context = fixture();

    await expect(
      context.service.preview(
        request([asset("asset-outside")], AbsolutePathSchema.parse("/other")),
      ),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    expect(context.snapshot).not.toHaveBeenCalled();
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects duplicate source asset identities before conversion or persistence", async () => {
    const source = asset("asset-duplicate");
    const convert = vi.fn<ToolAdapter["convert"]>();
    const context = fixture({}, { registry: registryWithConversion(convert) });

    await expect(context.service.preview(request([source, source]))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(convert).not.toHaveBeenCalled();
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rejects conversion results that are not bound to their source, target, or adapter", async () => {
    const source = asset("asset-untrusted");
    const trustedAdapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const valid = await trustedAdapter.convert({
      asset: source,
      target: request([source]).target,
      signal: new AbortController().signal,
    });
    const mismatches = [
      { sourceAssetId: "different-asset" },
      { sourceContentHash: hash("different-source") },
      { targetToolId: "cursor" },
      { targetResourceKind: "agent" },
      { targetSchemaVersion: "2.0.0" },
      { adapterId: "different-adapter" },
      { adapterVersion: "2.0.0" },
    ] as const;

    for (const mismatch of mismatches) {
      const context = fixture(
        {},
        {
          registry: registryWithConversion(() =>
            Promise.resolve({ ...valid, ...mismatch } as typeof valid),
          ),
        },
      );
      await expect(context.service.preview(request([source]))).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
      expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
    }
  });

  it("rejects duplicate conversion result identities", async () => {
    const first = asset("first", {
      kind: "agent",
      data: { name: "first", instructions: "First.", allowedTools: [], extensions: {} },
    });
    const second = asset("second", {
      kind: "agent",
      data: { name: "second", instructions: "Second.", allowedTools: [], extensions: {} },
    });
    const adapter = cursorRegistration.create({ logger: { debug() {}, warn() {} } });
    const convert: ToolAdapter["convert"] = async (context) => {
      const converted = await adapter.convert(context);
      return {
        ...converted,
        conversionResultId: ConversionResultIdSchema.parse("duplicate-conversion"),
      };
    };
    const context = fixture({}, { registry: registryWithConversion(convert, "cursor") });

    await expect(
      context.service.preview({
        ...request([first, second]),
        target: { toolId: "cursor", resourceKind: "agent", targetSchemaVersion: "1.0.0" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("does not persist when cancellation happens while awaiting a target snapshot", async () => {
    const controller = new AbortController();
    const context = fixture(
      {},
      {
        snapshot: () => {
          controller.abort();
          return Promise.resolve(undefined);
        },
      },
    );

    await expect(
      context.service.preview({ ...request([asset("cancelled")]), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("rechecks cancellation immediately before persistence", async () => {
    let checks = 0;
    const signal = new AbortController().signal;
    Object.defineProperty(signal, "throwIfAborted", {
      value() {
        checks += 1;
        if (checks === 6) throw new DOMException("Preview cancelled", "AbortError");
      },
    });
    const context = fixture();

    await expect(
      context.service.preview({ ...request([asset("cancelled-before-save")]), signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(context.repository.savePlanAndRecord).not.toHaveBeenCalled();
  });

  it("emits semantically accurate newline markers in unified diffs", async () => {
    const source = asset("newline", {
      kind: "rule",
      data: { name: "newline", instructions: "new", globs: [], extensions: {} },
    });
    const result = await fixture({ "/target/AGENTS.md": "old" }).service.preview(request([source]));

    expect(result.plan.diffs[0]?.unifiedText).toBe(
      "--- /target/AGENTS.md\n" +
        "+++ /target/AGENTS.md\n" +
        "@@ -1,1 +1,1 @@\n" +
        "-old\n" +
        "\\ No newline at end of file\n" +
        "+new",
    );
  });

  it("truncates ASCII and multibyte diffs at line boundaries with an explicit honest marker", async () => {
    for (const content of ["ascii\n".repeat(80_000), "你好世界\n".repeat(40_000)]) {
      const source = asset(`large-${content.charCodeAt(0)}`, {
        kind: "rule",
        data: { name: "large", instructions: content, globs: [], extensions: {} },
      });
      const result = await fixture({ "/target/AGENTS.md": "old\n" }).service.preview(
        request([source]),
      );
      const diff = result.plan.diffs[0]?.unifiedText ?? "";
      const header = diff.match(/@@ -1,(\d+) \+1,(\d+) @@/);
      const displayedOld = diff.split("\n").filter((line) => line.startsWith("-")).length - 1;
      const displayedNew = diff.split("\n").filter((line) => line.startsWith("+")).length - 1;

      expect(Buffer.byteLength(diff, "utf8")).toBeLessThanOrEqual(200 * 1024);
      expect(diff).toContain("# AI Config Hub: diff truncated");
      expect(header?.[1]).toBe(String(displayedOld));
      expect(header?.[2]).toBe(String(displayedNew));
      expect(diff).not.toContain("�");
    }
  });
});
