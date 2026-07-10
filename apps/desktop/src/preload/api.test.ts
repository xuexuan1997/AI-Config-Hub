import { API_COMMAND_NAMES, TaskEventSchema, type TaskEvent } from "@ai-config-hub/api";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

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
      "runtimeState",
      "selectProjectRoot",
      "subscribeIndexChanges",
      "subscribeTask",
      "subscribeUpdates",
      "updateStatus",
    ]);
  });

  it("reads active tasks and recovery state from the trusted runtime channel", async () => {
    const runtimeState = {
      activeTasks: [
        {
          taskId: "task:scan:1",
          taskKind: "scan" as const,
          clientContext: "asset-review" as const,
          selectedRoots: ["/workspace/selected-project"],
          canonicalRoots: ["/workspace/canonical-project"],
        },
      ],
      recoveryDeploymentIds: ["deployment-record:1"],
    };
    const invoke = vi.fn().mockResolvedValue(runtimeState);
    const api = createDesktopApi(
      { invoke, on: vi.fn(), off: vi.fn() },
      { requestId: () => "request-1" },
    );

    await expect(api.runtimeState()).resolves.toEqual(runtimeState);
    expect(invoke).toHaveBeenCalledWith("ai-config-hub:v1:runtime.state");
  });

  it("builds validated command-channel requests and removes task listeners", async () => {
    const invoke = vi.fn((channel: string) =>
      Promise.resolve(
        channel === "ai-config-hub:v1:task.subscribe"
          ? true
          : {
              apiVersion: 1,
              requestId: "request-1",
              ok: true,
              data: {},
            },
      ),
    );
    const off = vi.fn();
    const transport: PreloadTransport = { invoke, on: vi.fn(), off };
    const api = createDesktopApi(transport, { requestId: () => "request-1" });

    await api.invoke("scan.start", { mode: "full" });
    const subscription = api.subscribeTask("task-1", 0, vi.fn());
    expect(Object.isFrozen(subscription)).toBe(true);
    expect(Object.keys(subscription).sort()).toEqual(["ready", "unsubscribe"]);
    subscription.unsubscribe();
    await subscription.ready;
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

  it("delivers task events only to listeners subscribed to the matching task", () => {
    const eventListeners = new Set<(event: unknown, payload: unknown) => void>();
    const transport: PreloadTransport = {
      invoke: vi.fn().mockResolvedValue(true),
      on: vi.fn((_channel: string, listener: (event: unknown, payload: unknown) => void) =>
        eventListeners.add(listener),
      ),
      off: vi.fn((_channel: string, listener: (event: unknown, payload: unknown) => void) =>
        eventListeners.delete(listener),
      ),
    };
    const api = createDesktopApi(transport, { requestId: () => "request-1" });
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const firstEvent = acceptedTaskEvent("task:first", 1);
    const secondEvent = acceptedTaskEvent("task:second", 1);

    api.subscribeTask("task:first", 0, firstListener);
    api.subscribeTask("task:second", 0, secondListener);
    emitTaskEvent(eventListeners, firstEvent);

    expect(firstListener).toHaveBeenCalledWith(firstEvent);
    expect(secondListener).not.toHaveBeenCalled();

    emitTaskEvent(eventListeners, secondEvent);

    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledWith(secondEvent);
  });

  it("unsubscribes task listeners once and ignores retained callbacks", async () => {
    const invoke = vi.fn().mockResolvedValue(true);
    let wrapped: ((event: unknown, payload: unknown) => void) | undefined;
    const transport: PreloadTransport = {
      invoke,
      on: vi.fn((_channel: string, listener: (event: unknown, payload: unknown) => void) => {
        wrapped = listener;
      }),
      off: vi.fn(),
    };
    const api = createDesktopApi(transport, { requestId: () => "request-1" });
    const listener = vi.fn();
    const event = acceptedTaskEvent("task:safe-unsubscribe", 1);
    const subscription = api.subscribeTask("task:safe-unsubscribe", 4, listener);

    subscription.unsubscribe();
    subscription.unsubscribe();
    wrapped?.({}, event);
    await subscription.ready;
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("ai-config-hub:v1:task.unsubscribe", {
        taskId: "task:safe-unsubscribe",
        subscriptionId: "task-subscription:1:request-1",
      });
    });

    expect(listener).not.toHaveBeenCalled();
    expect(transport.off).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("ai-config-hub:v1:task.subscribe", {
      taskId: "task:safe-unsubscribe",
      afterSequence: 4,
      subscriptionId: "task-subscription:1:request-1",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("rejects readiness with an actionable error and skips cleanup when subscription IPC fails", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("IPC unavailable"));
    const transport: PreloadTransport = { invoke, on: vi.fn(), off: vi.fn() };
    const api = createDesktopApi(transport, { requestId: () => "request-1" });

    const subscription = api.subscribeTask("task:failed-subscription", 0, vi.fn());
    subscription.unsubscribe();
    await expect(subscription.ready).rejects.toThrow(
      'Could not subscribe to task events for "task:failed-subscription": IPC unavailable',
    );
    await vi.waitFor(() => expect(transport.off).toHaveBeenCalledTimes(1));

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("ai-config-hub:v1:task.subscribe", {
      taskId: "task:failed-subscription",
      afterSequence: 0,
      subscriptionId: "task-subscription:1:request-1",
    });
  });

  it("rejects readiness when the main process declines the subscription", async () => {
    const invoke = vi.fn().mockResolvedValue(false);
    const transport: PreloadTransport = { invoke, on: vi.fn(), off: vi.fn() };
    const api = createDesktopApi(transport, { requestId: () => "request-1" });

    const subscription = api.subscribeTask("task:rejected-subscription", 2, vi.fn());

    await expect(subscription.ready).rejects.toThrow(
      'Task event subscription for "task:rejected-subscription" was rejected by the main process.',
    );
    subscription.unsubscribe();

    expect(transport.off).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("ai-config-hub:v1:task.subscribe", {
      taskId: "task:rejected-subscription",
      afterSequence: 2,
      subscriptionId: "task-subscription:1:request-1",
    });
  });

  it("cleans up once when unsubscribe happens before subscription readiness", async () => {
    let resolveSubscription: ((value: unknown) => void) | undefined;
    const subscriptionResult = new Promise<unknown>((resolve) => {
      resolveSubscription = resolve;
    });
    const invoke = vi.fn((channel: string) =>
      channel === "ai-config-hub:v1:task.subscribe" ? subscriptionResult : Promise.resolve(true),
    );
    const transport: PreloadTransport = { invoke, on: vi.fn(), off: vi.fn() };
    const api = createDesktopApi(transport, { requestId: () => "request-late" });

    const subscription = api.subscribeTask("task:late-ready", 7, vi.fn());
    subscription.unsubscribe();
    subscription.unsubscribe();

    expect(transport.off).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("ai-config-hub:v1:task.unsubscribe", expect.anything());

    resolveSubscription?.(true);
    await subscription.ready;
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));

    expect(invoke).toHaveBeenLastCalledWith("ai-config-hub:v1:task.unsubscribe", {
      taskId: "task:late-ready",
      subscriptionId: "task-subscription:1:request-late",
    });
  });

  it("gives overlapping subscriptions unique ownership identities", async () => {
    const invoke = vi.fn().mockResolvedValue(true);
    const transport: PreloadTransport = { invoke, on: vi.fn(), off: vi.fn() };
    const api = createDesktopApi(transport, { requestId: () => "request-fixed" });

    const oldSubscription = api.subscribeTask("task:shared", 0, vi.fn());
    const newSubscription = api.subscribeTask("task:shared", 3, vi.fn());
    oldSubscription.unsubscribe();
    newSubscription.unsubscribe();
    await Promise.all([oldSubscription.ready, newSubscription.ready]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));

    expect(invoke.mock.calls).toEqual([
      [
        "ai-config-hub:v1:task.subscribe",
        {
          taskId: "task:shared",
          afterSequence: 0,
          subscriptionId: "task-subscription:1:request-fixed",
        },
      ],
      [
        "ai-config-hub:v1:task.subscribe",
        {
          taskId: "task:shared",
          afterSequence: 3,
          subscriptionId: "task-subscription:2:request-fixed",
        },
      ],
      [
        "ai-config-hub:v1:task.unsubscribe",
        {
          taskId: "task:shared",
          subscriptionId: "task-subscription:1:request-fixed",
        },
      ],
      [
        "ai-config-hub:v1:task.unsubscribe",
        {
          taskId: "task:shared",
          subscriptionId: "task-subscription:2:request-fixed",
        },
      ],
    ]);
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

  it("delivers validated index changes and removes the whitelisted listener once", () => {
    let wrapped: ((event: unknown, payload: unknown) => void) | undefined;
    const transport: PreloadTransport = {
      invoke: vi.fn(),
      on: vi.fn<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>(
        (_channel, listener) => {
          wrapped = listener;
        },
      ),
      off: vi.fn(),
    };
    const api = createDesktopApi(transport, { requestId: () => "request-1" });
    const listener = vi.fn();
    const unsubscribe = api.subscribeIndexChanges(listener);

    wrapped?.({}, { roots: [] });
    wrapped?.({}, { roots: ["/workspace/project", 42] });
    wrapped?.({}, { roots: ["/workspace/project"] });
    unsubscribe();
    unsubscribe();
    wrapped?.({}, { roots: ["/workspace/ignored"] });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ roots: ["/workspace/project"] });
    expect(transport.on).toHaveBeenCalledWith(
      "ai-config-hub:v1:index.changed",
      expect.any(Function),
    );
    expect(transport.off).toHaveBeenCalledWith(
      "ai-config-hub:v1:index.changed",
      expect.any(Function),
    );
    expect(transport.off).toHaveBeenCalledTimes(1);
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

  it("keeps the production preload command whitelist aligned with API commands", () => {
    const preloadPath = resolve(dirname(fileURLToPath(import.meta.url)), "preload.cts");
    const sourceFile = ts.createSourceFile(
      preloadPath,
      readFileSync(preloadPath, "utf8"),
      ts.ScriptTarget.ESNext,
      true,
    );

    expect(readonlyStringArrayConst(sourceFile, "API_COMMAND_NAMES")).toEqual([
      ...API_COMMAND_NAMES,
    ]);
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

function acceptedTaskEvent(taskId: string, sequence: number): TaskEvent {
  return TaskEventSchema.parse({
    apiVersion: 1,
    eventVersion: 1,
    taskId,
    sequence,
    emittedAt: "2026-07-10T00:00:00.000Z",
    type: "accepted",
    payload: {
      taskKind: "scan",
      phase: "queued",
      acceptedAt: "2026-07-10T00:00:00.000Z",
    },
  });
}

function emitTaskEvent(
  listeners: ReadonlySet<(event: unknown, payload: unknown) => void>,
  event: TaskEvent,
): void {
  for (const listener of listeners) listener({}, event);
}

function readonlyStringArrayConst(sourceFile: ts.SourceFile, name: string): readonly string[] {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      const initializer = declaration.initializer;
      if (initializer === undefined) return [];
      const arrayLiteral = ts.isAsExpression(initializer) ? initializer.expression : initializer;
      if (!ts.isArrayLiteralExpression(arrayLiteral)) return [];
      return arrayLiteral.elements
        .filter((element): element is ts.StringLiteral => ts.isStringLiteral(element))
        .map((element) => element.text);
    }
  }
  return [];
}
