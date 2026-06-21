import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AssetSchema,
  DeploymentPlanSchema,
  DeploymentRecordSchema,
  ScopeSchema,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
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

function replacement(scanRunId: string, assets: readonly ReturnType<typeof asset>[]) {
  return {
    scanRunId: ScanRunIdSchema.parse(scanRunId),
    tools: [tool],
    scopes: [scope],
    assets,
    effectiveConfigs: [],
    diagnostics: [],
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

  it("persists settings and task progress across reopen with optimistic revisions", async () => {
    const databasePath = path();
    const first = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(first);
    const initial = await repositories.settings.getPublic();
    const updated = await repositories.settings.updatePublic({
      expectedRevision: initial.revision,
      settings: {
        readOnlyMode: false,
        customScanRoots: [AbsolutePathSchema.parse("/project")],
        fileWatching: true,
        pathDisplay: "abbreviated",
      },
    });
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
});

function initialMigrationForDrift() {
  // Loaded lazily to keep the test fixture focused on repository behavior.
  return { version: 1, name: "initial", sql: "" } as const;
}
