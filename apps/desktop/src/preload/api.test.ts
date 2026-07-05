import { describe, expect, it, vi } from "vitest";

import { createDesktopApi, type PreloadTransport } from "./api.js";

describe("Desktop preload API", () => {
  it("exposes only the named frozen API surface", () => {
    const transport = fakeTransport();
    const api = createDesktopApi(transport, { requestId: () => "request-1" });

    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api).sort()).toEqual([
      "appVersion",
      "checkForUpdates",
      "downloadUpdate",
      "installUpdate",
      "invoke",
      "selectProjectRoot",
      "subscribeTask",
      "subscribeUpdates",
      "updateStatus",
    ]);
  });

  it("builds validated command-channel requests and removes task listeners", async () => {
    const invoke = vi.fn().mockResolvedValue({
      apiVersion: 1,
      requestId: "request-1",
      ok: true,
      data: {},
    });
    const off = vi.fn();
    const transport: PreloadTransport = { invoke, on: vi.fn(), off };
    const api = createDesktopApi(transport, { requestId: () => "request-1" });

    await api.invoke("scan.start", { mode: "full" });
    const unsubscribe = api.subscribeTask("task-1", 0, vi.fn());
    unsubscribe();
    await api.updateStatus();
    await api.checkForUpdates();
    await api.downloadUpdate();

    expect(invoke).toHaveBeenCalledWith("ai-config-hub:v1:scan.start", {
      apiVersion: 1,
      requestId: "request-1",
      payload: { mode: "full" },
    });
    expect(invoke).toHaveBeenCalledWith("ai-config-hub:v1:update.status");
    expect(invoke).toHaveBeenCalledWith("ai-config-hub:v1:update.check");
    expect(invoke).toHaveBeenCalledWith("ai-config-hub:v1:update.download");
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("subscribes and unsubscribes update status listeners", () => {
    const transport: PreloadTransport = { invoke: vi.fn(), on: vi.fn(), off: vi.fn() };
    const api = createDesktopApi(transport, { requestId: () => "request-1" });
    const listener = vi.fn();

    const unsubscribe = api.subscribeUpdates(listener);
    unsubscribe();

    expect(transport.on).toHaveBeenCalledWith(
      "ai-config-hub:v1:update.event",
      expect.any(Function),
    );
    expect(transport.off).toHaveBeenCalledWith(
      "ai-config-hub:v1:update.event",
      expect.any(Function),
    );
  });

  it("rejects unsupported command names before invoking IPC", async () => {
    const invoke = vi.fn();
    const transport: PreloadTransport = { invoke, on: vi.fn(), off: vi.fn() };
    const api = createDesktopApi(transport, { requestId: () => "request-1" });

    await expect(api.invoke("node:fs" as never, {} as never)).rejects.toThrow(
      "Unsupported API command",
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});

function fakeTransport(): PreloadTransport {
  return {
    invoke: vi
      .fn()
      .mockResolvedValue({ apiVersion: 1, requestId: "request-1", ok: true, data: {} }),
    on: vi.fn(),
    off: vi.fn(),
  };
}
