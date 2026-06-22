import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexRegistration, createAdapterRegistry } from "@ai-config-hub/adapters";
import {
  AssetSchema,
  type DeploymentPlan,
  type DeploymentRecord,
  type DeploymentRepository,
} from "@ai-config-hub/core";
import { DeploymentPreviewService } from "@ai-config-hub/deployer";
import { createNodeFileAccess } from "@ai-config-hub/scanner";
import { AbsolutePathSchema, CorrelationIdSchema, IsoDateTimeSchema } from "@ai-config-hub/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("deployment preview with real node file access", () => {
  it("creates a plan when the confined target snapshot is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-preview-"));
    temporaryDirectories.push(root);
    const targetRoot = AbsolutePathSchema.parse(root);
    const now = IsoDateTimeSchema.parse("2026-06-22T08:00:00.000Z");
    const access = await createNodeFileAccess({ allowedRoots: [targetRoot] });
    let saved: { readonly plan: DeploymentPlan; readonly record: DeploymentRecord } | undefined;
    const repository: DeploymentRepository = {
      savePlanAndRecord(input) {
        saved = structuredClone(input);
        return Promise.resolve();
      },
      getPlan: () => Promise.resolve(undefined),
      getRecord: () => Promise.resolve(undefined),
      compareAndSetRecord: () => Promise.resolve(false),
      listRecords: vi.fn(),
    };
    const service = new DeploymentPreviewService({
      registry: createAdapterRegistry([codexRegistration]),
      snapshots: access.snapshots,
      pathPolicy: access.pathPolicy,
      deploymentRepository: repository,
    });
    const source = AssetSchema.parse({
      assetId: "integration-preview-asset",
      toolId: "claude-code",
      resource: {
        kind: "rule",
        data: { name: "integration", instructions: "Use tests.", globs: [], extensions: {} },
      },
      scopeId: "integration-scope",
      canonicalSourcePath: "/virtual/source.md",
      locator: "rule:integration",
      sourceFormat: "markdown",
      contentHash: `sha256:${"a".repeat(64)}`,
      normalizedSchemaVersion: "1.0.0",
      adapterId: "integration-source-adapter",
      adapterVersion: "1.0.0",
      discoveredAt: now,
      references: [],
      diagnosticSummary: { info: 0, warning: 0, error: 0 },
    });

    const result = await service.preview({
      assets: [source],
      target: { toolId: "codex", resourceKind: "rule", targetSchemaVersion: "1.0.0" },
      targetRoot,
      backupRoot: AbsolutePathSchema.parse(join(root, "backups")),
      allowedRoots: [targetRoot],
      now,
      correlationId: CorrelationIdSchema.parse("integration-preview"),
      signal: new AbortController().signal,
    });

    expect(result.plan.operations).toEqual([
      expect.objectContaining({ kind: "create", expectedTargetHash: "absent" }),
    ]);
    expect(saved).toEqual({ plan: result.plan, record: result.record });
  });
});
