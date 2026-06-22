import { z } from "zod";

import { CorrelationIdSchema, TaskIdSchema } from "./primitives.js";

export const ErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "API_VERSION_UNSUPPORTED",
  "NOT_FOUND",
  "CONFLICT",
  "PATH_OUTSIDE_ALLOWED_ROOT",
  "PERMISSION_DENIED",
  "READ_ONLY_RECOVERY",
  "STALE_INDEX",
  "STALE_PREVIEW",
  "USER_CANCELLED",
  "TASK_NOT_CANCELLABLE",
  "INTERNAL_ERROR",
  "SCAN_ALREADY_RUNNING",
  "CURSOR_INVALID",
  "ADAPTER_VERSION_UNSUPPORTED",
  "RESOLUTION_FAILED",
  "UNSUPPORTED_CONVERSION",
  "TARGET_CONFLICT",
  "PREVIEW_TOO_LARGE",
  "TARGET_LOCKED",
  "FENCE_REJECTED",
  "BACKUP_MISSING",
  "BACKUP_HASH_MISMATCH",
  "STALE_TARGET",
  "SETTING_NOT_PUBLIC",
  "SYMLINK_ESCAPE",
  "INCOMPATIBLE_DOWNGRADE",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const SafeContextValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type SafeContextValue = z.infer<typeof SafeContextValueSchema>;

export const SafeContextSchema = z.record(z.string().min(1).max(100), SafeContextValueSchema);
export type SafeContext = z.infer<typeof SafeContextSchema>;

export const AppErrorJsonSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean(),
    suggestedActions: z.array(z.string().trim().min(1).max(500)).min(1),
    safeContext: SafeContextSchema.optional(),
    correlationId: CorrelationIdSchema.optional(),
    taskId: TaskIdSchema.optional(),
  })
  .strict();
export type AppErrorJson = z.infer<typeof AppErrorJsonSchema>;

export type AppErrorOptions = AppErrorJson & { readonly cause?: unknown };

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly suggestedActions: readonly string[];
  readonly safeContext?: SafeContext;
  readonly correlationId?: AppErrorJson["correlationId"];
  readonly taskId?: AppErrorJson["taskId"];

  constructor(options: AppErrorOptions) {
    const code = ErrorCodeSchema.safeParse(options.code);
    if (!code.success) {
      throw new TypeError("Invalid error code");
    }

    const { cause, ...json } = options;
    const parsed = AppErrorJsonSchema.parse(json);
    super(parsed.message, { cause });
    this.name = "AppError";
    this.code = parsed.code;
    this.retryable = parsed.retryable;
    this.suggestedActions = Object.freeze([...parsed.suggestedActions]);
    if (parsed.safeContext !== undefined)
      this.safeContext = Object.freeze({ ...parsed.safeContext });
    if (parsed.correlationId !== undefined) this.correlationId = parsed.correlationId;
    if (parsed.taskId !== undefined) this.taskId = parsed.taskId;
  }

  toJSON(): AppErrorJson {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      suggestedActions: [...this.suggestedActions],
      ...(this.safeContext === undefined ? {} : { safeContext: this.safeContext }),
      ...(this.correlationId === undefined ? {} : { correlationId: this.correlationId }),
      ...(this.taskId === undefined ? {} : { taskId: this.taskId }),
    };
  }
}
