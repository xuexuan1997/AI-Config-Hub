import { DiagnosticIdSchema, ScanRunIdSchema, TaskIdSchema } from "@ai-config-hub/shared";
import { z } from "zod";

export const ScanRunStatusSchema = z.enum([
  "queued",
  "detecting",
  "discovering",
  "parsing",
  "resolving",
  "diagnosing",
  "indexing",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
]);
export type ScanRunStatus = z.infer<typeof ScanRunStatusSchema>;

export const DeploymentStatusSchema = z.enum([
  "planned",
  "confirmed",
  "backed_up",
  "writing",
  "verifying",
  "succeeded",
  "failed",
  "rolling_back",
  "rolled_back",
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

export const ScanRunSummarySchema = z
  .object({
    scanRunId: ScanRunIdSchema,
    status: z.enum(["succeeded", "partially_succeeded", "failed", "cancelled"]),
    succeededCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    diagnosticIds: z.array(DiagnosticIdSchema).readonly(),
  })
  .strict()
  .superRefine((summary, context) => {
    if (
      summary.status === "partially_succeeded" &&
      (summary.succeededCount === 0 || summary.failedCount === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Partial success requires both successful and failed items",
        path: ["status"],
      });
    }
    if (summary.status === "succeeded" && summary.failedCount > 0) {
      context.addIssue({
        code: "custom",
        message: "Succeeded scans cannot contain failed items",
        path: ["failedCount"],
      });
    }
  })
  .readonly();
export type ScanRunSummary = z.infer<typeof ScanRunSummarySchema>;

export const TaskProgressSchema = z
  .object({
    taskId: TaskIdSchema,
    sequence: z.number().int().nonnegative(),
    phase: z.string().trim().min(1).max(100),
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    message: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((progress) => progress.completed <= progress.total, {
    message: "Task progress cannot exceed its total",
    path: ["completed"],
  })
  .readonly();
export type TaskProgress = z.infer<typeof TaskProgressSchema>;

const scanTransitions: Readonly<Record<ScanRunStatus, readonly ScanRunStatus[]>> = {
  queued: ["detecting", "cancelled"],
  detecting: ["discovering", "failed", "cancelled"],
  discovering: ["parsing", "failed", "cancelled"],
  parsing: ["resolving", "cancelled"],
  resolving: ["diagnosing", "failed"],
  diagnosing: ["indexing"],
  indexing: ["succeeded", "partially_succeeded", "failed"],
  succeeded: [],
  partially_succeeded: [],
  failed: [],
  cancelled: [],
};

const deploymentTransitions: Readonly<Record<DeploymentStatus, readonly DeploymentStatus[]>> = {
  planned: ["confirmed", "failed"],
  confirmed: ["backed_up", "failed"],
  backed_up: ["writing"],
  writing: ["verifying", "rolling_back"],
  verifying: ["succeeded", "rolling_back"],
  succeeded: [],
  failed: [],
  rolling_back: ["rolled_back", "failed"],
  rolled_back: [],
};

export function isScanTransitionAllowed(from: ScanRunStatus, to: ScanRunStatus): boolean {
  return scanTransitions[from].includes(to);
}

export function isDeploymentTransitionAllowed(
  from: DeploymentStatus,
  to: DeploymentStatus,
): boolean {
  return deploymentTransitions[from].includes(to);
}
