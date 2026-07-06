import type { BrowserWindowConstructorOptions } from "electron";

export const DESKTOP_MINIMUM_WINDOW_SIZE = {
  width: 1024,
  height: 700,
} as const;

export function createSecureWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 820,
    minWidth: DESKTOP_MINIMUM_WINDOW_SIZE.width,
    minHeight: DESKTOP_MINIMUM_WINDOW_SIZE.height,
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
