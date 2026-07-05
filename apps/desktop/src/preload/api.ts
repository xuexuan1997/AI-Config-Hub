import type {
  ApiCommandName,
  ApiResponse,
  CommandRequest,
  CommandResponse,
  TaskEvent,
} from "@ai-config-hub/api";
import { API_COMMAND_NAMES, commandChannel, TASK_EVENT_CHANNEL } from "@ai-config-hub/api";

import {
  APP_VERSION_CHANNEL,
  SELECT_PROJECT_ROOT_CHANNEL,
  TASK_SUBSCRIBE_CHANNEL,
  TASK_UNSUBSCRIBE_CHANNEL,
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_EVENT_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATUS_CHANNEL,
} from "../main/ipc.js";
import type { UpdateStatus } from "../main/updates.js";

const supportedCommandNames = new Set<string>(API_COMMAND_NAMES);

export interface DesktopApi {
  invoke<Name extends ApiCommandName>(
    name: Name,
    payload: CommandRequest<Name>,
  ): Promise<ApiResponse<CommandResponse<Name>>>;
  subscribeTask(
    taskId: string,
    afterSequence: number,
    listener: (event: TaskEvent) => void,
  ): () => void;
  selectProjectRoot(): Promise<string | undefined>;
  appVersion(): Promise<string>;
  updateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
  subscribeUpdates(listener: (status: UpdateStatus) => void): () => void;
}

export interface PreloadTransport {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void;
  off: (channel: string, listener: (event: unknown, payload: unknown) => void) => void;
}

export interface PreloadApiOptions {
  readonly requestId: () => string;
}

export function createDesktopApi(
  transport: PreloadTransport,
  options: PreloadApiOptions,
): DesktopApi {
  async function invoke<Name extends ApiCommandName>(
    name: Name,
    payload: CommandRequest<Name>,
  ): Promise<ApiResponse<CommandResponse<Name>>> {
    return (await transport.invoke(commandChannelFor(name), {
      apiVersion: 1,
      requestId: options.requestId(),
      payload,
    })) as ApiResponse<CommandResponse<Name>>;
  }

  function subscribeTask(
    taskId: string,
    afterSequence: number,
    listener: (event: TaskEvent) => void,
  ): () => void {
    const wrapped = (_event: unknown, payload: unknown) => {
      listener(payload as TaskEvent);
    };
    transport.on(TASK_EVENT_CHANNEL, wrapped);
    void transport.invoke(TASK_SUBSCRIBE_CHANNEL, { taskId, afterSequence });
    return () => {
      transport.off(TASK_EVENT_CHANNEL, wrapped);
      void transport.invoke(TASK_UNSUBSCRIBE_CHANNEL, { taskId });
    };
  }

  return Object.freeze({
    invoke,
    subscribeTask,
    selectProjectRoot() {
      return transport.invoke(SELECT_PROJECT_ROOT_CHANNEL) as Promise<string | undefined>;
    },
    appVersion() {
      return transport.invoke(APP_VERSION_CHANNEL) as Promise<string>;
    },
    updateStatus() {
      return transport.invoke(UPDATE_STATUS_CHANNEL) as Promise<UpdateStatus>;
    },
    checkForUpdates() {
      return transport.invoke(UPDATE_CHECK_CHANNEL) as Promise<UpdateStatus>;
    },
    downloadUpdate() {
      return transport.invoke(UPDATE_DOWNLOAD_CHANNEL) as Promise<UpdateStatus>;
    },
    async installUpdate() {
      await transport.invoke(UPDATE_INSTALL_CHANNEL);
    },
    subscribeUpdates(listener: (status: UpdateStatus) => void): () => void {
      const wrapped = (_event: unknown, payload: unknown) => {
        listener(payload as UpdateStatus);
      };
      transport.on(UPDATE_EVENT_CHANNEL, wrapped);
      return () => {
        transport.off(UPDATE_EVENT_CHANNEL, wrapped);
      };
    },
  });
}

function commandChannelFor(name: ApiCommandName): string {
  if (!supportedCommandNames.has(name)) throw new Error("Unsupported API command");
  return commandChannel(name);
}
