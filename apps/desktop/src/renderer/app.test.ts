import { describe, expect, it, vi } from "vitest";

import { TaskEventSchema } from "@ai-config-hub/api";

import type { DesktopApi } from "../preload/api.js";
import {
  advanceIndexRefreshGeneration,
  createSingleRetryScheduler,
  indexChangeAffectsMigration,
  isCurrentIndexRefresh,
  isCurrentScanRoot,
  migrationPreviewRequestFingerprint,
  operationTaskFailureMessage,
  refreshAffectedIndexViews,
  refreshRestoredScanSelection,
  rendererWorkIsInFlight,
  restoredScanSelectionForTask,
  runGuardedAction,
  scanStartRequestForContext,
  subscribeTaskWithRetry,
} from "./app.js";
import type { AppAction } from "./model.js";

describe("desktop watcher index refresh", () => {
  it("tags each renderer scan entry point with its restoring context", () => {
    expect(
      scanStartRequestForContext("/workspace/review", "project:review", "asset-review"),
    ).toMatchObject({
      roots: ["/workspace/review"],
      projectId: "project:review",
      clientContext: "asset-review",
    });
    expect(
      scanStartRequestForContext("/workspace/source", "project:source", "migration-source"),
    ).toMatchObject({
      roots: ["/workspace/source"],
      projectId: "project:source",
      clientContext: "migration-source",
    });
    expect(
      scanStartRequestForContext("/workspace/target", "project:target", "migration-target"),
    ).toMatchObject({
      roots: ["/workspace/target"],
      projectId: "project:target",
      clientContext: "migration-target",
    });
  });

  it("restores scan scope and project from active runtime metadata", () => {
    expect(
      restoredScanSelectionForTask({
        taskId: "task:scan:restored",
        taskKind: "scan",
        clientContext: "migration-target",
        selectedRoots: ["/workspace/selected-target"],
        canonicalRoots: ["/workspace/canonical-target"],
      }),
    ).toEqual({
      scanScope: "migration-target",
      projectRoot: "/workspace/selected-target",
    });
    expect(
      restoredScanSelectionForTask({
        taskId: "task:scan:watcher",
        taskKind: "scan",
        canonicalRoots: ["/workspace/watcher"],
      }),
    ).toBeUndefined();
  });

  it.each([
    ["asset-review", "assetReview"],
    ["migration-source", "migrationSource"],
    ["migration-target", "migrationTarget"],
  ] as const)(
    "refreshes only the matching %s view after restored scan completion",
    (scanScope, key) => {
      const refreshers = {
        assetReview: vi.fn(),
        migrationSource: vi.fn(),
        migrationTarget: vi.fn(),
      };

      refreshRestoredScanSelection({ scanScope, projectRoot: "/workspace/restored" }, refreshers);

      expect(refreshers[key]).toHaveBeenCalledWith("/workspace/restored");
      expect(
        Object.values(refreshers).reduce((count, refresh) => count + refresh.mock.calls.length, 0),
      ).toBe(1);
    },
  );

  it("matches each scan scope against its own selected root", () => {
    const roots = {
      assetReview: "/workspace/review",
      migrationSource: "/workspace/source",
      migrationTarget: "/workspace/target",
    };

    expect(isCurrentScanRoot(roots, "asset-review", "/workspace/review")).toBe(true);
    expect(isCurrentScanRoot(roots, "asset-review", "/workspace/source")).toBe(false);
    expect(isCurrentScanRoot(roots, "migration-source", "/workspace/source")).toBe(true);
    expect(isCurrentScanRoot(roots, "migration-target", "/workspace/target")).toBe(true);
  });

  it("invalidates late migration previews when visible inputs change", () => {
    const original = migrationPreviewRequestFingerprint({
      sourceAssetIds: ["asset-1"],
      targetToolKey: "cursor",
      targetScopeId: "/workspace/target",
      conflictPolicy: "replace",
    });

    expect(
      migrationPreviewRequestFingerprint({
        sourceAssetIds: ["asset-1"],
        targetToolKey: "codex",
        targetScopeId: "/workspace/target",
        conflictPolicy: "replace",
      }),
    ).not.toBe(original);
    expect(
      migrationPreviewRequestFingerprint({
        sourceAssetIds: ["asset-1"],
        targetToolKey: "cursor",
        targetScopeId: "/workspace/other-target",
        conflictPolicy: "replace",
      }),
    ).not.toBe(original);
  });

  it("recognizes watcher changes that must retire a migration preview immediately", () => {
    const roots = {
      assetReview: "/workspace/review",
      migrationSource: "/workspace/source",
      migrationTarget: "C:\\WORK\\target",
    };

    expect(indexChangeAffectsMigration({ roots: ["/workspace/source/"] }, roots)).toBe(true);
    expect(indexChangeAffectsMigration({ roots: ["c:/work/target/"] }, roots)).toBe(true);
    expect(indexChangeAffectsMigration({ roots: ["/workspace/review"] }, roots)).toBe(false);
  });

  it("retires an old root generation across an A-to-B-to-A selection cycle", () => {
    const generations = new Map<"assetReview" | "migrationSource" | "migrationTarget", number>();
    const oldGeneration = advanceIndexRefreshGeneration(generations, "assetReview");

    advanceIndexRefreshGeneration(generations, "assetReview");

    expect(
      isCurrentIndexRefresh(
        generations,
        "assetReview",
        oldGeneration,
        { assetReview: "/workspace/a" },
        "/workspace/a",
      ),
    ).toBe(false);
  });

  it("refreshes only matching visible roots without creating scan or task state", async () => {
    const invoke = vi.fn((name: string) => {
      if (name === "assets.list") {
        return {
          ok: true,
          data: { items: [], nextCursor: null, snapshotRevision: "1", stale: false },
        };
      }
      if (name === "diagnostics.list") {
        return {
          ok: true,
          data: {
            items: [],
            nextCursor: null,
            countsBySeverity: { info: 0, warning: 0, error: 0 },
          },
        };
      }
      throw new Error(`Unexpected command: ${name}`);
    });
    const api = { invoke } as unknown as DesktopApi;
    const actions: AppAction[] = [];

    await refreshAffectedIndexViews(
      api,
      { roots: ["/workspace/review/", "C:\\WORK\\target"] },
      {
        assetReview: "/workspace/review",
        migrationSource: "/workspace/source",
        migrationTarget: "c:/work/target/",
      },
      (action) => actions.push(action),
    );

    const commands = invoke.mock.calls.map(([name]) => name);
    expect(commands.filter((name) => name === "assets.list")).toHaveLength(2);
    expect(commands.filter((name) => name === "diagnostics.list")).toHaveLength(1);
    expect(actions.map((action) => action.type).sort()).toEqual([
      "assets",
      "diagnostics",
      "migrationTargetAssets",
    ]);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "assets", projectRoot: "/workspace/review" }),
        expect.objectContaining({ type: "diagnostics", projectRoot: "/workspace/review" }),
      ]),
    );
    expect(actions.some((action) => action.type === "scan" || action.type === "taskEvent")).toBe(
      false,
    );
  });

  it("ignores unrelated roots and drops results after the selected root changes", async () => {
    let releaseAssets: (() => void) | undefined;
    const assetsReady = new Promise<void>((resolve) => {
      releaseAssets = resolve;
    });
    const invoke = vi.fn(async (name: string) => {
      if (name !== "assets.list") throw new Error(`Unexpected command: ${name}`);
      await assetsReady;
      return {
        ok: true,
        data: { items: [], nextCursor: null, snapshotRevision: "1", stale: false },
      };
    });
    const api = { invoke } as unknown as DesktopApi;
    const actions: AppAction[] = [];
    let currentSource = "/workspace/source";
    const refresh = refreshAffectedIndexViews(
      api,
      { roots: ["/workspace/source"] },
      { migrationSource: currentSource, migrationTarget: "/workspace/unrelated" },
      (action) => actions.push(action),
      () => ({ migrationSource: currentSource }),
    );

    currentSource = "/workspace/new-source";
    releaseAssets?.();
    await refresh;

    expect(invoke).toHaveBeenCalledOnce();
    expect(actions).toEqual([]);
  });

  it("drops an older same-root watcher refresh that resolves last", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let invocation = 0;
    const invoke = vi.fn(async (name: string) => {
      if (name !== "assets.list") throw new Error(`Unexpected command: ${name}`);
      invocation += 1;
      if (invocation === 1) await firstReady;
      return {
        ok: true,
        data: { items: [], nextCursor: null, snapshotRevision: String(invocation), stale: false },
      };
    });
    const api = { invoke } as unknown as DesktopApi;
    const actions: AppAction[] = [];
    let generation = 0;
    const claimRefresh = () => {
      const claimed = ++generation;
      return () => generation === claimed;
    };
    const roots = { migrationSource: "/workspace/source" };

    const older = refreshAffectedIndexViews(
      api,
      { roots: ["/workspace/source"] },
      roots,
      (action) => actions.push(action),
      () => roots,
      claimRefresh,
    );
    const newer = refreshAffectedIndexViews(
      api,
      { roots: ["/workspace/source"] },
      roots,
      (action) => actions.push(action),
      () => roots,
      claimRefresh,
    );
    await newer;
    releaseFirst?.();
    await older;

    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("migrationSourceAssets");
  });
});

describe("desktop async lifecycle guards", () => {
  it("treats pre-subscription scans and asset mutations as blocking work", () => {
    expect(
      rendererWorkIsInFlight({
        scanInFlight: true,
        deploymentInFlight: false,
        assetMutationInFlight: false,
        activeTask: undefined,
      }),
    ).toBe(true);
    expect(
      rendererWorkIsInFlight({
        scanInFlight: false,
        deploymentInFlight: false,
        assetMutationInFlight: true,
        activeTask: undefined,
      }),
    ).toBe(true);
    expect(
      rendererWorkIsInFlight({
        scanInFlight: false,
        deploymentInFlight: false,
        assetMutationInFlight: false,
        activeTask: undefined,
      }),
    ).toBe(false);
  });

  it("surfaces an actionable operation failure message with an error-code fallback", () => {
    const baseEvent = {
      apiVersion: 1,
      eventVersion: 1,
      taskId: "task:deployment:failure-message",
      sequence: 2,
      emittedAt: "2026-07-10T00:00:00.000Z",
      type: "item.failed" as const,
      payload: {
        itemRef: "/workspace/source/AGENTS.md",
        diagnosticId: "diagnostic:source-drift",
        errorCode: "SOURCE_DRIFT",
        retryable: false,
      },
    };

    expect(
      operationTaskFailureMessage(
        TaskEventSchema.parse({
          ...baseEvent,
          payload: {
            ...baseEvent.payload,
            message: "Source changed before deployment: /workspace/source/AGENTS.md",
          },
        }),
      ),
    ).toBe("Source changed before deployment: /workspace/source/AGENTS.md");
    expect(operationTaskFailureMessage(TaskEventSchema.parse(baseEvent))).toBe("SOURCE_DRIFT");
  });

  it("coalesces runtime-state failures into a retry that can be scheduled again", async () => {
    vi.useFakeTimers();
    try {
      const retry = vi.fn();
      const scheduler = createSingleRetryScheduler(25);

      scheduler.schedule(retry);
      scheduler.schedule(retry);
      await vi.advanceTimersByTimeAsync(25);
      expect(retry).toHaveBeenCalledOnce();

      scheduler.schedule(retry);
      await vi.advanceTimersByTimeAsync(25);
      expect(retry).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses an error after its request context becomes stale", async () => {
    const reportError = vi.fn();

    await runGuardedAction(
      () => Promise.reject(new Error("old request failed")),
      reportError,
      () => false,
    );

    expect(reportError).not.toHaveBeenCalled();
  });

  it("retries the exact task id so a terminal replay can be received", async () => {
    vi.useFakeTimers();
    try {
      const terminalEvent = TaskEventSchema.parse({
        apiVersion: 1,
        eventVersion: 1,
        taskId: "task:deployment:retry",
        sequence: 4,
        emittedAt: "2026-07-10T00:00:00.000Z",
        type: "completed",
        payload: {
          status: "failed",
          succeededCount: 0,
          failedCount: 1,
          skippedCount: 0,
          systemRecoveryLock: false,
        },
      });
      const firstUnsubscribe = vi.fn();
      const replayUnsubscribe = vi.fn();
      let attempts = 0;
      const subscribeTask = vi.fn(
        (
          _taskId: string,
          _afterSequence: number,
          listener: (event: typeof terminalEvent) => void,
        ) => {
          attempts += 1;
          if (attempts === 1) {
            return {
              ready: Promise.reject(new Error("temporary subscription failure")),
              unsubscribe: firstUnsubscribe,
            };
          }
          queueMicrotask(() => listener(terminalEvent));
          return { ready: Promise.resolve(), unsubscribe: replayUnsubscribe };
        },
      );
      const listener = vi.fn();
      const onError = vi.fn();
      const stop = subscribeTaskWithRetry({
        api: { subscribeTask },
        taskId: "task:deployment:retry",
        listener,
        onError,
        retryDelayMs: 25,
      });

      await Promise.resolve();
      expect(onError).toHaveBeenCalledOnce();
      expect(firstUnsubscribe).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();

      expect(subscribeTask.mock.calls.map(([taskId, after]) => [taskId, after])).toEqual([
        ["task:deployment:retry", 0],
        ["task:deployment:retry", 0],
      ]);
      expect(listener).toHaveBeenCalledWith(terminalEvent);

      stop();
      expect(replayUnsubscribe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
