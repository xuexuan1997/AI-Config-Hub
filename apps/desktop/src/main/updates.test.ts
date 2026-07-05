import { describe, expect, it, vi } from "vitest";

import { createUpdateService, type UpdateStatus, type UpdaterPort } from "./updates.js";

describe("desktop update service", () => {
  it("stays disabled outside packaged Windows and Linux builds", async () => {
    const updater = fakeUpdater();
    const service = createUpdateService({
      appVersion: "0.2.12",
      isPackaged: false,
      platform: "win32",
      updater,
    });

    expect(service.status()).toEqual({
      enabled: false,
      status: "unsupported",
      currentVersion: "0.2.12",
      reason: "Updates are only available in packaged Windows and Linux builds.",
    });
    await expect(service.check()).resolves.toEqual(service.status());
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("checks for Windows updates and records available versions without auto-downloading", async () => {
    const updater = fakeUpdater();
    const service = createUpdateService({
      appVersion: "0.2.12",
      isPackaged: true,
      platform: "win32",
      updater,
    });

    const events: UpdateStatus[] = [];
    service.subscribe((event) => events.push(event));
    const check = service.check();
    updater.emit("update-available", { version: "0.2.13", releaseName: "v0.2.13" });
    await check;

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(service.status()).toEqual({
      enabled: true,
      status: "available",
      currentVersion: "0.2.12",
      updateVersion: "0.2.13",
      releaseName: "v0.2.13",
    });
    expect(events.map((event) => event.status)).toEqual(["checking", "available"]);
  });

  it("downloads Linux AppImage updates and only installs after download completes", async () => {
    const updater = fakeUpdater();
    const service = createUpdateService({
      appVersion: "0.2.12",
      isPackaged: true,
      platform: "linux",
      updater,
    });

    updater.emit("update-available", { version: "0.2.13" });
    const download = service.download();
    updater.emit("download-progress", {
      bytesPerSecond: 1024,
      percent: 25,
      total: 400,
      transferred: 100,
    });
    updater.emit("update-downloaded", { version: "0.2.13" });
    await download;

    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(service.status()).toEqual({
      enabled: true,
      status: "downloaded",
      currentVersion: "0.2.12",
      updateVersion: "0.2.13",
    });
    service.install();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("does not start a download before an update is available", async () => {
    const updater = fakeUpdater();
    const service = createUpdateService({
      appVersion: "0.2.12",
      isPackaged: true,
      platform: "win32",
      updater,
    });

    await expect(service.download()).resolves.toEqual({
      enabled: true,
      status: "idle",
      currentVersion: "0.2.12",
    });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("reports updater errors without leaking stack traces to the renderer", () => {
    const updater = fakeUpdater();
    const service = createUpdateService({
      appVersion: "0.2.12",
      isPackaged: true,
      platform: "win32",
      updater,
    });

    updater.emit("error", new Error("network token stack trace"));

    expect(service.status()).toEqual({
      enabled: true,
      status: "error",
      currentVersion: "0.2.12",
      message: "network token stack trace",
    });
  });
});

function fakeUpdater(): UpdaterPort & {
  readonly emit: (event: string, payload?: unknown) => void;
} {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const updater: UpdaterPort & {
    readonly emit: (event: string, payload?: unknown) => void;
  } = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn(),
    on(event, listener) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return updater;
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
  return updater;
}
