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
const INDEX_CHANGE_EVENT_CHANNEL = "ai-config-hub:v1:index.changed";
const RUNTIME_STATE_CHANNEL = "ai-config-hub:v1:runtime.state";
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
  "settings.clearLocalData",
  "settings.update",
] as const;
const supportedCommandNames = new Set<string>(API_COMMAND_NAMES);
let taskSubscriptionSequence = 0;

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
  ): TaskSubscription;
  selectProjectRoot(): Promise<unknown>;
  appVersion(): Promise<unknown>;
  runtimeState(): Promise<unknown>;
  updateStatus(): Promise<unknown>;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  installUpdate(): Promise<unknown>;
  subscribeUpdates(listener: (event: unknown) => void): () => void;
  subscribeIndexChanges(listener: (event: IndexChangeEvent) => void): () => void;
}

interface TaskSubscription {
  readonly ready: Promise<void>;
  unsubscribe(): void;
}

interface IndexChangeEvent {
  readonly roots: readonly string[];
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
      const subscriptionId = nextTaskSubscriptionId();
      let active = true;
      let remotelySubscribed = false;
      let remoteUnsubscribeRequested = false;
      const wrapped = (_event: unknown, payload: unknown) => {
        if (active && isTaskEventFor(payload, taskId)) listener(payload);
      };
      const unsubscribeRemote = () => {
        if (remoteUnsubscribeRequested) return;
        remoteUnsubscribeRequested = true;
        void invokeSafely(transport, TASK_UNSUBSCRIBE_CHANNEL, { taskId, subscriptionId });
      };
      transport.on(TASK_EVENT_CHANNEL, wrapped);
      const ready = Promise.resolve()
        .then(() =>
          transport.invoke(TASK_SUBSCRIBE_CHANNEL, {
            taskId,
            afterSequence,
            subscriptionId,
          }),
        )
        .then(
          (result) => {
            if (result !== true) {
              throw new Error(
                `Task event subscription for "${taskId}" was rejected by the main process.`,
              );
            }
            remotelySubscribed = true;
            if (!active) unsubscribeRemote();
          },
          (error: unknown) => {
            throw new Error(
              `Could not subscribe to task events for "${taskId}": ${errorMessage(error)}`,
            );
          },
        );
      const unsubscribe = () => {
        if (!active) return;
        active = false;
        transport.off(TASK_EVENT_CHANNEL, wrapped);
        if (remotelySubscribed) unsubscribeRemote();
      };
      return Object.freeze({ ready, unsubscribe });
    },
    selectProjectRoot() {
      return transport.invoke(SELECT_PROJECT_ROOT_CHANNEL);
    },
    appVersion() {
      return transport.invoke(APP_VERSION_CHANNEL);
    },
    runtimeState() {
      return transport.invoke(RUNTIME_STATE_CHANNEL);
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
    subscribeIndexChanges(listener: (event: IndexChangeEvent) => void) {
      let active = true;
      const wrapped = (_event: unknown, payload: unknown) => {
        const indexChange = indexChangeEvent(payload);
        if (active && indexChange !== undefined) listener(indexChange);
      };
      transport.on(INDEX_CHANGE_EVENT_CHANNEL, wrapped);
      return () => {
        if (!active) return;
        active = false;
        transport.off(INDEX_CHANGE_EVENT_CHANNEL, wrapped);
      };
    },
  });
}

function commandChannelFor(name: string): string {
  if (!supportedCommandNames.has(name)) throw new Error("Unsupported API command");
  return `ai-config-hub:v1:${name}`;
}

function isTaskEventFor(payload: unknown, taskId: string): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { readonly taskId?: unknown }).taskId === taskId
  );
}

function indexChangeEvent(payload: unknown): IndexChangeEvent | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const roots = (payload as { readonly roots?: unknown }).roots;
  const stringRoots = Array.isArray(roots)
    ? roots.filter((root): root is string => typeof root === "string")
    : [];
  if (
    !Array.isArray(roots) ||
    stringRoots.length === 0 ||
    stringRoots.length !== roots.length ||
    stringRoots.some((root) => root.trim().length === 0)
  ) {
    return undefined;
  }
  return { roots: stringRoots };
}

async function invokeSafely(
  transport: IpcRendererPort,
  channel: string,
  payload: unknown,
): Promise<boolean> {
  try {
    return (await transport.invoke(channel, payload)) !== false;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "the IPC request failed";
}

function nextRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `request:${globalThis.crypto.randomUUID()}`;
  }
  return `request:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function nextTaskSubscriptionId(): string {
  taskSubscriptionSequence += 1;
  return `task-subscription:${taskSubscriptionSequence}:${nextRequestId()}`;
}
