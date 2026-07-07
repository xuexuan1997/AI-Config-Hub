import { resolve } from "node:path";

import type { BrowserWindowConstructorOptions } from "electron";

type DesktopDock = {
  readonly setIcon: (iconPath: string) => void;
};

export function resolveDesktopWindowIconPath(mainModuleDirectory: string): string {
  return resolve(mainModuleDirectory, "../../../resources/icon.png");
}

export function applyDesktopDockIcon(input: {
  readonly dock: DesktopDock | undefined;
  readonly iconPath: string;
  readonly platform: NodeJS.Platform;
}): void {
  if (input.platform === "darwin") input.dock?.setIcon(input.iconPath);
}

export function createSecureWindowOptions(
  preloadPath: string,
  iconPath: string,
): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  };
}
