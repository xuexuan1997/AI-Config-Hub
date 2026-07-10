import { watch as fsWatch } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { AbsolutePathSchema } from "@ai-config-hub/shared";
import type { AbsolutePath } from "@ai-config-hub/shared";

export type WatchFileEventKind = "created" | "modified" | "deleted" | "renamed";
export type WatchFallbackReason = "overflow" | "unstable";

export interface WatchServiceOptions {
  readonly debounceMs?: number;
  readonly suppressionGraceMs?: number;
  readonly nowMs?: () => number;
}

export interface FileWatchHandle {
  close(): void;
  on?(event: "error", listener: (error: unknown) => void): FileWatchHandle;
}

export type FileWatchFactory = (
  path: AbsolutePath,
  options: { readonly recursive: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => FileWatchHandle;

export type DirectoryListFactory = (root: AbsolutePath) => Promise<readonly AbsolutePath[]>;

export interface WatchFileEvent {
  readonly path: AbsolutePath;
  readonly kind: WatchFileEventKind;
  readonly observedAtMs: number;
}

export interface WatcherErrorEvent {
  readonly kind: WatchFallbackReason;
  readonly observedAtMs: number;
}

export type WatchBatch =
  | {
      readonly kind: "changes";
      readonly changedPaths: readonly AbsolutePath[];
    }
  | {
      readonly kind: "refresh_required";
      readonly reason: WatchFallbackReason;
      readonly suggestedAction: "Run a full scan or manual refresh";
    };

export class WatchService {
  private readonly debounceMs: number;
  private readonly suppressionGraceMs: number;
  private readonly nowMs: () => number;
  private readonly pendingPaths = new Set<AbsolutePath>();
  private suppressedPaths = new Map<AbsolutePath, number | "active">();
  private pendingSinceMs: number | undefined;
  private pendingFallback: WatchFallbackReason | undefined;

  constructor(options: WatchServiceOptions = {}) {
    this.debounceMs = Math.max(0, options.debounceMs ?? 100);
    this.suppressionGraceMs = Math.max(0, options.suppressionGraceMs ?? 1_000);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /**
   * Creates an independently drainable event queue that shares deployment
   * suppression with this service. A separate queue is required per native
   * watcher so one root cannot consume another root's events.
   */
  fork(): WatchService {
    const fork = new WatchService({
      debounceMs: this.debounceMs,
      suppressionGraceMs: this.suppressionGraceMs,
      nowMs: this.nowMs,
    });
    fork.suppressedPaths = this.suppressedPaths;
    return fork;
  }

  suppressDeploymentPaths(paths: readonly AbsolutePath[]): void {
    for (const path of paths) this.suppressedPaths.set(normalizePath(path), "active");
  }

  clearDeploymentSuppression(paths: readonly AbsolutePath[]): void {
    const suppressUntil = this.nowMs() + this.suppressionGraceMs;
    for (const path of paths) this.suppressedPaths.set(normalizePath(path), suppressUntil);
  }

  recordFileEvent(event: WatchFileEvent): void {
    const path = normalizePath(event.path);
    if (this.isSuppressed(path, event.observedAtMs) || isEditorTemporaryPath(path)) return;
    if (event.kind === "renamed") {
      this.pendingFallback = "unstable";
      return;
    }
    this.pendingPaths.add(path);
    this.pendingSinceMs = event.observedAtMs;
  }

  recordWatcherError(error: WatcherErrorEvent): void {
    this.pendingFallback = error.kind;
  }

  drainReady(nowMs: number): WatchBatch | undefined {
    if (this.pendingFallback !== undefined) {
      const reason = this.pendingFallback;
      this.pendingFallback = undefined;
      this.pendingPaths.clear();
      this.pendingSinceMs = undefined;
      return {
        kind: "refresh_required",
        reason,
        suggestedAction: "Run a full scan or manual refresh",
      };
    }
    if (this.pendingSinceMs === undefined || nowMs - this.pendingSinceMs < this.debounceMs) {
      return undefined;
    }
    const changedPaths = [...this.pendingPaths].sort();
    this.pendingPaths.clear();
    this.pendingSinceMs = undefined;
    if (changedPaths.length === 0) return undefined;
    return { kind: "changes", changedPaths };
  }

  private isSuppressed(path: AbsolutePath, observedAtMs: number): boolean {
    const deadline = this.suppressedPaths.get(path);
    if (deadline === undefined) return false;
    if (deadline === "active" || observedAtMs <= deadline) return true;
    this.suppressedPaths.delete(path);
    return false;
  }
}

export interface NodeFileWatcherOptions {
  readonly roots: readonly AbsolutePath[];
  readonly platform: "linux" | "darwin" | "win32";
  readonly service?: WatchService;
  readonly watch?: FileWatchFactory;
  readonly listDirectories?: DirectoryListFactory;
  readonly nowMs?: () => number;
  readonly autoDrainIntervalMs?: number;
  readonly maxDirectories?: number;
  readonly errorRetryBaseMs?: number;
  readonly errorRetryMaxMs?: number;
  readonly maxErrorRetries?: number;
  readonly onBatch: (batch: WatchBatch) => void | Promise<void>;
}

interface WatchRetryState {
  readonly directory: AbsolutePath;
  readonly attempts: number;
  readonly retryAtMs: number;
  readonly disabled: boolean;
}

export class NodeFileWatcher {
  private readonly service: WatchService;
  private readonly watch: FileWatchFactory;
  private readonly listDirectories: DirectoryListFactory;
  private readonly nowMs: () => number;
  private readonly autoDrainIntervalMs: number;
  private readonly maxDirectories: number;
  private readonly errorRetryBaseMs: number;
  private readonly errorRetryMaxMs: number;
  private readonly maxErrorRetries: number;
  private readonly handles = new Map<string, FileWatchHandle>();
  private failedHandles = new WeakSet<FileWatchHandle>();
  private readonly retryStates = new Map<string, WatchRetryState>();
  private batchChain: Promise<void> = Promise.resolve();
  private refreshFailureCount = 0;
  private refreshRetryAtMs: number | undefined;
  private refreshDisabled = false;
  private refreshInFlight = false;
  private generation = 0;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: NodeFileWatcherOptions) {
    this.service = options.service ?? new WatchService();
    this.watch = options.watch ?? defaultWatchFactory;
    this.listDirectories = options.listDirectories ?? defaultDirectoryList;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.autoDrainIntervalMs = options.autoDrainIntervalMs ?? 250;
    this.maxDirectories = Math.max(1, options.maxDirectories ?? MAX_WATCHED_DIRECTORIES);
    this.errorRetryBaseMs = Math.max(1, options.errorRetryBaseMs ?? 250);
    this.errorRetryMaxMs = Math.max(this.errorRetryBaseMs, options.errorRetryMaxMs ?? 30_000);
    this.maxErrorRetries = Math.max(1, options.maxErrorRetries ?? 5);
  }

  async start(): Promise<void> {
    this.close();
    const generation = this.generation;
    await this.refreshWatchDirectories(generation, true);
    if (this.autoDrainIntervalMs > 0) {
      this.interval = setInterval(() => {
        this.drain();
      }, this.autoDrainIntervalMs);
      if (typeof this.interval === "object" && "unref" in this.interval) this.interval.unref();
    }
  }

  private async watchDirectories(root: AbsolutePath): Promise<readonly AbsolutePath[]> {
    if (this.options.platform !== "linux") return [root];
    return this.listDirectories(root);
  }

  private async refreshWatchDirectories(generation: number, force = false): Promise<void> {
    if (this.refreshDisabled) return;
    if (!force && (this.refreshRetryAtMs ?? 0) > this.nowMs()) return;
    try {
      const desired = new Map<string, AbsolutePath>();
      for (const root of this.options.roots) {
        for (const directory of await this.watchDirectories(root)) {
          desired.set(normalizePath(directory), directory);
          if (desired.size > this.maxDirectories) throw watchLimitError();
        }
      }
      if (generation !== this.generation) return;
      for (const [key, handle] of this.handles) {
        if (desired.has(key)) continue;
        handle.close();
        this.handles.delete(key);
        this.retryStates.delete(key);
      }
      for (const key of this.retryStates.keys()) {
        if (!desired.has(key)) this.retryStates.delete(key);
      }
      for (const [key, directory] of desired) {
        const retryState = this.retryStates.get(key);
        if (
          !this.handles.has(key) &&
          retryState?.disabled !== true &&
          (retryState === undefined || retryState.retryAtMs <= this.nowMs())
        ) {
          this.watchDirectory(key, directory, generation);
        }
      }
      this.refreshFailureCount = 0;
      this.refreshRetryAtMs = undefined;
    } catch (error) {
      if (generation !== this.generation) return;
      this.recordRefreshError(error);
    }
  }

  private watchDirectory(key: string, directory: AbsolutePath, generation: number): void {
    if (
      generation !== this.generation ||
      this.handles.has(key) ||
      this.retryStates.get(key)?.disabled === true
    ) {
      return;
    }
    let handle: FileWatchHandle | undefined;
    let failedDuringRegistration = false;
    try {
      handle = this.watch(
        directory,
        { recursive: this.options.platform !== "linux" },
        (eventType, filename) => {
          if (filename === null) {
            // fs.watch rename events do not reliably distinguish create,
            // delete, and directory moves, so an incremental path scan can
            // retain stale entries. Conservatively request a full refresh.
            this.service.recordWatcherError({ kind: "unstable", observedAtMs: this.nowMs() });
            return;
          }
          this.retryStates.delete(key);
          this.service.recordFileEvent({
            path: AbsolutePathSchema.parse(resolve(directory, String(filename))),
            kind: eventType === "rename" ? "renamed" : "modified",
            observedAtMs: this.nowMs(),
          });
        },
      );
      handle.on?.("error", (error) => {
        if (handle === undefined || this.failedHandles.has(handle)) return;
        this.failedHandles.add(handle);
        failedDuringRegistration = !this.handles.has(key);
        this.handleWatchError(key, directory, error, generation);
      });
    } catch (error) {
      handle?.close();
      this.handleWatchError(key, directory, error, generation);
      return;
    }
    if (handle === undefined) return;
    if (generation !== this.generation || failedDuringRegistration) handle.close();
    else this.handles.set(key, handle);
  }

  private handleWatchError(
    key: string,
    directory: AbsolutePath,
    error: unknown,
    generation: number,
  ): void {
    if (generation !== this.generation) return;
    this.handles.get(key)?.close();
    this.handles.delete(key);
    const attempts = (this.retryStates.get(key)?.attempts ?? 0) + 1;
    const disabled = attempts >= this.maxErrorRetries;
    this.retryStates.set(key, {
      directory,
      attempts,
      retryAtMs: this.nowMs() + this.retryDelayMs(attempts),
      disabled,
    });
    this.service.recordWatcherError({
      kind: watchFallbackReason(error),
      observedAtMs: this.nowMs(),
    });
  }

  private recordRefreshError(error: unknown): void {
    this.refreshFailureCount += 1;
    this.refreshDisabled = this.refreshFailureCount >= this.maxErrorRetries;
    this.refreshRetryAtMs = this.nowMs() + this.retryDelayMs(this.refreshFailureCount);
    this.service.recordWatcherError({
      kind: watchFallbackReason(error),
      observedAtMs: this.nowMs(),
    });
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(this.errorRetryBaseMs * 2 ** Math.max(0, attempt - 1), this.errorRetryMaxMs);
  }

  private retryFailedWatches(generation: number): void {
    const nowMs = this.nowMs();
    for (const [key, state] of this.retryStates) {
      if (state.disabled || state.retryAtMs > nowMs || this.handles.has(key)) continue;
      this.watchDirectory(key, state.directory, generation);
    }
  }

  private retryDirectoryRefresh(generation: number): void {
    if (
      this.options.platform !== "linux" ||
      this.refreshInFlight ||
      this.refreshDisabled ||
      this.refreshRetryAtMs === undefined ||
      this.refreshRetryAtMs > this.nowMs()
    ) {
      return;
    }
    this.refreshInFlight = true;
    this.batchChain = this.batchChain
      .then(async () => {
        if (
          generation !== this.generation ||
          this.refreshDisabled ||
          this.refreshRetryAtMs === undefined ||
          this.refreshRetryAtMs > this.nowMs()
        ) {
          return;
        }
        await this.refreshWatchDirectories(generation);
      })
      .catch((error: unknown) => {
        if (generation === this.generation) this.recordRefreshError(error);
      })
      .finally(() => {
        if (generation === this.generation) this.refreshInFlight = false;
      });
  }

  drain(): WatchBatch | undefined {
    const generation = this.generation;
    this.retryFailedWatches(generation);
    this.retryDirectoryRefresh(generation);
    const batch = this.service.drainReady(this.nowMs());
    if (batch !== undefined) {
      this.batchChain = this.batchChain
        .then(async () => {
          if (generation !== this.generation) return;
          await this.options.onBatch(batch);
          if (this.options.platform === "linux") await this.refreshWatchDirectories(generation);
        })
        .catch((error: unknown) => {
          if (generation !== this.generation) return;
          this.service.recordWatcherError({
            kind: watchFallbackReason(error),
            observedAtMs: this.nowMs(),
          });
        });
    }
    return batch;
  }

  suppressDeploymentPaths(paths: readonly AbsolutePath[]): void {
    this.service.suppressDeploymentPaths(paths);
  }

  clearDeploymentSuppression(paths: readonly AbsolutePath[]): void {
    this.service.clearDeploymentSuppression(paths);
  }

  close(): void {
    this.generation += 1;
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    for (const handle of this.handles.values()) handle.close();
    this.handles.clear();
    this.failedHandles = new WeakSet();
    this.retryStates.clear();
    this.batchChain = Promise.resolve();
    this.refreshFailureCount = 0;
    this.refreshRetryAtMs = undefined;
    this.refreshDisabled = false;
    this.refreshInFlight = false;
  }
}

const defaultWatchFactory: FileWatchFactory = (path, options, listener) =>
  fsWatch(path, options, (eventType, filename) => {
    listener(eventType, filename);
  });

async function defaultDirectoryList(root: AbsolutePath): Promise<readonly AbsolutePath[]> {
  const directories: AbsolutePath[] = [];
  const pending: AbsolutePath[] = [root];
  const visitedCanonicalDirectories = new Set<string>();
  while (pending.length > 0) {
    const directory = pending.shift();
    if (directory === undefined) break;
    const canonicalDirectory = normalizePath(AbsolutePathSchema.parse(await realpath(directory)));
    if (visitedCanonicalDirectories.has(canonicalDirectory)) continue;
    visitedCanonicalDirectories.add(canonicalDirectory);
    directories.push(directory);
    if (directories.length > MAX_WATCHED_DIRECTORIES) throw watchLimitError();
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink() || isIgnoredWatchDirectory(child.name)) {
        continue;
      }
      pending.push(AbsolutePathSchema.parse(join(directory, child.name)));
    }
  }
  return directories;
}

const MAX_WATCHED_DIRECTORIES = 4_096;
const IGNORED_WATCH_DIRECTORIES = new Set([".git", "node_modules", "dist", "target"]);

function isIgnoredWatchDirectory(name: string): boolean {
  return IGNORED_WATCH_DIRECTORIES.has(name);
}

function watchLimitError(): Error & { readonly code: "ENOSPC" } {
  return Object.assign(new Error("Recursive watcher directory limit exceeded"), {
    code: "ENOSPC" as const,
  });
}

function watchFallbackReason(error: unknown): WatchFallbackReason {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOSPC" || error.code === "EMFILE")
  ) {
    return "overflow";
  }
  return "unstable";
}

function normalizePath(path: AbsolutePath): string {
  return path.replaceAll("\\", "/");
}

function isEditorTemporaryPath(path: AbsolutePath): boolean {
  const name = path.split("/").at(-1) ?? path;
  return (
    name.endsWith("~") ||
    name.endsWith(".tmp") ||
    name.endsWith(".temp") ||
    name.endsWith(".swp") ||
    name.endsWith(".swx") ||
    name.startsWith(".#") ||
    name.startsWith("#") ||
    name.endsWith("#")
  );
}
