import { describe, expect, it, vi } from "vitest";

import { createCoreUseCases, type ApplicationServices } from "./application-services.js";

describe("ApplicationServices", () => {
  it("adapts the named service facade to the approved core command catalog", async () => {
    const start = vi.fn().mockResolvedValue({ taskId: "task-1", scanRunId: "scan-1" });
    const services = {
      scan: { start, status: vi.fn(), cancel: vi.fn() },
      assets: { list: vi.fn(), get: vi.fn() },
      effective: { resolve: vi.fn() },
      diagnostics: { list: vi.fn() },
      migration: { preview: vi.fn() },
      deployments: { execute: vi.fn(), rollback: vi.fn() },
      history: { list: vi.fn() },
      settings: { get: vi.fn(), update: vi.fn() },
    } as unknown as ApplicationServices;

    const useCases = createCoreUseCases(services);

    await expect(
      useCases["scan.start"]({ mode: "full", readOnly: false, roots: [] }),
    ).resolves.toEqual({ taskId: "task-1", scanRunId: "scan-1" });
    expect(start).toHaveBeenCalledWith({ mode: "full", readOnly: false, roots: [] });
    expect(Object.keys(useCases)).toEqual([
      "scan.start",
      "scan.status",
      "scan.cancel",
      "assets.list",
      "assets.get",
      "effective.resolve",
      "diagnostics.list",
      "migration.preview",
      "deployment.execute",
      "deployment.rollback",
      "history.list",
      "settings.get",
      "settings.update",
    ]);
  });
});
