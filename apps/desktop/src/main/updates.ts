import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronUpdater = require("electron-updater") as typeof import("electron-updater");

export type UpdatePlatform = NodeJS.Platform;
type UpdateEventName =
  | "checking-for-update"
  | "update-not-available"
  | "update-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

export type UpdateStatus =
  | {
      readonly enabled: false;
      readonly status: "unsupported";
      readonly currentVersion: string;
      readonly reason: string;
    }
  | {
      readonly enabled: true;
      readonly status: "idle" | "checking" | "not-available";
      readonly currentVersion: string;
    }
  | {
      readonly enabled: true;
      readonly status: "available" | "downloaded";
      readonly currentVersion: string;
      readonly updateVersion: string;
      readonly releaseName?: string;
    }
  | {
      readonly enabled: true;
      readonly status: "downloading";
      readonly currentVersion: string;
      readonly updateVersion?: string;
      readonly bytesPerSecond: number;
      readonly percent: number;
      readonly total: number;
      readonly transferred: number;
    }
  | {
      readonly enabled: true;
      readonly status: "error";
      readonly currentVersion: string;
      readonly message: string;
    };

export interface UpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: (event: UpdateEventName, listener: (payload: unknown) => void) => UpdaterPort;
}

export interface UpdateService {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  install(): void;
  startAutomaticChecks(options?: {
    readonly initialDelayMs?: number;
    readonly intervalMs?: number;
  }): () => void;
  subscribe(listener: (status: UpdateStatus) => void): () => void;
}

export interface UpdateServiceOptions {
  readonly appVersion: string;
  readonly isPackaged: boolean;
  readonly platform: UpdatePlatform;
  readonly updater: UpdaterPort;
}

interface UpdateInfoLike {
  readonly version?: unknown;
  readonly releaseName?: unknown;
}

interface ProgressInfoLike {
  readonly bytesPerSecond?: unknown;
  readonly percent?: unknown;
  readonly total?: unknown;
  readonly transferred?: unknown;
}

const SUPPORTED_PLATFORMS = new Set<UpdatePlatform>(["win32", "linux"]);
const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export function createElectronUpdaterPort(): UpdaterPort {
  const { autoUpdater } = electronUpdater;
  const port: UpdaterPort = {
    get autoDownload() {
      return autoUpdater.autoDownload;
    },
    set autoDownload(value: boolean) {
      autoUpdater.autoDownload = value;
    },
    get autoInstallOnAppQuit() {
      return autoUpdater.autoInstallOnAppQuit;
    },
    set autoInstallOnAppQuit(value: boolean) {
      autoUpdater.autoInstallOnAppQuit = value;
    },
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    downloadUpdate: () => autoUpdater.downloadUpdate(),
    quitAndInstall: (isSilent, isForceRunAfter) =>
      autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
    on(event, listener) {
      switch (event) {
        case "checking-for-update":
          autoUpdater.on("checking-for-update", () => listener(undefined));
          break;
        case "update-not-available":
          autoUpdater.on("update-not-available", (info) => listener(info));
          break;
        case "update-available":
          autoUpdater.on("update-available", (info) => listener(info));
          break;
        case "download-progress":
          autoUpdater.on("download-progress", (info) => listener(info));
          break;
        case "update-downloaded":
          autoUpdater.on("update-downloaded", (info) => listener(info));
          break;
        case "error":
          autoUpdater.on("error", (error) => listener(error));
          break;
      }
      return port;
    },
  };
  return port;
}

export function createUpdateService(options: UpdateServiceOptions): UpdateService {
  const enabled = options.isPackaged && SUPPORTED_PLATFORMS.has(options.platform);
  const listeners = new Set<(status: UpdateStatus) => void>();
  let status: UpdateStatus = enabled
    ? { enabled: true, status: "idle", currentVersion: options.appVersion }
    : {
        enabled: false,
        status: "unsupported",
        currentVersion: options.appVersion,
        reason: "Updates are only available in packaged Windows and Linux builds.",
      };

  if (enabled) {
    options.updater.autoDownload = false;
    options.updater.autoInstallOnAppQuit = true;
    options.updater.on("checking-for-update", () => {
      setStatus({ enabled: true, status: "checking", currentVersion: options.appVersion });
    });
    options.updater.on("update-not-available", () => {
      setStatus({ enabled: true, status: "not-available", currentVersion: options.appVersion });
    });
    options.updater.on("update-available", (info) => {
      setStatus(availableStatus(options.appVersion, info));
    });
    options.updater.on("download-progress", (progress) => {
      setStatus(downloadProgressStatus(options.appVersion, status, progress));
    });
    options.updater.on("update-downloaded", (info) => {
      setStatus(downloadedStatus(options.appVersion, status, info));
    });
    options.updater.on("error", (error) => {
      setStatus({
        enabled: true,
        status: "error",
        currentVersion: options.appVersion,
        message: errorMessage(error),
      });
    });
  }

  function setStatus(next: UpdateStatus): void {
    status = next;
    for (const listener of listeners) listener(status);
  }

  async function check(): Promise<UpdateStatus> {
    if (!enabled) return status;
    setStatus({ enabled: true, status: "checking", currentVersion: options.appVersion });
    try {
      await options.updater.checkForUpdates();
    } catch (error) {
      setStatus({
        enabled: true,
        status: "error",
        currentVersion: options.appVersion,
        message: errorMessage(error),
      });
    }
    return status;
  }

  async function download(): Promise<UpdateStatus> {
    if (!enabled) return status;
    if (!canDownload(status)) return status;
    setStatus(downloadProgressStatus(options.appVersion, status, {}));
    try {
      await options.updater.downloadUpdate();
    } catch (error) {
      setStatus({
        enabled: true,
        status: "error",
        currentVersion: options.appVersion,
        message: errorMessage(error),
      });
    }
    return status;
  }

  function install(): void {
    if (status.enabled && status.status === "downloaded") {
      options.updater.quitAndInstall(false, true);
    }
  }

  const service: UpdateService = {
    status(): UpdateStatus {
      return status;
    },
    check,
    download,
    install,
    startAutomaticChecks(checkOptions = {}) {
      if (!enabled) return () => {};
      const initialDelayMs = checkOptions.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
      const intervalMs = checkOptions.intervalMs ?? DEFAULT_INTERVAL_MS;
      const timeout = setTimeout(() => {
        void check();
      }, initialDelayMs);
      const interval = setInterval(() => {
        void check();
      }, intervalMs);
      return () => {
        clearTimeout(timeout);
        clearInterval(interval);
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return service;
}

function availableStatus(currentVersion: string, info: unknown): UpdateStatus {
  const updateInfo = updateInfoLike(info);
  const updateVersion = stringValue(updateInfo.version) ?? "unknown";
  const releaseName = stringValue(updateInfo.releaseName);
  return {
    enabled: true,
    status: "available",
    currentVersion,
    updateVersion,
    ...(releaseName === undefined ? {} : { releaseName }),
  };
}

function downloadedStatus(
  currentVersion: string,
  previous: UpdateStatus,
  info: unknown,
): UpdateStatus {
  const updateInfo = updateInfoLike(info);
  const fallbackVersion =
    previous.enabled &&
    (previous.status === "available" ||
      previous.status === "downloading" ||
      previous.status === "downloaded")
      ? previous.updateVersion
      : undefined;
  const updateVersion = stringValue(updateInfo.version) ?? fallbackVersion ?? "unknown";
  const releaseName = stringValue(updateInfo.releaseName);
  return {
    enabled: true,
    status: "downloaded",
    currentVersion,
    updateVersion,
    ...(releaseName === undefined ? {} : { releaseName }),
  };
}

function downloadProgressStatus(
  currentVersion: string,
  previous: UpdateStatus,
  progress: unknown,
): UpdateStatus {
  const progressInfo = progressInfoLike(progress);
  const updateVersion =
    previous.enabled && (previous.status === "available" || previous.status === "downloading")
      ? previous.updateVersion
      : undefined;
  return {
    enabled: true,
    status: "downloading",
    currentVersion,
    ...(updateVersion === undefined ? {} : { updateVersion }),
    bytesPerSecond: numberValue(progressInfo.bytesPerSecond),
    percent: numberValue(progressInfo.percent),
    total: numberValue(progressInfo.total),
    transferred: numberValue(progressInfo.transferred),
  };
}

function canDownload(status: UpdateStatus): boolean {
  return status.enabled && (status.status === "available" || status.status === "downloading");
}

function updateInfoLike(value: unknown): UpdateInfoLike {
  return typeof value === "object" && value !== null ? value : {};
}

function progressInfoLike(value: unknown): ProgressInfoLike {
  return typeof value === "object" && value !== null ? value : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
