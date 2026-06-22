import {
  CorrelationIdSchema,
  ErrorCodeSchema,
  RequestIdSchema,
  SafeContextSchema,
  TaskIdSchema,
} from "@ai-config-hub/shared";
import { z } from "zod";

export const ApiVersionSchema = z.literal(1);
export type ApiVersion = z.infer<typeof ApiVersionSchema>;

export const ApiErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean(),
    action: z.string().trim().min(1).max(500).optional(),
    details: SafeContextSchema.optional(),
    correlationId: CorrelationIdSchema,
    taskId: TaskIdSchema.optional(),
  })
  .strict()
  .readonly();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export function createApiRequestSchema<Payload extends z.ZodType>(payload: Payload) {
  return z
    .object({
      apiVersion: ApiVersionSchema,
      requestId: RequestIdSchema,
      payload,
    })
    .strict()
    .readonly();
}

export function createApiSuccessSchema<Data extends z.ZodType>(data: Data) {
  return z
    .object({
      apiVersion: ApiVersionSchema,
      requestId: RequestIdSchema,
      ok: z.literal(true),
      data,
    })
    .strict()
    .readonly();
}

export const ApiFailureSchema = z
  .object({
    apiVersion: ApiVersionSchema,
    requestId: RequestIdSchema,
    ok: z.literal(false),
    error: ApiErrorSchema,
  })
  .strict()
  .readonly();
export type ApiFailure = z.infer<typeof ApiFailureSchema>;

export function createApiResponseSchema<Data extends z.ZodType>(data: Data) {
  return z.union([createApiSuccessSchema(data), ApiFailureSchema]);
}

export type ApiRequest<Payload> = Readonly<{
  apiVersion: 1;
  requestId: z.infer<typeof RequestIdSchema>;
  payload: Payload;
}>;

export type ApiSuccess<Data> = Readonly<{
  apiVersion: 1;
  requestId: z.infer<typeof RequestIdSchema>;
  ok: true;
  data: Data;
}>;

export type ApiResponse<Data> = ApiSuccess<Data> | ApiFailure;
