import { describe, expect, it, vi } from "vitest";

import { TaskEventSchema, createTaskEventCursor } from "./events.js";

const base = {
  apiVersion: 1,
  eventVersion: 1,
  taskId: "task-1",
  emittedAt: "2026-06-21T08:00:00.000Z",
} as const;

describe("task event schema", () => {
  it("accepts closed typed events and rejects unknown payload fields", () => {
    expect(
      TaskEventSchema.safeParse({
        ...base,
        sequence: 1,
        type: "accepted",
        payload: { taskKind: "scan", phase: "queued", acceptedAt: base.emittedAt },
      }).success,
    ).toBe(true);
    expect(
      TaskEventSchema.safeParse({
        ...base,
        sequence: 2,
        type: "progress",
        payload: { phase: "reading", completed: 2, total: 1, unit: "files" },
      }).success,
    ).toBe(false);
    expect(
      TaskEventSchema.safeParse({
        ...base,
        sequence: 1,
        type: "accepted",
        payload: {
          taskKind: "scan",
          phase: "queued",
          acceptedAt: base.emittedAt,
          secret: "nope",
        },
      }).success,
    ).toBe(false);
  });

  it("models cursor reset and snapshot as non-persistent events", () => {
    expect(
      TaskEventSchema.safeParse({
        ...base,
        sequence: null,
        type: "cursor.reset",
        payload: { requestedAfterSequence: 1, earliestAvailableSequence: 4, latestSequence: 8 },
      }).success,
    ).toBe(true);
  });
});

describe("task event cursor", () => {
  it("deduplicates events and stops on gaps or wrong tasks", () => {
    const accepted = vi.fn();
    const cursor = createTaskEventCursor("task-1", 0, accepted);
    const event = {
      ...base,
      sequence: 1,
      type: "accepted",
      payload: { taskKind: "scan", phase: "queued", acceptedAt: base.emittedAt },
    } as const;

    expect(cursor.push(event)).toEqual({ kind: "accepted", sequence: 1 });
    expect(cursor.push(event)).toEqual({ kind: "duplicate", sequence: 1 });
    expect(cursor.push({ ...event, sequence: 3 })).toEqual({
      kind: "gap",
      expectedSequence: 2,
      receivedSequence: 3,
    });
    expect(cursor.push({ ...event, taskId: "task-2", sequence: 2 }).kind).toBe("invalid");
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it("requires declared phase transitions before progress", () => {
    const cursor = createTaskEventCursor("task-1", 0, vi.fn());
    const accepted = {
      ...base,
      sequence: 1,
      type: "accepted",
      payload: { taskKind: "scan", phase: "queued", acceptedAt: base.emittedAt },
    } as const;
    expect(cursor.push(accepted).kind).toBe("accepted");
    expect(
      cursor.push({
        ...base,
        sequence: 2,
        type: "progress",
        payload: { phase: "discovering", completed: 0, total: null, unit: "files" },
      }),
    ).toEqual({ kind: "invalid", reason: "PROGRESS_PHASE_NOT_ACTIVE" });
    expect(
      cursor.push({
        ...base,
        sequence: 2,
        type: "phase.changed",
        payload: { from: "queued", to: "discovering" },
      }).kind,
    ).toBe("accepted");
    expect(
      cursor.push({
        ...base,
        sequence: 3,
        type: "progress",
        payload: { phase: "discovering", completed: 1, total: 1, unit: "files" },
      }).kind,
    ).toBe("accepted");
  });

  it("accepts deployment failure streams that route writing through rolling_back", () => {
    const accepted = vi.fn();
    const cursor = createTaskEventCursor("task-1", 0, accepted);

    for (const event of [
      {
        ...base,
        sequence: 1,
        type: "accepted",
        payload: { taskKind: "deployment", phase: "queued", acceptedAt: base.emittedAt },
      },
      { ...base, sequence: 2, type: "phase.changed", payload: { from: "queued", to: "preflight" } },
      {
        ...base,
        sequence: 3,
        type: "phase.changed",
        payload: { from: "preflight", to: "backing_up" },
      },
      {
        ...base,
        sequence: 4,
        type: "phase.changed",
        payload: { from: "backing_up", to: "writing" },
      },
      {
        ...base,
        sequence: 5,
        type: "item.failed",
        payload: {
          itemRef: "deployment-1",
          diagnosticId: "diagnostic:deployment:failure",
          errorCode: "VALIDATION_FAILED",
          retryable: false,
        },
      },
      {
        ...base,
        sequence: 6,
        type: "phase.changed",
        payload: { from: "writing", to: "rolling_back" },
      },
      {
        ...base,
        sequence: 7,
        type: "phase.changed",
        payload: { from: "rolling_back", to: "completed" },
      },
      {
        ...base,
        sequence: 8,
        type: "completed",
        payload: {
          status: "failed",
          succeededCount: 0,
          failedCount: 1,
          skippedCount: 0,
          resultRef: "deployment-1",
          systemRecoveryLock: true,
        },
      },
    ] as const) {
      expect(cursor.push(event).kind, `${event.sequence}:${event.type}`).toBe("accepted");
    }

    expect(accepted).toHaveBeenCalledTimes(8);
  });
});
