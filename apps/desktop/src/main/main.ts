import { app, BrowserWindow, dialog, ipcMain, shell, webContents } from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { registerIpcHandlers } from "./ipc.js";
import { createSecureWindowOptions } from "./window-options.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;
let unregisterIpc: (() => void) | undefined;

async function createMainWindow(): Promise<void> {
  const preloadPath = resolve(currentDir, "../preload/preload.js");
  const rendererPath = resolve(currentDir, "../../renderer/index.html");
  const window = new BrowserWindow(createSecureWindowOptions(preloadPath));
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
      unregisterIpc = registerIpcHandlers({
        ipcMain,
        appVersion: () => app.getVersion(),
        webContents: () => webContents.getAllWebContents(),
        dialog: {
          async selectDirectory() {
            const options = {
              title: "Select AI Config Hub project",
              properties: ["openDirectory" as const],
            };
            const result =
              mainWindow === undefined
                ? await dialog.showOpenDialog(options)
                : await dialog.showOpenDialog(mainWindow, options);
            return result.canceled ? undefined : result.filePaths[0];
          },
        },
      });
      await createMainWindow();
    })
    .catch((error: unknown) => {
      console.error(error);
    });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });
  app.on("before-quit", () => {
    unregisterIpc?.();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
} else {
  app.quit();
}
