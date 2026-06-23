import { AppError, TaskIdSchema } from "@ai-config-hub/shared";
import { describe, expect, it, vi } from "vitest";

import { API_COMMAND_NAMES, type CommandResponse } from "./commands.js";
import { createCommandHandlers, type CommandServiceMap } from "./handlers.js";

describe("createCommandHandlers", () => {
  it("validates requests before calling services and returns stable envelopes", async () => {
    const scanStart = vi.fn().mockResolvedValue({
      taskId: TaskIdSchema.parse("task-1"),
      status: "queued",
      acceptedAt: "2026-06-21T08:00:00.000Z",
    } satisfies CommandResponse<"scan.start">);
    const handlers = createCommandHandlers(services({ "scan.start": scanStart }), {
      correlationId: () => "correlation-1",
    });

    await expect(
      handlers["scan.start"]({ apiVersion: 1, requestId: "request-1", payload: { mode: "bad" } }),
    ).resolves.toMatchObject({
      ok: false,
      requestId: "request-1",
      error: { code: "VALIDATION_FAILED", correlationId: "correlation-1" },
    });
    expect(scanStart).not.toHaveBeenCalled();

    await expect(
      handlers["scan.start"]({ apiVersion: 1, requestId: "request-2", payload: { mode: "full" } }),
    ).resolves.toEqual({
      apiVersion: 1,
      requestId: "request-2",
      ok: true,
      data: {
        taskId: "task-1",
        status: "queued",
        acceptedAt: "2026-06-21T08:00:00.000Z",
      },
    });
    expect(scanStart).toHaveBeenCalledWith({ mode: "full" });
  });

  it("maps domain errors to redacted API failures", async () => {
    const handlers = createCommandHandlers(
      services({
        "assets.get": vi.fn().mockRejectedValue(
          new AppError({
            code: "NOT_FOUND",
            message: "Asset was not found",
            retryable: false,
            suggestedActions: ["Refresh the asset list"],
            safeContext: { assetId: "asset-1" },
            cause: new Error("secret token"),
          }),
        ),
      }),
      { correlationId: () => "correlation-2" },
    );

    const response = await handlers["assets.get"]({
      apiVersion: 1,
      requestId: "request-3",
      payload: { assetId: "asset-1" },
    });

    expect(response).toEqual({
      apiVersion: 1,
      requestId: "request-3",
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Asset was not found",
        retryable: false,
        action: "Refresh the asset list",
        details: { assetId: "asset-1" },
        correlationId: "correlation-2",
      },
    });
    expect(JSON.stringify(response)).not.toContain("secret");
  });
});

function services(overrides: Partial<CommandServiceMap>): CommandServiceMap {
  return Object.fromEntries(
    API_COMMAND_NAMES.map((name) => [
      name,
      overrides[name] ??
        vi.fn().mockRejectedValue(new Error(`Unexpected command service call: ${name}`)),
    ]),
  ) as CommandServiceMap;
}
