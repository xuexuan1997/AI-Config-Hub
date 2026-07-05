import electron = require("electron");

const { contextBridge, ipcRenderer } = electron as {
  readonly contextBridge: ContextBridgePort;
  readonly ipcRenderer: IpcRendererPort;
};

const SELECT_PROJECT_ROOT_CHANNEL = "ai-config-hub:v1:dialog.selectProjectRoot";
const APP_VERSION_CHANNEL = "ai-config-hub:v1:app.version";
const TASK_EVENT_CHANNEL = "ai-config-hub:v1:task.event";
const TASK_SUBSCRIBE_CHANNEL = "ai-config-hub:v1:task.subscribe";
const TASK_UNSUBSCRIBE_CHANNEL = "ai-config-hub:v1:task.unsubscribe";
const UPDATE_STATUS_CHANNEL = "ai-config-hub:v1:update.status";
const UPDATE_CHECK_CHANNEL = "ai-config-hub:v1:update.check";
const UPDATE_DOWNLOAD_CHANNEL = "ai-config-hub:v1:update.download";
const UPDATE_INSTALL_CHANNEL = "ai-config-hub:v1:update.install";
const UPDATE_EVENT_CHANNEL = "ai-config-hub:v1:update.event";
const API_COMMAND_NAMES = [
  "scan.start",
  "scan.status",
  "scan.cancel",
  "assets.list",
  "assets.get",
  "assets.openSource",
  "assets.disable",
  "assets.enable",
  "effective.resolve",
  "diagnostics.list",
  "diagnostics.export",
  "migration.preview",
  "deployment.execute",
  "deployment.rollback",
  "history.list",
  "history.get",
  "settings.get",
  "settings.update",
] as const;
const supportedCommandNames = new Set<string>(API_COMMAND_NAMES);

interface ContextBridgePort {
  exposeInMainWorld(apiKey: string, api: unknown): void;
}

interface IpcRendererPort {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  off(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

interface DesktopApi {
  invoke(name: string, payload: unknown): Promise<unknown>;
  subscribeTask(
    taskId: string,
    afterSequence: number,
    listener: (event: unknown) => void,
  ): () => void;
  selectProjectRoot(): Promise<unknown>;
  appVersion(): Promise<unknown>;
  updateStatus(): Promise<unknown>;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  installUpdate(): Promise<unknown>;
  subscribeUpdates(listener: (event: unknown) => void): () => void;
}

contextBridge.exposeInMainWorld("aiConfigHub", createDesktopApi(ipcRenderer));

function createDesktopApi(transport: IpcRendererPort): DesktopApi {
  return Object.freeze({
    invoke(name: string, payload: unknown) {
      return transport.invoke(commandChannelFor(name), {
        apiVersion: 1,
        requestId: nextRequestId(),
        payload,
      });
    },
    subscribeTask(taskId: string, afterSequence: number, listener: (event: unknown) => void) {
      const wrapped = (_event: unknown, payload: unknown) => {
        listener(payload);
      };
      transport.on(TASK_EVENT_CHANNEL, wrapped);
      void transport.invoke(TASK_SUBSCRIBE_CHANNEL, { taskId, afterSequence });
      return () => {
        transport.off(TASK_EVENT_CHANNEL, wrapped);
        void transport.invoke(TASK_UNSUBSCRIBE_CHANNEL, { taskId });
      };
    },
    selectProjectRoot() {
      return transport.invoke(SELECT_PROJECT_ROOT_CHANNEL);
    },
    appVersion() {
      return transport.invoke(APP_VERSION_CHANNEL);
    },
    updateStatus() {
      return transport.invoke(UPDATE_STATUS_CHANNEL);
    },
    checkForUpdates() {
      return transport.invoke(UPDATE_CHECK_CHANNEL);
    },
    downloadUpdate() {
      return transport.invoke(UPDATE_DOWNLOAD_CHANNEL);
    },
    installUpdate() {
      return transport.invoke(UPDATE_INSTALL_CHANNEL);
    },
    subscribeUpdates(listener: (event: unknown) => void) {
      const wrapped = (_event: unknown, payload: unknown) => {
        listener(payload);
      };
      transport.on(UPDATE_EVENT_CHANNEL, wrapped);
      return () => {
        transport.off(UPDATE_EVENT_CHANNEL, wrapped);
      };
    },
  });
}

function commandChannelFor(name: string): string {
  if (!supportedCommandNames.has(name)) throw new Error("Unsupported API command");
  return `ai-config-hub:v1:${name}`;
}

function nextRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `request:${globalThis.crypto.randomUUID()}`;
  }
  return `request:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}
