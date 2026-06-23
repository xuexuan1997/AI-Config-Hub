import { AbsolutePathSchema, IsoDateTimeSchema, TaskIdSchema } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { TaskService, type TaskOperationContext, type TaskReplayEvent } from "./task-service.js";

const now = IsoDateTimeSchema.parse("2026-06-22T12:00:00.000Z");

describe("TaskService", () => {
  it("emits accepted as sequence one and keeps progress totals monotonic", () => {
    const task = newTaskService();
    let context: TaskOperationContext | undefined;
    const { taskId } = task.start("deployment", (operation) => {
      context = operation;
    });

    context?.phase("preflight");
    context?.progress({ completed: 1, total: 2, unit: "operations" });
    expect(() => context?.progress({ completed: 1, total: 1, unit: "operations" })).toThrow(
      /total cannot decrease/i,
    );
    context?.complete({
      status: "succeeded",
      succeededCount: 1,
      failedCount: 0,
      skippedCount: 0,
    });

    const events = collect(task, taskId, 0);
    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "accepted"],
      [2, "phase.changed"],
      [3, "progress"],
      [4, "completed"],
    ]);
  });

  it("rejects cancellation during atomic write phases", () => {
    const task = newTaskService();
    let context: TaskOperationContext | undefined;
    const { taskId } = task.start("deployment", (operation) => {
      context = operation;
    });
    context?.phase("writing");

    expect(() => task.cancel(taskId, "user")).toThrow(/atomic write/i);
  });

  it("returns cursor reset plus snapshot when replay has fallen behind the ring", () => {
    const task = newTaskService(2);
    let context: TaskOperationContext | undefined;
    const { taskId } = task.start("scan", (operation) => {
      context = operation;
    });
    context?.phase("discovering");
    context?.phase("reading");
    context?.phase("parsing");

    const replayed = collect(task, taskId, 1);
    expect(replayed.map((event) => event.type)).toEqual(["cursor.reset", "snapshot"]);
  });

  it("blocks later writes when a task completes with a recovery lock", () => {
    const task = newTaskService();
    let context: TaskOperationContext | undefined;
    task.start("deployment", (operation) => {
      context = operation;
    });
    context?.complete({
      status: "failed",
      succeededCount: 0,
      failedCount: 1,
      skippedCount: 0,
      systemRecoveryLock: true,
    });

    expect(() =>
      task.assertWritesAllowed([AbsolutePathSchema.parse("/project/.cursor/rules/a.mdc")]),
    ).toThrow(/recovery/i);
  });
});

function newTaskService(ringSize?: number): TaskService {
  let sequence = 0;
  return new TaskService({
    ids: {
      taskId: () => TaskIdSchema.parse(`task-${String((sequence += 1))}`),
    },
    clock: { now: () => now },
    ...(ringSize === undefined ? {} : { ringSize }),
  });
}

function collect(
  service: TaskService,
  taskId: ReturnType<typeof TaskIdSchema.parse>,
  after: number,
) {
  const events: TaskReplayEvent[] = [];
  service.subscribe(taskId, after, (event) => events.push(event));
  return events;
}
