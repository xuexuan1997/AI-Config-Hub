import {
  commandChannel,
  TASK_EVENT_CHANNEL,
  type CommandServiceMap,
  type TaskEvent,
} from "@ai-config-hub/api";
import { AssetIdSchema, ContentHashSchema, TaskIdSchema } from "@ai-config-hub/shared";
import { describe, expect, it, vi } from "vitest";

import {
  registerIpcHandlers,
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_EVENT_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATUS_CHANNEL,
} from "./ipc.js";
import type { UpdateStatus } from "./updates.js";

describe("desktop IPC handlers", () => {
  it("dispatches API commands to the injected command services", async () => {
    const services = commandServices({
      "scan.start": vi.fn().mockResolvedValue({
        taskId: TaskIdSchema.parse("task:desktop-ipc"),
        status: "queued",
        acceptedAt: "2026-06-28T08:00:00.000Z",
      }),
    });
    const ipcMain = fakeIpcMain();
    const sender = fakeWebContents();

    registerIpcHandlers({
      ipcMain: ipcMain as never,
      services,
      appVersion: () => "0.2.0-test",
      dialog: { selectDirectory: () => Promise.resolve(undefined) },
      webContents: () => [sender as never],
    });

    const response = await ipcMain.invoke(
      commandChannel("scan.start"),
      {
        apiVersion: 1,
        requestId: "request:desktop-ipc",
        payload: { mode: "full" },
      },
      trustedEvent(sender),
    );

    expect(response).toMatchObject({
      ok: true,
      data: { taskId: "task:desktop-ipc", status: "queued" },
    });
    expect(services["scan.start"]).toHaveBeenCalledWith({ mode: "full" });
  });

  it("rejects API commands from unknown senders and subframes", async () => {
    const services = commandServices({
      "scan.start": vi.fn().mockResolvedValue({
        taskId: TaskIdSchema.parse("task:desktop-ipc"),
        status: "queued",
        acceptedAt: "2026-06-28T08:00:00.000Z",
      }),
    });
    const ipcMain = fakeIpcMain();
    const sender = fakeWebContents();
    const unknownSender = fakeWebContents();

    registerIpcHandlers({
      ipcMain: ipcMain as never,
      services,
      appVersion: () => "0.2.0-test",
      dialog: { selectDirectory: () => Promise.resolve(undefined) },
      webContents: () => [sender as never],
    });

    const request = {
      apiVersion: 1,
      requestId: "request:desktop-ipc",
      payload: { mode: "full" },
    };

    await expect(
      ipcMain.invoke(commandChannel("scan.start"), request, trustedEvent(unknownSender)),
    ).rejects.toThrow("Untrusted IPC sender");
    await expect(
      ipcMain.invoke(commandChannel("scan.start"), request, {
        sender,
        senderFrame: { frameId: 2 },
      }),
    ).rejects.toThrow("Untrusted IPC sender");
    expect(services["scan.start"]).not.toHaveBeenCalled();
  });

  it("replays task events to the subscribing sender and removes subscriptions", async () => {
    const sent: unknown[] = [];
    const unsubscribe = vi.fn();
    const ipcMain = fakeIpcMain();
    const sender = fakeWebContents((channel, payload) => sent.push({ channel, payload }));
    const taskEvent: TaskEvent = {
      apiVersion: 1,
      eventVersion: 1,
      taskId: TaskIdSchema.parse("task:event-bridge"),
      sequence: 1,
      emittedAt: "2026-06-28T08:00:00.000Z",
      type: "accepted" as const,
      payload: {
        taskKind: "scan" as const,
        phase: "queued" as const,
        acceptedAt: "2026-06-28T08:00:00.000Z",
      },
    };

    registerIpcHandlers({
      ipcMain: ipcMain as never,
      services: commandServices({}),
      taskEvents: {
        subscribe: vi.fn(
          (_taskId: string, _afterSequence: number, listener: (event: TaskEvent) => void) => {
            listener(taskEvent);
            return unsubscribe;
          },
        ),
      },
      appVersion: () => "0.2.0-test",
      dialog: { selectDirectory: () => Promise.resolve(undefined) },
      webContents: () => [sender as never],
    });

    await ipcMain.invoke(
      "ai-config-hub:v1:task.subscribe",
      { taskId: "task:event-bridge", afterSequence: 0 },
      trustedEvent(sender),
    );
    await ipcMain.invoke(
      "ai-config-hub:v1:task.unsubscribe",
      { taskId: "task:event-bridge" },
      trustedEvent(sender),
    );

    expect(sent).toEqual([{ channel: TASK_EVENT_CHANNEL, payload: taskEvent }]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("dispatches update commands and forwards update events to trusted windows", async () => {
    const sent: unknown[] = [];
    const unsubscribe = vi.fn();
    const ipcMain = fakeIpcMain();
    const sender = fakeWebContents((channel, payload) => sent.push({ channel, payload }));
    const status = {
      enabled: true,
      status: "available" as const,
      currentVersion: "0.2.12",
      updateVersion: "0.2.13",
    } satisfies UpdateStatus;
    const updates = {
      status: vi.fn(() => status),
      check: vi.fn().mockResolvedValue(status),
      download: vi.fn().mockResolvedValue(status),
      install: vi.fn().mockResolvedValue(undefined),
      startAutomaticChecks: vi.fn(() => vi.fn()),
      subscribe: vi.fn((listener: (event: typeof status) => void) => {
        listener(status);
        return unsubscribe;
      }),
    };

    const unregister = registerIpcHandlers({
      ipcMain: ipcMain as never,
      services: commandServices({}),
      updates,
      appVersion: () => "0.2.12",
      dialog: { selectDirectory: () => Promise.resolve(undefined) },
      webContents: () => [sender as never],
    });

    expect(await ipcMain.invoke(UPDATE_STATUS_CHANNEL, undefined, trustedEvent(sender))).toBe(
      status,
    );
    await ipcMain.invoke(UPDATE_CHECK_CHANNEL, undefined, trustedEvent(sender));
    await ipcMain.invoke(UPDATE_DOWNLOAD_CHANNEL, undefined, trustedEvent(sender));
    await ipcMain.invoke(UPDATE_INSTALL_CHANNEL, undefined, trustedEvent(sender));
    unregister();

    expect(updates.check).toHaveBeenCalledTimes(1);
    expect(updates.download).toHaveBeenCalledTimes(1);
    expect(updates.install).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ channel: UPDATE_EVENT_CHANNEL, payload: status }]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("rejects update commands from unknown senders", async () => {
    const ipcMain = fakeIpcMain();
    const sender = fakeWebContents();
    const unknownSender = fakeWebContents();
    const updates = {
      status: vi.fn(),
      check: vi.fn(),
      download: vi.fn(),
      install: vi.fn(),
      startAutomaticChecks: vi.fn(() => vi.fn()),
      subscribe: vi.fn(() => vi.fn()),
    };

    registerIpcHandlers({
      ipcMain: ipcMain as never,
      services: commandServices({}),
      updates,
      appVersion: () => "0.2.12",
      dialog: { selectDirectory: () => Promise.resolve(undefined) },
      webContents: () => [sender as never],
    });

    await expect(
      ipcMain.invoke(UPDATE_STATUS_CHANNEL, undefined, trustedEvent(unknownSender)),
    ).rejects.toThrow("Untrusted IPC sender");
    expect(updates.status).not.toHaveBeenCalled();
  });

  it("skips destroyed windows when forwarding update events", () => {
    const ipcMain = fakeIpcMain();
    const destroyedSend = vi.fn(() => {
      throw new Error("destroyed window cannot receive updates");
    });
    const destroyedWindow = fakeWebContents(destroyedSend, { destroyed: true });
    const liveSend = vi.fn();
    const liveWindow = fakeWebContents(liveSend);
    const status = {
      enabled: true,
      status: "available" as const,
      currentVersion: "0.2.12",
      updateVersion: "0.2.13",
    } satisfies UpdateStatus;
    const updates = {
      status: vi.fn(() => status),
      check: vi.fn().mockResolvedValue(status),
      download: vi.fn().mockResolvedValue(status),
      install: vi.fn(),
      startAutomaticChecks: vi.fn(() => vi.fn()),
      subscribe: vi.fn((listener: (event: typeof status) => void) => {
        listener(status);
        return vi.fn();
      }),
    };

    expect(() =>
      registerIpcHandlers({
        ipcMain: ipcMain as never,
        services: commandServices({}),
        updates,
        appVersion: () => "0.2.12",
        dialog: { selectDirectory: () => Promise.resolve(undefined) },
        webContents: () => [destroyedWindow as never, liveWindow as never],
      }),
    ).not.toThrow();

    expect(destroyedSend).not.toHaveBeenCalled();
    expect(liveSend).toHaveBeenCalledWith(UPDATE_EVENT_CHANNEL, status);
  });
});

function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>();
  return {
    handle(channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) {
      handlers.set(channel, handler);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
    invoke(channel: string, payload?: unknown, event: unknown = {}) {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`Missing handler: ${channel}`);
      return Promise.resolve().then(() => handler(event, payload));
    },
  };
}

function fakeWebContents(
  send: (channel: string, payload: unknown) => void = vi.fn(),
  options: { readonly destroyed?: boolean } = {},
) {
  const mainFrame = { frameId: 1 };
  return { isDestroyed: () => options.destroyed ?? false, mainFrame, send };
}

function trustedEvent(sender: ReturnType<typeof fakeWebContents>) {
  return { sender, senderFrame: sender.mainFrame };
}

function commandServices(overrides: Partial<CommandServiceMap>): CommandServiceMap {
  const hash = ContentHashSchema.parse(`sha256:${"a".repeat(64)}`);
  const base: Record<keyof CommandServiceMap, (payload: never) => Promise<unknown>> = {
    "scan.start": vi.fn(),
    "scan.status": vi.fn(),
    "scan.cancel": vi.fn(),
    "assets.list": vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      snapshotRevision: "1",
      stale: false,
    }),
    "assets.get": vi.fn().mockResolvedValue({
      asset: {
        id: AssetIdSchema.parse("asset-1"),
        toolKey: "codex",
        resourceType: "rule",
        scopeId: "scope-1",
        logicalKey: "AGENTS.md",
        status: "enabled",
        disablementOptions: [
          {
            method: "move_file",
            label: "Move file out of the tool load path",
            description: "Move the source file into the AI Config Hub disabled-assets area.",
            recommended: true,
          },
          {
            method: "hub_ignore",
            label: "Ignore inside AI Config Hub only",
            description: "Keep the tool configuration unchanged and ignore the asset in Hub.",
            recommended: false,
          },
        ],
      },
      source: {
        pathDisplay: "AGENTS.md",
        contentHash: hash,
        observedAt: "2026-06-28T08:00:00.000Z",
      },
      redactions: [],
    }),
    "assets.openSource": vi.fn(),
    "assets.disable": vi
      .fn()
      .mockResolvedValue({ assetId: AssetIdSchema.parse("asset-1"), status: "disabled" }),
    "assets.enable": vi
      .fn()
      .mockResolvedValue({ assetId: AssetIdSchema.parse("asset-1"), status: "enabled" }),
    "effective.resolve": vi.fn(),
    "diagnostics.list": vi.fn(),
    "diagnostics.export": vi.fn(),
    "migration.preview": vi.fn(),
    "deployment.execute": vi.fn(),
    "deployment.rollback": vi.fn(),
    "history.list": vi.fn(),
    "history.get": vi.fn(),
    "settings.get": vi.fn(),
    "settings.update": vi.fn(),
  };
  return { ...base, ...overrides } as CommandServiceMap;
}
