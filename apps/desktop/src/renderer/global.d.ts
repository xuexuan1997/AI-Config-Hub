import type { DesktopApi } from "../preload/api.js";

declare global {
  interface Window {
    readonly aiConfigHub: DesktopApi;
  }
}

export {};
