import { contextBridge, ipcRenderer } from "electron";
import { randomUUID } from "node:crypto";

import { createDesktopApi } from "./api.js";

contextBridge.exposeInMainWorld(
  "aiConfigHub",
  createDesktopApi(ipcRenderer, { requestId: () => `request:${randomUUID()}` }),
);
