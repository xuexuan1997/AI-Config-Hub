import { AppError, CorrelationIdSchema, RequestIdSchema } from "@ai-config-hub/shared";
import { z } from "zod";

import {
  API_COMMAND_NAMES,
  type ApiCommandName,
  type CommandRequest,
  CommandRequestSchemas,
  type CommandResponse,
  CommandResponseSchemas,
} from "./commands.js";
import {
  type ApiError,
  type ApiRequest,
  type ApiResponse,
  createApiRequestSchema,
  createApiResponseSchema,
} from "./envelope.js";

export type CommandServiceMap = {
  readonly [Name in ApiCommandName]: (
    payload: CommandRequest<Name>,
  ) => Promise<CommandResponse<Name>>;
};

export type CommandHandlerMap = {
  readonly [Name in ApiCommandName]: (
    request: unknown,
  ) => Promise<ApiResponse<CommandResponse<Name>>>;
};

export interface CommandHandlerOptions {
  readonly correlationId?: () => string;
}

export function createCommandHandlers(
  services: CommandServiceMap,
  options: CommandHandlerOptions = {},
): CommandHandlerMap {
  return Object.fromEntries(
    API_COMMAND_NAMES.map((name) => [
      name,
      async (request: unknown) => handleCommand(name, services[name], request, options),
    ]),
  ) as CommandHandlerMap;
}

async function handleCommand<Name extends ApiCommandName>(
  name: Name,
  service: CommandServiceMap[Name],
  request: unknown,
  options: CommandHandlerOptions,
): Promise<ApiResponse<CommandResponse<Name>>> {
  const requestId = readRequestId(request);
  try {
    const payloadSchema = CommandRequestSchemas[name];
    const dataSchema = CommandResponseSchemas[name];
    const parsedRequest = createApiRequestSchema(payloadSchema).parse(request) as ApiRequest<
      CommandRequest<Name>
    >;
    const data = await service(parsedRequest.payload);
    return createApiResponseSchema(dataSchema).parse({
      apiVersion: 1,
      requestId: parsedRequest.requestId,
      ok: true,
      data,
    }) as ApiResponse<CommandResponse<Name>>;
  } catch (error) {
    return {
      apiVersion: 1,
      requestId,
      ok: false,
      error: toApiError(error, options),
    };
  }
}

function readRequestId(request: unknown): ApiRequest<unknown>["requestId"] {
  if (typeof request === "object" && request !== null && "requestId" in request) {
    const parsed = RequestIdSchema.safeParse(request.requestId);
    if (parsed.success) return parsed.data;
  }
  return RequestIdSchema.parse("request:invalid");
}

function toApiError(error: unknown, options: CommandHandlerOptions): ApiError {
  const correlationId = CorrelationIdSchema.parse(options.correlationId?.() ?? "correlation:api");
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      action: error.suggestedActions[0] ?? "Review the request and retry",
      ...(error.safeContext === undefined ? {} : { details: error.safeContext }),
      correlationId,
      ...(error.taskId === undefined ? {} : { taskId: error.taskId }),
    };
  }
  if (error instanceof z.ZodError) {
    return {
      code: "VALIDATION_FAILED",
      message: "Command request or response failed validation",
      retryable: false,
      action: "Review the command payload and retry",
      details: { issues: error.issues.length },
      correlationId,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "Command handler failed unexpectedly",
    retryable: false,
    action: "Check application logs and retry",
    correlationId,
  };
}
