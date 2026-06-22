import type { AbsolutePath, CorrelationId, IsoDateTime, TaskId } from "@ai-config-hub/shared";

import type { ScanRunSummary, TaskProgress } from "../domain/task.js";
import type { CancellationSignal } from "./adapter.js";

export type CoreTaskEvent =
  | {
      readonly type: "progress";
      readonly taskId: TaskId;
      readonly correlationId: CorrelationId;
      readonly sequence: number;
      readonly progress: TaskProgress;
    }
  | {
      readonly type: "scan_terminal";
      readonly taskId: TaskId;
      readonly correlationId: CorrelationId;
      readonly sequence: number;
      readonly summary: ScanRunSummary;
    };

export interface TaskEventPublisher {
  publish(event: CoreTaskEvent): Promise<void>;
}

export interface CancellationRegistry {
  create(taskId: TaskId): CancellationSignal;
  request(taskId: TaskId): boolean;
  release(taskId: TaskId): void;
}

export interface PathLockPort {
  withLocks<T>(paths: readonly AbsolutePath[], action: () => Promise<T>): Promise<T>;
}

export interface ClockPort {
  now(): IsoDateTime;
}

export interface IdGeneratorPort {
  taskId(): TaskId;
  correlationId(): CorrelationId;
}
