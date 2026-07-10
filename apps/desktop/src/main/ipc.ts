import {
  API_COMMAND_NAMES,
  TASK_EVENT_CHANNEL,
  commandChannel,
  createCommandHandlers,
} from "@ai-config-hub/api";
import type { CommandServiceMap, TaskEvent } from "@ai-config-hub/api";
import { TaskIdSchema } from "@ai-config-hub/shared";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

import type {
  DesktopIndexChangeEvent,
  DesktopIndexChangePort,
  DesktopRuntimeState,
} from "./composition.js";
import type { UpdateService, UpdateStatus } from "./updates.js";

export type { DesktopIndexChangeEvent } from "./composition.js";

export const SELECT_PROJECT_ROOT_CHANNEL = "ai-config-hub:v1:dialog.selectProjectRoot";
export const APP_VERSION_CHANNEL = "ai-config-hub:v1:app.version";
export const TASK_SUBSCRIBE_CHANNEL = "ai-config-hub:v1:task.subscribe";
export const TASK_UNSUBSCRIBE_CHANNEL = "ai-config-hub:v1:task.unsubscribe";
export const UPDATE_STATUS_CHANNEL = "ai-config-hub:v1:update.status";
export const UPDATE_CHECK_CHANNEL = "ai-config-hub:v1:update.check";
export const UPDATE_DOWNLOAD_CHANNEL = "ai-config-hub:v1:update.download";
export const UPDATE_INSTALL_CHANNEL = "ai-config-hub:v1:update.install";
export const UPDATE_EVENT_CHANNEL = "ai-config-hub:v1:update.event";
export const INDEX_CHANGE_EVENT_CHANNEL = "ai-config-hub:v1:index.changed";
export const RUNTIME_STATE_CHANNEL = "ai-config-hub:v1:runtime.state";

export interface IpcDialogPort {
  selectDirectory(): Promise<string | undefined>;
}

export interface IpcTaskEventPort {
  subscribe(
    taskId: string,
    afterSequence: number,
    listener: (event: TaskEvent) => void,
  ): () => void;
}

interface TaskSubscription {
  readonly taskId: string;
  readonly unsubscribe: () => void;
}

interface SenderTaskSubscriptions {
  readonly subscriptions: Map<string, TaskSubscription>;
  readonly destroyedListener: () => void;
}

export function registerIpcHandlers(input: {
  readonly ipcMain: IpcMain;
  readonly services: CommandServiceMap;
  readonly taskEvents?: IpcTaskEventPort;
  readonly indexChanges?: DesktopIndexChangePort;
  readonly runtimeState?: () => DesktopRuntimeState;
  readonly updates?: UpdateService;
  readonly dialog: IpcDialogPort;
  readonly appVersion: () => string;
  readonly webContents: () => readonly WebContents[];
}): () => void {
  const handlers = createCommandHandlers(input.services);
  const taskSubscriptions = new Map<WebContents, SenderTaskSubscriptions>();

  const removeSenderSubscriptions = (sender: WebContents, removeDestroyedListener = true) => {
    const senderSubscriptions = taskSubscriptions.get(sender);
    if (senderSubscriptions === undefined) return;

    taskSubscriptions.delete(sender);
    if (removeDestroyedListener) {
      sender.removeListener("destroyed", senderSubscriptions.destroyedListener);
    }
    const subscriptions = [...senderSubscriptions.subscriptions.values()];
    senderSubscriptions.subscriptions.clear();
    for (const subscription of subscriptions) subscription.unsubscribe();
  };

  const ensureSenderSubscriptions = (sender: WebContents): SenderTaskSubscriptions => {
    const existing = taskSubscriptions.get(sender);
    if (existing !== undefined) return existing;

    const destroyedListener = () => removeSenderSubscriptions(sender, false);
    const created = {
      subscriptions: new Map<string, TaskSubscription>(),
      destroyedListener,
    };
    taskSubscriptions.set(sender, created);
    sender.once("destroyed", destroyedListener);
    return created;
  };

  const removeSubscription = (
    sender: WebContents,
    subscriptionId: string,
    taskId: string,
  ): void => {
    const senderSubscriptions = taskSubscriptions.get(sender);
    const subscription = senderSubscriptions?.subscriptions.get(subscriptionId);
    if (senderSubscriptions === undefined || subscription?.taskId !== taskId) return;

    senderSubscriptions.subscriptions.delete(subscriptionId);
    if (senderSubscriptions.subscriptions.size === 0) {
      taskSubscriptions.delete(sender);
      sender.removeListener("destroyed", senderSubscriptions.destroyedListener);
    }
    subscription.unsubscribe();
  };
  const unsubscribeUpdates = input.updates?.subscribe((status) =>
    sendUpdateEvent(input.webContents(), status),
  );
  const unsubscribeIndexChanges = input.indexChanges?.subscribe((event) =>
    sendIndexChangeEvent(input.webContents(), event),
  );
  for (const name of API_COMMAND_NAMES) {
    input.ipcMain.handle(commandChannel(name), (event, request: unknown) => {
      assertTrustedIpcSender(event, input.webContents());
      return handlers[name](request);
    });
  }
  input.ipcMain.handle(SELECT_PROJECT_ROOT_CHANNEL, (event) => {
    assertTrustedIpcSender(event, input.webContents());
    return input.dialog.selectDirectory();
  });
  input.ipcMain.handle(APP_VERSION_CHANNEL, (event) => {
    assertTrustedIpcSender(event, input.webContents());
    return input.appVersion();
  });
  if (input.runtimeState !== undefined) {
    input.ipcMain.handle(RUNTIME_STATE_CHANNEL, (event) => {
      assertTrustedIpcSender(event, input.webContents());
      return input.runtimeState?.();
    });
  }
  if (input.updates !== undefined) {
    input.ipcMain.handle(UPDATE_STATUS_CHANNEL, (event) => {
      assertTrustedIpcSender(event, input.webContents());
      return input.updates?.status();
    });
    input.ipcMain.handle(UPDATE_CHECK_CHANNEL, (event) => {
      assertTrustedIpcSender(event, input.webContents());
      return input.updates?.check();
    });
    input.ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, (event) => {
      assertTrustedIpcSender(event, input.webContents());
      return input.updates?.download();
    });
    input.ipcMain.handle(UPDATE_INSTALL_CHANNEL, (event) => {
      assertTrustedIpcSender(event, input.webContents());
      input.updates?.install();
      return true;
    });
  }
  input.ipcMain.handle(TASK_SUBSCRIBE_CHANNEL, (event, payload: unknown) => {
    assertTrustedIpcSender(event, input.webContents());
    if (input.taskEvents === undefined) return false;
    const request = taskSubscriptionPayload(payload);
    const senderSubscriptions = ensureSenderSubscriptions(event.sender);
    let unsubscribe: () => void;
    try {
      unsubscribe = input.taskEvents.subscribe(request.taskId, request.afterSequence, (taskEvent) =>
        sendTaskEvent(event.sender, taskEvent),
      );
    } catch (error) {
      if (senderSubscriptions.subscriptions.size === 0) {
        taskSubscriptions.delete(event.sender);
        event.sender.removeListener("destroyed", senderSubscriptions.destroyedListener);
      }
      throw error;
    }

    if (event.sender.isDestroyed() || taskSubscriptions.get(event.sender) !== senderSubscriptions) {
      unsubscribe();
      return false;
    }

    const replaced = senderSubscriptions.subscriptions.get(request.subscriptionId);
    senderSubscriptions.subscriptions.set(request.subscriptionId, {
      taskId: request.taskId,
      unsubscribe,
    });
    replaced?.unsubscribe();
    return true;
  });
  input.ipcMain.handle(TASK_UNSUBSCRIBE_CHANNEL, (event, payload: unknown) => {
    assertTrustedIpcSender(event, input.webContents());
    const request = taskUnsubscribePayload(payload);
    removeSubscription(event.sender, request.subscriptionId, request.taskId);
    return true;
  });

  return () => {
    unsubscribeUpdates?.();
    unsubscribeIndexChanges?.();
    for (const sender of [...taskSubscriptions.keys()]) removeSenderSubscriptions(sender);
    for (const name of API_COMMAND_NAMES) input.ipcMain.removeHandler(commandChannel(name));
    input.ipcMain.removeHandler(SELECT_PROJECT_ROOT_CHANNEL);
    input.ipcMain.removeHandler(APP_VERSION_CHANNEL);
    input.ipcMain.removeHandler(RUNTIME_STATE_CHANNEL);
    input.ipcMain.removeHandler(UPDATE_STATUS_CHANNEL);
    input.ipcMain.removeHandler(UPDATE_CHECK_CHANNEL);
    input.ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
    input.ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
    input.ipcMain.removeHandler(TASK_SUBSCRIBE_CHANNEL);
    input.ipcMain.removeHandler(TASK_UNSUBSCRIBE_CHANNEL);
    void input.webContents;
  };
}

function assertTrustedIpcSender(
  event: IpcMainInvokeEvent,
  trustedWebContents: readonly WebContents[],
): void {
  const sender = event.sender;
  if (!trustedWebContents.includes(sender)) throw new Error("Untrusted IPC sender");

  const senderFrame = (event as { readonly senderFrame?: unknown }).senderFrame;
  const mainFrame = (sender as { readonly mainFrame?: unknown }).mainFrame;
  if (senderFrame !== undefined && mainFrame !== undefined && senderFrame !== mainFrame) {
    throw new Error("Untrusted IPC sender");
  }
}

function taskSubscriptionPayload(payload: unknown): {
  readonly taskId: string;
  readonly afterSequence: number;
  readonly subscriptionId: string;
} {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("Task subscription payload must be an object");
  }
  const input = payload as {
    readonly taskId?: unknown;
    readonly afterSequence?: unknown;
    readonly subscriptionId?: unknown;
  };
  return {
    taskId: TaskIdSchema.parse(input.taskId),
    afterSequence:
      typeof input.afterSequence === "number" && Number.isInteger(input.afterSequence)
        ? input.afterSequence
        : 0,
    subscriptionId: taskSubscriptionId(input.subscriptionId),
  };
}

function taskUnsubscribePayload(payload: unknown): {
  readonly taskId: string;
  readonly subscriptionId: string;
} {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("Task unsubscribe payload must be an object");
  }
  const input = payload as { readonly taskId?: unknown; readonly subscriptionId?: unknown };
  return {
    taskId: TaskIdSchema.parse(input.taskId),
    subscriptionId: taskSubscriptionId(input.subscriptionId),
  };
}

function taskSubscriptionId(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0 || input.length > 512) {
    throw new TypeError("Task subscription id must be a non-empty string");
  }
  return input;
}

function sendTaskEvent(sender: WebContents, taskEvent: TaskEvent): void {
  if (sender.isDestroyed()) return;
  try {
    sender.send(TASK_EVENT_CHANNEL, taskEvent);
  } catch {
    // A renderer can disappear between isDestroyed() and send(). Task delivery
    // is observational and must never change the operation's durable outcome.
  }
}

function sendUpdateEvent(trustedWebContents: readonly WebContents[], status: UpdateStatus): void {
  for (const contents of trustedWebContents) {
    if (contents.isDestroyed()) continue;
    contents.send(UPDATE_EVENT_CHANNEL, status);
  }
}

function sendIndexChangeEvent(
  trustedWebContents: readonly WebContents[],
  event: DesktopIndexChangeEvent,
): void {
  for (const contents of trustedWebContents) {
    if (contents.isDestroyed()) continue;
    contents.send(INDEX_CHANGE_EVENT_CHANNEL, event);
  }
}
