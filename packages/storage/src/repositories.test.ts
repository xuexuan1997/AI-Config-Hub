import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AssetSchema,
  DeploymentPlanSchema,
  DeploymentRecordSchema,
  DiagnosticSchema,
  ScopeSchema,
  operationGroupsForPlan,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AssetIdSchema,
  ProjectIdSchema,
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
    sourceFiles: [
      {
        path: `/project/${id}.md`,
        relativePath: `${id}.md`,
        role: "primary",
        mediaType: "text/markdown",
        isText: true,
        contentHash: `sha256:${"a".repeat(64)}`,
      },
    ],
    nativeIdentity: { nativeId: `rule:${id}`, displayName: id },
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
    evidence: { sourcePath: input.sourcePath, toolInstallationId: tool.installationId },
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

  it("retires only missing tool installations covered by a scoped rescan", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    const otherTool = {
      ...tool,
      installationId: ToolInstallationIdSchema.parse("codex-other-project"),
      configRoots: [AbsolutePathSchema.parse("/other-project")],
    };
    const otherToolKind = {
      ...tool,
      toolId: "cursor" as const,
      installationId: ToolInstallationIdSchema.parse("cursor-project"),
    };
    const otherScope = ScopeSchema.parse({
      ...scope,
      scopeId: "scope-other-project-installation",
      canonicalRootPath: "/other-project",
      projectId: "project-2",
      discoveryEvidence: { installationId: otherTool.installationId },
    });
    const otherAsset = AssetSchema.parse({
      ...asset("asset-other-installation", "Other project"),
      scopeId: otherScope.scopeId,
      canonicalSourcePath: "/other-project/AGENTS.md",
      sourceFiles: [
        {
          path: "/other-project/AGENTS.md",
          relativePath: "AGENTS.md",
          role: "primary",
          mediaType: "text/markdown",
          isText: true,
          contentHash: `sha256:${"a".repeat(64)}`,
        },
      ],
    });
    await repositories.index.replaceDerivedIndex({
      ...replacement("scan-installations", [asset("asset-project", "Project"), otherAsset]),
      scanCoverage: {
        roots: [AbsolutePathSchema.parse("/project"), AbsolutePathSchema.parse("/other-project")],
        toolIds: ["codex", "cursor"],
      },
      tools: [tool, otherTool, otherToolKind],
      scopes: [scope, otherScope],
    });

    await repositories.index.mergeIncrementalIndex({
      ...replacement("scan-project-removed", []),
      scanCoverage: {
        roots: [AbsolutePathSchema.parse("/project")],
        toolIds: ["codex"],
      },
      tools: [],
      scopes: [],
      changedPaths: [AbsolutePathSchema.parse("/project")],
    });

    const installationRows = opened.database
      .prepare(
        "SELECT tool_installation_id, is_detected FROM tools WHERE tool_installation_id IN (?, ?, ?) ORDER BY tool_installation_id",
      )
      .all(tool.installationId, otherTool.installationId, otherToolKind.installationId) as {
      readonly tool_installation_id: string;
      readonly is_detected: number;
    }[];
    expect(installationRows).toEqual([
      { tool_installation_id: "codex-other-project", is_detected: 1 },
      { tool_installation_id: "codex-project", is_detected: 0 },
      { tool_installation_id: "cursor-project", is_detected: 1 },
    ]);
    expect(
      (await repositories.index.listAssets({ limit: 20 })).items.map(({ assetId }) => assetId),
    ).toEqual(["asset-other-installation"]);
    opened.database.close();
  });

  it("removes a stale locator below a changed directory while preserving another project", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    const oldTargetAsset = AssetSchema.parse({
      ...asset("asset-target-old", "Old target rule"),
      canonicalSourcePath: "/project/.cursor/rules/agents.mdc",
      locator: "rule:agents",
      sourceFiles: [
        {
          path: "/project/.cursor/rules/agents.mdc",
          relativePath: ".cursor/rules/agents.mdc",
          role: "primary",
          mediaType: "text/markdown",
          isText: true,
          contentHash: `sha256:${"a".repeat(64)}`,
        },
      ],
      nativeIdentity: { nativeId: "rule:agents", displayName: "agents" },
    });
    const newTargetAsset = AssetSchema.parse({
      ...oldTargetAsset,
      assetId: "asset-target-new",
      locator: "rule:AGENTS",
      resource: {
        kind: "rule",
        data: {
          name: "AGENTS",
          instructions: "Replacement target rule",
          globs: [],
          extensions: {},
        },
      },
      nativeIdentity: { nativeId: "rule:AGENTS", displayName: "AGENTS" },
    });
    const otherScope = ScopeSchema.parse({
      ...scope,
      scopeId: "scope-other-project",
      canonicalRootPath: "/other-project",
      projectId: "project-2",
    });
    const otherProjectAsset = AssetSchema.parse({
      ...asset("asset-other-project", "Keep this rule"),
      scopeId: otherScope.scopeId,
      canonicalSourcePath: "/other-project/AGENTS.md",
      sourceFiles: [
        {
          path: "/other-project/AGENTS.md",
          relativePath: "AGENTS.md",
          role: "primary",
          mediaType: "text/markdown",
          isText: true,
          contentHash: `sha256:${"a".repeat(64)}`,
        },
      ],
    });
    await repositories.index.replaceDerivedIndex({
      ...replacement("scan-full-directory", [oldTargetAsset, otherProjectAsset]),
      scopes: [scope, otherScope],
    });

    await repositories.index.mergeIncrementalIndex({
      ...replacement("scan-incremental-directory", [newTargetAsset]),
      changedPaths: [AbsolutePathSchema.parse("/project/.cursor/rules")],
    });

    expect(
      (await repositories.index.listAssets({ limit: 20 })).items.map(({ assetId, locator }) => ({
        assetId,
        locator,
      })),
    ).toEqual([
      { assetId: "asset-other-project", locator: "rule:asset-other-project" },
      { assetId: "asset-target-new", locator: "rule:AGENTS" },
    ]);
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

  it("persists directory restore metadata for moved package disablement records", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    const source = asset("asset-a", "A");
    await repositories.index.replaceDerivedIndex(replacement("scan-full", [source]));

    await repositories.index.saveAssetDisablement({
      assetId: AssetIdSchema.parse("asset-a"),
      method: "move_file",
      disabledAt: "2026-07-05T08:00:00.000Z",
      asset: source,
      scope,
      tool,
      restore: {
        sourcePath: source.canonicalSourcePath,
        sourceDirectoryPath: AbsolutePathSchema.parse("/project/.agents/skills/release"),
        movedDirectoryPath: AbsolutePathSchema.parse("/user-data/disabled-assets/asset-a/release"),
      },
    });

    const restored = await repositories.index.getAssetDisablement(AssetIdSchema.parse("asset-a"));

    expect(restored?.restore).toMatchObject({
      sourcePath: "/project/asset-a.md",
      sourceDirectoryPath: "/project/.agents/skills/release",
      movedDirectoryPath: "/user-data/disabled-assets/asset-a/release",
    });
    opened.database.close();
  });

  it("upserts an unchanged recorded-disabled asset during an unrelated incremental merge", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    const sourceA = asset("asset-a", "A");
    await repositories.index.replaceDerivedIndex(
      replacement("scan-full-disabled-merge", [sourceA, asset("asset-b", "B")]),
    );
    const internalIdBefore = (
      opened.database.prepare("SELECT id FROM assets WHERE domain_id = ?").get(sourceA.assetId) as {
        readonly id: string;
      }
    ).id;
    await repositories.index.saveAssetDisablement({
      assetId: AssetIdSchema.parse(sourceA.assetId),
      method: "move_file",
      disabledAt: "2026-07-05T08:00:00.000Z",
      asset: sourceA,
      scope,
      tool,
      restore: { sourcePath: sourceA.canonicalSourcePath },
    });

    const merged = await repositories.index.mergeIncrementalIndex({
      ...replacement("scan-incremental-disabled-merge", [asset("asset-b", "B2")]),
      changedPaths: [AbsolutePathSchema.parse("/project/asset-b.md")],
    });
    expect(merged.revision).toMatch(/^\d+$/);

    const items = (await repositories.index.listAssets({ limit: 20 })).items;
    expect(items.map(({ assetId, status }) => ({ assetId, status }))).toEqual([
      { assetId: "asset-a", status: "disabled" },
      { assetId: "asset-b", status: "enabled" },
    ]);
    expect(
      (
        opened.database
          .prepare("SELECT id FROM assets WHERE domain_id = ?")
          .get(sourceA.assetId) as {
          readonly id: string;
        }
      ).id,
    ).toBe(internalIdBefore);
    opened.database.close();
  });

  it("replaces diagnostics for unchanged assets included in an incremental scan", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    const sourceA = asset("asset-a", "A");
    await repositories.index.replaceDerivedIndex(
      replacement(
        "scan-full-diagnostic-refresh",
        [sourceA, asset("asset-b", "B")],
        [
          diagnosticForAssetPath({
            diagnosticId: "diagnostic-old-a",
            scanRunId: "scan-full-diagnostic-refresh",
            sourcePath: sourceA.canonicalSourcePath,
          }),
        ],
      ),
    );

    await repositories.index.mergeIncrementalIndex({
      ...replacement(
        "scan-incremental-diagnostic-refresh",
        [sourceA, asset("asset-b", "B2")],
        [
          diagnosticForAssetPath({
            diagnosticId: "diagnostic-new-a",
            scanRunId: "scan-incremental-diagnostic-refresh",
            sourcePath: sourceA.canonicalSourcePath,
          }),
        ],
      ),
      changedPaths: [AbsolutePathSchema.parse("/project/asset-b.md")],
    });

    expect(
      (await repositories.index.listDiagnostics({ limit: 20 })).items.map(
        ({ diagnosticId }) => diagnosticId,
      ),
    ).toEqual(["diagnostic-new-a"]);
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

  it("matches incremental deletion and diagnostics through support source files", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    const packageAsset = AssetSchema.parse({
      ...asset("asset-a", "A"),
      canonicalSourcePath: "/project/.agents/skills/release/SKILL.md",
      locator: "skill:.agents/skills/release",
      resource: {
        kind: "skill",
        data: {
          name: "release",
          description: "Release safely",
          instructions: "Use the checklist.",
          references: [],
          extensions: {},
        },
      },
      sourceFiles: [
        {
          path: "/project/.agents/skills/release/SKILL.md",
          relativePath: "SKILL.md",
          role: "primary",
          mediaType: "text/markdown",
          isText: true,
          contentHash: `sha256:${"a".repeat(64)}`,
        },
        {
          path: "/project/.agents/skills/release/references/checklist.md",
          relativePath: "references/checklist.md",
          role: "support",
          mediaType: "text/markdown",
          isText: true,
          contentHash: `sha256:${"b".repeat(64)}`,
        },
      ],
      nativeIdentity: {
        nativeId: "skill:.agents/skills/release",
        displayName: "release",
        directoryName: "release",
        invocationName: "release",
      },
    });
    await repositories.index.replaceDerivedIndex(
      replacement(
        "scan-full",
        [packageAsset],
        [
          diagnosticForAssetPath({
            diagnosticId: "diagnostic-support",
            scanRunId: "scan-full",
            sourcePath: "/project/.agents/skills/release/references/checklist.md",
          }),
        ],
      ),
    );

    expect(
      (
        await repositories.index.listDiagnostics({
          assetId: AssetIdSchema.parse(packageAsset.assetId),
          limit: 20,
        })
      ).items.map(({ diagnosticId }) => diagnosticId),
    ).toEqual(["diagnostic-support"]);

    await repositories.index.mergeIncrementalIndex({
      ...replacement("scan-incremental-delete", []),
      changedPaths: [
        AbsolutePathSchema.parse("/project/.agents/skills/release/references/checklist.md"),
      ],
    });

    expect((await repositories.index.listAssets({ limit: 20 })).items).toEqual([]);
    expect((await repositories.index.listDiagnostics({ limit: 20 })).items).toEqual([]);
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

  it("clears scan cache and public settings while retaining protected recovery data", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    await repositories.index.replaceDerivedIndex(
      replacement(
        "scan-full",
        [asset("asset-a", "A")],
        [
          diagnosticForAssetPath({
            diagnosticId: "diagnostic-a",
            scanRunId: "scan-full",
            sourcePath: "/project/asset-a.md",
          }),
        ],
      ),
    );
    await repositories.settings.updatePublic({
      expectedRevision: "0",
      settings: {
        readOnlyMode: false,
        customScanRoots: [AbsolutePathSchema.parse("/project")],
        theme: "dark",
        language: "zh-CN",
        scanHints: true,
        fileWatching: true,
        pathDisplay: "full",
      },
    });
    opened.database
      .prepare(
        `INSERT INTO database_backups(
          id, domain_id, reason, state, backup_path_normalized, manifest_version, manifest_hash,
          database_file_hash, database_schema_version, source_database_id, size_bytes, created_at,
          verified_at
        ) VALUES('database-backup-row', 'database-backup-1', 'migration', 'verified',
          '/backups/before-v1.sqlite', 1, 'sha256:${"b".repeat(64)}', 'sha256:${"c".repeat(64)}',
          1, 'source-db', 10, 1, 1)`,
      )
      .run();
    opened.database
      .prepare(
        `INSERT INTO asset_disablement_records(
          asset_domain_id, method, record_json, created_at, updated_at
        ) VALUES('asset-a', 'hub_ignore', '{}', 1, 1)`,
      )
      .run();
    const databaseBackupsBefore = rowCount(opened.database, "database_backups");
    const revisionBefore = userVersion(opened.database);

    const result = await repositories.maintenance.clearLocalData({
      categories: ["scan_cache", "settings"],
      now: "2026-07-04T08:00:00.000Z",
    });

    expect(result.counts).toMatchObject({
      scanRuns: 1,
      projects: 1,
      scopes: 1,
      assets: 1,
      diagnostics: 1,
      settings: 1,
    });
    expect(result.retained).toEqual({
      databaseBackups: true,
      deploymentBackups: true,
      disabledAssets: true,
    });
    expect(rowCount(opened.database, "scan_runs")).toBe(0);
    expect(rowCount(opened.database, "projects")).toBe(0);
    expect(rowCount(opened.database, "scopes")).toBe(0);
    expect(rowCount(opened.database, "assets")).toBe(0);
    expect(rowCount(opened.database, "diagnostics")).toBe(0);
    expect(rowCount(opened.database, "settings")).toBe(0);
    expect(rowCount(opened.database, "tools")).toBeGreaterThan(0);
    expect(rowCount(opened.database, "database_backups")).toBe(databaseBackupsBefore);
    expect(rowCount(opened.database, "schema_migrations")).toBeGreaterThan(0);
    expect(rowCount(opened.database, "asset_disablement_records")).toBe(1);
    expect(userVersion(opened.database)).toBeGreaterThan(revisionBefore);
    expect(await repositories.settings.getPublic()).toMatchObject({
      revision: "0",
      settings: { theme: "system", language: "system" },
    });
    opened.database.close();
  });

  it("does not clear deployment history while backup or recovery records still need it", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    const deployment = deploymentFixture({
      deploymentRecordId: "deployment-protected",
      deploymentPlanId: "plan-protected",
      createdAt: "2026-06-21T08:00:00.000Z",
      hashSeed: "d",
    });
    await repositories.deployments.savePlanAndRecord(deployment);
    const deploymentRow = opened.database
      .prepare("SELECT id FROM deployments WHERE domain_id = 'deployment-protected'")
      .get() as { readonly id: string };
    opened.database
      .prepare(
        `INSERT INTO recovery_locks(
          canonical_target_key, deployment_id, reason, created_at, recovery_fence_token
        ) VALUES('/project/AGENTS.md', ?, 'failed_deployment', 1, 1)`,
      )
      .run(deploymentRow.id);
    const recoveryLockMessageMatcher: unknown = expect.stringContaining(
      "Resolve recovery or rollback state",
    );
    await expect(
      repositories.maintenance.clearLocalData({
        categories: ["deployment_history"],
        now: "2026-07-04T08:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: recoveryLockMessageMatcher,
    });
    expect(rowCount(opened.database, "deployments")).toBe(1);
    expect(rowCount(opened.database, "recovery_locks")).toBe(1);
    opened.database.close();
  });

  it("clears deployment history when recovery locks are already resolved", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    const deployment = deploymentFixture({
      deploymentRecordId: "deployment-resolved",
      deploymentPlanId: "plan-resolved",
      createdAt: "2026-06-21T08:00:00.000Z",
      hashSeed: "e",
    });
    await repositories.deployments.savePlanAndRecord(deployment);
    const deploymentRow = opened.database
      .prepare("SELECT id FROM deployments WHERE domain_id = 'deployment-resolved'")
      .get() as { readonly id: string };
    opened.database
      .prepare(
        `INSERT INTO recovery_locks(
          canonical_target_key, deployment_id, reason, created_at, resolved_at,
          resolution_evidence_json, recovery_fence_token
        ) VALUES('/project/resolved.md', ?, 'failed_deployment', 1, 2, '{}', 1)`,
      )
      .run(deploymentRow.id);

    const result = await repositories.maintenance.clearLocalData({
      categories: ["deployment_history"],
      now: "2026-07-04T08:00:00.000Z",
    });

    expect(result.counts.deploymentRecords).toBe(1);
    expect(rowCount(opened.database, "deployments")).toBe(0);
    expect(rowCount(opened.database, "recovery_locks")).toBe(0);
    opened.database.close();
  });

  it("rejects maintenance cleanup preflight and mutation in read-only recovery mode", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    opened.database.close();

    const recovery = await openDatabase({
      path: databasePath,
      appVersion: "0.1.0",
      migrations: [{ ...initialMigrationForDrift(), checksum: `sha256:${"f".repeat(64)}` }],
    });
    const repositories = createStorageRepositories(recovery);

    await expect(
      repositories.maintenance.assertCanClearLocalData({
        categories: ["deployment_history"],
      }),
    ).rejects.toMatchObject({ code: "READ_ONLY_RECOVERY" });
    await expect(
      repositories.maintenance.clearLocalData({
        categories: ["deployment_history"],
        now: "2026-07-04T08:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "READ_ONLY_RECOVERY" });
    recovery.database.close();
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
    const storedPlan = await repositories.deployments.getPlan(plan.deploymentPlanId);
    expect(storedPlan).toEqual(plan);
    expect(storedPlan).not.toHaveProperty("operationGroups");
    expect(storedPlan).not.toHaveProperty("issueSummary");
    expect(storedPlan === undefined ? [] : operationGroupsForPlan(storedPlan)).toEqual([
      expect.objectContaining({
        targetRootPath: "/project/AGENTS.md",
        targetPaths: ["/project/AGENTS.md"],
        operationCount: 1,
      }),
    ]);
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

  it("continues filtered deployment history after the cursor record changes status", async () => {
    const databasePath = path();
    const opened = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const repositories = createStorageRepositories(opened);
    const oldest = deploymentFixture({
      deploymentRecordId: "deployment-oldest",
      deploymentPlanId: "plan-oldest",
      createdAt: "2026-06-21T08:00:00.000Z",
      hashSeed: "a",
    });
    const middle = deploymentFixture({
      deploymentRecordId: "deployment-middle",
      deploymentPlanId: "plan-middle",
      createdAt: "2026-06-21T09:00:00.000Z",
      hashSeed: "b",
    });
    const newest = deploymentFixture({
      deploymentRecordId: "deployment-newest",
      deploymentPlanId: "plan-newest",
      createdAt: "2026-06-21T10:00:00.000Z",
      hashSeed: "c",
    });
    await repositories.deployments.savePlanAndRecord(oldest);
    await repositories.deployments.savePlanAndRecord(middle);
    await repositories.deployments.savePlanAndRecord(newest);

    const firstPage = await repositories.deployments.listRecords({
      statuses: ["planned"],
      limit: 1,
    });
    expect(firstPage.items.map(({ deploymentRecordId }) => deploymentRecordId)).toEqual([
      "deployment-newest",
    ]);
    const cursor = firstPage.nextCursor;
    if (cursor === undefined) throw new Error("Expected a filtered history cursor");

    const transitioned = DeploymentRecordSchema.parse({
      ...newest.record,
      status: "confirmed",
      confirmedPlanHash: newest.plan.planHash,
      confirmedAt: newest.record.createdAt,
    });
    await expect(
      repositories.deployments.compareAndSetRecord({
        expectedStatus: "planned",
        record: transitioned,
      }),
    ).resolves.toBe(true);

    await expect(
      repositories.deployments.listRecords({
        statuses: ["planned"],
        cursor,
        snapshotRevision: firstPage.snapshotRevision,
        limit: 10,
      }),
    ).rejects.toMatchObject({
      code: "STALE_INDEX",
      safeContext: { requestedRevision: firstPage.snapshotRevision },
    });

    const secondPage = await repositories.deployments.listRecords({
      statuses: ["planned"],
      cursor,
      limit: 10,
    });
    expect(secondPage.items.map(({ deploymentRecordId }) => deploymentRecordId)).toEqual([
      "deployment-middle",
      "deployment-oldest",
    ]);
    expect(Number(secondPage.snapshotRevision)).toBeGreaterThan(Number(firstPage.snapshotRevision));
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
      taskId: "task:deployment-history",
      projectId: "project:history-a",
    });
    const rollback = deploymentFixture({
      deploymentRecordId: "rollback-succeeded",
      deploymentPlanId: "plan-rollback",
      createdAt: "2026-06-21T09:00:00.000Z",
      hashSeed: "b",
      rollbackOfRecordId: "deployment-succeeded",
      status: "succeeded",
      taskId: "task:rollback-history",
      projectId: "project:history-a",
    });
    const plannedRollback = deploymentFixture({
      deploymentRecordId: "rollback-planned",
      deploymentPlanId: "plan-failed",
      createdAt: "2026-06-21T10:00:00.000Z",
      hashSeed: "c",
      rollbackOfRecordId: "deployment-succeeded",
      taskId: "task:rollback-planned",
      projectId: "project:history-b",
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
    await expect(
      repositories.deployments.listRecords({
        taskId: TaskIdSchema.parse("task:rollback-history"),
        projectId: ProjectIdSchema.parse("project:history-a"),
        limit: 10,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          deploymentRecordId: "rollback-succeeded",
          taskId: "task:rollback-history",
          projectId: "project:history-a",
        }),
      ],
    });
    await expect(
      repositories.deployments.listRecords({
        taskId: TaskIdSchema.parse("task:rollback-history"),
        projectId: ProjectIdSchema.parse("project:history-b"),
        limit: 10,
      }),
    ).resolves.toMatchObject({ items: [] });
    opened.database.close();
  });
});

function initialMigrationForDrift() {
  // Loaded lazily to keep the test fixture focused on repository behavior.
  return { version: 1, name: "initial", sql: "" } as const;
}

function rowCount(database: { prepare(sql: string): { get(): unknown } }, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    readonly count: number;
  };
  return row.count;
}

function userVersion(database: { prepare(sql: string): { get(): unknown } }): number {
  return (database.prepare("PRAGMA user_version").get() as { readonly user_version: number })
    .user_version;
}

function deploymentFixture(input: {
  readonly deploymentRecordId: string;
  readonly deploymentPlanId: string;
  readonly createdAt: string;
  readonly hashSeed: string;
  readonly rollbackOfRecordId?: string;
  readonly status?: "planned" | "succeeded" | "failed";
  readonly taskId?: string;
  readonly projectId?: string;
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
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
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
