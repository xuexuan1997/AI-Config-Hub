import { createHash } from "node:crypto";

import {
  DeploymentPlanSchema,
  DeploymentRecordSchema,
  operationGroupsForPlan,
  type DeploymentFilePort,
  type DeploymentPlan,
  type DeploymentRecord,
  type DeploymentRepository,
  type FileSnapshot,
  type FileSnapshotPort,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  ContentHashSchema,
  CorrelationIdSchema,
  DeploymentPlanIdSchema,
  DeploymentRecordIdSchema,
  IsoDateTimeSchema,
  SemVerSchema,
  type AbsolutePath,
  type ContentHash,
} from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { PathLockManager } from "./path-locks.js";
import { DeploymentRollbackService } from "./rollback-service.js";

const NOW = IsoDateTimeSchema.parse("2026-06-22T08:00:00.000Z");
const LATER = IsoDateTimeSchema.parse("2026-06-22T09:00:00.000Z");
const ORIGINAL_PLAN_ID = DeploymentPlanIdSchema.parse("deployment-plan:original");
const ORIGINAL_RECORD_ID = DeploymentRecordIdSchema.parse("deployment-record:original");

function hash(text: string): ContentHash {
  return ContentHashSchema.parse(`sha256:${createHash("sha256").update(text).digest("hex")}`);
}

function plan(): DeploymentPlan {
  const operations = [
    {
      kind: "create" as const,
      targetPath: AbsolutePathSchema.parse("/target/created.md"),
      nextText: "created",
      expectedTargetHash: "absent" as const,
    },
    {
      kind: "replace" as const,
      targetPath: AbsolutePathSchema.parse("/target/replaced.md"),
      nextText: "new",
      expectedTargetHash: hash("old"),
    },
    {
      kind: "delete" as const,
      targetPath: AbsolutePathSchema.parse("/target/deleted.md"),
      expectedTargetHash: hash("deleted"),
    },
  ];
  return DeploymentPlanSchema.parse({
    deploymentPlanId: ORIGINAL_PLAN_ID,
    conversionResultIds: ["conversion:original"],
    operations,
    diffs: [],
    expectedSourceHashes: {},
    expectedTargetHashes: {
      "/target/created.md": "absent",
      "/target/replaced.md": hash("old"),
      "/target/deleted.md": hash("deleted"),
    },
    backupPolicy: { mode: "required", backupRoot: "/backups" },
    verificationStrategy: { kind: "adapter", description: "verify" },
    requiredConfirmations: [],
    warnings: [],
    planHash: hash("original-plan"),
    adapterId: "fixture-adapter",
    adapterVersion: SemVerSchema.parse("1.0.0"),
    createdAt: NOW,
  });
}

function succeededRecord(originalPlan = plan()): DeploymentRecord {
  return DeploymentRecordSchema.parse({
    deploymentRecordId: ORIGINAL_RECORD_ID,
    deploymentPlanId: originalPlan.deploymentPlanId,
    confirmedPlanHash: originalPlan.planHash,
    status: "succeeded",
    operations: originalPlan.operations,
    backupLocations: {
      "/target/created.md": "previously-absent",
      "/target/replaced.md": "/backups/replaced.md",
      "/target/deleted.md": "/backups/deleted.md",
    },
    resultingHashes: {
      "/target/created.md": hash("created"),
      "/target/replaced.md": hash("new"),
    },
    verificationResult: {
      status: "passed",
      verifiedHashes: {
        "/target/created.md": hash("created"),
        "/target/replaced.md": hash("new"),
      },
      diagnostics: [],
    },
    rollbackResults: [],
    adapterId: "fixture-adapter",
    adapterVersion: SemVerSchema.parse("1.0.0"),
    normalizedSchemaVersion: SemVerSchema.parse("1.0.0"),
    createdAt: NOW,
    confirmedAt: NOW,
    startedAt: NOW,
    finishedAt: NOW,
    correlationId: CorrelationIdSchema.parse("correlation:rollback"),
    diagnostics: [],
  });
}

class MemoryRepository implements DeploymentRepository {
  readonly records = new Map<string, DeploymentRecord>();
  readonly plans = new Map<string, DeploymentPlan>();
  readonly saved: DeploymentRecord[] = [];

  constructor(originalPlan = plan(), originalRecord = succeededRecord(originalPlan)) {
    this.plans.set(originalPlan.deploymentPlanId, originalPlan);
    this.records.set(originalRecord.deploymentRecordId, originalRecord);
  }

  savePlanAndRecord(input: { readonly plan: DeploymentPlan; readonly record: DeploymentRecord }) {
    this.plans.set(input.plan.deploymentPlanId, structuredClone(input.plan));
    this.records.set(input.record.deploymentRecordId, structuredClone(input.record));
    this.saved.push(structuredClone(input.record));
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

class MemoryFiles implements FileSnapshotPort, DeploymentFilePort {
  readonly writes: string[] = [];
  failReplaceFor?: AbsolutePath;
  constructor(readonly files = new Map<AbsolutePath, string>()) {}
  snapshot(input: { readonly path: AbsolutePath }): Promise<FileSnapshot | undefined> {
    const text = this.files.get(input.path);
    if (text === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      canonicalPath: input.path,
      text,
      contentHash: hash(text),
      modifiedAt: NOW,
      size: Buffer.byteLength(text),
    });
  }
  createBackup(): never {
    throw new Error("rollback must not create new backups");
  }
  atomicReplace(input: {
    readonly target: AbsolutePath;
    readonly text: string;
    readonly expectedHash: ContentHash | "absent";
  }) {
    if (input.target === this.failReplaceFor) throw new Error("rollback replace failed");
    const current = this.files.get(input.target);
    const currentHash = current === undefined ? "absent" : hash(current);
    if (currentHash !== input.expectedHash) throw new Error("stale target");
    this.files.set(input.target, input.text);
    this.writes.push(`replace:${input.target}:${input.text}`);
    return Promise.resolve({ resultingHash: hash(input.text) });
  }
  copy(): never {
    throw new Error("rollback must not copy sources");
  }
  createSymlink(): never {
    throw new Error("rollback must not create symlinks");
  }
  remove(input: { readonly target: AbsolutePath; readonly expectedHash: ContentHash }) {
    const current = this.files.get(input.target);
    if (current === undefined || hash(current) !== input.expectedHash)
      throw new Error("stale target");
    this.files.delete(input.target);
    this.writes.push(`remove:${input.target}`);
    return Promise.resolve();
  }
}

function fixture() {
  const repository = new MemoryRepository();
  const files = new MemoryFiles(
    new Map([
      [AbsolutePathSchema.parse("/target/created.md"), "created"],
      [AbsolutePathSchema.parse("/target/replaced.md"), "new"],
      [AbsolutePathSchema.parse("/backups/replaced.md"), "old"],
      [AbsolutePathSchema.parse("/backups/deleted.md"), "deleted"],
    ]),
  );
  const service = new DeploymentRollbackService({
    deploymentRepository: repository,
    snapshots: files,
    deploymentFiles: files,
    locks: new PathLockManager(),
  });
  return { service, repository, files };
}

describe("DeploymentRollbackService", () => {
  it("previews immutable inverse create, replace, and delete operations", async () => {
    const { service } = fixture();

    const rollbackPlan = await service.preview(ORIGINAL_RECORD_ID);

    expect(rollbackPlan.operations).toEqual([
      {
        kind: "delete",
        targetPath: "/target/created.md",
        expectedTargetHash: hash("created"),
        deploymentType: "generated_file",
      },
      {
        kind: "replace",
        targetPath: "/target/replaced.md",
        nextText: "old",
        expectedTargetHash: hash("new"),
        deploymentType: "generated_file",
      },
      {
        kind: "create",
        targetPath: "/target/deleted.md",
        nextText: "deleted",
        expectedTargetHash: "absent",
        deploymentType: "generated_file",
      },
    ]);
    const rollbackGroups = operationGroupsForPlan(rollbackPlan);
    expect(rollbackGroups).toEqual([
      expect.objectContaining({
        targetRootPath: "/target/created.md",
        targetPaths: ["/target/created.md"],
        operation: "delete",
        operationCount: 1,
      }),
      expect.objectContaining({
        targetRootPath: "/target/replaced.md",
        targetPaths: ["/target/replaced.md"],
        operation: "replace",
        operationCount: 1,
      }),
      expect.objectContaining({
        targetRootPath: "/target/deleted.md",
        targetPaths: ["/target/deleted.md"],
        operation: "create",
        operationCount: 1,
      }),
    ]);
    expect(rollbackGroups.every((group) => !("targetRootRelativePath" in group))).toBe(true);
    expect(rollbackPlan.planHash).toMatch(/^sha256:/);
  });

  it("rejects current target drift before rollback", async () => {
    const { service, files } = fixture();
    files.files.set(AbsolutePathSchema.parse("/target/replaced.md"), "edited");

    await expect(service.preview(ORIGINAL_RECORD_ID)).rejects.toMatchObject({
      code: "STALE_INDEX",
    });
  });

  it("rejects missing or corrupt backups", async () => {
    const { service, files } = fixture();
    files.files.set(AbsolutePathSchema.parse("/backups/replaced.md"), "corrupt");

    await expect(service.preview(ORIGINAL_RECORD_ID)).rejects.toMatchObject({
      code: "BACKUP_MISSING",
    });
  });

  it("executes verified rollback, links the rollback record, and preserves backup files", async () => {
    const { service, repository, files } = fixture();
    const rollbackPlan = await service.preview(ORIGINAL_RECORD_ID);

    const rollbackRecord = await service.execute({
      deploymentRecordId: ORIGINAL_RECORD_ID,
      rollbackPlanHash: rollbackPlan.planHash,
      now: LATER,
    });

    expect(rollbackRecord.status).toBe("succeeded");
    expect(rollbackRecord.rollbackOfRecordId).toBe(ORIGINAL_RECORD_ID);
    expect(repository.saved[0]?.rollbackOfRecordId).toBe(ORIGINAL_RECORD_ID);
    expect(files.files.has(AbsolutePathSchema.parse("/target/created.md"))).toBe(false);
    expect(files.files.get(AbsolutePathSchema.parse("/target/replaced.md"))).toBe("old");
    expect(files.files.get(AbsolutePathSchema.parse("/target/deleted.md"))).toBe("deleted");
    expect(files.files.get(AbsolutePathSchema.parse("/backups/replaced.md"))).toBe("old");
    expect(files.files.get(AbsolutePathSchema.parse("/backups/deleted.md"))).toBe("deleted");
    expect(files.writes).toEqual([
      "remove:/target/created.md",
      "replace:/target/replaced.md:old",
      "replace:/target/deleted.md:deleted",
    ]);
  });

  it("marks the rollback record failed when execution fails after a prior mutation", async () => {
    const { service, repository, files } = fixture();
    const rollbackPlan = await service.preview(ORIGINAL_RECORD_ID);
    files.failReplaceFor = AbsolutePathSchema.parse("/target/replaced.md");

    const rollbackRecord = await service.execute({
      deploymentRecordId: ORIGINAL_RECORD_ID,
      rollbackPlanHash: rollbackPlan.planHash,
      now: LATER,
    });

    expect(rollbackRecord.status).toBe("failed");
    expect(rollbackRecord.finishedAt).toBe(LATER);
    expect(rollbackRecord.diagnostics).toEqual([
      expect.objectContaining({ code: "ROLLBACK_FAILED" }),
    ]);
    expect(files.files.has(AbsolutePathSchema.parse("/target/created.md"))).toBe(false);
    expect(files.files.get(AbsolutePathSchema.parse("/target/replaced.md"))).toBe("new");
    expect(repository.records.get(rollbackRecord.deploymentRecordId)?.status).toBe("failed");
  });
});
