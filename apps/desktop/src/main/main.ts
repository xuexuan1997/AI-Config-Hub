import { app, BrowserWindow, dialog, ipcMain, shell, webContents } from "electron";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createDesktopCommandServices, type DesktopCommandServiceRuntime } from "./composition.js";
import { createProjectDialogPort } from "./dialog.js";
import { registerIpcHandlers } from "./ipc.js";
import { createElectronUpdaterPort, createUpdateService, type UpdateService } from "./updates.js";
import { createSecureWindowOptions } from "./window-options.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
configureElectronUserDataPath();
const appVersion = desktopAppVersion();
let mainWindow: BrowserWindow | undefined;
let unregisterIpc: (() => void) | undefined;
let commandServices: DesktopCommandServiceRuntime | undefined;
let updateService: UpdateService | undefined;
let stopAutomaticUpdateChecks: (() => void) | undefined;

async function createMainWindow(): Promise<void> {
  const preloadPath = resolve(currentDir, "../preload/preload.cjs");
  const rendererPath = resolve(currentDir, "../../renderer/index.html");
  const window = new BrowserWindow(createSecureWindowOptions(preloadPath));
  mainWindow = window;
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
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
  app.on("second-instance", () => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) {
      if (app.isReady()) void createMainWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  void app
    .whenReady()
    .then(async () => {
      commandServices = await createDesktopCommandServices({
        appVersion,
        userDataPath: desktopUserDataPath(),
        sourceFileOpener: {
          async openPath(path) {
            const error = await shell.openPath(path);
            if (error.length > 0) throw new Error(error);
          },
        },
      });
      const desktopRuntime = commandServices;
      updateService = createUpdateService({
        appVersion,
        isPackaged: app.isPackaged,
        platform: process.platform,
        updater: createElectronUpdaterPort(),
      });
      unregisterIpc = registerIpcHandlers({
        ipcMain,
        services: commandServices.services,
        taskEvents: commandServices.taskEvents,
        indexChanges: commandServices.indexChanges,
        runtimeState: () => desktopRuntime.runtimeState(),
        updates: updateService,
        appVersion: () => appVersion,
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
  return resolve(app.getPath("userData"));
}

function configureElectronUserDataPath(): void {
  const override = process.env["AI_CONFIG_HUB_USER_DATA"];
  if (override !== undefined && override.trim().length > 0) {
    app.setPath("userData", resolve(override));
  }
}

function desktopAppVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(resolve(currentDir, "../../../package.json"), "utf8"),
    ) as { readonly version?: unknown };
    if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
      return packageJson.version;
    }
  } catch {
    // Electron still provides a safe fallback for non-standard development layouts.
  }
  return app.getVersion();
}
