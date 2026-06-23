import { createHash } from "node:crypto";
import { basename, posix } from "node:path";

import type { AdapterRegistry } from "@ai-config-hub/adapters";
import {
  DeploymentRecordSchema,
  type AdapterDiagnostic,
  type AdapterReadApi,
  type DeploymentFilePort,
  type DeploymentOperation,
  type DeploymentPlan,
  type DeploymentRecord,
  type DeploymentRepository,
  type FileSnapshot,
  type FileSnapshotPort,
  type ToolAdapter,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AppError,
  DiagnosticIdSchema,
  ToolInstallationIdSchema,
  type AbsolutePath,
  type ContentHash,
  type DeploymentRecordId,
  type IsoDateTime,
} from "@ai-config-hub/shared";

import type { PathLockManager } from "./path-locks.js";

export interface ExecuteDeploymentRequest {
  readonly deploymentRecordId: DeploymentRecordId;
  readonly confirmedPlanHash: ContentHash;
  readonly confirmations: readonly ("partial_conversion" | "overwrite" | "delete")[];
  readonly allowedRoots: readonly AbsolutePath[];
  readonly now: IsoDateTime;
}

export interface DeploymentExecutionServiceOptions {
  readonly deploymentRepository: DeploymentRepository;
  readonly sourceHashes: DeploymentSourceHashPort;
  readonly snapshots: FileSnapshotPort;
  readonly deploymentFiles: DeploymentFilePort;
  readonly locks: PathLockManager;
  readonly registry: AdapterRegistry;
  readonly read: AdapterReadApi;
}

export interface DeploymentSourceHashPort {
  currentHash(assetId: string): Promise<ContentHash | undefined>;
}

type MutableRecordFields = Omit<DeploymentRecord, "diagnostics"> & {
  readonly diagnostics: DeploymentRecord["diagnostics"];
};

interface CompletedOperation {
  readonly operation: DeploymentOperation;
  readonly resultingHash?: ContentHash;
}

function appError(
  code:
    | "VALIDATION_FAILED"
    | "NOT_FOUND"
    | "CONFLICT"
    | "STALE_INDEX"
    | "INTERNAL_ERROR"
    | "BACKUP_MISSING",
  message: string,
  retryable = false,
): AppError {
  return new AppError({
    code,
    message,
    retryable,
    suggestedActions: ["Refresh the deployment state and retry"],
  });
}

function sameHash(left: ContentHash | "absent", snapshot: FileSnapshot | undefined): boolean {
  return left === "absent" ? snapshot === undefined : snapshot?.contentHash === left;
}

function textHash(text: string): ContentHash {
  return `sha256:${createHash("sha256").update(text).digest("hex")}` as ContentHash;
}

function adapterDiagnostics(
  diagnostics: readonly AdapterDiagnostic[],
  now: IsoDateTime,
  deploymentRecordId: DeploymentRecordId,
): DeploymentRecord["diagnostics"] {
  return diagnostics.map((diagnostic, index) => ({
    diagnosticId: DiagnosticIdSchema.parse(
      `diagnostic:deployment:${deploymentRecordId}:${diagnostic.code.toLowerCase()}:${index}`,
    ),
    code: diagnostic.code,
    severity: diagnostic.severity,
    category: "verification",
    message: diagnostic.message,
    subject: { kind: "deployment", id: deploymentRecordId },
    ...(diagnostic.location === undefined ? {} : { location: diagnostic.location }),
    impact: diagnostic.blocking
      ? "Deployment verification reported a blocking problem"
      : "Deployment verification reported a non-blocking problem",
    evidence:
      Object.keys(diagnostic.evidence).length === 0
        ? { code: diagnostic.code }
        : diagnostic.evidence,
    suggestedActions:
      diagnostic.suggestedActions.length === 0
        ? ["Review deployment verification output"]
        : [...diagnostic.suggestedActions],
    blocking: diagnostic.blocking,
    createdAt: now,
  }));
}

function internalDiagnostic(
  code: string,
  message: string,
  now: IsoDateTime,
  deploymentRecordId: DeploymentRecordId,
): DeploymentRecord["diagnostics"][number] {
  return {
    diagnosticId: DiagnosticIdSchema.parse(
      `diagnostic:deployment:${deploymentRecordId}:${code.toLowerCase()}`,
    ),
    code,
    severity: "error",
    category: "deployment",
    message,
    subject: { kind: "deployment", id: deploymentRecordId },
    impact: message,
    evidence: { code },
    suggestedActions: ["Inspect deployment backups and retry from a fresh preview"],
    blocking: true,
    createdAt: now,
  };
}

function backupPath(plan: DeploymentPlan, record: DeploymentRecord, index: number): AbsolutePath {
  const operation = plan.operations[index];
  if (operation === undefined) throw appError("INTERNAL_ERROR", "Operation index out of range");
  return AbsolutePathSchema.parse(
    posix.join(
      plan.backupPolicy.backupRoot,
      record.deploymentRecordId,
      `${String(index).padStart(4, "0")}-${basename(operation.targetPath)}`,
    ),
  );
}

function withRecord(
  record: DeploymentRecord,
  updates: Partial<MutableRecordFields>,
): DeploymentRecord {
  return DeploymentRecordSchema.parse({
    ...record,
    ...updates,
  });
}

function journalHash(completed: CompletedOperation): ContentHash {
  if (completed.resultingHash !== undefined) return completed.resultingHash;
  throw appError("INTERNAL_ERROR", `Missing result hash for ${completed.operation.kind} operation`);
}

function operationDesiredHash(operation: DeploymentOperation): ContentHash | undefined {
  if (operation.kind === "delete") return undefined;
  return textHash(operation.nextText);
}

function isUncertainCommittedOutcome(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (("committed" in cause && cause.committed === true) ||
      ("durabilityUncertain" in cause && cause.durabilityUncertain === true) ||
      ("mutationOutcomeUncertain" in cause && cause.mutationOutcomeUncertain === true))
  );
}

export class DeploymentExecutionService {
  constructor(private readonly options: DeploymentExecutionServiceOptions) {}

  async execute(request: ExecuteDeploymentRequest): Promise<DeploymentRecord> {
    const loadedRecord = await this.options.deploymentRepository.getRecord(
      request.deploymentRecordId,
    );
    if (loadedRecord === undefined) throw appError("NOT_FOUND", "Deployment record not found");
    const plan = await this.options.deploymentRepository.getPlan(loadedRecord.deploymentPlanId);
    if (plan === undefined) throw appError("NOT_FOUND", "Deployment plan not found");
    this.validateRequest(plan, loadedRecord, request);

    return this.options.locks.withPaths(
      plan.operations.map(({ targetPath }) => targetPath),
      () => this.executeLocked(plan, loadedRecord, request),
    );
  }

  private validateRequest(
    plan: DeploymentPlan,
    record: DeploymentRecord,
    request: ExecuteDeploymentRequest,
  ): void {
    if (record.status !== "planned") {
      throw appError("CONFLICT", `Deployment is not planned: ${record.status}`, true);
    }
    if (request.allowedRoots.length === 0) {
      throw appError(
        "VALIDATION_FAILED",
        "Deployment execution requires at least one allowed root",
      );
    }
    if (plan.planHash !== request.confirmedPlanHash) {
      throw appError("VALIDATION_FAILED", "Confirmed plan hash does not match deployment plan");
    }
    if (plan.expiresAt !== undefined && Date.parse(request.now) > Date.parse(plan.expiresAt)) {
      throw appError("VALIDATION_FAILED", "Deployment plan has expired");
    }
    const expected = [...new Set(plan.requiredConfirmations)].sort();
    const actual = [...new Set(request.confirmations)].sort();
    if (
      expected.length !== actual.length ||
      expected.some((item, index) => actual[index] !== item)
    ) {
      throw appError("VALIDATION_FAILED", "Deployment confirmations do not match plan");
    }
  }

  private async executeLocked(
    plan: DeploymentPlan,
    initialRecord: DeploymentRecord,
    request: ExecuteDeploymentRequest,
  ): Promise<DeploymentRecord> {
    let record = await this.transition(initialRecord, "planned", {
      status: "confirmed",
      confirmedPlanHash: request.confirmedPlanHash,
      confirmedAt: request.now,
    });

    try {
      await this.assertNoSourceDrift(plan);
      await this.assertNoTargetDrift(plan, request.allowedRoots);
      record = await this.backup(plan, record);
      record = await this.transition(record, "backed_up", {
        status: "writing",
        startedAt: request.now,
      });
    } catch (cause) {
      const latest = await this.latestRecord(record);
      const failed = await this.fail(latest, latest.status, request.now, cause);
      throw cause instanceof AppError ? cause : Object.assign(cause as Error, { record: failed });
    }

    const completed: CompletedOperation[] = [];
    try {
      for (const operation of plan.operations) {
        record = await this.appendOperationJournal(record, operation, "intent", request.now);
        let resultingHash: ContentHash | undefined;
        try {
          resultingHash = await this.writeOperation(operation);
        } catch (cause) {
          if (isUncertainCommittedOutcome(cause)) {
            const committed = await this.completedFromCurrentState(operation, request.allowedRoots);
            if (committed !== undefined) {
              completed.push(committed);
              record = await this.journalCompleted(record, committed, request.now);
            }
          }
          throw cause;
        }
        const completedOperation =
          resultingHash === undefined ? { operation } : { operation, resultingHash };
        completed.push(completedOperation);
        record = await this.journalCompleted(record, completedOperation, request.now);
      }

      record = await this.transition(record, "writing", { status: "verifying" });
      const verification = await this.verify(plan, record, request);
      await this.assertVerifiedDeploymentState(plan, record, verification, request.allowedRoots);
      const normalizedDiagnostics = adapterDiagnostics(
        verification.diagnostics,
        request.now,
        record.deploymentRecordId,
      );
      record = await this.transition(record, "verifying", {
        status: "verifying",
        verificationResult:
          verification.status === "passed"
            ? {
                status: "passed",
                verifiedHashes: verification.verifiedHashes,
                diagnostics: normalizedDiagnostics,
              }
            : {
                status: "failed",
                verifiedHashes: verification.verifiedHashes,
                diagnostics:
                  normalizedDiagnostics.length === 0
                    ? [
                        internalDiagnostic(
                          "VERIFY_FAILED",
                          "Deployment verification failed",
                          request.now,
                          record.deploymentRecordId,
                        ),
                      ]
                    : normalizedDiagnostics,
              },
        diagnostics: [...record.diagnostics, ...normalizedDiagnostics],
      });
      if (record.verificationResult.status !== "passed") {
        throw appError("VALIDATION_FAILED", "Deployment verification failed");
      }
      return this.transition(record, "verifying", {
        status: "succeeded",
        finishedAt: request.now,
      });
    } catch (cause) {
      return this.rollback(plan, record, completed, request, cause);
    }
  }

  private async assertNoTargetDrift(
    plan: DeploymentPlan,
    allowedRoots: readonly AbsolutePath[],
  ): Promise<void> {
    for (const operation of plan.operations) {
      const snapshot = await this.options.snapshots.snapshot({
        path: operation.targetPath,
        allowedRoots,
      });
      if (!sameHash(operation.expectedTargetHash, snapshot)) {
        throw appError(
          "STALE_INDEX",
          `Target changed before deployment: ${operation.targetPath}`,
          true,
        );
      }
    }
  }

  private async assertNoSourceDrift(plan: DeploymentPlan): Promise<void> {
    for (const [assetId, expectedHash] of Object.entries(plan.expectedSourceHashes)) {
      const currentHash = await this.options.sourceHashes.currentHash(assetId);
      if (currentHash !== expectedHash) {
        throw appError("STALE_INDEX", `Source changed before deployment: ${assetId}`, true);
      }
    }
  }

  private async backup(plan: DeploymentPlan, record: DeploymentRecord): Promise<DeploymentRecord> {
    let next = record;
    for (let index = 0; index < plan.operations.length; index += 1) {
      const operation = plan.operations[index]!;
      const location =
        operation.kind === "create"
          ? "previously-absent"
          : (
              await this.options.deploymentFiles.createBackup({
                source: operation.targetPath,
                destination: backupPath(plan, record, index),
                expectedHash: operation.expectedTargetHash,
              })
            ).backupPath;
      const latest = await this.latestRecord(next);
      next = await this.transition(latest, "confirmed", {
        status: "confirmed",
        backupLocations: { ...latest.backupLocations, [operation.targetPath]: location },
      });
    }
    return this.transition(next, "confirmed", { status: "backed_up" });
  }

  private async writeOperation(operation: DeploymentOperation): Promise<ContentHash | undefined> {
    if (operation.kind === "delete") {
      await this.options.deploymentFiles.remove({
        target: operation.targetPath,
        expectedHash: operation.expectedTargetHash,
      });
      return undefined;
    }
    return (
      await this.options.deploymentFiles.atomicReplace({
        target: operation.targetPath,
        text: operation.nextText,
        expectedHash: operation.expectedTargetHash,
      })
    ).resultingHash;
  }

  private async completedFromCurrentState(
    operation: DeploymentOperation,
    allowedRoots: readonly AbsolutePath[],
  ): Promise<CompletedOperation | undefined> {
    const snapshot = await this.options.snapshots.snapshot({
      path: operation.targetPath,
      allowedRoots,
    });
    if (operation.kind === "delete") {
      return snapshot === undefined ? { operation } : undefined;
    }
    if (
      snapshot?.text === operation.nextText &&
      snapshot.contentHash === textHash(operation.nextText)
    ) {
      return { operation, resultingHash: snapshot.contentHash };
    }
    return undefined;
  }

  private async assertVerifiedDeploymentState(
    plan: DeploymentPlan,
    record: DeploymentRecord,
    verification: Awaited<ReturnType<ToolAdapter["verify"]>>,
    allowedRoots: readonly AbsolutePath[],
  ): Promise<void> {
    if (verification.status !== "passed") return;
    for (const operation of plan.operations) {
      if (operation.kind === "delete") {
        const snapshot = await this.options.snapshots.snapshot({
          path: operation.targetPath,
          allowedRoots,
        });
        if (
          snapshot !== undefined ||
          Object.hasOwn(verification.verifiedHashes, operation.targetPath)
        ) {
          throw appError(
            "VALIDATION_FAILED",
            `Adapter verification did not prove deletion: ${operation.targetPath}`,
          );
        }
        continue;
      }
      const resultingHash = record.resultingHashes[operation.targetPath];
      if (
        resultingHash === undefined ||
        verification.verifiedHashes[operation.targetPath] !== resultingHash
      ) {
        throw appError(
          "VALIDATION_FAILED",
          `Adapter verification did not cover ${operation.targetPath}`,
        );
      }
    }
  }

  private journalCompleted(
    record: DeploymentRecord,
    completed: CompletedOperation,
    now: IsoDateTime,
  ): Promise<DeploymentRecord> {
    return this.appendOperationJournal(
      record,
      completed.operation,
      "completed",
      now,
      completed.resultingHash,
    );
  }

  private async appendOperationJournal(
    record: DeploymentRecord,
    operation: DeploymentOperation,
    phase: "intent" | "completed",
    now: IsoDateTime,
    resultingHash = operationDesiredHash(operation),
  ): Promise<DeploymentRecord> {
    const latest = await this.latestRecord(record);
    if (latest.status !== "writing") {
      throw appError("CONFLICT", `Deployment is not writing: ${latest.status}`, true);
    }
    const hashUpdates =
      phase === "completed" && resultingHash !== undefined
        ? { [operation.targetPath]: journalHash({ operation, resultingHash }) }
        : {};
    return this.transition(latest, "writing", {
      status: "writing",
      resultingHashes: {
        ...latest.resultingHashes,
        ...hashUpdates,
      },
      operationJournal: [
        ...(latest.operationJournal ?? []),
        {
          targetPath: operation.targetPath,
          operationKind: operation.kind,
          phase,
          expectedTargetHash: operation.expectedTargetHash,
          ...(resultingHash === undefined ? {} : { resultingHash }),
          recordedAt: now,
        },
      ],
    });
  }

  private async latestRecord(record: DeploymentRecord): Promise<DeploymentRecord> {
    return (await this.options.deploymentRepository.getRecord(record.deploymentRecordId)) ?? record;
  }

  private async verify(
    plan: DeploymentPlan,
    record: DeploymentRecord,
    request: ExecuteDeploymentRequest,
  ): ReturnType<ToolAdapter["verify"]> {
    const registration = Object.values(this.options.registry.registrations).find(
      (candidate) =>
        candidate?.adapterId === plan.adapterId && candidate.adapterVersion === plan.adapterVersion,
    );
    if (registration === undefined) {
      throw appError("VALIDATION_FAILED", "Deployment adapter is not registered");
    }
    const adapter = this.options.registry.create(registration.toolId, {
      debug() {},
      warn() {},
    });
    return adapter.verify({
      deployment: record,
      target: {
        tool: {
          toolId: adapter.toolId,
          installationId: ToolInstallationIdSchema.parse(`deployment:${record.deploymentRecordId}`),
          configRoots: request.allowedRoots,
          evidence: {},
        },
        scope: {
          kind: "project",
          canonicalRootPath: request.allowedRoots[0]!,
          depth: 0,
          precedence: 0,
        },
        canonicalRootPath: request.allowedRoots[0]!,
      },
      read: this.options.read,
      signal: { aborted: false, throwIfAborted() {} },
    });
  }

  private async rollback(
    plan: DeploymentPlan,
    record: DeploymentRecord,
    completed: readonly CompletedOperation[],
    request: ExecuteDeploymentRequest,
    cause: unknown,
  ): Promise<DeploymentRecord> {
    const rolling = await this.transition(record, record.status, { status: "rolling_back" });
    const rollbackResults: Array<DeploymentRecord["rollbackResults"][number]> = [];
    const completedTargets = new Set(completed.map(({ operation }) => operation.targetPath));

    for (const { operation, resultingHash } of [...completed].reverse()) {
      try {
        const result = await this.compensate(operation, rolling, request, resultingHash);
        rollbackResults.push(result);
      } catch {
        rollbackResults.push({
          targetPath: operation.targetPath,
          status: "failed",
          diagnosticIds: [],
        });
      }
    }

    for (const operation of plan.operations) {
      if (completedTargets.has(operation.targetPath)) continue;
      rollbackResults.push(await this.verifyUncompletedOperation(operation, request.allowedRoots));
    }

    const failedRollback = rollbackResults.some(({ status }) => status === "failed");
    const diagnostics = [
      ...rolling.diagnostics,
      internalDiagnostic(
        "DEPLOYMENT_ROLLED_BACK",
        cause instanceof Error ? cause.message : "Deployment failed and was rolled back",
        request.now,
        rolling.deploymentRecordId,
      ),
    ];
    return this.transition(rolling, "rolling_back", {
      status: failedRollback ? "failed" : "rolled_back",
      rollbackResults,
      diagnostics,
      finishedAt: request.now,
    });
  }

  private async compensate(
    operation: DeploymentOperation,
    record: DeploymentRecord,
    request: ExecuteDeploymentRequest,
    resultingHash: ContentHash | undefined,
  ): Promise<DeploymentRecord["rollbackResults"][number]> {
    if (operation.kind === "create") {
      const snapshot = await this.options.snapshots.snapshot({
        path: operation.targetPath,
        allowedRoots: request.allowedRoots,
      });
      if (snapshot !== undefined) {
        try {
          await this.options.deploymentFiles.remove({
            target: operation.targetPath,
            expectedHash: resultingHash ?? snapshot.contentHash,
          });
        } catch (cause) {
          const verified = await this.options.snapshots.snapshot({
            path: operation.targetPath,
            allowedRoots: request.allowedRoots,
          });
          if (verified !== undefined) throw cause;
        }
      }
      const verified = await this.options.snapshots.snapshot({
        path: operation.targetPath,
        allowedRoots: request.allowedRoots,
      });
      if (verified !== undefined) {
        throw appError("STALE_INDEX", `Rollback did not remove ${operation.targetPath}`, true);
      }
      return { targetPath: operation.targetPath, status: "removed", diagnosticIds: [] };
    }

    const backupLocation = record.backupLocations[operation.targetPath];
    if (backupLocation === undefined || backupLocation === "previously-absent") {
      throw appError("BACKUP_MISSING", `Missing backup for ${operation.targetPath}`);
    }
    const backup = await this.options.snapshots.snapshot({
      path: backupLocation,
      allowedRoots: [backupLocation],
    });
    if (backup === undefined) {
      throw appError("BACKUP_MISSING", `Missing backup for ${operation.targetPath}`);
    }
    const current = await this.options.snapshots.snapshot({
      path: operation.targetPath,
      allowedRoots: request.allowedRoots,
    });
    if (current?.contentHash !== resultingHash) {
      throw appError(
        "STALE_INDEX",
        `Target changed again before rollback: ${operation.targetPath}`,
        true,
      );
    }
    try {
      await this.options.deploymentFiles.atomicReplace({
        target: operation.targetPath,
        text: backup.text,
        expectedHash: current?.contentHash ?? "absent",
      });
    } catch (cause) {
      const verified = await this.options.snapshots.snapshot({
        path: operation.targetPath,
        allowedRoots: request.allowedRoots,
      });
      if (verified?.contentHash !== backup.contentHash) throw cause;
    }
    const verified = await this.options.snapshots.snapshot({
      path: operation.targetPath,
      allowedRoots: request.allowedRoots,
    });
    if (verified?.contentHash !== backup.contentHash) {
      throw appError("STALE_INDEX", `Rollback did not restore ${operation.targetPath}`, true);
    }
    return {
      targetPath: operation.targetPath,
      status: "restored",
      resultingHash: backup.contentHash,
      diagnosticIds: [],
    };
  }

  private async verifyUncompletedOperation(
    operation: DeploymentOperation,
    allowedRoots: readonly AbsolutePath[],
  ): Promise<DeploymentRecord["rollbackResults"][number]> {
    const snapshot = await this.options.snapshots.snapshot({
      path: operation.targetPath,
      allowedRoots,
    });
    if (operation.kind === "create") {
      return {
        targetPath: operation.targetPath,
        status: snapshot === undefined ? "removed" : "failed",
        diagnosticIds: [],
      };
    }
    if (snapshot?.contentHash !== operation.expectedTargetHash) {
      return { targetPath: operation.targetPath, status: "failed", diagnosticIds: [] };
    }
    return {
      targetPath: operation.targetPath,
      status: "restored",
      resultingHash: snapshot.contentHash,
      diagnosticIds: [],
    };
  }

  private async fail(
    record: DeploymentRecord,
    expectedStatus: DeploymentRecord["status"],
    now: IsoDateTime,
    cause: unknown,
  ): Promise<DeploymentRecord> {
    return this.transition(record, expectedStatus, {
      status: "failed",
      diagnostics: [
        ...record.diagnostics,
        internalDiagnostic(
          "DEPLOYMENT_FAILED",
          cause instanceof Error ? cause.message : "Deployment failed",
          now,
          record.deploymentRecordId,
        ),
      ],
      finishedAt: now,
    });
  }

  private async transition(
    record: DeploymentRecord,
    expectedStatus: DeploymentRecord["status"],
    updates: Partial<MutableRecordFields>,
  ): Promise<DeploymentRecord> {
    const next = withRecord(record, updates);
    const ok = await this.options.deploymentRepository.compareAndSetRecord({
      expectedStatus,
      record: next,
    });
    if (!ok) {
      throw appError("CONFLICT", `Deployment state changed during ${expectedStatus}`, true);
    }
    return next;
  }
}
