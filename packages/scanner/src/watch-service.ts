import { watch as fsWatch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
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
  private readonly suppressedPaths = new Map<AbsolutePath, number | "active">();
  private pendingSinceMs: number | undefined;
  private pendingFallback: WatchFallbackReason | undefined;

  constructor(options: WatchServiceOptions = {}) {
    this.debounceMs = Math.max(0, options.debounceMs ?? 100);
    this.suppressionGraceMs = Math.max(0, options.suppressionGraceMs ?? 1_000);
    this.nowMs = options.nowMs ?? (() => Date.now());
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
  readonly onBatch: (batch: WatchBatch) => void | Promise<void>;
}

export class NodeFileWatcher {
  private readonly service: WatchService;
  private readonly watch: FileWatchFactory;
  private readonly listDirectories: DirectoryListFactory;
  private readonly nowMs: () => number;
  private readonly autoDrainIntervalMs: number;
  private readonly handles: FileWatchHandle[] = [];
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: NodeFileWatcherOptions) {
    this.service = options.service ?? new WatchService();
    this.watch = options.watch ?? defaultWatchFactory;
    this.listDirectories = options.listDirectories ?? defaultDirectoryList;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.autoDrainIntervalMs = options.autoDrainIntervalMs ?? 250;
  }

  async start(): Promise<void> {
    this.close();
    for (const root of this.options.roots) {
      try {
        for (const directory of await this.watchDirectories(root)) this.watchDirectory(directory);
      } catch (error) {
        this.service.recordWatcherError({
          kind: watchFallbackReason(error),
          observedAtMs: this.nowMs(),
        });
      }
    }
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

  private watchDirectory(directory: AbsolutePath): void {
    const handle = this.watch(
      directory,
      { recursive: this.options.platform !== "linux" },
      (eventType, filename) => {
        if (filename === null) {
          this.service.recordWatcherError({ kind: "unstable", observedAtMs: this.nowMs() });
          return;
        }
        this.service.recordFileEvent({
          path: AbsolutePathSchema.parse(resolve(directory, String(filename))),
          kind: eventType === "rename" ? "renamed" : "modified",
          observedAtMs: this.nowMs(),
        });
      },
    );
    handle.on?.("error", (error) => {
      this.service.recordWatcherError({
        kind: watchFallbackReason(error),
        observedAtMs: this.nowMs(),
      });
    });
    this.handles.push(handle);
  }

  drain(): WatchBatch | undefined {
    const batch = this.service.drainReady(this.nowMs());
    if (batch !== undefined)
      void Promise.resolve(this.options.onBatch(batch)).catch(() => undefined);
    return batch;
  }

  suppressDeploymentPaths(paths: readonly AbsolutePath[]): void {
    this.service.suppressDeploymentPaths(paths);
  }

  clearDeploymentSuppression(paths: readonly AbsolutePath[]): void {
    this.service.clearDeploymentSuppression(paths);
  }

  close(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    for (const handle of this.handles.splice(0)) handle.close();
  }
}

const defaultWatchFactory: FileWatchFactory = (path, options, listener) =>
  fsWatch(path, options, (eventType, filename) => {
    listener(eventType, filename);
  });

async function defaultDirectoryList(root: AbsolutePath): Promise<readonly AbsolutePath[]> {
  const directories: AbsolutePath[] = [root];
  for (const directory of directories) {
    const children = await readdir(directory);
    for (const child of children) {
      const childPath = AbsolutePathSchema.parse(join(directory, child));
      const metadata = await stat(childPath).catch(() => undefined);
      if (metadata?.isDirectory() === true) directories.push(childPath);
    }
  }
  return directories;
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
