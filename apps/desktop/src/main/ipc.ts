import {
  API_COMMAND_NAMES,
  TASK_EVENT_CHANNEL,
  commandChannel,
  createCommandHandlers,
} from "@ai-config-hub/api";
import type { CommandServiceMap, TaskEvent } from "@ai-config-hub/api";
import { TaskIdSchema } from "@ai-config-hub/shared";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

export const SELECT_PROJECT_ROOT_CHANNEL = "ai-config-hub:v1:dialog.selectProjectRoot";
export const APP_VERSION_CHANNEL = "ai-config-hub:v1:app.version";
export const TASK_SUBSCRIBE_CHANNEL = "ai-config-hub:v1:task.subscribe";
export const TASK_UNSUBSCRIBE_CHANNEL = "ai-config-hub:v1:task.unsubscribe";

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

export function registerIpcHandlers(input: {
  readonly ipcMain: IpcMain;
  readonly services: CommandServiceMap;
  readonly taskEvents?: IpcTaskEventPort;
  readonly dialog: IpcDialogPort;
  readonly appVersion: () => string;
  readonly webContents: () => readonly WebContents[];
}): () => void {
  const handlers = createCommandHandlers(input.services);
  const taskSubscriptions = new Map<string, () => void>();
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
  input.ipcMain.handle(TASK_SUBSCRIBE_CHANNEL, (event, payload: unknown) => {
    assertTrustedIpcSender(event, input.webContents());
    if (input.taskEvents === undefined) return false;
    const request = taskSubscriptionPayload(payload);
    const unsubscribe = input.taskEvents.subscribe(
      request.taskId,
      request.afterSequence,
      (taskEvent) => sendTaskEvent(event, taskEvent),
    );
    taskSubscriptions.set(request.taskId, unsubscribe);
    return true;
  });
  input.ipcMain.handle(TASK_UNSUBSCRIBE_CHANNEL, (event, payload: unknown) => {
    assertTrustedIpcSender(event, input.webContents());
    const request = taskUnsubscribePayload(payload);
    taskSubscriptions.get(request.taskId)?.();
    taskSubscriptions.delete(request.taskId);
    return true;
  });

  return () => {
    for (const unsubscribe of taskSubscriptions.values()) unsubscribe();
    taskSubscriptions.clear();
    for (const name of API_COMMAND_NAMES) input.ipcMain.removeHandler(commandChannel(name));
    input.ipcMain.removeHandler(SELECT_PROJECT_ROOT_CHANNEL);
    input.ipcMain.removeHandler(APP_VERSION_CHANNEL);
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
} {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("Task subscription payload must be an object");
  }
  const input = payload as { readonly taskId?: unknown; readonly afterSequence?: unknown };
  return {
    taskId: TaskIdSchema.parse(input.taskId),
    afterSequence:
      typeof input.afterSequence === "number" && Number.isInteger(input.afterSequence)
        ? input.afterSequence
        : 0,
  };
}

function taskUnsubscribePayload(payload: unknown): { readonly taskId: string } {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("Task unsubscribe payload must be an object");
  }
  const input = payload as { readonly taskId?: unknown };
  return { taskId: TaskIdSchema.parse(input.taskId) };
}

function sendTaskEvent(event: IpcMainInvokeEvent, taskEvent: TaskEvent): void {
  event.sender.send(TASK_EVENT_CHANNEL, taskEvent);
}
