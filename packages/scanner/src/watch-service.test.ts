import { AbsolutePathSchema } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { NodeFileWatcher, WatchService, type FileWatchFactory } from "./watch-service.js";

describe("WatchService", () => {
  it("debounces noisy editor temporary events into stable changed paths", () => {
    const service = new WatchService({ debounceMs: 50 });

    service.recordFileEvent({
      path: AbsolutePathSchema.parse("/project/.config.md.swp"),
      kind: "modified",
      observedAtMs: 0,
    });
    service.recordFileEvent({
      path: AbsolutePathSchema.parse("/project/config.md.tmp"),
      kind: "created",
      observedAtMs: 10,
    });
    service.recordFileEvent({
      path: AbsolutePathSchema.parse("/project/config.md"),
      kind: "modified",
      observedAtMs: 20,
    });

    expect(service.drainReady(40)).toBeUndefined();
    expect(service.drainReady(75)).toEqual({
      kind: "changes",
      changedPaths: ["/project/config.md"],
    });
  });

  it("suppresses deployment-written paths so they do not trigger loop scans", () => {
    const service = new WatchService({ debounceMs: 25 });

    service.suppressDeploymentPaths([AbsolutePathSchema.parse("/project/generated.mdc")]);
    service.recordFileEvent({
      path: AbsolutePathSchema.parse("/project/generated.mdc"),
      kind: "modified",
      observedAtMs: 0,
    });
    service.recordFileEvent({
      path: AbsolutePathSchema.parse("/project/manual.md"),
      kind: "modified",
      observedAtMs: 5,
    });

    expect(service.drainReady(35)).toEqual({
      kind: "changes",
      changedPaths: ["/project/manual.md"],
    });
  });

  it("keeps suppressing deployment-written paths during the post-write grace window", () => {
    const nowMs = 10;
    const service = new WatchService({
      debounceMs: 0,
      suppressionGraceMs: 50,
      nowMs: () => nowMs,
    });
    const path = AbsolutePathSchema.parse("/project/generated.mdc");

    service.suppressDeploymentPaths([path]);
    service.clearDeploymentSuppression([path]);
    service.recordFileEvent({ path, kind: "modified", observedAtMs: 40 });
    expect(service.drainReady(40)).toBeUndefined();

    service.recordFileEvent({ path, kind: "modified", observedAtMs: 61 });
    expect(service.drainReady(61)).toEqual({
      kind: "changes",
      changedPaths: ["/project/generated.mdc"],
    });
  });

  it("exposes refresh-required fallback batches for overflow and unstable watcher errors", () => {
    const service = new WatchService({ debounceMs: 25 });

    service.recordWatcherError({ kind: "overflow", observedAtMs: 0 });
    expect(service.drainReady(0)).toEqual({
      kind: "refresh_required",
      reason: "overflow",
      suggestedAction: "Run a full scan or manual refresh",
    });

    service.recordWatcherError({ kind: "unstable", observedAtMs: 10 });
    expect(service.drainReady(10)).toEqual({
      kind: "refresh_required",
      reason: "unstable",
      suggestedAction: "Run a full scan or manual refresh",
    });
  });

  it("adapts platform file watcher events into debounced batches", async () => {
    let observedAtMs = 0;
    const batches: unknown[] = [];
    const listeners: ((eventType: string, filename: string | Buffer | null) => void)[] = [];
    const options: { recursive: boolean }[] = [];
    const watch: FileWatchFactory = (_path, option, listener) => {
      options.push(option);
      listeners.push(listener);
      return { close() {} };
    };
    const watcher = new NodeFileWatcher({
      roots: [AbsolutePathSchema.parse("/project")],
      platform: "darwin",
      watch,
      nowMs: () => observedAtMs,
      autoDrainIntervalMs: 0,
      service: new WatchService({ debounceMs: 25 }),
      onBatch: (batch) => {
        batches.push(batch);
      },
    });

    await watcher.start();
    listeners[0]?.("change", "AGENTS.md");
    expect(watcher.drain()).toBeUndefined();
    observedAtMs = 30;

    expect(watcher.drain()).toEqual({
      kind: "changes",
      changedPaths: ["/project/AGENTS.md"],
    });
    expect(batches).toEqual([{ kind: "changes", changedPaths: ["/project/AGENTS.md"] }]);
    expect(options).toEqual([{ recursive: true }]);
    watcher.close();
  });

  it("watches Linux subdirectories non-recursively and falls back on watcher signals", async () => {
    let errorListener: ((error: unknown) => void) | undefined;
    const batches: unknown[] = [];
    const watchedPaths: string[] = [];
    const options: { recursive: boolean }[] = [];
    const listeners: ((eventType: string, filename: string | Buffer | null) => void)[] = [];
    const watch: FileWatchFactory = (path, option, listener) => {
      watchedPaths.push(path);
      options.push(option);
      listeners.push(listener);
      return {
        close() {},
        on(event, listener) {
          if (event === "error") errorListener = listener;
          return this;
        },
      };
    };
    const watcher = new NodeFileWatcher({
      roots: [AbsolutePathSchema.parse("/project")],
      platform: "linux",
      watch,
      service: new WatchService({ debounceMs: 0 }),
      listDirectories: () =>
        Promise.resolve([
          AbsolutePathSchema.parse("/project"),
          AbsolutePathSchema.parse("/project/.codex"),
          AbsolutePathSchema.parse("/project/.codex/agents"),
        ]),
      nowMs: () => 0,
      autoDrainIntervalMs: 0,
      onBatch: (batch) => {
        batches.push(batch);
      },
    });

    await watcher.start();
    listeners[2]?.("change", "reviewer.toml");
    expect(watcher.drain()).toEqual({
      kind: "changes",
      changedPaths: ["/project/.codex/agents/reviewer.toml"],
    });

    errorListener?.(new Error("watch failed"));

    expect(watcher.drain()).toEqual({
      kind: "refresh_required",
      reason: "unstable",
      suggestedAction: "Run a full scan or manual refresh",
    });
    expect(batches).toEqual([
      { kind: "changes", changedPaths: ["/project/.codex/agents/reviewer.toml"] },
      {
        kind: "refresh_required",
        reason: "unstable",
        suggestedAction: "Run a full scan or manual refresh",
      },
    ]);
    expect(watchedPaths).toEqual(["/project", "/project/.codex", "/project/.codex/agents"]);
    expect(options).toEqual([{ recursive: false }, { recursive: false }, { recursive: false }]);
    watcher.close();
  });

  it("maps watcher resource limits to overflow fallback", async () => {
    let errorListener: ((error: unknown) => void) | undefined;
    const watch: FileWatchFactory = () => ({
      close() {},
      on(event, listener) {
        if (event === "error") errorListener = listener;
        return this;
      },
    });
    const watcher = new NodeFileWatcher({
      roots: [AbsolutePathSchema.parse("/project")],
      platform: "darwin",
      watch,
      nowMs: () => 0,
      autoDrainIntervalMs: 0,
      onBatch: () => undefined,
    });

    await watcher.start();
    errorListener?.(Object.assign(new Error("too many watches"), { code: "ENOSPC" }));

    expect(watcher.drain()).toEqual({
      kind: "refresh_required",
      reason: "overflow",
      suggestedAction: "Run a full scan or manual refresh",
    });
    watcher.close();
  });
});
