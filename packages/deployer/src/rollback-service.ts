import { createHash } from "node:crypto";

import {
  DeploymentPlanSchema,
  DeploymentRecordSchema,
  type DeploymentFilePort,
  type DeploymentOperation,
  type DeploymentPlan,
  type DeploymentRecord,
  type DeploymentRepository,
  type FileSnapshotPort,
} from "@ai-config-hub/core";
import {
  AppError,
  ContentHashSchema,
  DeploymentPlanIdSchema,
  DeploymentRecordIdSchema,
  DiagnosticIdSchema,
  type AbsolutePath,
  type ContentHash,
  type DeploymentRecordId,
  type IsoDateTime,
} from "@ai-config-hub/shared";

import type { PathLockManager } from "./path-locks.js";

export interface DeploymentRollbackServiceOptions {
  readonly deploymentRepository: DeploymentRepository;
  readonly snapshots: FileSnapshotPort;
  readonly deploymentFiles: DeploymentFilePort;
  readonly locks: PathLockManager;
}

export interface ExecuteRollbackRequest {
  readonly deploymentRecordId: DeploymentRecordId;
  readonly rollbackPlanHash: ContentHash;
  readonly now: IsoDateTime;
}

interface RollbackDraft {
  readonly original: DeploymentRecord;
  readonly plan: DeploymentPlan;
}

function appError(
  code: "VALIDATION_FAILED" | "NOT_FOUND" | "STALE_INDEX" | "BACKUP_MISSING" | "CONFLICT",
  message: string,
  retryable = false,
): AppError {
  return new AppError({
    code,
    message,
    retryable,
    suggestedActions: ["Refresh deployment history and retry rollback"],
  });
}

function hash(namespace: string, value: string): ContentHash {
  return ContentHashSchema.parse(
    `sha256:${createHash("sha256").update(namespace).update("\0").update(value).digest("hex")}`,
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class DeploymentRollbackService {
  constructor(private readonly options: DeploymentRollbackServiceOptions) {}

  async preview(deploymentRecordId: DeploymentRecordId): Promise<DeploymentPlan> {
    return (await this.buildRollbackDraft(deploymentRecordId)).plan;
  }

  async execute(input: ExecuteRollbackRequest): Promise<DeploymentRecord> {
    const draft = await this.buildRollbackDraft(input.deploymentRecordId);
    if (draft.plan.planHash !== input.rollbackPlanHash) {
      throw appError("VALIDATION_FAILED", "Rollback plan hash does not match current preview");
    }
    const record = DeploymentRecordSchema.parse({
      deploymentRecordId: DeploymentRecordIdSchema.parse(
        `rollback-record:${draft.plan.planHash.slice("sha256:".length)}`,
      ),
      deploymentPlanId: draft.plan.deploymentPlanId,
      rollbackOfRecordId: draft.original.deploymentRecordId,
      status: "planned",
      operations: draft.plan.operations,
      backupLocations: Object.fromEntries(
        draft.plan.operations.map((operation) => [operation.targetPath, "previously-absent"]),
      ),
      resultingHashes: {},
      verificationResult: { status: "not_started", diagnostics: [] },
      rollbackResults: [],
      adapterId: draft.original.adapterId,
      adapterVersion: draft.original.adapterVersion,
      normalizedSchemaVersion: draft.original.normalizedSchemaVersion,
      createdAt: input.now,
      correlationId: draft.original.correlationId,
      diagnostics: [],
    });
    await this.options.deploymentRepository.savePlanAndRecord({ plan: draft.plan, record });

    return this.options.locks.withPaths(
      draft.plan.operations.map(({ targetPath }) => targetPath),
      () => this.executeLocked(draft, record, input),
    );
  }

  private async executeLocked(
    draft: RollbackDraft,
    initialRecord: DeploymentRecord,
    input: ExecuteRollbackRequest,
  ): Promise<DeploymentRecord> {
    let record = await this.transition(initialRecord, "planned", {
      status: "confirmed",
      confirmedAt: input.now,
      confirmedPlanHash: draft.plan.planHash,
    });
    record = await this.transition(record, "confirmed", {
      status: "backed_up",
      backupLocations: Object.fromEntries(
        draft.plan.operations.map((operation) => [operation.targetPath, "previously-absent"]),
      ),
    });
    record = await this.transition(record, "backed_up", {
      status: "writing",
      startedAt: input.now,
    });

    try {
      const resultingHashes: Record<AbsolutePath, ContentHash> = {};
      for (const operation of draft.plan.operations) {
        if (operation.kind === "delete") {
          await this.options.deploymentFiles.remove({
            target: operation.targetPath,
            expectedHash: operation.expectedTargetHash,
          });
          await this.assertAbsent(operation.targetPath);
        } else {
          const result = await this.options.deploymentFiles.atomicReplace({
            target: operation.targetPath,
            text: operation.nextText,
            expectedHash: operation.expectedTargetHash,
          });
          resultingHashes[operation.targetPath] = result.resultingHash;
          await this.assertHash(operation.targetPath, result.resultingHash);
        }
        record = await this.transition(record, "writing", {
          status: "writing",
          resultingHashes,
        });
      }

      record = await this.transition(record, "writing", {
        status: "verifying",
        verificationResult: {
          status: "passed",
          verifiedHashes: resultingHashes,
          diagnostics: [],
        },
      });
      return this.transition(record, "verifying", {
        status: "succeeded",
        finishedAt: input.now,
      });
    } catch (cause) {
      return this.transition(record, record.status, {
        status: "failed",
        diagnostics: [
          ...record.diagnostics,
          this.rollbackFailureDiagnostic(record, input.now, cause),
        ],
        finishedAt: input.now,
      });
    }
  }

  private async buildRollbackDraft(deploymentRecordId: DeploymentRecordId): Promise<RollbackDraft> {
    const original = await this.options.deploymentRepository.getRecord(deploymentRecordId);
    if (original === undefined) throw appError("NOT_FOUND", "Deployment record not found");
    if (original.status !== "succeeded") {
      throw appError("VALIDATION_FAILED", "Only succeeded deployments can be rolled back");
    }
    const originalPlan = await this.options.deploymentRepository.getPlan(original.deploymentPlanId);
    if (originalPlan === undefined) throw appError("NOT_FOUND", "Deployment plan not found");

    const operations: DeploymentOperation[] = [];
    const expectedTargetHashes: Record<AbsolutePath, ContentHash | "absent"> = {};
    for (const operation of original.operations) {
      const live = await this.options.snapshots.snapshot({
        path: operation.targetPath,
        allowedRoots: [operation.targetPath],
      });
      if (operation.kind === "create") {
        const resultingHash = original.resultingHashes[operation.targetPath];
        if (resultingHash === undefined || live?.contentHash !== resultingHash) {
          throw appError("STALE_INDEX", `Current target drifted: ${operation.targetPath}`, true);
        }
        operations.push({
          kind: "delete",
          targetPath: operation.targetPath,
          expectedTargetHash: resultingHash,
        });
        expectedTargetHashes[operation.targetPath] = resultingHash;
        continue;
      }

      const backupLocation = original.backupLocations[operation.targetPath];
      if (backupLocation === undefined || backupLocation === "previously-absent") {
        throw appError("BACKUP_MISSING", `Missing rollback backup for ${operation.targetPath}`);
      }
      const backup = await this.options.snapshots.snapshot({
        path: backupLocation,
        allowedRoots: [backupLocation],
      });
      if (backup === undefined) {
        throw appError("BACKUP_MISSING", `Missing rollback backup for ${operation.targetPath}`);
      }
      if (operation.expectedTargetHash !== backup.contentHash) {
        throw appError(
          "BACKUP_MISSING",
          `Rollback backup hash mismatch for ${operation.targetPath}`,
        );
      }
      if (operation.kind === "replace") {
        const resultingHash = original.resultingHashes[operation.targetPath];
        if (resultingHash === undefined || live?.contentHash !== resultingHash) {
          throw appError("STALE_INDEX", `Current target drifted: ${operation.targetPath}`, true);
        }
        operations.push({
          kind: "replace",
          targetPath: operation.targetPath,
          nextText: backup.text,
          expectedTargetHash: resultingHash,
        });
        expectedTargetHashes[operation.targetPath] = resultingHash;
      } else {
        if (live !== undefined) {
          throw appError(
            "STALE_INDEX",
            `Deleted target was recreated: ${operation.targetPath}`,
            true,
          );
        }
        operations.push({
          kind: "create",
          targetPath: operation.targetPath,
          nextText: backup.text,
          expectedTargetHash: "absent",
        });
        expectedTargetHashes[operation.targetPath] = "absent";
      }
    }
    const payload = {
      conversionResultIds: [`rollback:${deploymentRecordId}`],
      operations,
      diffs: [],
      expectedSourceHashes: {},
      expectedTargetHashes,
      backupPolicy: originalPlan.backupPolicy,
      verificationStrategy: { kind: "adapter" as const, description: "Verify rollback hashes" },
      requiredConfirmations: [],
      warnings: [],
      adapterId: original.adapterId,
      adapterVersion: original.adapterVersion,
      createdAt: original.finishedAt ?? original.createdAt,
    };
    const planHash = hash("ai-config-hub:rollback-plan:v1", stableJson(payload));
    return {
      original,
      plan: DeploymentPlanSchema.parse({
        deploymentPlanId: DeploymentPlanIdSchema.parse(
          `rollback-plan:${planHash.slice("sha256:".length)}`,
        ),
        ...payload,
        planHash,
      }),
    };
  }

  private async assertHash(path: AbsolutePath, expectedHash: ContentHash): Promise<void> {
    const snapshot = await this.options.snapshots.snapshot({ path, allowedRoots: [path] });
    if (snapshot?.contentHash !== expectedHash) {
      throw appError("STALE_INDEX", `Rollback verification failed for ${path}`, true);
    }
  }

  private async assertAbsent(path: AbsolutePath): Promise<void> {
    const snapshot = await this.options.snapshots.snapshot({ path, allowedRoots: [path] });
    if (snapshot !== undefined) {
      throw appError("STALE_INDEX", `Rollback delete verification failed for ${path}`, true);
    }
  }

  private async transition(
    record: DeploymentRecord,
    expectedStatus: DeploymentRecord["status"],
    updates: Partial<DeploymentRecord>,
  ): Promise<DeploymentRecord> {
    const next = DeploymentRecordSchema.parse({ ...record, ...updates });
    const ok = await this.options.deploymentRepository.compareAndSetRecord({
      expectedStatus,
      record: next,
    });
    if (!ok) throw appError("CONFLICT", "Rollback record changed concurrently", true);
    return next;
  }

  private rollbackFailureDiagnostic(
    record: DeploymentRecord,
    now: IsoDateTime,
    cause: unknown,
  ): DeploymentRecord["diagnostics"][number] {
    return {
      diagnosticId: DiagnosticIdSchema.parse(
        `diagnostic:rollback:${record.deploymentRecordId}:failed`,
      ),
      code: "ROLLBACK_FAILED",
      severity: "error",
      category: "deployment",
      message: cause instanceof Error ? cause.message : "Rollback failed",
      subject: { kind: "deployment", id: record.deploymentRecordId },
      impact: "Rollback did not complete; inspect target files before retrying",
      evidence: { deploymentRecordId: record.deploymentRecordId },
      suggestedActions: ["Inspect rollback target files and retry from deployment history"],
      blocking: true,
      createdAt: now,
    };
  }
}
