import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.js";

describe("transport-neutral API client", () => {
  it("validates both sides of a command invocation", async () => {
    const invoke = vi.fn().mockResolvedValue({
      apiVersion: 1,
      requestId: "request-1",
      ok: true,
      data: {
        taskId: "task-1",
        status: "queued",
        acceptedAt: "2026-06-21T08:00:00.000Z",
      },
    });
    const client = createApiClient(
      { invoke, subscribeTask: vi.fn() },
      { requestId: () => "request-1" },
    );

    const response = await client.invoke("scan.start", { mode: "full" });
    expect(response.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("ai-config-hub:v1:scan.start", {
      apiVersion: 1,
      requestId: "request-1",
      payload: { mode: "full" },
    });
  });

  it("rejects response/request correlation drift", async () => {
    const client = createApiClient(
      {
        invoke: vi.fn().mockResolvedValue({
          apiVersion: 1,
          requestId: "wrong-request",
          ok: true,
          data: {
            taskId: "task-1",
            status: "queued",
            acceptedAt: "2026-06-21T08:00:00.000Z",
          },
        }),
        subscribeTask: vi.fn(),
      },
      { requestId: () => "request-1" },
    );

    await expect(client.invoke("scan.start", { mode: "full" })).rejects.toThrow(
      "API_RESPONSE_REQUEST_ID_MISMATCH",
    );
  });
});
