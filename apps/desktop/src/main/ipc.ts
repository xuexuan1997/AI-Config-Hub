import { API_COMMAND_NAMES, commandChannel, createCommandHandlers } from "@ai-config-hub/api";
import type { IpcMain, WebContents } from "electron";

import { createDesktopCommandServices } from "./composition.js";

export const SELECT_PROJECT_ROOT_CHANNEL = "ai-config-hub:v1:dialog.selectProjectRoot";
export const APP_VERSION_CHANNEL = "ai-config-hub:v1:app.version";
export const TASK_SUBSCRIBE_CHANNEL = "ai-config-hub:v1:task.subscribe";
export const TASK_UNSUBSCRIBE_CHANNEL = "ai-config-hub:v1:task.unsubscribe";

export interface IpcDialogPort {
  selectDirectory(): Promise<string | undefined>;
}

export function registerIpcHandlers(input: {
  readonly ipcMain: IpcMain;
  readonly dialog: IpcDialogPort;
  readonly appVersion: () => string;
  readonly webContents: () => readonly WebContents[];
}): () => void {
  const handlers = createCommandHandlers(createDesktopCommandServices());
  for (const name of API_COMMAND_NAMES) {
    input.ipcMain.handle(commandChannel(name), (_event, request: unknown) =>
      handlers[name](request),
    );
  }
  input.ipcMain.handle(SELECT_PROJECT_ROOT_CHANNEL, () => input.dialog.selectDirectory());
  input.ipcMain.handle(APP_VERSION_CHANNEL, () => input.appVersion());
  input.ipcMain.handle(TASK_SUBSCRIBE_CHANNEL, () => true);
  input.ipcMain.handle(TASK_UNSUBSCRIBE_CHANNEL, () => true);

  return () => {
    for (const name of API_COMMAND_NAMES) input.ipcMain.removeHandler(commandChannel(name));
    input.ipcMain.removeHandler(SELECT_PROJECT_ROOT_CHANNEL);
    input.ipcMain.removeHandler(APP_VERSION_CHANNEL);
    input.ipcMain.removeHandler(TASK_SUBSCRIBE_CHANNEL);
    input.ipcMain.removeHandler(TASK_UNSUBSCRIBE_CHANNEL);
    void input.webContents;
  };
}
