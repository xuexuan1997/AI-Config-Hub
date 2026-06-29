import { describe, expect, it, vi } from "vitest";

import { createCoreUseCases, type ApplicationServices } from "./application-services.js";

describe("ApplicationServices", () => {
  it("adapts the named service facade to the approved core command catalog", async () => {
    const start = vi.fn().mockResolvedValue({ taskId: "task-1", scanRunId: "scan-1" });
    const openSource = vi.fn().mockResolvedValue({ assetId: "asset-1", opened: true });
    const getHistory = vi.fn().mockResolvedValue({
      entry: {
        id: "deployment-1",
        kind: "deployment",
        status: "succeeded",
        createdAt: "2026-06-28T08:00:00.000Z",
      },
      plan: {
        planId: "deployment-plan-1",
        planHash: `sha256:${"a".repeat(64)}`,
        requiredConfirmations: [],
      },
      changes: [],
    });
    const services = {
      scan: { start, status: vi.fn(), cancel: vi.fn() },
      assets: { list: vi.fn(), get: vi.fn(), openSource },
      effective: { resolve: vi.fn() },
      diagnostics: { list: vi.fn(), export: vi.fn() },
      migration: { preview: vi.fn() },
      deployments: { execute: vi.fn(), rollback: vi.fn() },
      history: { list: vi.fn(), get: getHistory },
      settings: { get: vi.fn(), update: vi.fn() },
    } as unknown as ApplicationServices;

    const useCases = createCoreUseCases(services);

    await expect(
      useCases["scan.start"]({ mode: "full", readOnly: false, roots: [] }),
    ).resolves.toEqual({ taskId: "task-1", scanRunId: "scan-1" });
    expect(start).toHaveBeenCalledWith({ mode: "full", readOnly: false, roots: [] });
    await expect(useCases["history.get"]({ id: "deployment-1" })).resolves.toMatchObject({
      entry: { id: "deployment-1" },
      plan: { planId: "deployment-plan-1" },
      changes: [],
    });
    expect(getHistory).toHaveBeenCalledWith({ id: "deployment-1" });
    await expect(useCases["assets.openSource"]({ assetId: "asset-1" })).resolves.toEqual({
      assetId: "asset-1",
      opened: true,
    });
    expect(openSource).toHaveBeenCalledWith({ assetId: "asset-1" });
    expect(Object.keys(useCases)).toEqual([
      "scan.start",
      "scan.status",
      "scan.cancel",
      "assets.list",
      "assets.get",
      "assets.openSource",
      "effective.resolve",
      "diagnostics.list",
      "diagnostics.export",
      "migration.preview",
      "deployment.execute",
      "deployment.rollback",
      "history.list",
      "history.get",
      "settings.get",
      "settings.update",
    ]);
  });
});
