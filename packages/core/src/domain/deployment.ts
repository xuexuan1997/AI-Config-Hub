import {
  AbsolutePathSchema,
  AdapterIdSchema,
  ContentHashSchema,
  ConversionResultIdSchema,
  CorrelationIdSchema,
  DeploymentPlanIdSchema,
  DeploymentRecordIdSchema,
  IsoDateTimeSchema,
  ResourceKindSchema,
  SemVerSchema,
} from "@ai-config-hub/shared";
import { z } from "zod";

import { DiagnosticSchema } from "./diagnostic.js";
import { DeploymentStatusSchema } from "./task.js";

export const DeploymentOperationTypeSchema = z.enum(["copy", "symlink", "generated_file"]);
export type DeploymentOperationType = z.infer<typeof DeploymentOperationTypeSchema>;

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
  })
  .readonly();
export type DeploymentPlan = z.infer<typeof DeploymentPlanSchema>;

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
