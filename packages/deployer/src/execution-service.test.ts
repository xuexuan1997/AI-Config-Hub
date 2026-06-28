import { createHash } from "node:crypto";

import type { AdapterRegistry } from "@ai-config-hub/adapters";
import {
  DeploymentPlanSchema,
  DeploymentRecordSchema,
  type AdapterReadApi,
  type DeploymentFilePort,
  type DeploymentPlan,
  type DeploymentRecord,
  type DeploymentRepository,
  type FileSnapshot,
  type FileSnapshotPort,
  type ToolAdapter,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AdapterIdSchema,
  ContentHashSchema,
  CorrelationIdSchema,
  DeploymentPlanIdSchema,
  DeploymentRecordIdSchema,
  IsoDateTimeSchema,
  SemVerSchema,
  type AbsolutePath,
  type ContentHash,
} from "@ai-config-hub/shared";
import { describe, expect, it, vi } from "vitest";

import { DeploymentExecutionService, type DeploymentSourceHashPort } from "./execution-service.js";
import { PathLockManager } from "./path-locks.js";

const NOW = IsoDateTimeSchema.parse("2026-06-22T08:00:00.000Z");
const LATER = IsoDateTimeSchema.parse("2026-06-22T08:05:00.000Z");
const ROOT = AbsolutePathSchema.parse("/target");
const BACKUP_ROOT = AbsolutePathSchema.parse("/backups");
const PLAN_ID = DeploymentPlanIdSchema.parse("deployment-plan:test");
const RECORD_ID = DeploymentRecordIdSchema.parse("deployment-record:test");
const PLAN_HASH = hash("plan");

function hash(text: string): ContentHash {
  return ContentHashSchema.parse(`sha256:${createHash("sha256").update(text).digest("hex")}`);
}

function basePlan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return DeploymentPlanSchema.parse({
    deploymentPlanId: PLAN_ID,
    conversionResultIds: ["conversion:one"],
    operations: [
      {
        kind: "replace",
        targetPath: AbsolutePathSchema.parse("/target/a.md"),
        nextText: "next a",
        expectedTargetHash: hash("old a"),
      },
    ],
    diffs: [],
    expectedSourceHashes: { source: hash("source") },
    expectedTargetHashes: { "/target/a.md": hash("old a") },
    backupPolicy: { mode: "required", backupRoot: BACKUP_ROOT },
    verificationStrategy: { kind: "adapter", description: "verify" },
    requiredConfirmations: ["overwrite"],
    warnings: [],
    planHash: PLAN_HASH,
    adapterId: "fixture-adapter",
    adapterVersion: SemVerSchema.parse("1.0.0"),
    createdAt: NOW,
    ...overrides,
  });
}

function baseRecord(plan: DeploymentPlan = basePlan(), overrides: Partial<DeploymentRecord> = {}) {
  return DeploymentRecordSchema.parse({
    deploymentRecordId: RECORD_ID,
    deploymentPlanId: plan.deploymentPlanId,
    status: "planned",
    operations: plan.operations,
    backupLocations: {},
    resultingHashes: {},
    verificationResult: { status: "not_started", diagnostics: [] },
    rollbackResults: [],
    adapterId: plan.adapterId,
    adapterVersion: plan.adapterVersion,
    normalizedSchemaVersion: SemVerSchema.parse("1.0.0"),
    createdAt: NOW,
    correlationId: CorrelationIdSchema.parse("correlation:test"),
    diagnostics: [],
    ...overrides,
  });
}

class MemoryDeploymentRepository implements DeploymentRepository {
  readonly transitions: DeploymentRecord[] = [];
  failNextCas = false;
  failCasAt?: number;
  private casAttempts = 0;

  constructor(
    public plan: DeploymentPlan | undefined,
    public record: DeploymentRecord | undefined,
  ) {}

  savePlanAndRecord(): Promise<void> {
    throw new Error("Execution must not create plans");
  }

  getPlan(): Promise<DeploymentPlan | undefined> {
    return Promise.resolve(this.plan);
  }

  getRecord(): Promise<DeploymentRecord | undefined> {
    return Promise.resolve(this.record);
  }

  compareAndSetRecord(input: {
    readonly expectedStatus: DeploymentRecord["status"];
    readonly record: DeploymentRecord;
  }): Promise<boolean> {
    this.casAttempts += 1;
    if (this.failCasAt === this.casAttempts) {
      return Promise.resolve(false);
    }
    if (this.failNextCas) {
      this.failNextCas = false;
      return Promise.resolve(false);
    }
    if (this.record?.status !== input.expectedStatus) return Promise.resolve(false);
    this.record = structuredClone(input.record);
    this.transitions.push(this.record);
    return Promise.resolve(true);
  }

  listRecords(): never {
    throw new Error("Execution tests do not list records");
  }
}

class MemoryFiles implements FileSnapshotPort, DeploymentFilePort {
  readonly writes: string[] = [];
  readonly backups: string[] = [];
  failBackupFor?: AbsolutePath;
  failReplaceFor?: AbsolutePath;
  failReplaceAfterCommitFor?: AbsolutePath;
  mutateBeforeFailReplaceTo?: string;
  failRemoveFor?: AbsolutePath;

  constructor(readonly files = new Map<AbsolutePath, string>()) {}

  snapshot(input: {
    readonly path: AbsolutePath;
    readonly allowedRoots: readonly AbsolutePath[];
  }): Promise<FileSnapshot | undefined> {
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

  createBackup(input: {
    readonly source: AbsolutePath;
    readonly destination: AbsolutePath;
    readonly expectedHash: ContentHash;
  }): Promise<{ readonly backupPath: AbsolutePath; readonly backupHash: ContentHash }> {
    if (input.source === this.failBackupFor) throw new Error("backup failed");
    const text = this.files.get(input.source);
    if (text === undefined || hash(text) !== input.expectedHash) throw new Error("backup drift");
    this.files.set(input.destination, text);
    this.backups.push(`${input.source}->${input.destination}`);
    return Promise.resolve({ backupPath: input.destination, backupHash: hash(text) });
  }

  atomicReplace(input: {
    readonly target: AbsolutePath;
    readonly text: string;
    readonly expectedHash: ContentHash | "absent";
  }): Promise<{ readonly resultingHash: ContentHash }> {
    this.writes.push(`replace:${input.target}:${input.text}`);
    if (input.target === this.failReplaceFor) {
      if (this.mutateBeforeFailReplaceTo !== undefined) {
        this.files.set(input.target, this.mutateBeforeFailReplaceTo);
      }
      throw new Error("replace failed");
    }
    const current = this.files.get(input.target);
    const currentHash = current === undefined ? "absent" : hash(current);
    if (currentHash !== input.expectedHash) throw new Error("replace drift");
    this.files.set(input.target, input.text);
    if (input.target === this.failReplaceAfterCommitFor) {
      throw Object.assign(new Error("replace committed but uncertain"), {
        committed: true,
        durabilityUncertain: true,
      });
    }
    return Promise.resolve({ resultingHash: hash(input.text) });
  }

  remove(input: {
    readonly target: AbsolutePath;
    readonly expectedHash: ContentHash;
  }): Promise<void> {
    this.writes.push(`remove:${input.target}`);
    if (input.target === this.failRemoveFor) throw new Error("remove failed");
    const current = this.files.get(input.target);
    if (current === undefined || hash(current) !== input.expectedHash)
      throw new Error("remove drift");
    this.files.delete(input.target);
    return Promise.resolve();
  }
}

function registry(
  verify: ToolAdapter["verify"] = ({ deployment }) =>
    Promise.resolve({
      status: "passed",
      verifiedHashes: deployment.resultingHashes,
      diagnostics: [],
    }),
): AdapterRegistry {
  const adapter = {
    adapterId: AdapterIdSchema.parse("fixture-adapter"),
    adapterVersion: SemVerSchema.parse("1.0.0"),
    toolId: "codex" as const,
    capabilities: {
      supportedToolVersions: "*",
      testedToolVersions: [],
      readableSchemaVersions: ["1.0.0"],
      writtenSchemaVersion: SemVerSchema.parse("1.0.0"),
      resourceKinds: ["rule" as const],
      scopeKinds: ["project" as const],
      supportsNestedScopes: false,
      conversions: [],
    },
    detect: vi.fn(),
    discover: vi.fn(),
    parse: vi.fn(),
    resolveEffective: vi.fn(),
    diagnose: vi.fn(),
    convert: vi.fn(),
    planDeployment: vi.fn(),
    verify: vi.fn(verify),
  } satisfies ToolAdapter;
  return {
    create: vi.fn(() => adapter),
    registrations: [adapter],
  } as unknown as AdapterRegistry;
}

function readApi(files: MemoryFiles): AdapterReadApi {
  return {
    realpath: (path) => Promise.resolve(path),
    stat: async (path) => {
      const snapshot = await files.snapshot({ path, allowedRoots: [ROOT] });
      return {
        kind: snapshot === undefined ? "missing" : "file",
        size: snapshot?.size ?? 0,
        modifiedAt: snapshot?.modifiedAt ?? NOW,
      };
    },
    list: () => Promise.resolve([]),
    readText: async (path) => {
      const snapshot = await files.snapshot({ path, allowedRoots: [ROOT] });
      if (snapshot === undefined) throw new Error("missing");
      return snapshot.text;
    },
  };
}

function serviceFixture(
  plan = basePlan(),
  files = new MemoryFiles(new Map([[AbsolutePathSchema.parse("/target/a.md"), "old a"]])),
  verify?: ToolAdapter["verify"],
  sourceHashes: DeploymentSourceHashPort = {
    currentHash: (assetId) => Promise.resolve(plan.expectedSourceHashes[assetId]),
  },
) {
  const repo = new MemoryDeploymentRepository(plan, baseRecord(plan));
  const service = new DeploymentExecutionService({
    deploymentRepository: repo,
    sourceHashes,
    snapshots: files,
    deploymentFiles: files,
    locks: new PathLockManager(),
    registry: registry(verify),
    read: readApi(files),
  });
  return { service, repo, files };
}

async function execute(
  service: DeploymentExecutionService,
  confirmations: readonly ("partial_conversion" | "overwrite" | "delete")[] = ["overwrite"],
) {
  return service.execute({
    deploymentRecordId: RECORD_ID,
    confirmedPlanHash: PLAN_HASH,
    confirmations,
    allowedRoots: [ROOT],
    now: LATER,
  });
}

describe("DeploymentExecutionService", () => {
  it("rejects confirmation mismatches before state changes", async () => {
    const { service, repo, files } = serviceFixture();

    await expect(execute(service, [])).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(repo.transitions).toEqual([]);
    expect(files.writes).toEqual([]);
  });

  it("rejects expired plans before state changes", async () => {
    const { service, repo } = serviceFixture(
      basePlan({ expiresAt: IsoDateTimeSchema.parse("2026-06-22T07:59:00.000Z") }),
    );

    await expect(execute(service)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(repo.transitions).toEqual([]);
  });

  it("rejects plan hash mismatches before state changes", async () => {
    const { service, repo } = serviceFixture();

    await expect(
      service.execute({
        deploymentRecordId: RECORD_ID,
        confirmedPlanHash: hash("different"),
        confirmations: ["overwrite"],
        allowedRoots: [ROOT],
        now: LATER,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(repo.transitions).toEqual([]);
  });

  it("rejects target drift after confirmation and before backups", async () => {
    const { service, repo, files } = serviceFixture(
      basePlan(),
      new MemoryFiles(new Map([[AbsolutePathSchema.parse("/target/a.md"), "changed"]])),
    );

    await expect(execute(service)).rejects.toMatchObject({ code: "STALE_INDEX" });

    expect(repo.transitions.map(({ status }) => status)).toEqual(["confirmed", "failed"]);
    expect(files.backups).toEqual([]);
    expect(files.writes).toEqual([]);
  });

  it("rejects source drift after confirmation and before backups", async () => {
    const { service, repo, files } = serviceFixture(basePlan(), undefined, undefined, {
      currentHash: () => Promise.resolve(hash("changed source")),
    });

    await expect(execute(service)).rejects.toMatchObject({ code: "STALE_INDEX" });

    expect(repo.transitions.map(({ status }) => status)).toEqual(["confirmed", "failed"]);
    expect(files.backups).toEqual([]);
    expect(files.writes).toEqual([]);
  });

  it("fails safely when backup creation fails", async () => {
    const { service, repo, files } = serviceFixture();
    files.failBackupFor = AbsolutePathSchema.parse("/target/a.md");

    await expect(execute(service)).rejects.toThrow("backup failed");

    expect(repo.transitions.map(({ status }) => status)).toEqual(["confirmed", "failed"]);
    expect(files.writes).toEqual([]);
  });

  it("compensates completed writes in reverse order after a later write fails", async () => {
    const plan = basePlan({
      operations: [
        {
          kind: "replace",
          targetPath: AbsolutePathSchema.parse("/target/a.md"),
          nextText: "next a",
          expectedTargetHash: hash("old a"),
          deploymentType: "generated_file",
        },
        {
          kind: "replace",
          targetPath: AbsolutePathSchema.parse("/target/b.md"),
          nextText: "next b",
          expectedTargetHash: hash("old b"),
          deploymentType: "generated_file",
        },
      ],
      expectedTargetHashes: {
        "/target/a.md": hash("old a"),
        "/target/b.md": hash("old b"),
      },
    });
    const files = new MemoryFiles(
      new Map([
        [AbsolutePathSchema.parse("/target/a.md"), "old a"],
        [AbsolutePathSchema.parse("/target/b.md"), "old b"],
      ]),
    );
    files.failReplaceFor = AbsolutePathSchema.parse("/target/b.md");
    const { service, repo } = serviceFixture(plan, files);

    const result = await execute(service);

    expect(result.status).toBe("rolled_back");
    expect(files.writes).toEqual([
      "replace:/target/a.md:next a",
      "replace:/target/b.md:next b",
      "replace:/target/a.md:old a",
    ]);
    expect(repo.transitions.map(({ status }) => status)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
      "backed_up",
      "writing",
      "writing",
      "writing",
      "writing",
      "rolling_back",
      "rolled_back",
    ]);
    expect(files.files.get(AbsolutePathSchema.parse("/target/a.md"))).toBe("old a");
    expect(files.files.get(AbsolutePathSchema.parse("/target/b.md"))).toBe("old b");
  });

  it("fails rollback when an uncompleted target no longer matches its expected hash", async () => {
    const plan = basePlan({
      operations: [
        {
          kind: "replace",
          targetPath: AbsolutePathSchema.parse("/target/a.md"),
          nextText: "next a",
          expectedTargetHash: hash("old a"),
          deploymentType: "generated_file",
        },
        {
          kind: "replace",
          targetPath: AbsolutePathSchema.parse("/target/b.md"),
          nextText: "next b",
          expectedTargetHash: hash("old b"),
          deploymentType: "generated_file",
        },
      ],
      expectedTargetHashes: {
        "/target/a.md": hash("old a"),
        "/target/b.md": hash("old b"),
      },
    });
    const files = new MemoryFiles(
      new Map([
        [AbsolutePathSchema.parse("/target/a.md"), "old a"],
        [AbsolutePathSchema.parse("/target/b.md"), "old b"],
      ]),
    );
    files.failReplaceFor = AbsolutePathSchema.parse("/target/b.md");
    files.mutateBeforeFailReplaceTo = "external b";
    const { service } = serviceFixture(plan, files);

    const result = await execute(service);

    expect(result.status).toBe("failed");
    expect(files.files.get(AbsolutePathSchema.parse("/target/a.md"))).toBe("old a");
    expect(files.files.get(AbsolutePathSchema.parse("/target/b.md"))).toBe("external b");
    expect(result.rollbackResults).toContainEqual({
      targetPath: AbsolutePathSchema.parse("/target/b.md"),
      status: "failed",
      diagnosticIds: [],
    });
  });

  it("compensates two completed writes in reverse order when a later write fails", async () => {
    const plan = basePlan({
      operations: [
        {
          kind: "replace",
          targetPath: AbsolutePathSchema.parse("/target/a.md"),
          nextText: "next a",
          expectedTargetHash: hash("old a"),
          deploymentType: "generated_file",
        },
        {
          kind: "replace",
          targetPath: AbsolutePathSchema.parse("/target/b.md"),
          nextText: "next b",
          expectedTargetHash: hash("old b"),
          deploymentType: "generated_file",
        },
        {
          kind: "replace",
          targetPath: AbsolutePathSchema.parse("/target/c.md"),
          nextText: "next c",
          expectedTargetHash: hash("old c"),
          deploymentType: "generated_file",
        },
      ],
      expectedTargetHashes: {
        "/target/a.md": hash("old a"),
        "/target/b.md": hash("old b"),
        "/target/c.md": hash("old c"),
      },
    });
    const files = new MemoryFiles(
      new Map([
        [AbsolutePathSchema.parse("/target/a.md"), "old a"],
        [AbsolutePathSchema.parse("/target/b.md"), "old b"],
        [AbsolutePathSchema.parse("/target/c.md"), "old c"],
      ]),
    );
    files.failReplaceFor = AbsolutePathSchema.parse("/target/c.md");
    const { service } = serviceFixture(plan, files);

    const result = await execute(service);

    expect(result.status).toBe("rolled_back");
    expect(files.writes).toEqual([
      "replace:/target/a.md:next a",
      "replace:/target/b.md:next b",
      "replace:/target/c.md:next c",
      "replace:/target/b.md:old b",
      "replace:/target/a.md:old a",
    ]);
  });

  it("rolls back when completed journal compare-and-set fails after a write", async () => {
    const { service, repo, files } = serviceFixture();
    repo.failCasAt = 6;

    const result = await execute(service);

    expect(result.status).toBe("rolled_back");
    expect(files.writes).toEqual(["replace:/target/a.md:next a", "replace:/target/a.md:old a"]);
    expect(files.files.get(AbsolutePathSchema.parse("/target/a.md"))).toBe("old a");
  });

  it("rolls back when adapter verification fails", async () => {
    const { service, repo, files } = serviceFixture(basePlan(), undefined, ({ deployment }) =>
      Promise.resolve({
        status: "failed",
        verifiedHashes: deployment.resultingHashes,
        diagnostics: [
          {
            code: "VERIFY_FAILED",
            severity: "error",
            message: "Nope",
            location: { path: AbsolutePathSchema.parse("/target/a.md") },
            evidence: {},
            suggestedActions: ["Fix output"],
            blocking: true,
          },
        ],
      }),
    );

    const result = await execute(service);

    expect(result.status).toBe("rolled_back");
    expect(repo.transitions.map(({ status }) => status)).toEqual([
      "confirmed",
      "confirmed",
      "backed_up",
      "writing",
      "writing",
      "writing",
      "verifying",
      "verifying",
      "rolling_back",
      "rolled_back",
    ]);
    expect(files.files.get(AbsolutePathSchema.parse("/target/a.md"))).toBe("old a");
  });

  it("persists delete completion before verification and restores it on rollback", async () => {
    const target = AbsolutePathSchema.parse("/target/delete.md");
    const plan = basePlan({
      operations: [
        {
          kind: "delete",
          targetPath: target,
          expectedTargetHash: hash("old delete"),
          deploymentType: "generated_file",
        },
      ],
      expectedTargetHashes: { "/target/delete.md": hash("old delete") },
      requiredConfirmations: ["delete"],
    });
    const files = new MemoryFiles(new Map([[target, "old delete"]]));
    const { service } = serviceFixture(plan, files, ({ deployment }) =>
      Promise.resolve({
        status: "failed",
        verifiedHashes: deployment.resultingHashes,
        diagnostics: [
          {
            code: "VERIFY_FAILED",
            severity: "error",
            message: "Nope",
            evidence: {},
            suggestedActions: ["Fix output"],
            blocking: true,
          },
        ],
      }),
    );

    const result = await execute(service, ["delete"]);

    expect(result.status).toBe("rolled_back");
    expect(result.resultingHashes["/target/delete.md"]).toBeUndefined();
    expect(result.operationJournal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: "/target/delete.md",
          operationKind: "delete",
          phase: "completed",
        }),
      ]),
    );
    expect(files.writes).toEqual([
      "remove:/target/delete.md",
      "replace:/target/delete.md:old delete",
    ]);
    expect(files.files.get(target)).toBe("old delete");
  });

  it("fails rollback instead of overwriting external drift after a write", async () => {
    const target = AbsolutePathSchema.parse("/target/a.md");
    const files = new MemoryFiles(new Map([[target, "old a"]]));
    const { service } = serviceFixture(basePlan(), files, ({ deployment }) => {
      files.files.set(target, "external edit");
      return Promise.resolve({
        status: "failed",
        verifiedHashes: deployment.resultingHashes,
        diagnostics: [
          {
            code: "VERIFY_FAILED",
            severity: "error",
            message: "Nope",
            evidence: {},
            suggestedActions: ["Fix output"],
            blocking: true,
          },
        ],
      });
    });

    const result = await execute(service);

    expect(result.status).toBe("failed");
    expect(files.files.get(target)).toBe("external edit");
    expect(result.rollbackResults).toEqual([
      { targetPath: target, status: "failed", diagnosticIds: [] },
    ]);
  });

  it("resnapshots uncertain committed writes and compensates them", async () => {
    const { service, files } = serviceFixture();
    files.failReplaceAfterCommitFor = AbsolutePathSchema.parse("/target/a.md");

    const result = await execute(service);

    expect(result.status).toBe("rolled_back");
    expect(files.writes).toEqual(["replace:/target/a.md:next a", "replace:/target/a.md:old a"]);
    expect(files.files.get(AbsolutePathSchema.parse("/target/a.md"))).toBe("old a");
  });

  it("executes backups, writes, adapter verification, and succeeds", async () => {
    const { service, repo, files } = serviceFixture();

    const result = await execute(service);

    expect(result.status).toBe("succeeded");
    expect(result.verificationResult.status).toBe("passed");
    expect(result.backupLocations["/target/a.md"]).toMatch(/^\/backups\//);
    expect(result.resultingHashes["/target/a.md"]).toBe(hash("next a"));
    expect(files.files.get(AbsolutePathSchema.parse("/target/a.md"))).toBe("next a");
    expect(repo.transitions.map(({ status }) => status)).toEqual([
      "confirmed",
      "confirmed",
      "backed_up",
      "writing",
      "writing",
      "writing",
      "verifying",
      "verifying",
      "succeeded",
    ]);
  });

  it("rejects concurrent executions when compare-and-set fails", async () => {
    const { service, repo, files } = serviceFixture();
    repo.failNextCas = true;

    await expect(execute(service)).rejects.toMatchObject({ code: "CONFLICT" });

    expect(repo.transitions).toEqual([]);
    expect(files.writes).toEqual([]);
  });
});
