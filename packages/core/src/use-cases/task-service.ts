import type { AbsolutePath, IsoDateTime, TaskId } from "@ai-config-hub/shared";
import { AppError } from "@ai-config-hub/shared";

import type { ClockPort, IdGeneratorPort } from "../ports/events.js";

export type ObservableTaskKind = "scan" | "deployment" | "rollback";
export type ObservableTaskPhase =
  | "queued"
  | "discovering"
  | "reading"
  | "parsing"
  | "validating"
  | "committing"
  | "preflight"
  | "backing_up"
  | "writing"
  | "restoring"
  | "verifying"
  | "rolling_back"
  | "completed";
export type ObservableTaskTerminalStatus =
  | "succeeded"
  | "partially_succeeded"
  | "cancelled"
  | "failed"
  | "rolled_back";

export interface ObservableTaskProgress {
  readonly phase: ObservableTaskPhase;
  readonly completed: number;
  readonly total: number | null;
  readonly unit: "files" | "operations" | "items";
}

export type ObservableTaskEvent =
  | {
      readonly type: "accepted";
      readonly taskId: TaskId;
      readonly sequence: number;
      readonly emittedAt: IsoDateTime;
      readonly payload: {
        readonly taskKind: ObservableTaskKind;
        readonly phase: "queued";
        readonly acceptedAt: IsoDateTime;
      };
    }
  | {
      readonly type: "phase.changed";
      readonly taskId: TaskId;
      readonly sequence: number;
      readonly emittedAt: IsoDateTime;
      readonly payload: {
        readonly from: ObservableTaskPhase | null;
        readonly to: ObservableTaskPhase;
      };
    }
  | {
      readonly type: "progress";
      readonly taskId: TaskId;
      readonly sequence: number;
      readonly emittedAt: IsoDateTime;
      readonly payload: ObservableTaskProgress;
    }
  | {
      readonly type: "cancel.requested";
      readonly taskId: TaskId;
      readonly sequence: number;
      readonly emittedAt: IsoDateTime;
      readonly payload: {
        readonly reason: "user" | "shutdown";
        readonly effectiveAfterPhase: ObservableTaskPhase;
      };
    }
  | {
      readonly type: "completed";
      readonly taskId: TaskId;
      readonly sequence: number;
      readonly emittedAt: IsoDateTime;
      readonly payload: {
        readonly status: ObservableTaskTerminalStatus;
        readonly succeededCount: number;
        readonly failedCount: number;
        readonly skippedCount: number;
        readonly resultRef?: string;
        readonly systemRecoveryLock: boolean;
      };
    };

export type TaskReplayEvent =
  | ObservableTaskEvent
  | {
      readonly type: "cursor.reset";
      readonly taskId: TaskId;
      readonly sequence: null;
      readonly emittedAt: IsoDateTime;
      readonly payload: {
        readonly requestedAfterSequence: number;
        readonly earliestAvailableSequence: number;
        readonly latestSequence: number;
      };
    }
  | {
      readonly type: "snapshot";
      readonly taskId: TaskId;
      readonly sequence: null;
      readonly emittedAt: IsoDateTime;
      readonly payload: {
        readonly taskKind: ObservableTaskKind;
        readonly phase: ObservableTaskPhase;
        readonly status: "running" | ObservableTaskTerminalStatus;
        readonly progress: ObservableTaskProgress;
        readonly lastSequence: number;
        readonly cancellable: boolean;
      };
    };

export interface TaskOperationContext {
  readonly taskId: TaskId;
  phase(phase: ObservableTaskPhase): void;
  progress(progress: Omit<ObservableTaskProgress, "phase">): void;
  complete(input: {
    readonly status: ObservableTaskTerminalStatus;
    readonly succeededCount: number;
    readonly failedCount: number;
    readonly skippedCount: number;
    readonly resultRef?: string;
    readonly systemRecoveryLock?: boolean;
  }): void;
}

export interface TaskServiceOptions {
  readonly ids: Pick<IdGeneratorPort, "taskId">;
  readonly clock: ClockPort;
  readonly ringSize?: number;
}

interface TaskState {
  readonly taskId: TaskId;
  readonly kind: ObservableTaskKind;
  phase: ObservableTaskPhase;
  status: "running" | ObservableTaskTerminalStatus;
  sequence: number;
  progress: ObservableTaskProgress;
  events: ObservableTaskEvent[];
  recoveryLock: boolean;
}

export class TaskService {
  readonly #tasks = new Map<TaskId, TaskState>();
  readonly #ringSize: number;
  #systemRecoveryLock = false;

  constructor(private readonly options: TaskServiceOptions) {
    this.#ringSize = options.ringSize ?? 200;
  }

  start(
    kind: ObservableTaskKind,
    operation: (context: TaskOperationContext) => Promise<void> | void,
  ): { readonly taskId: TaskId } {
    const taskId = this.options.ids.taskId();
    const now = this.options.clock.now();
    const state: TaskState = {
      taskId,
      kind,
      phase: "queued",
      status: "running",
      sequence: 0,
      progress: { phase: "queued", completed: 0, total: null, unit: "items" },
      events: [],
      recoveryLock: false,
    };
    this.#tasks.set(taskId, state);
    this.emit(state, {
      type: "accepted",
      taskId,
      sequence: 0,
      emittedAt: now,
      payload: { taskKind: kind, phase: "queued", acceptedAt: now },
    });

    try {
      const result = operation(this.contextFor(state));
      void Promise.resolve(result).catch(() => {
        if (state.status === "running") {
          this.contextFor(state).complete({
            status: "failed",
            succeededCount: 0,
            failedCount: 1,
            skippedCount: 0,
            systemRecoveryLock: true,
          });
        }
      });
    } catch {
      if (state.status === "running") {
        this.contextFor(state).complete({
          status: "failed",
          succeededCount: 0,
          failedCount: 1,
          skippedCount: 0,
          systemRecoveryLock: true,
        });
      }
    }
    return { taskId };
  }

  cancel(taskId: TaskId, reason: "user" | "shutdown"): boolean {
    const state = this.requireTask(taskId);
    if (state.status !== "running") return false;
    if (["writing", "restoring", "verifying"].includes(state.phase)) {
      throw new AppError({
        code: "TASK_NOT_CANCELLABLE",
        message: "Task cannot be cancelled during atomic write or verification phases",
        retryable: true,
        suggestedActions: ["Wait for the current atomic phase to finish"],
        taskId,
      });
    }
    this.emit(state, {
      type: "cancel.requested",
      taskId,
      sequence: 0,
      emittedAt: this.options.clock.now(),
      payload: { reason, effectiveAfterPhase: state.phase },
    });
    return true;
  }

  subscribe(
    taskId: TaskId,
    afterSequence: number,
    listener: (event: TaskReplayEvent) => void,
  ): () => void {
    const state = this.requireTask(taskId);
    const earliest = state.events[0]?.sequence ?? state.sequence;
    if (afterSequence > 0 && afterSequence < earliest - 1) {
      listener({
        type: "cursor.reset",
        taskId,
        sequence: null,
        emittedAt: this.options.clock.now(),
        payload: {
          requestedAfterSequence: afterSequence,
          earliestAvailableSequence: earliest,
          latestSequence: state.sequence,
        },
      });
      listener(this.snapshot(state));
      return () => undefined;
    }
    for (const event of state.events) {
      if (event.sequence > afterSequence) listener(event);
    }
    return () => undefined;
  }

  assertWritesAllowed(paths: readonly AbsolutePath[]): void {
    void paths;
    if (!this.#systemRecoveryLock) return;
    throw new AppError({
      code: "READ_ONLY_RECOVERY",
      message: "Writes are blocked until unresolved recovery work is completed",
      retryable: true,
      suggestedActions: ["Resolve the recovery lock before starting another write"],
    });
  }

  private contextFor(state: TaskState): TaskOperationContext {
    return {
      taskId: state.taskId,
      phase: (phase) => {
        if (state.status !== "running") return;
        const from = state.phase;
        state.phase = phase;
        state.progress = { ...state.progress, phase };
        this.emit(state, {
          type: "phase.changed",
          taskId: state.taskId,
          sequence: 0,
          emittedAt: this.options.clock.now(),
          payload: { from, to: phase },
        });
      },
      progress: (progress) => {
        if (state.status !== "running") return;
        if (
          state.progress.total !== null &&
          progress.total !== null &&
          progress.total < state.progress.total
        ) {
          throw new AppError({
            code: "VALIDATION_FAILED",
            message: "Task progress total cannot decrease",
            retryable: false,
            suggestedActions: ["Report monotonic task progress"],
            taskId: state.taskId,
          });
        }
        state.progress = { phase: state.phase, ...progress };
        this.emit(state, {
          type: "progress",
          taskId: state.taskId,
          sequence: 0,
          emittedAt: this.options.clock.now(),
          payload: state.progress,
        });
      },
      complete: (input) => {
        if (state.status !== "running") return;
        state.phase = "completed";
        state.status = input.status;
        state.recoveryLock = input.systemRecoveryLock ?? false;
        this.#systemRecoveryLock = this.#systemRecoveryLock || state.recoveryLock;
        this.emit(state, {
          type: "completed",
          taskId: state.taskId,
          sequence: 0,
          emittedAt: this.options.clock.now(),
          payload: {
            status: input.status,
            succeededCount: input.succeededCount,
            failedCount: input.failedCount,
            skippedCount: input.skippedCount,
            ...(input.resultRef === undefined ? {} : { resultRef: input.resultRef }),
            systemRecoveryLock: state.recoveryLock,
          },
        });
      },
    };
  }

  private emit(state: TaskState, event: ObservableTaskEvent): void {
    state.sequence += 1;
    const sequenced = { ...event, sequence: state.sequence } as ObservableTaskEvent;
    state.events.push(sequenced);
    if (state.events.length > this.#ringSize) state.events.shift();
  }

  private snapshot(state: TaskState): TaskReplayEvent {
    return {
      type: "snapshot",
      taskId: state.taskId,
      sequence: null,
      emittedAt: this.options.clock.now(),
      payload: {
        taskKind: state.kind,
        phase: state.phase,
        status: state.status,
        progress: state.progress,
        lastSequence: state.sequence,
        cancellable: !["writing", "restoring", "verifying"].includes(state.phase),
      },
    };
  }

  private requireTask(taskId: TaskId): TaskState {
    const state = this.#tasks.get(taskId);
    if (state === undefined) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "Task was not found",
        retryable: false,
        suggestedActions: ["Refresh task history"],
        taskId,
      });
    }
    return state;
  }
}
