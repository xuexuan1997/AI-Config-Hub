import type { CommandServiceMap, TaskEvent } from "@ai-config-hub/api";
import { API_COMMAND_NAMES } from "@ai-config-hub/api";
import { TaskIdSchema } from "@ai-config-hub/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startLocalApiServer } from "./index.js";

type RunningServer = Awaited<ReturnType<typeof startLocalApiServer>>;

const runningServers: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop()));
});

describe("local API server", () => {
  it("rejects unsafe bind hosts unless explicitly allowed", async () => {
    await expect(
      startLocalApiServer({ services: commandServices({}), host: "0.0.0.0" }),
    ).rejects.toThrow("UNSAFE_BIND_HOST");
    await expect(
      startLocalApiServer({ services: commandServices({}), host: "192.168.1.10" }),
    ).rejects.toThrow("UNSAFE_BIND_HOST");

    const server = await startLocalApiServer({
      services: commandServices({}),
      host: "0.0.0.0",
      allowUnsafeRemote: true,
    });
    runningServers.push(server);
    expect(server.url).toMatch(/^http:\/\/0\.0\.0\.0:/);
  });

  it("requires bearer authentication and sends no-store API responses", async () => {
    const services = commandServices({
      "assets.list": vi.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
        snapshotRevision: "1",
        stale: false,
      }),
    });
    const server = await startLocalApiServer({
      services,
      authToken: "secret-token",
      allowedOrigins: ["http://localhost:5173"],
    });
    runningServers.push(server);

    const missing = await fetch(`${server.url}/api/command/assets.list`, {
      method: "POST",
      body: JSON.stringify({ apiVersion: 1, requestId: "request:auth", payload: { limit: 10 } }),
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    await expect(missing.json()).resolves.toMatchObject({
      apiVersion: 1,
      requestId: "request:invalid",
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });

    const invalid = await postCommand(server, "assets.list", {
      token: "wrong-token",
      origin: "http://localhost:5173",
      payload: { apiVersion: 1, requestId: "request:auth", payload: { limit: 10 } },
    });
    expect(invalid.status).toBe(401);

    const valid = await postCommand(server, "assets.list", {
      token: "secret-token",
      origin: "http://localhost:5173",
      payload: { apiVersion: 1, requestId: "request:auth", payload: { limit: 10 } },
    });
    expect(valid.status).toBe(200);
    expect(valid.headers.get("cache-control")).toBe("no-store");
    await expect(valid.json()).resolves.toMatchObject({ ok: true, requestId: "request:auth" });
    expect(services["assets.list"]).toHaveBeenCalledWith({ limit: 10 });
  });

  it("allows absent Origin but rejects unapproved browser origins", async () => {
    const services = commandServices({
      "assets.list": vi.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
        snapshotRevision: "1",
        stale: false,
      }),
    });
    const server = await startLocalApiServer({
      services,
      authToken: "secret-token",
      allowedOrigins: ["http://localhost:5173"],
    });
    runningServers.push(server);

    const cli = await postCommand(server, "assets.list", {
      token: "secret-token",
      payload: { apiVersion: 1, requestId: "request:cli", payload: { limit: 10 } },
    });
    expect(cli.status).toBe(200);

    const browser = await postCommand(server, "assets.list", {
      token: "secret-token",
      origin: "http://evil.example",
      payload: { apiVersion: 1, requestId: "request:browser", payload: { limit: 10 } },
    });
    expect(browser.status).toBe(403);
    await expect(browser.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });

  it("reuses shared command handlers and does not call services for malformed commands", async () => {
    const assetsList = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      snapshotRevision: "1",
      stale: false,
    });
    const server = await startLocalApiServer({
      services: commandServices({ "assets.list": assetsList }),
      authToken: "secret-token",
    });
    runningServers.push(server);

    const malformedEnvelope = await postCommand(server, "assets.list", {
      token: "secret-token",
      payload: { apiVersion: 1, requestId: "request:bad", payload: { limit: 0 } },
    });
    expect(malformedEnvelope.status).toBe(400);
    await expect(malformedEnvelope.json()).resolves.toMatchObject({
      apiVersion: 1,
      requestId: "request:bad",
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(assetsList).not.toHaveBeenCalled();

    const invalidCommand = await postCommand(server, "nope", {
      token: "secret-token",
      payload: { apiVersion: 1, requestId: "request:nope", payload: {} },
    });
    expect(invalidCommand.status).toBe(404);
    await expect(invalidCommand.json()).resolves.toMatchObject({
      apiVersion: 1,
      requestId: "request:nope",
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(assetsList).not.toHaveBeenCalled();

    const valid = await postCommand(server, "assets.list", {
      token: "secret-token",
      payload: { apiVersion: 1, requestId: "request:good", payload: { limit: 10 } },
    });
    expect(valid.status).toBe(200);
    expect(assetsList).toHaveBeenCalledOnce();
  });

  it("streams task events over SSE and closes subscriptions on shutdown", async () => {
    let listener: ((event: TaskEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(
      (_taskId: string, _afterSequence: number, onEvent: (event: TaskEvent) => void) => {
        listener = onEvent;
        return unsubscribe;
      },
    );
    const server = await startLocalApiServer({
      services: commandServices({}),
      authToken: "secret-token",
      taskEvents: { subscribe },
    });
    runningServers.push(server);

    const response = await fetch(`${server.url}/api/tasks/task:sse/events?afterSequence=7`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(subscribe).toHaveBeenCalledWith("task:sse", 7, expect.any(Function));

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    listener?.(acceptedEvent("task:sse", 8));
    const chunk = await reader?.read();
    const text = new TextDecoder().decode(chunk?.value);
    expect(text).toContain("event: task");
    expect(text).toContain('"taskId":"task:sse"');
    expect(text).toContain('"sequence":8');

    await server.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

async function postCommand(
  server: RunningServer,
  name: string,
  options: {
    readonly token: string;
    readonly origin?: string;
    readonly payload: unknown;
  },
): Promise<Response> {
  return fetch(`${server.url}/api/command/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json",
      ...(options.origin === undefined ? {} : { Origin: options.origin }),
    },
    body: JSON.stringify(options.payload),
  });
}

function acceptedEvent(taskId: string, sequence: number): TaskEvent {
  return {
    apiVersion: 1,
    eventVersion: 1,
    taskId: TaskIdSchema.parse(taskId),
    sequence,
    emittedAt: "2026-06-29T08:00:00.000Z",
    type: "accepted",
    payload: {
      taskKind: "scan",
      phase: "queued",
      acceptedAt: "2026-06-29T08:00:00.000Z",
    },
  };
}

function commandServices(overrides: Partial<CommandServiceMap>): CommandServiceMap {
  return Object.fromEntries(
    API_COMMAND_NAMES.map((name) => [
      name,
      overrides[name] ??
        vi.fn().mockRejectedValue(new Error(`Unexpected command service call: ${name}`)),
    ]),
  ) as CommandServiceMap;
}
