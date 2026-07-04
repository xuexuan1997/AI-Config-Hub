import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AssetSchema,
  DeploymentPlanSchema,
  DeploymentRecordSchema,
  DiagnosticSchema,
  ScopeSchema,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AssetIdSchema,
  ScanRunIdSchema,
  TaskIdSchema,
  ToolInstallationIdSchema,
} from "@ai-config-hub/shared";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database.js";
import { createStorageRepositories } from "./repositories.js";

const directories: string[] = [];

function path() {
  const directory = mkdtempSync(join(tmpdir(), "ai-config-hub-repository-"));
  directories.push(directory);
  return join(directory, "index.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const tool = {
  toolId: "codex" as const,
  installationId: ToolInstallationIdSchema.parse("codex-project"),
  detectedVersion: "0.101.0",
  configRoots: [AbsolutePathSchema.parse("/project")],
  evidence: { marker: "AGENTS.md" },
};
const scope = ScopeSchema.parse({
  scopeId: "scope-project",
  toolId: "codex",
  scopeKind: "project",
  canonicalRootPath: "/project",
  projectId: "project-1",
  depth: 0,
  precedence: 100,
  discoveryEvidence: { installationId: "codex-project" },
});

function asset(id: string, instruction: string, extensions: Record<string, unknown> = {}) {
  return AssetSchema.parse({
    assetId: id,
    toolId: "codex",
    resource: {
      kind: "rule",
      data: { name: id, instructions: instruction, globs: [], extensions },
    },
    scopeId: scope.scopeId,
    canonicalSourcePath: `/project/${id}.md`,
    locator: `rule:${id}`,
    sourceFormat: "markdown",
    contentHash: `sha256:${"a".repeat(64)}`,
    normalizedSchemaVersion: "1.0.0",
    adapterId: "builtin-codex",
    adapterVersion: "0.1.0",
    discoveredAt: "2026-06-21T08:00:00.000Z",
    references: [],
    diagnosticSummary: { info: 0, warning: 0, error: 0 },
  });
}

function diagnosticForAssetPath(input: {
  readonly diagnosticId: string;
  readonly scanRunId: string;
  readonly sourcePath: string;
}) {
  return DiagnosticSchema.parse({
    diagnosticId: input.diagnosticId,
    code: "RESOURCE_INSTRUCTIONS_EMPTY",
    severity: "error",
    category: "discovery",
    message: "Resource instructions are empty",
    subject: { kind: "scan", id: input.scanRunId },
    location: { path: input.sourcePath },
    impact: "The resource cannot be used safely",
    evidence: { sourcePath: input.sourcePath },
    suggestedActions: ["Review the source configuration and scan again"],
    blocking: true,
    createdAt: "2026-06-21T08:00:00.000Z",
  });
}

function replacement(
  scanRunId: string,
  assets: readonly ReturnType<typeof asset>[],
  diagnostics: readonly ReturnType<typeof diagnosticForAssetPath>[] = [],
) {
  return {
    scanRunId: ScanRunIdSchema.parse(scanRunId),
    tools: [tool],
    scopes: [scope],
    assets,
    effectiveConfigs: [],
    diagnostics,
  };
}

describe("storage repositories", () => {
  it("atomically replaces the derived index and rejects secret-bearing JSON before writing", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    await repositories.index.replaceDerivedIndex(replacement("scan-a", [asset("asset-a", "A")]));

    const canary = "top-secret-canary";
    await expect(
      repositories.index.replaceDerivedIndex(
        replacement("scan-b", [asset("asset-b", "B", { apiKey: canary })]),
      ),
    ).rejects.toThrow();
    expect(
      (await repositories.index.listAssets({ limit: 20 })).items.map(({ assetId }) => assetId),
    ).toEqual(["asset-a"]);
    expect(readFileSync(databasePath).includes(Buffer.from(canary))).toBe(false);

    await repositories.index.replaceDerivedIndex(replacement("scan-c", [asset("asset-c", "C")]));
    expect(
      (await repositories.index.listAssets({ limit: 20 })).items.map(({ assetId }) => assetId),
    ).toEqual(["asset-c"]);
    opened.database.close();
  });

  it("merges incremental changed paths without dropping unrelated assets", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    await repositories.index.replaceDerivedIndex(
      replacement("scan-full", [asset("asset-a", "A"), asset("asset-b", "B")]),
    );

    await repositories.index.mergeIncrementalIndex({
      ...replacement("scan-incremental-update", [asset("asset-b", "B2")]),
      changedPaths: [AbsolutePathSchema.parse("/project/asset-b.md")],
    });

    const updated = await repositories.index.listAssets({ limit: 20 });
    expect(updated.items.map(({ assetId }) => assetId)).toEqual(["asset-a", "asset-b"]);
    expect(
      updated.items.map(({ resource }) => {
        if (resource.kind !== "rule") throw new Error("Expected rule fixture");
        return resource.data.instructions;
      }),
    ).toEqual(["A", "B2"]);

    await repositories.index.mergeIncrementalIndex({
      ...replacement("scan-incremental-delete", []),
      changedPaths: [AbsolutePathSchema.parse("/project/asset-b.md")],
    });

    expect(
      (await repositories.index.listAssets({ limit: 20 })).items.map(({ assetId }) => assetId),
    ).toEqual(["asset-a"]);
    opened.database.close();
  });

  it("persists asset disablement across derived index replacement without deleting the asset", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    await repositories.index.replaceDerivedIndex(
      replacement("scan-full", [asset("asset-a", "A"), asset("asset-b", "B")]),
    );
    const missingAssetId = AssetIdSchema.parse("missing-asset");
    const assetAId = AssetIdSchema.parse("asset-a");
    const assetBId = AssetIdSchema.parse("asset-b");

    await expect(
      repositories.index.setAssetStatus(missingAssetId, "disabled"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const disabled = await repositories.index.setAssetStatus(assetAId, "disabled");
    expect(disabled).toMatchObject({ assetId: "asset-a", status: "disabled" });
    expect((await repositories.index.getAsset(assetAId))?.status).toBe("disabled");
    expect((await repositories.index.getAsset(assetBId))?.status).toBe("enabled");
    expect(
      (await repositories.index.listAssets({ limit: 20 })).items.map(({ assetId, status }) => ({
        assetId,
        status,
      })),
    ).toEqual([
      { assetId: "asset-a", status: "disabled" },
      { assetId: "asset-b", status: "enabled" },
    ]);

    await repositories.index.replaceDerivedIndex(
      replacement("scan-rescan", [asset("asset-a", "A2"), asset("asset-b", "B2")]),
    );
    expect((await repositories.index.getAsset(assetAId))?.status).toBe("disabled");

    const enabled = await repositories.index.setAssetStatus(assetAId, "enabled");
    expect(enabled).toMatchObject({ assetId: "asset-a", status: "enabled" });
    expect((await repositories.index.getAsset(assetAId))?.status).toBe("enabled");
    opened.database.close();
  });

  it("can explicitly enable an adapter-reported disabled asset before the next scan", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    try {
      const repositories = createStorageRepositories(opened);
      const nativeDisabled = AssetSchema.parse({ ...asset("asset-a", "A"), status: "disabled" });
      await repositories.index.replaceDerivedIndex(replacement("scan-full", [nativeDisabled]));
      const assetAId = AssetIdSchema.parse("asset-a");

      expect((await repositories.index.getAsset(assetAId))?.status).toBe("disabled");

      await repositories.index.setAssetStatus(assetAId, "enabled");

      expect((await repositories.index.getAsset(assetAId))?.status).toBe("enabled");
      expect((await repositories.index.listAssets({ limit: 20 })).items[0]?.status).toBe("enabled");
    } finally {
      opened.database.close();
    }
  });

  it("lists diagnostics associated to an asset by source path ownership", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    const inspectedAsset = asset("asset-a", "A");
    await repositories.index.replaceDerivedIndex(
      replacement(
        "scan-full",
        [inspectedAsset],
        [
          diagnosticForAssetPath({
            diagnosticId: "diagnostic-a",
            scanRunId: "scan-full",
            sourcePath: inspectedAsset.canonicalSourcePath,
          }),
        ],
      ),
    );

    const page = await repositories.index.listDiagnostics({
      assetId: AssetIdSchema.parse(inspectedAsset.assetId),
      limit: 20,
    });

    expect(page.items.map(({ diagnosticId }) => diagnosticId)).toEqual(["diagnostic-a"]);
    opened.database.close();
  });

  it("persists settings and task progress across reopen with optimistic revisions", async () => {
    const databasePath = path();
    const first = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(first);
    const initial = await repositories.settings.getPublic();
    expect(initial.settings.language).toBe("system");
    const updated = await repositories.settings.updatePublic({
      expectedRevision: initial.revision,
      settings: {
        readOnlyMode: false,
        customScanRoots: [AbsolutePathSchema.parse("/project")],
        theme: "system",
        language: "zh-CN",
        scanHints: true,
        fileWatching: true,
        pathDisplay: "abbreviated",
      },
    });
    expect(updated.settings.language).toBe("zh-CN");
    await expect(
      repositories.settings.updatePublic({
        expectedRevision: initial.revision,
        settings: updated.settings,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await repositories.tasks.create({
      taskId: TaskIdSchema.parse("task-1"),
      scanRunId: ScanRunIdSchema.parse("scan-task-1"),
      status: "queued",
    });
    await repositories.tasks.updateProgress({
      taskId: TaskIdSchema.parse("task-1"),
      sequence: 1,
      phase: "discovering",
      completed: 1,
      total: 2,
    });
    first.database.close();

    const second = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const reopened = createStorageRepositories(second);
    expect(await reopened.settings.getPublic()).toEqual(updated);
    expect(await reopened.tasks.get(TaskIdSchema.parse("task-1"))).toMatchObject({
      status: "queued",
      progress: { sequence: 1, phase: "discovering" },
    });
    second.database.close();
  });

  it("round-trips deployment plans and records and blocks recovery-mode mutations", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    const operation = {
      kind: "create" as const,
      targetPath: "/project/AGENTS.md",
      nextText: "Use tests.",
      expectedTargetHash: "absent" as const,
    };
    const plan = DeploymentPlanSchema.parse({
      deploymentPlanId: "plan-1",
      conversionResultIds: ["conversion-1"],
      operations: [operation],
      diffs: [],
      expectedSourceHashes: { "asset-1": `sha256:${"a".repeat(64)}` },
      expectedTargetHashes: { "/project/AGENTS.md": "absent" },
      backupPolicy: { mode: "required", backupRoot: "/backups" },
      verificationStrategy: { kind: "adapter", description: "Parse target" },
      requiredConfirmations: [],
      warnings: [],
      planHash: `sha256:${"b".repeat(64)}`,
      adapterId: "builtin-codex",
      adapterVersion: "0.1.0",
      createdAt: "2026-06-21T08:00:00.000Z",
    });
    const record = DeploymentRecordSchema.parse({
      deploymentRecordId: "deployment-1",
      deploymentPlanId: plan.deploymentPlanId,
      status: "planned",
      operations: [operation],
      backupLocations: {},
      resultingHashes: {},
      verificationResult: { status: "not_started", diagnostics: [] },
      rollbackResults: [],
      adapterId: "builtin-codex",
      adapterVersion: "0.1.0",
      normalizedSchemaVersion: "1.0.0",
      createdAt: "2026-06-21T08:00:00.000Z",
      correlationId: "correlation-1",
      diagnostics: [],
    });
    await repositories.deployments.savePlanAndRecord({ plan, record });
    expect(await repositories.deployments.getPlan(plan.deploymentPlanId)).toEqual(plan);
    expect(await repositories.deployments.getRecord(record.deploymentRecordId)).toEqual(record);
    opened.database.close();

    const recovery = await openDatabase({
      path: databasePath,
      appVersion: "0.1.0",
      migrations: [{ ...initialMigrationForDrift(), checksum: `sha256:${"f".repeat(64)}` }],
    });
    const readOnly = createStorageRepositories(recovery);
    await expect(readOnly.deployments.savePlanAndRecord({ plan, record })).rejects.toMatchObject({
      code: "READ_ONLY_RECOVERY",
    });
    recovery.database.close();
  });

  it("lists deployment history newest-first with cursor pagination", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    const older = deploymentFixture({
      deploymentRecordId: "deployment-a",
      deploymentPlanId: "plan-a",
      createdAt: "2026-06-21T08:00:00.000Z",
      hashSeed: "a",
    });
    const newer = deploymentFixture({
      deploymentRecordId: "deployment-z",
      deploymentPlanId: "plan-z",
      createdAt: "2026-06-21T09:00:00.000Z",
      hashSeed: "b",
    });
    await repositories.deployments.savePlanAndRecord(older);
    await repositories.deployments.savePlanAndRecord(newer);

    const firstPage = await repositories.deployments.listRecords({ limit: 1 });
    expect(firstPage.items.map((record) => record.deploymentRecordId)).toEqual(["deployment-z"]);
    expect(firstPage.nextCursor).toBe("deployment-z");
    const cursor = firstPage.nextCursor;
    if (cursor === undefined) throw new Error("Expected first page cursor");

    const secondPage = await repositories.deployments.listRecords({
      cursor,
      limit: 1,
    });
    expect(secondPage.items.map((record) => record.deploymentRecordId)).toEqual(["deployment-a"]);
    expect(secondPage.nextCursor).toBeUndefined();
    opened.database.close();
  });

  it("filters deployment history by kind, status, and creation window", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    const deployment = deploymentFixture({
      deploymentRecordId: "deployment-succeeded",
      deploymentPlanId: "plan-deployment",
      createdAt: "2026-06-21T08:00:00.000Z",
      hashSeed: "a",
      status: "succeeded",
    });
    const rollback = deploymentFixture({
      deploymentRecordId: "rollback-succeeded",
      deploymentPlanId: "plan-rollback",
      createdAt: "2026-06-21T09:00:00.000Z",
      hashSeed: "b",
      rollbackOfRecordId: "deployment-succeeded",
      status: "succeeded",
    });
    const plannedRollback = deploymentFixture({
      deploymentRecordId: "rollback-planned",
      deploymentPlanId: "plan-failed",
      createdAt: "2026-06-21T10:00:00.000Z",
      hashSeed: "c",
      rollbackOfRecordId: "deployment-succeeded",
    });
    await repositories.deployments.savePlanAndRecord(deployment);
    await repositories.deployments.savePlanAndRecord(rollback);
    await repositories.deployments.savePlanAndRecord(plannedRollback);

    const page = await repositories.deployments.listRecords({
      kinds: ["rollback"],
      statuses: ["succeeded"],
      from: "2026-06-21T08:30:00.000Z",
      to: "2026-06-21T09:30:00.000Z",
      limit: 10,
    });

    expect(page.items.map((record) => record.deploymentRecordId)).toEqual(["rollback-succeeded"]);
    opened.database.close();
  });
});

function initialMigrationForDrift() {
  // Loaded lazily to keep the test fixture focused on repository behavior.
  return { version: 1, name: "initial", sql: "" } as const;
}

function deploymentFixture(input: {
  readonly deploymentRecordId: string;
  readonly deploymentPlanId: string;
  readonly createdAt: string;
  readonly hashSeed: string;
  readonly rollbackOfRecordId?: string;
  readonly status?: "planned" | "succeeded" | "failed";
}) {
  const operation = {
    kind: "create" as const,
    targetPath: `/project/${input.deploymentRecordId}.md`,
    nextText: "Use tests.",
    expectedTargetHash: "absent" as const,
  };
  const plan = DeploymentPlanSchema.parse({
    deploymentPlanId: input.deploymentPlanId,
    conversionResultIds: [`conversion-${input.hashSeed}`],
    operations: [operation],
    diffs: [],
    expectedSourceHashes: { [`asset-${input.hashSeed}`]: `sha256:${input.hashSeed.repeat(64)}` },
    expectedTargetHashes: { [operation.targetPath]: "absent" },
    backupPolicy: { mode: "required", backupRoot: "/backups" },
    verificationStrategy: { kind: "adapter", description: "Parse target" },
    requiredConfirmations: [],
    warnings: [],
    planHash: `sha256:${input.hashSeed.repeat(64)}`,
    adapterId: "builtin-codex",
    adapterVersion: "0.1.0",
    createdAt: input.createdAt,
  });
  const record = DeploymentRecordSchema.parse({
    deploymentRecordId: input.deploymentRecordId,
    deploymentPlanId: plan.deploymentPlanId,
    ...(input.rollbackOfRecordId === undefined
      ? {}
      : { rollbackOfRecordId: input.rollbackOfRecordId }),
    status: input.status ?? "planned",
    operations: [operation],
    backupLocations:
      input.status === "succeeded" ? { [operation.targetPath]: "previously-absent" } : {},
    resultingHashes: input.status === "succeeded" ? { [operation.targetPath]: plan.planHash } : {},
    verificationResult:
      input.status === "succeeded"
        ? {
            status: "passed",
            verifiedHashes: { [operation.targetPath]: plan.planHash },
            diagnostics: [],
          }
        : input.status === "failed"
          ? { status: "failed", verifiedHashes: {}, diagnostics: [] }
          : { status: "not_started", diagnostics: [] },
    rollbackResults: [],
    adapterId: "builtin-codex",
    adapterVersion: "0.1.0",
    normalizedSchemaVersion: "1.0.0",
    createdAt: input.createdAt,
    ...(input.status === "succeeded" || input.status === "failed"
      ? {
          confirmedAt: input.createdAt,
          confirmedPlanHash: plan.planHash,
          startedAt: input.createdAt,
          finishedAt: input.createdAt,
        }
      : {}),
    correlationId: `correlation-${input.hashSeed}`,
    diagnostics: [],
  });
  return { plan, record };
}
