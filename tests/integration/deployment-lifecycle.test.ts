import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  codexRegistration,
  createAdapterRegistry,
  type AdapterRegistry,
} from "@ai-config-hub/adapters";
import {
  AssetSchema,
  type AdapterReadApi,
  type DeploymentFilePort,
  type DeploymentPlan,
  type DeploymentRecord,
  type DeploymentRepository,
  type FileSnapshotPort,
  type ToolAdapter,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  ContentHashSchema,
  CorrelationIdSchema,
  IsoDateTimeSchema,
  type AbsolutePath,
  type ContentHash,
} from "@ai-config-hub/shared";
import {
  DeploymentExecutionService,
  DeploymentPreviewService,
  DeploymentRollbackService,
  PathLockManager,
} from "@ai-config-hub/deployer";
import { createNodeFileAccess } from "@ai-config-hub/scanner";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function hash(text: string): ContentHash {
  return ContentHashSchema.parse(`sha256:${createHash("sha256").update(text).digest("hex")}`);
}

class MemoryDeploymentRepository implements DeploymentRepository {
  readonly plans = new Map<string, DeploymentPlan>();
  readonly records = new Map<string, DeploymentRecord>();
  savePlanAndRecord(input: { readonly plan: DeploymentPlan; readonly record: DeploymentRecord }) {
    this.plans.set(input.plan.deploymentPlanId, structuredClone(input.plan));
    this.records.set(input.record.deploymentRecordId, structuredClone(input.record));
    return Promise.resolve();
  }
  getPlan(id: DeploymentPlan["deploymentPlanId"]) {
    return Promise.resolve(this.plans.get(id));
  }
  getRecord(id: DeploymentRecord["deploymentRecordId"]) {
    return Promise.resolve(this.records.get(id));
  }
  compareAndSetRecord(input: {
    readonly expectedStatus: DeploymentRecord["status"];
    readonly record: DeploymentRecord;
  }) {
    const current = this.records.get(input.record.deploymentRecordId);
    if (current?.status !== input.expectedStatus) return Promise.resolve(false);
    this.records.set(input.record.deploymentRecordId, structuredClone(input.record));
    return Promise.resolve(true);
  }
  listRecords(): never {
    throw new Error("not needed");
  }
}

class RealTextFiles implements DeploymentFilePort {
  constructor(private readonly snapshots: FileSnapshotPort) {}
  async createBackup(input: {
    readonly source: AbsolutePath;
    readonly destination: AbsolutePath;
    readonly expectedHash: ContentHash;
  }) {
    const source = await this.snapshots.snapshot({
      path: input.source,
      allowedRoots: [input.source],
    });
    if (source?.contentHash !== input.expectedHash) throw new Error("stale backup source");
    await mkdir(dirname(input.destination), { recursive: true });
    await copyFile(input.source, input.destination);
    return { backupPath: input.destination, backupHash: source.contentHash };
  }
  async atomicReplace(input: {
    readonly target: AbsolutePath;
    readonly text: string;
    readonly expectedHash: ContentHash | "absent";
  }) {
    const current = await this.snapshots.snapshot({
      path: input.target,
      allowedRoots: [input.target],
    });
    const currentHash = current?.contentHash ?? "absent";
    if (currentHash !== input.expectedHash) throw new Error("stale replace target");
    await mkdir(dirname(input.target), { recursive: true });
    await writeFile(input.target, input.text, "utf8");
    return { resultingHash: hash(input.text) };
  }
  async copy(input: {
    readonly source: AbsolutePath;
    readonly target: AbsolutePath;
    readonly expectedSourceHash: ContentHash;
    readonly expectedHash: ContentHash | "absent";
  }) {
    const source = await this.snapshots.snapshot({
      path: input.source,
      allowedRoots: [input.source],
    });
    if (source?.contentHash !== input.expectedSourceHash) throw new Error("stale copy source");
    const current = await this.snapshots.snapshot({
      path: input.target,
      allowedRoots: [input.target],
    });
    if ((current?.contentHash ?? "absent") !== input.expectedHash)
      throw new Error("stale copy target");
    await mkdir(dirname(input.target), { recursive: true });
    await copyFile(input.source, input.target);
    return { resultingHash: source.contentHash };
  }
  async createSymlink(input: {
    readonly source: AbsolutePath;
    readonly target: AbsolutePath;
    readonly expectedSourceHash: ContentHash;
    readonly expectedHash: ContentHash | "absent";
  }) {
    const source = await this.snapshots.snapshot({
      path: input.source,
      allowedRoots: [input.source],
    });
    if (source?.contentHash !== input.expectedSourceHash) throw new Error("stale symlink source");
    const current = await this.snapshots.snapshot({
      path: input.target,
      allowedRoots: [input.target],
    });
    if ((current?.contentHash ?? "absent") !== input.expectedHash)
      throw new Error("stale symlink target");
    await mkdir(dirname(input.target), { recursive: true });
    await symlink(input.source, input.target);
    return { resultingHash: source.contentHash };
  }
  async remove(input: { readonly target: AbsolutePath; readonly expectedHash: ContentHash }) {
    const current = await this.snapshots.snapshot({
      path: input.target,
      allowedRoots: [input.target],
    });
    if (current?.contentHash !== input.expectedHash) throw new Error("stale remove target");
    await unlink(input.target);
  }
}

function verifyingRegistry(): AdapterRegistry {
  const base = createAdapterRegistry([codexRegistration]);
  return {
    ...base,
    create(toolId, logger) {
      const adapter = base.create(toolId, logger);
      const verify: ToolAdapter["verify"] = ({ deployment }) =>
        Promise.resolve({
          status: "passed",
          verifiedHashes: deployment.resultingHashes,
          diagnostics: [],
        });
      return {
        adapterId: adapter.adapterId,
        adapterVersion: adapter.adapterVersion,
        toolId: adapter.toolId,
        capabilities: adapter.capabilities,
        detect: adapter.detect.bind(adapter),
        discover: adapter.discover.bind(adapter),
        parse: adapter.parse.bind(adapter),
        resolveEffective: adapter.resolveEffective.bind(adapter),
        diagnose: adapter.diagnose.bind(adapter),
        convert: adapter.convert.bind(adapter),
        planDeployment: adapter.planDeployment.bind(adapter),
        verify,
      };
    },
  };
}

function readApi(access: Awaited<ReturnType<typeof createNodeFileAccess>>): AdapterReadApi {
  return access.read;
}

describe("deployment lifecycle", () => {
  it("previews, deploys, verifies, rolls back, and restores original bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-lifecycle-"));
    temporaryDirectories.push(root);
    const targetRoot = AbsolutePathSchema.parse(root);
    const backupRoot = AbsolutePathSchema.parse(join(root, "backups"));
    await mkdir(backupRoot, { recursive: true });
    const now = IsoDateTimeSchema.parse("2026-06-22T08:00:00.000Z");
    const repository = new MemoryDeploymentRepository();
    const access = await createNodeFileAccess({ allowedRoots: [targetRoot, backupRoot] });
    const deploymentFiles = new RealTextFiles(access.snapshots);
    const registry = verifyingRegistry();
    const locks = new PathLockManager();
    const source = AssetSchema.parse({
      assetId: "asset-lifecycle",
      toolId: "claude-code",
      resource: {
        kind: "rule",
        data: {
          name: "lifecycle",
          instructions: "Use lifecycle tests.",
          globs: [],
          extensions: {},
        },
      },
      scopeId: "scope-lifecycle",
      canonicalSourcePath: "/virtual/lifecycle.md",
      locator: "rule:lifecycle",
      sourceFormat: "markdown",
      contentHash: hash("source-lifecycle"),
      normalizedSchemaVersion: "1.0.0",
      adapterId: "source-adapter",
      adapterVersion: "1.0.0",
      discoveredAt: now,
      references: [],
      diagnosticSummary: { info: 0, warning: 0, error: 0 },
    });
    const targetPath = join(root, "AGENTS.md");
    await writeFile(targetPath, "original bytes", "utf8");

    const preview = await new DeploymentPreviewService({
      registry,
      snapshots: access.snapshots,
      pathPolicy: access.pathPolicy,
      deploymentRepository: repository,
    }).preview({
      assets: [source],
      target: { toolId: "codex", resourceKind: "rule", targetSchemaVersion: "1.0.0" },
      targetRoot,
      backupRoot,
      allowedRoots: [targetRoot],
      now,
      correlationId: CorrelationIdSchema.parse("correlation:lifecycle"),
      signal: new AbortController().signal,
    });

    const deployed = await new DeploymentExecutionService({
      deploymentRepository: repository,
      sourceHashes: { currentHash: () => Promise.resolve(source.contentHash) },
      snapshots: access.snapshots,
      deploymentFiles,
      locks,
      registry,
      read: readApi(access),
    }).execute({
      deploymentRecordId: preview.record.deploymentRecordId,
      confirmedPlanHash: preview.plan.planHash,
      confirmations: ["overwrite"],
      allowedRoots: [targetRoot],
      now: IsoDateTimeSchema.parse("2026-06-22T08:01:00.000Z"),
    });

    expect(deployed.status).toBe("succeeded");
    expect(await readFile(targetPath, "utf8")).toContain("Use lifecycle tests.");

    const rollbackService = new DeploymentRollbackService({
      deploymentRepository: repository,
      snapshots: access.snapshots,
      deploymentFiles,
      locks,
    });
    const rollbackPlan = await rollbackService.preview(deployed.deploymentRecordId);
    const rolledBack = await rollbackService.execute({
      deploymentRecordId: deployed.deploymentRecordId,
      rollbackPlanHash: rollbackPlan.planHash,
      now: IsoDateTimeSchema.parse("2026-06-22T08:02:00.000Z"),
    });

    expect(rolledBack.status).toBe("succeeded");
    expect(rolledBack.rollbackOfRecordId).toBe(deployed.deploymentRecordId);
    expect(await readFile(targetPath, "utf8")).toBe("original bytes");
  });
});
