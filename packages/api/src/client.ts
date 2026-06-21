import { RequestIdSchema } from "@ai-config-hub/shared";
import type { z } from "zod";

import {
  type ApiCommandName,
  type CommandRequest,
  CommandRequestSchemas,
  type CommandResponse,
  CommandResponseSchemas,
  commandChannel,
} from "./commands.js";
import { type ApiResponse, createApiRequestSchema, createApiResponseSchema } from "./envelope.js";
import { type TaskEvent, type TaskEventCursorResult, createTaskEventCursor } from "./events.js";

export interface ApiTransport {
  invoke(channel: string, request: unknown): Promise<unknown>;
  subscribeTask(
    taskId: string,
    afterSequence: number,
    listener: (event: unknown) => void,
  ): () => void;
}

export interface ApiClientOptions {
  readonly requestId: () => string;
}

export interface TaskSubscription {
  readonly unsubscribe: () => void;
  readonly sequence: () => number;
}

export interface ApiClient {
  invoke<Name extends ApiCommandName>(
    name: Name,
    payload: CommandRequest<Name>,
  ): Promise<ApiResponse<CommandResponse<Name>>>;
  subscribeTask(
    taskId: string,
    afterSequence: number,
    listener: (event: TaskEvent) => void,
    onCursorResult?: (result: TaskEventCursorResult) => void,
  ): TaskSubscription;
}

export function createApiClient(transport: ApiTransport, options: ApiClientOptions): ApiClient {
  return {
    async invoke<Name extends ApiCommandName>(
      name: Name,
      payload: CommandRequest<Name>,
    ): Promise<ApiResponse<CommandResponse<Name>>> {
      const requestId = RequestIdSchema.parse(options.requestId());
      const payloadSchema: z.ZodType = CommandRequestSchemas[name];
      const responseDataSchema: z.ZodType = CommandResponseSchemas[name];
      const request = createApiRequestSchema(payloadSchema).parse({
        apiVersion: 1,
        requestId,
        payload,
      });
      const rawResponse = await transport.invoke(commandChannel(name), request);
      const response = createApiResponseSchema(responseDataSchema).parse(rawResponse);
      if (response.requestId !== requestId) throw new Error("API_RESPONSE_REQUEST_ID_MISMATCH");
      return response as ApiResponse<CommandResponse<Name>>;
    },
    subscribeTask(taskId, afterSequence, listener, onCursorResult): TaskSubscription {
      const cursor = createTaskEventCursor(taskId, afterSequence, listener);
      const unsubscribe = transport.subscribeTask(taskId, afterSequence, (event) => {
        const result = cursor.push(event);
        onCursorResult?.(result);
      });
      return { unsubscribe, sequence: cursor.sequence };
    },
  };
}
