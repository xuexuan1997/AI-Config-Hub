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
  INDEX_CHANGE_EVENT_CHANNEL,
  RUNTIME_STATE_CHANNEL,
  SELECT_PROJECT_ROOT_CHANNEL,
  TASK_SUBSCRIBE_CHANNEL,
  TASK_UNSUBSCRIBE_CHANNEL,
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_EVENT_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATUS_CHANNEL,
} from "../main/ipc.js";
import type { DesktopIndexChangeEvent } from "../main/ipc.js";
import type { DesktopRuntimeState } from "../main/composition.js";
import type { UpdateStatus } from "../main/updates.js";

export type { DesktopIndexChangeEvent } from "../main/ipc.js";

const supportedCommandNames = new Set<string>(API_COMMAND_NAMES);

export interface TaskSubscription {
  readonly ready: Promise<void>;
  unsubscribe(): void;
}

export interface DesktopApi {
  invoke<Name extends ApiCommandName>(
    name: Name,
    payload: CommandRequest<Name>,
  ): Promise<ApiResponse<CommandResponse<Name>>>;
  subscribeTask(
    taskId: string,
    afterSequence: number,
    listener: (event: TaskEvent) => void,
  ): TaskSubscription;
  selectProjectRoot(): Promise<string | undefined>;
  appVersion(): Promise<string>;
  updateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
  subscribeUpdates(listener: (status: UpdateStatus) => void): () => void;
  subscribeIndexChanges(listener: (event: DesktopIndexChangeEvent) => void): () => void;
  runtimeState(): Promise<DesktopRuntimeState>;
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
  let taskSubscriptionSequence = 0;

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
  ): TaskSubscription {
    taskSubscriptionSequence += 1;
    const subscriptionId = `task-subscription:${taskSubscriptionSequence}:${options.requestId()}`;
    let active = true;
    let remotelySubscribed = false;
    let remoteUnsubscribeRequested = false;
    const wrapped = (_event: unknown, payload: unknown) => {
      if (active && isTaskEventFor(payload, taskId)) listener(payload);
    };
    const unsubscribeRemote = () => {
      if (remoteUnsubscribeRequested) return;
      remoteUnsubscribeRequested = true;
      void invokeSafely(transport, TASK_UNSUBSCRIBE_CHANNEL, { taskId, subscriptionId });
    };
    transport.on(TASK_EVENT_CHANNEL, wrapped);
    const ready = Promise.resolve()
      .then(() =>
        transport.invoke(TASK_SUBSCRIBE_CHANNEL, {
          taskId,
          afterSequence,
          subscriptionId,
        }),
      )
      .then(
        (result) => {
          if (result !== true) {
            throw new Error(
              `Task event subscription for "${taskId}" was rejected by the main process.`,
            );
          }
          remotelySubscribed = true;
          if (!active) unsubscribeRemote();
        },
        (error: unknown) => {
          throw new Error(
            `Could not subscribe to task events for "${taskId}": ${errorMessage(error)}`,
          );
        },
      );
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      transport.off(TASK_EVENT_CHANNEL, wrapped);
      if (remotelySubscribed) unsubscribeRemote();
    };
    return Object.freeze({ ready, unsubscribe });
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
    runtimeState() {
      return transport.invoke(RUNTIME_STATE_CHANNEL) as Promise<DesktopRuntimeState>;
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
    subscribeIndexChanges(listener: (event: DesktopIndexChangeEvent) => void): () => void {
      let active = true;
      const wrapped = (_event: unknown, payload: unknown) => {
        const indexChange = indexChangeEvent(payload);
        if (active && indexChange !== undefined) listener(indexChange);
      };
      transport.on(INDEX_CHANGE_EVENT_CHANNEL, wrapped);
      return () => {
        if (!active) return;
        active = false;
        transport.off(INDEX_CHANGE_EVENT_CHANNEL, wrapped);
      };
    },
  });
}

function commandChannelFor(name: ApiCommandName): string {
  if (!supportedCommandNames.has(name)) throw new Error("Unsupported API command");
  return commandChannel(name);
}

function isTaskEventFor(payload: unknown, taskId: string): payload is TaskEvent {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { readonly taskId?: unknown }).taskId === taskId
  );
}

function indexChangeEvent(payload: unknown): DesktopIndexChangeEvent | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const roots = (payload as { readonly roots?: unknown }).roots;
  const stringRoots = Array.isArray(roots)
    ? roots.filter((root): root is string => typeof root === "string")
    : [];
  if (
    !Array.isArray(roots) ||
    stringRoots.length === 0 ||
    stringRoots.length !== roots.length ||
    stringRoots.some((root) => root.trim().length === 0)
  ) {
    return undefined;
  }
  return { roots: stringRoots };
}

async function invokeSafely(
  transport: PreloadTransport,
  channel: string,
  payload: unknown,
): Promise<boolean> {
  try {
    return (await transport.invoke(channel, payload)) !== false;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "the IPC request failed";
}
