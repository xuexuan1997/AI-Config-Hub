import {
  AbsolutePathSchema,
  AdapterIdSchema,
  AssetIdSchema,
  ContentHashSchema,
  ConversionResultIdSchema,
  CorrelationIdSchema,
  DeploymentPlanIdSchema,
  DeploymentRecordIdSchema,
  IsoDateTimeSchema,
  ProjectIdSchema,
  ResourceKindSchema,
  SemVerSchema,
  TaskIdSchema,
} from "@ai-config-hub/shared";
import { z } from "zod";

import { DiagnosticSchema } from "./diagnostic.js";
import { DeploymentStatusSchema } from "./task.js";

export const CHANGE_DETAIL_LIMIT = 50;
export const GROUP_TARGET_PATH_SAMPLE_LIMIT = 10;
export const PACKAGE_PATH_SAMPLE_LIMIT = 10;
export const HASH_SAMPLE_LIMIT = 20;

export const DeploymentOperationTypeSchema = z.enum(["copy", "symlink", "generated_file"]);
export type DeploymentOperationType = z.infer<typeof DeploymentOperationTypeSchema>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const operationMetadataShape = {
  deploymentType: DeploymentOperationTypeSchema.default("generated_file"),
  sourcePath: AbsolutePathSchema.optional(),
  sourceHash: ContentHashSchema.optional(),
} as const;

const generatedTargetMetadataShape = {
  ...operationMetadataShape,
  targetResourceKind: ResourceKindSchema.optional(),
} as const;

const CreateOperationSchema = z
  .object({
    ...generatedTargetMetadataShape,
    kind: z.literal("create"),
    targetPath: AbsolutePathSchema,
    nextText: z.string().optional(),
    expectedTargetHash: z.literal("absent"),
  })
  .strict()
  .readonly();
const ReplaceOperationSchema = z
  .object({
    ...generatedTargetMetadataShape,
    kind: z.literal("replace"),
    targetPath: AbsolutePathSchema,
    nextText: z.string().optional(),
    expectedTargetHash: ContentHashSchema,
  })
  .strict()
  .readonly();
const DeleteOperationSchema = z
  .object({
    ...operationMetadataShape,
    kind: z.literal("delete"),
    targetPath: AbsolutePathSchema,
    expectedTargetHash: ContentHashSchema,
  })
  .strict()
  .readonly();

export const DeploymentOperationSchema = z
  .discriminatedUnion("kind", [
    CreateOperationSchema,
    ReplaceOperationSchema,
    DeleteOperationSchema,
  ])
  .superRefine((operation, context) => {
    const deploymentType = operation.deploymentType ?? "generated_file";
    const isSourceDeployment = deploymentType === "copy" || deploymentType === "symlink";

    if (operation.kind === "delete") {
      if (isSourceDeployment) {
        context.addIssue({
          code: "custom",
          message: "Copy and symlink deployment operations cannot delete targets",
          path: ["deploymentType"],
        });
      }
      if (operation.sourcePath !== undefined || operation.sourceHash !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Delete deployment operations cannot carry source metadata",
          path: ["sourcePath"],
        });
      }
      return;
    }

    if (isSourceDeployment) {
      if (operation.sourcePath === undefined) {
        context.addIssue({
          code: "custom",
          message: "Copy and symlink deployment operations require sourcePath",
          path: ["sourcePath"],
        });
      }
      if (operation.sourceHash === undefined) {
        context.addIssue({
          code: "custom",
          message: "Copy and symlink deployment operations require sourceHash",
          path: ["sourceHash"],
        });
      }
      if (operation.nextText !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Copy and symlink deployment operations cannot carry nextText",
          path: ["nextText"],
        });
      }
      return;
    }

    if (operation.nextText === undefined) {
      context.addIssue({
        code: "custom",
        message: "Generated deployment operations require nextText",
        path: ["nextText"],
      });
    }
    if (operation.sourcePath !== undefined || operation.sourceHash !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Generated deployment operations cannot carry source metadata",
        path: ["sourcePath"],
      });
    }
  });
type ParsedDeploymentOperation = z.output<typeof DeploymentOperationSchema>;
export type DeploymentOperation =
  | (Omit<Extract<ParsedDeploymentOperation, { readonly kind: "create" }>, "deploymentType"> & {
      readonly deploymentType?: DeploymentOperationType;
    })
  | (Omit<Extract<ParsedDeploymentOperation, { readonly kind: "replace" }>, "deploymentType"> & {
      readonly deploymentType?: DeploymentOperationType;
    })
  | (Omit<Extract<ParsedDeploymentOperation, { readonly kind: "delete" }>, "deploymentType"> & {
      readonly deploymentType?: DeploymentOperationType;
    });

export const DeploymentDiffSchema = z
  .object({
    targetPath: AbsolutePathSchema,
    summary: z.string().trim().min(1),
    unifiedText: z.string(),
  })
  .strict()
  .readonly();

const OperationCountSchema = z.number().int().nonnegative();

export const DeploymentOperationGroupSchema = z
  .object({
    groupId: z.string().trim().min(1),
    sourceAssetId: AssetIdSchema.optional(),
    resourceKind: ResourceKindSchema.optional(),
    targetRootPath: AbsolutePathSchema,
    targetRootRelativePath: z.string().trim().min(1).optional(),
    operation: z.enum(["create", "replace", "delete", "mixed"]),
    operationCount: z.number().int().min(1),
    createCount: OperationCountSchema,
    replaceCount: OperationCountSchema,
    deleteCount: OperationCountSchema,
    generatedFileCount: OperationCountSchema,
    copyCount: OperationCountSchema,
    symlinkCount: OperationCountSchema,
    targetPaths: z.array(AbsolutePathSchema).min(1).readonly(),
    packageOutputCount: OperationCountSchema.optional(),
    packagePathSample: z
      .array(z.string().trim().min(1))
      .max(PACKAGE_PATH_SAMPLE_LIMIT)
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();
export type DeploymentOperationGroup = z.infer<typeof DeploymentOperationGroupSchema>;

export const DeploymentIssueSummarySchema = z
  .object({
    planWarningCount: OperationCountSchema,
    conversionWarningCount: OperationCountSchema,
    partialConversionCount: OperationCountSchema,
    droppedFieldCount: OperationCountSchema,
    transformedFieldCount: OperationCountSchema,
  })
  .strict()
  .readonly();
export type DeploymentIssueSummary = z.infer<typeof DeploymentIssueSummarySchema>;

const BackupPolicySchema = z
  .object({
    mode: z.literal("required"),
    backupRoot: AbsolutePathSchema,
  })
  .strict()
  .readonly();

const VerificationStrategySchema = z
  .object({
    kind: z.literal("adapter"),
    description: z.string().trim().min(1),
  })
  .strict()
  .readonly();

export const DeploymentPlanSchema = z
  .object({
    deploymentPlanId: DeploymentPlanIdSchema,
    conversionResultIds: z.array(ConversionResultIdSchema).min(1).readonly(),
    operations: z.array(DeploymentOperationSchema).min(1).readonly(),
    operationGroups: z.array(DeploymentOperationGroupSchema).readonly().optional(),
    diffs: z.array(DeploymentDiffSchema).readonly(),
    expectedSourceHashes: z.record(z.string().min(1), ContentHashSchema).readonly(),
    expectedTargetHashes: z
      .record(AbsolutePathSchema, z.union([ContentHashSchema, z.literal("absent")]))
      .readonly(),
    backupPolicy: BackupPolicySchema,
    verificationStrategy: VerificationStrategySchema,
    requiredConfirmations: z
      .array(z.enum(["partial_conversion", "overwrite", "delete"]))
      .readonly(),
    warnings: z.array(z.string().trim().min(1)).readonly(),
    issueSummary: DeploymentIssueSummarySchema.optional(),
    planHash: ContentHashSchema,
    adapterId: AdapterIdSchema,
    adapterVersion: SemVerSchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((plan, context) => {
    const targets = plan.operations.map((operation) => operation.targetPath);
    if (new Set(targets).size !== targets.length) {
      context.addIssue({
        code: "custom",
        message: "Deployment operation target paths must be unique",
        path: ["operations"],
      });
    }
    if (plan.operationGroups !== undefined) {
      validateOperationGroups(
        { operations: plan.operations, operationGroups: plan.operationGroups },
        context,
      );
    }
    if (
      plan.issueSummary !== undefined &&
      plan.issueSummary.planWarningCount + plan.issueSummary.conversionWarningCount !==
        plan.warnings.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Deployment issue summary warning counts must match plan warnings",
        path: ["issueSummary"],
      });
    }
  })
  .readonly();
export type DeploymentPlan = z.infer<typeof DeploymentPlanSchema>;

export function operationGroupsForPlan(plan: DeploymentPlan): readonly DeploymentOperationGroup[] {
  if (plan.operationGroups !== undefined) return plan.operationGroups;
  return plan.operations.map((operation) => fallbackOperationGroup(operation));
}

function validateOperationGroups(
  plan: {
    readonly operations: readonly ParsedDeploymentOperation[];
    readonly operationGroups: readonly DeploymentOperationGroup[] | undefined;
  },
  context: z.RefinementCtx,
): void {
  const operationsByTarget = new Map(
    plan.operations.map((operation) => [operation.targetPath, operation]),
  );
  const groupedTargets = new Set<string>();

  for (const [groupIndex, group] of (plan.operationGroups ?? []).entries()) {
    const groupOperations: ParsedDeploymentOperation[] = [];

    for (const [targetIndex, targetPath] of group.targetPaths.entries()) {
      const operation = operationsByTarget.get(targetPath);
      if (operation === undefined) {
        context.addIssue({
          code: "custom",
          message: "Operation group target paths must reference deployment operations",
          path: ["operationGroups", groupIndex, "targetPaths", targetIndex],
        });
        continue;
      }
      if (groupedTargets.has(targetPath)) {
        context.addIssue({
          code: "custom",
          message: "Operation group target paths must be unique across groups",
          path: ["operationGroups", groupIndex, "targetPaths", targetIndex],
        });
      }
      groupedTargets.add(targetPath);
      groupOperations.push(operation);
    }

    validateGroupCounts(group, groupOperations, groupIndex, context);
    validatePackageContext(group, groupIndex, context);
  }

  for (const [operationIndex, operation] of plan.operations.entries()) {
    if (!groupedTargets.has(operation.targetPath)) {
      context.addIssue({
        code: "custom",
        message: "Every deployment operation must appear in exactly one operation group",
        path: ["operations", operationIndex, "targetPath"],
      });
    }
  }
}

function validateGroupCounts(
  group: DeploymentOperationGroup,
  operations: readonly ParsedDeploymentOperation[],
  groupIndex: number,
  context: z.RefinementCtx,
): void {
  if (group.targetPaths.length !== group.operationCount) {
    context.addIssue({
      code: "custom",
      message: "Operation group target path count must equal operationCount",
      path: ["operationGroups", groupIndex, "operationCount"],
    });
  }
  if (operations.length !== group.targetPaths.length) return;

  const createCount = operations.filter(({ kind }) => kind === "create").length;
  const replaceCount = operations.filter(({ kind }) => kind === "replace").length;
  const deleteCount = operations.filter(({ kind }) => kind === "delete").length;
  const generatedFileCount = operations.filter(
    (operation) => deploymentTypeFor(operation) === "generated_file",
  ).length;
  const copyCount = operations.filter(
    (operation) => deploymentTypeFor(operation) === "copy",
  ).length;
  const symlinkCount = operations.filter(
    (operation) => deploymentTypeFor(operation) === "symlink",
  ).length;
  const operationKinds = [...new Set(operations.map(({ kind }) => kind))];
  const expectedOperation = operationKinds.length === 1 ? operationKinds[0] : "mixed";

  assertGroupCount(group.createCount, createCount, groupIndex, "createCount", context);
  assertGroupCount(group.replaceCount, replaceCount, groupIndex, "replaceCount", context);
  assertGroupCount(group.deleteCount, deleteCount, groupIndex, "deleteCount", context);
  assertGroupCount(
    group.generatedFileCount,
    generatedFileCount,
    groupIndex,
    "generatedFileCount",
    context,
  );
  assertGroupCount(group.copyCount, copyCount, groupIndex, "copyCount", context);
  assertGroupCount(group.symlinkCount, symlinkCount, groupIndex, "symlinkCount", context);

  if (group.createCount + group.replaceCount + group.deleteCount !== group.operationCount) {
    context.addIssue({
      code: "custom",
      message: "Operation group kind counts must equal operationCount",
      path: ["operationGroups", groupIndex, "operationCount"],
    });
  }
  if (group.generatedFileCount + group.copyCount + group.symlinkCount !== group.operationCount) {
    context.addIssue({
      code: "custom",
      message: "Operation group deployment type counts must equal operationCount",
      path: ["operationGroups", groupIndex, "operationCount"],
    });
  }
  if (group.operation !== expectedOperation) {
    context.addIssue({
      code: "custom",
      message: "Operation group operation must match grouped operation kinds",
      path: ["operationGroups", groupIndex, "operation"],
    });
  }
}

function assertGroupCount(
  actual: number,
  expected: number,
  groupIndex: number,
  field: keyof Pick<
    DeploymentOperationGroup,
    | "createCount"
    | "replaceCount"
    | "deleteCount"
    | "generatedFileCount"
    | "copyCount"
    | "symlinkCount"
  >,
  context: z.RefinementCtx,
): void {
  if (actual === expected) return;
  context.addIssue({
    code: "custom",
    message: "Operation group counts must match grouped operations",
    path: ["operationGroups", groupIndex, field],
  });
}

function validatePackageContext(
  group: DeploymentOperationGroup,
  groupIndex: number,
  context: z.RefinementCtx,
): void {
  if (group.packageOutputCount !== undefined && group.packageOutputCount < group.operationCount) {
    context.addIssue({
      code: "custom",
      message: "Operation group packageOutputCount must be at least operationCount",
      path: ["operationGroups", groupIndex, "packageOutputCount"],
    });
  }

  if (group.packagePathSample === undefined) return;
  const uniqueSample = new Set(group.packagePathSample);
  if (uniqueSample.size !== group.packagePathSample.length) {
    context.addIssue({
      code: "custom",
      message: "Operation group packagePathSample entries must be unique",
      path: ["operationGroups", groupIndex, "packagePathSample"],
    });
  }
  const sortedSample = [...group.packagePathSample].sort(compareText);
  if (sortedSample.some((item, index) => item !== group.packagePathSample?.[index])) {
    context.addIssue({
      code: "custom",
      message: "Operation group packagePathSample entries must be stable sorted",
      path: ["operationGroups", groupIndex, "packagePathSample"],
    });
  }
  if (
    group.packageOutputCount !== undefined &&
    group.packagePathSample.length > group.packageOutputCount
  ) {
    context.addIssue({
      code: "custom",
      message: "Operation group packagePathSample cannot exceed packageOutputCount",
      path: ["operationGroups", groupIndex, "packagePathSample"],
    });
  }
}

function fallbackOperationGroup(operation: ParsedDeploymentOperation): DeploymentOperationGroup {
  const deploymentType = deploymentTypeFor(operation);
  return {
    groupId: `group:operation:${encodeURIComponent(operation.targetPath)}`,
    targetRootPath: operation.targetPath,
    operation: operation.kind,
    operationCount: 1,
    createCount: operation.kind === "create" ? 1 : 0,
    replaceCount: operation.kind === "replace" ? 1 : 0,
    deleteCount: operation.kind === "delete" ? 1 : 0,
    generatedFileCount: deploymentType === "generated_file" ? 1 : 0,
    copyCount: deploymentType === "copy" ? 1 : 0,
    symlinkCount: deploymentType === "symlink" ? 1 : 0,
    targetPaths: [operation.targetPath],
  };
}

function deploymentTypeFor(operation: ParsedDeploymentOperation): DeploymentOperationType {
  return operation.deploymentType ?? "generated_file";
}

export const VerificationResultSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("not_started"), diagnostics: z.array(DiagnosticSchema).readonly() })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal("passed"),
      verifiedHashes: z.record(AbsolutePathSchema, ContentHashSchema).readonly(),
      diagnostics: z.array(DiagnosticSchema).readonly(),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal("failed"),
      verifiedHashes: z.record(AbsolutePathSchema, ContentHashSchema).readonly(),
      diagnostics: z.array(DiagnosticSchema).min(1).readonly(),
    })
    .strict()
    .readonly(),
]);

const RollbackResultSchema = z
  .object({
    targetPath: AbsolutePathSchema,
    status: z.enum(["restored", "removed", "failed"]),
    resultingHash: ContentHashSchema.optional(),
    diagnosticIds: z.array(z.string().min(1)).readonly(),
  })
  .strict()
  .readonly();

const OperationJournalEntrySchema = z
  .object({
    targetPath: AbsolutePathSchema,
    operationKind: z.enum(["create", "replace", "delete"]),
    phase: z.enum(["intent", "completed"]),
    expectedTargetHash: z.union([ContentHashSchema, z.literal("absent")]),
    resultingHash: ContentHashSchema.optional(),
    recordedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();

export const DeploymentRecordSchema = z
  .object({
    deploymentRecordId: DeploymentRecordIdSchema,
    deploymentPlanId: DeploymentPlanIdSchema,
    rollbackOfRecordId: DeploymentRecordIdSchema.optional(),
    taskId: TaskIdSchema.optional(),
    projectId: ProjectIdSchema.optional(),
    confirmedPlanHash: ContentHashSchema.optional(),
    status: DeploymentStatusSchema,
    operations: z.array(DeploymentOperationSchema).readonly(),
    backupLocations: z
      .record(AbsolutePathSchema, z.union([AbsolutePathSchema, z.literal("previously-absent")]))
      .readonly(),
    resultingHashes: z.record(AbsolutePathSchema, ContentHashSchema).readonly(),
    operationJournal: z.array(OperationJournalEntrySchema).readonly().optional(),
    verificationResult: VerificationResultSchema,
    rollbackResults: z.array(RollbackResultSchema).readonly(),
    adapterId: AdapterIdSchema,
    adapterVersion: SemVerSchema,
    normalizedSchemaVersion: SemVerSchema,
    createdAt: IsoDateTimeSchema,
    confirmedAt: IsoDateTimeSchema.optional(),
    startedAt: IsoDateTimeSchema.optional(),
    finishedAt: IsoDateTimeSchema.optional(),
    correlationId: CorrelationIdSchema,
    diagnostics: z.array(DiagnosticSchema).readonly(),
  })
  .strict()
  .superRefine((record, context) => {
    const confirmedStatuses = new Set([
      "confirmed",
      "backed_up",
      "writing",
      "verifying",
      "succeeded",
      "rolling_back",
      "rolled_back",
    ]);
    if (
      confirmedStatuses.has(record.status) &&
      (record.confirmedAt === undefined || record.confirmedPlanHash === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Confirmed and later records require confirmation evidence",
        path: ["confirmedPlanHash"],
      });
    }
    if (record.status === "succeeded" && record.verificationResult.status !== "passed") {
      context.addIssue({
        code: "custom",
        message: "Succeeded deployments require passed verification",
        path: ["verificationResult"],
      });
    }
    if (
      ["writing", "verifying", "succeeded", "rolling_back", "rolled_back"].includes(record.status)
    ) {
      if (record.startedAt === undefined) {
        context.addIssue({
          code: "custom",
          message: "Writing and later deployment records require startedAt",
          path: ["startedAt"],
        });
      }
      for (const operation of record.operations) {
        if (!Object.hasOwn(record.backupLocations, operation.targetPath)) {
          context.addIssue({
            code: "custom",
            message: "Every written target requires a backup association",
            path: ["backupLocations", operation.targetPath],
          });
        }
      }
    }
    if (record.status === "rolled_back") {
      for (const operation of record.operations) {
        const rollback = record.rollbackResults.find(
          (result) => result.targetPath === operation.targetPath,
        );
        if (rollback === undefined || rollback.status === "failed") {
          context.addIssue({
            code: "custom",
            message: "Rolled-back deployments require verified compensation for every target",
            path: ["rollbackResults", operation.targetPath],
          });
        }
      }
    }
    if (
      ["succeeded", "failed", "rolled_back"].includes(record.status) &&
      record.finishedAt === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Terminal deployment records require finishedAt",
        path: ["finishedAt"],
      });
    }
  })
  .readonly();
export type DeploymentRecord = z.infer<typeof DeploymentRecordSchema>;
