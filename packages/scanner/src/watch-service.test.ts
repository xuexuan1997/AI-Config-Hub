import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AbsolutePathSchema } from "@ai-config-hub/shared";
import { describe, expect, it, vi } from "vitest";

import { NodeFileWatcher, WatchService, type FileWatchFactory } from "./watch-service.js";

describe("WatchService", () => {
  it("forks independently drained queues while sharing deployment suppression", () => {
    let nowMs = 0;
    const parent = new WatchService({ debounceMs: 0, suppressionGraceMs: 10, nowMs: () => nowMs });
    const first = parent.fork();
    const second = parent.fork();
    const firstPath = AbsolutePathSchema.parse("/first/AGENTS.md");
    const secondPath = AbsolutePathSchema.parse("/second/AGENTS.md");

    first.recordFileEvent({ path: firstPath, kind: "modified", observedAtMs: nowMs });
    second.recordFileEvent({ path: secondPath, kind: "modified", observedAtMs: nowMs });
    expect(first.drainReady(nowMs)).toEqual({ kind: "changes", changedPaths: [firstPath] });
    expect(second.drainReady(nowMs)).toEqual({ kind: "changes", changedPaths: [secondPath] });

    parent.suppressDeploymentPaths([secondPath]);
    second.recordFileEvent({ path: secondPath, kind: "modified", observedAtMs: nowMs });
    expect(second.drainReady(nowMs)).toBeUndefined();
    parent.clearDeploymentSuppression([secondPath]);
    nowMs = 11;
    second.recordFileEvent({ path: secondPath, kind: "modified", observedAtMs: nowMs });
    expect(second.drainReady(nowMs)).toEqual({ kind: "changes", changedPaths: [secondPath] });
  });

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
    const changedPath = AbsolutePathSchema.parse(
      resolve("/project", "AGENTS.md").replaceAll("\\", "/"),
    );
    listeners[0]?.("change", "AGENTS.md");
    expect(watcher.drain()).toBeUndefined();
    observedAtMs = 30;

    expect(watcher.drain()).toEqual({
      kind: "changes",
      changedPaths: [changedPath],
    });
    await vi.waitFor(() =>
      expect(batches).toEqual([{ kind: "changes", changedPaths: [changedPath] }]),
    );
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
    const reviewerPath = AbsolutePathSchema.parse(
      resolve("/project/.codex/agents", "reviewer.toml").replaceAll("\\", "/"),
    );
    listeners[2]?.("change", "reviewer.toml");
    expect(watcher.drain()).toEqual({
      kind: "changes",
      changedPaths: [reviewerPath],
    });

    errorListener?.(new Error("watch failed"));

    expect(watcher.drain()).toEqual({
      kind: "refresh_required",
      reason: "unstable",
      suggestedAction: "Run a full scan or manual refresh",
    });
    await vi.waitFor(() =>
      expect(batches).toEqual([
        { kind: "changes", changedPaths: [reviewerPath] },
        {
          kind: "refresh_required",
          reason: "unstable",
          suggestedAction: "Run a full scan or manual refresh",
        },
      ]),
    );
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

  it("turns ambiguous rename notifications into a conservative full-refresh fallback", async () => {
    let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    const watcher = new NodeFileWatcher({
      roots: [AbsolutePathSchema.parse("/project")],
      platform: "darwin",
      watch: (_path, _options, nextListener) => {
        listener = nextListener;
        return { close() {} };
      },
      nowMs: () => 0,
      autoDrainIntervalMs: 0,
      onBatch: () => undefined,
    });

    await watcher.start();
    listener?.("rename", "AGENTS.md");
    expect(watcher.drain()).toEqual({
      kind: "refresh_required",
      reason: "unstable",
      suggestedAction: "Run a full scan or manual refresh",
    });
    watcher.close();
  });

  it("backs off failed native handles and disables retries after a bounded attempt count", async () => {
    let nowMs = 0;
    const errorListeners: ((error: unknown) => void)[] = [];
    let watchAttempts = 0;
    const watcher = new NodeFileWatcher({
      roots: [AbsolutePathSchema.parse("/project")],
      platform: "darwin",
      watch: () => {
        watchAttempts += 1;
        return {
          close() {},
          on(_event, listener) {
            errorListeners.push(listener);
            return this;
          },
        };
      },
      nowMs: () => nowMs,
      autoDrainIntervalMs: 0,
      errorRetryBaseMs: 10,
      errorRetryMaxMs: 20,
      maxErrorRetries: 3,
      onBatch: () => undefined,
    });

    await watcher.start();
    expect(watchAttempts).toBe(1);
    errorListeners[0]?.(new Error("permanent failure"));
    watcher.drain();
    nowMs = 9;
    watcher.drain();
    expect(watchAttempts).toBe(1);

    nowMs = 10;
    watcher.drain();
    expect(watchAttempts).toBe(2);
    errorListeners[1]?.(new Error("permanent failure"));
    watcher.drain();
    nowMs = 30;
    watcher.drain();
    expect(watchAttempts).toBe(3);
    errorListeners[2]?.(new Error("permanent failure"));
    watcher.drain();

    nowMs = 10_000;
    watcher.drain();
    expect(watchAttempts).toBe(3);
    watcher.close();
  });

  it("bounds retries when Linux directory enumeration keeps failing", async () => {
    let nowMs = 0;
    let listAttempts = 0;
    const watcher = new NodeFileWatcher({
      roots: [AbsolutePathSchema.parse("/project")],
      platform: "linux",
      watch: () => ({ close() {} }),
      listDirectories: () => {
        listAttempts += 1;
        return Promise.reject(new Error("directory is permanently unreadable"));
      },
      nowMs: () => nowMs,
      autoDrainIntervalMs: 0,
      errorRetryBaseMs: 10,
      errorRetryMaxMs: 20,
      maxErrorRetries: 3,
      onBatch: () => undefined,
    });

    await watcher.start();
    expect(listAttempts).toBe(1);
    watcher.drain();

    nowMs = 10;
    watcher.drain();
    await vi.waitFor(() => expect(listAttempts).toBe(2));
    watcher.drain();

    nowMs = 30;
    watcher.drain();
    await vi.waitFor(() => expect(listAttempts).toBe(3));
    watcher.drain();

    nowMs = 10_000;
    watcher.drain();
    await Promise.resolve();
    expect(listAttempts).toBe(3);
    watcher.close();
  });

  it("adds Linux directory handles after a handled change batch", async () => {
    const root = AbsolutePathSchema.parse("/project");
    const nested = AbsolutePathSchema.parse("/project/.agents/skills/new-skill");
    let directories: readonly ReturnType<typeof AbsolutePathSchema.parse>[] = [root];
    let rootListener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    let resolveNestedWatch: (() => void) | undefined;
    const nestedWatched = new Promise<void>((resolveWatch) => {
      resolveNestedWatch = resolveWatch;
    });
    const watcher = new NodeFileWatcher({
      roots: [root],
      platform: "linux",
      watch: (path, _options, listener) => {
        if (path === root) rootListener = listener;
        if (path === nested) resolveNestedWatch?.();
        return { close() {} };
      },
      listDirectories: () => Promise.resolve(directories),
      nowMs: () => 0,
      autoDrainIntervalMs: 0,
      service: new WatchService({ debounceMs: 0 }),
      onBatch: () => {
        directories = [root, nested];
      },
    });

    await watcher.start();
    rootListener?.("rename", ".agents");
    watcher.drain();
    await nestedWatched;
    watcher.close();
  });

  it("maps an excessive Linux directory expansion to overflow without opening handles", async () => {
    const watchedPaths: string[] = [];
    const watcher = new NodeFileWatcher({
      roots: [AbsolutePathSchema.parse("/project")],
      platform: "linux",
      maxDirectories: 2,
      watch: (path) => {
        watchedPaths.push(path);
        return { close() {} };
      },
      listDirectories: () =>
        Promise.resolve([
          AbsolutePathSchema.parse("/project"),
          AbsolutePathSchema.parse("/project/a"),
          AbsolutePathSchema.parse("/project/b"),
        ]),
      autoDrainIntervalMs: 0,
      onBatch: () => undefined,
    });

    await watcher.start();
    expect(watchedPaths).toEqual([]);
    expect(watcher.drain()).toEqual({
      kind: "refresh_required",
      reason: "overflow",
      suggestedAction: "Run a full scan or manual refresh",
    });
    watcher.close();
  });

  it.runIf(process.platform !== "win32")(
    "does not recurse through ignored dependency directories or directory symlinks",
    async () => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "ai-config-hub-watcher-"));
      const root = AbsolutePathSchema.parse(fixtureRoot);
      const watchedPaths: string[] = [];
      try {
        await mkdir(join(fixtureRoot, ".agents", "skills"), { recursive: true });
        await mkdir(join(fixtureRoot, "node_modules", "package"), { recursive: true });
        await mkdir(join(fixtureRoot, "build", "generated"), { recursive: true });
        await mkdir(join(fixtureRoot, ".cache", "metadata"), { recursive: true });
        await symlink(fixtureRoot, join(fixtureRoot, "loop"), "dir");
        const watcher = new NodeFileWatcher({
          roots: [root],
          platform: "linux",
          watch: (path) => {
            watchedPaths.push(path);
            return { close() {} };
          },
          autoDrainIntervalMs: 0,
          onBatch: () => undefined,
        });

        await watcher.start();
        expect(watchedPaths).toContain(root);
        expect(watchedPaths).toContain(join(fixtureRoot, ".agents"));
        expect(watchedPaths).toContain(join(fixtureRoot, ".agents", "skills"));
        expect(watchedPaths.some((path) => path.includes("node_modules"))).toBe(false);
        expect(watchedPaths).toContain(join(fixtureRoot, "build"));
        expect(watchedPaths).toContain(join(fixtureRoot, "build", "generated"));
        expect(watchedPaths).toContain(join(fixtureRoot, ".cache"));
        expect(watchedPaths.some((path) => path.includes("loop"))).toBe(false);
        watcher.close();
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );
});
