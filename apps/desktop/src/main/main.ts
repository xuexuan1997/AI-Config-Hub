import { app, BrowserWindow, dialog, ipcMain, shell, webContents } from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createDesktopCommandServices, type DesktopCommandServiceRuntime } from "./composition.js";
import { createProjectDialogPort } from "./dialog.js";
import { registerIpcHandlers } from "./ipc.js";
import { createElectronUpdaterPort, createUpdateService, type UpdateService } from "./updates.js";
import {
  applyDesktopDockIcon,
  createSecureWindowOptions,
  resolveDesktopWindowIconPath,
} from "./window-options.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;
let unregisterIpc: (() => void) | undefined;
let commandServices: DesktopCommandServiceRuntime | undefined;
let updateService: UpdateService | undefined;
let stopAutomaticUpdateChecks: (() => void) | undefined;

async function createMainWindow(): Promise<void> {
  const preloadPath = resolve(currentDir, "../preload/preload.cjs");
  const rendererPath = resolve(currentDir, "../../renderer/index.html");
  const iconPath = resolveDesktopWindowIconPath(currentDir);
  applyDesktopDockIcon({ dock: app.dock, iconPath, platform: process.platform });
  const window = new BrowserWindow(createSecureWindowOptions(preloadPath, iconPath));
  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  await window.loadURL(pathToFileURL(rendererPath).toString());
}

if (app.requestSingleInstanceLock()) {
  void app
    .whenReady()
    .then(async () => {
      commandServices = await createDesktopCommandServices({
        appVersion: app.getVersion(),
        userDataPath: desktopUserDataPath(),
        sourceFileOpener: {
          async openPath(path) {
            const error = await shell.openPath(path);
            if (error.length > 0) throw new Error(error);
          },
        },
      });
      updateService = createUpdateService({
        appVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        updater: createElectronUpdaterPort(),
      });
      unregisterIpc = registerIpcHandlers({
        ipcMain,
        services: commandServices.services,
        taskEvents: commandServices.taskEvents,
        updates: updateService,
        appVersion: () => app.getVersion(),
        webContents: () => webContents.getAllWebContents(),
        dialog: createProjectDialogPort({
          dialog,
          env: process.env,
          getMainWindow: () => mainWindow,
          platform: process.platform,
        }),
      });
      await createMainWindow();
      stopAutomaticUpdateChecks = updateService.startAutomaticChecks();
    })
    .catch((error: unknown) => {
      console.error(error);
    });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });
  app.on("before-quit", () => {
    stopAutomaticUpdateChecks?.();
    unregisterIpc?.();
    commandServices?.close();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
} else {
  app.quit();
}

function desktopUserDataPath(): string {
  return resolve(process.env["AI_CONFIG_HUB_USER_DATA"] ?? app.getPath("userData"));
}
