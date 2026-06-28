import { IsoDateTimeSchema, TaskIdSchema } from "@ai-config-hub/shared";
import { z } from "zod";

import { ApiVersionSchema } from "./envelope.js";

export const EventVersionSchema = z.literal(1);
export const TaskKindSchema = z.enum(["scan", "deployment", "rollback"]);
export const TaskPhaseSchema = z.enum([
  "queued",
  "discovering",
  "reading",
  "parsing",
  "validating",
  "committing",
  "preflight",
  "backing_up",
  "writing",
  "restoring",
  "verifying",
  "rolling_back",
  "completed",
]);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

export const TaskTerminalStatusSchema = z.enum([
  "succeeded",
  "partially_succeeded",
  "cancelled",
  "failed",
  "rolled_back",
]);

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema).readonly(),
    z.record(z.string(), JsonValueSchema).readonly(),
  ]),
);

const ExtensionsSchema = z.record(z.string().min(1), JsonValueSchema).readonly();
const orderedBaseShape = {
  apiVersion: ApiVersionSchema,
  eventVersion: EventVersionSchema,
  taskId: TaskIdSchema,
  sequence: z.number().int().positive(),
  emittedAt: IsoDateTimeSchema,
  extensions: ExtensionsSchema.optional(),
};
const replayBaseShape = {
  apiVersion: ApiVersionSchema,
  eventVersion: EventVersionSchema,
  taskId: TaskIdSchema,
  sequence: z.null(),
  emittedAt: IsoDateTimeSchema,
  extensions: ExtensionsSchema.optional(),
};

export const TaskProgressPayloadSchema = z
  .object({
    phase: TaskPhaseSchema,
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().nullable(),
    unit: z.enum(["files", "operations", "items"]),
  })
  .strict()
  .refine((progress) => progress.total === null || progress.completed <= progress.total, {
    message: "Completed progress cannot exceed total",
    path: ["completed"],
  })
  .readonly();

const AcceptedEventSchema = z
  .object({
    ...orderedBaseShape,
    type: z.literal("accepted"),
    payload: z
      .object({
        taskKind: TaskKindSchema,
        phase: z.literal("queued"),
        acceptedAt: IsoDateTimeSchema,
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
const PhaseChangedEventSchema = z
  .object({
    ...orderedBaseShape,
    type: z.literal("phase.changed"),
    payload: z
      .object({ from: TaskPhaseSchema.nullable(), to: TaskPhaseSchema })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
const ProgressEventSchema = z
  .object({ ...orderedBaseShape, type: z.literal("progress"), payload: TaskProgressPayloadSchema })
  .strict()
  .readonly();
const ItemFailedEventSchema = z
  .object({
    ...orderedBaseShape,
    type: z.literal("item.failed"),
    payload: z
      .object({
        itemRef: z.string().trim().min(1).max(500),
        diagnosticId: z.string().trim().min(1).max(200),
        errorCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        retryable: z.boolean(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
const CancelRequestedEventSchema = z
  .object({
    ...orderedBaseShape,
    type: z.literal("cancel.requested"),
    payload: z
      .object({
        reason: z.enum(["user", "shutdown"]),
        effectiveAfterPhase: TaskPhaseSchema,
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
const CompletedEventSchema = z
  .object({
    ...orderedBaseShape,
    type: z.literal("completed"),
    payload: z
      .object({
        status: TaskTerminalStatusSchema,
        succeededCount: z.number().int().nonnegative(),
        failedCount: z.number().int().nonnegative(),
        skippedCount: z.number().int().nonnegative(),
        resultRef: z.string().trim().min(1).max(200).optional(),
        systemRecoveryLock: z.boolean(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
const CursorResetEventSchema = z
  .object({
    ...replayBaseShape,
    type: z.literal("cursor.reset"),
    payload: z
      .object({
        requestedAfterSequence: z.number().int().nonnegative(),
        earliestAvailableSequence: z.number().int().positive(),
        latestSequence: z.number().int().nonnegative(),
      })
      .strict()
      .refine((payload) => payload.latestSequence >= payload.earliestAvailableSequence, {
        message: "Latest sequence cannot precede earliest available sequence",
        path: ["latestSequence"],
      })
      .readonly(),
  })
  .strict()
  .readonly();
const SnapshotEventSchema = z
  .object({
    ...replayBaseShape,
    type: z.literal("snapshot"),
    payload: z
      .object({
        taskKind: TaskKindSchema,
        phase: TaskPhaseSchema,
        status: z.union([z.literal("running"), TaskTerminalStatusSchema]),
        progress: TaskProgressPayloadSchema,
        lastSequence: z.number().int().nonnegative(),
        cancellable: z.boolean(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export const TaskEventSchema = z.discriminatedUnion("type", [
  AcceptedEventSchema,
  PhaseChangedEventSchema,
  ProgressEventSchema,
  ItemFailedEventSchema,
  CancelRequestedEventSchema,
  CompletedEventSchema,
  CursorResetEventSchema,
  SnapshotEventSchema,
]);
export type TaskEvent = z.infer<typeof TaskEventSchema>;

export type TaskEventCursorResult =
  | { readonly kind: "accepted" | "duplicate"; readonly sequence: number }
  | { readonly kind: "snapshot"; readonly sequence: number }
  | {
      readonly kind: "gap";
      readonly expectedSequence: number;
      readonly receivedSequence: number;
    }
  | { readonly kind: "awaiting_snapshot" }
  | { readonly kind: "invalid"; readonly reason: string };

const phaseTransitions = {
  scan: {
    queued: ["discovering"],
    discovering: ["reading"],
    reading: ["parsing"],
    parsing: ["validating"],
    validating: ["committing"],
    committing: ["completed"],
  },
  deployment: {
    queued: ["preflight"],
    preflight: ["backing_up", "completed"],
    backing_up: ["writing", "completed"],
    writing: ["verifying", "rolling_back"],
    verifying: ["completed", "rolling_back"],
    rolling_back: ["completed"],
  },
  rollback: {
    queued: ["preflight"],
    preflight: ["restoring", "completed"],
    restoring: ["verifying", "completed"],
    verifying: ["completed"],
  },
} as const;

function isPhaseTransitionAllowed(
  taskKind: z.infer<typeof TaskKindSchema>,
  from: TaskPhase,
  to: TaskPhase,
): boolean {
  const transitions = phaseTransitions[taskKind] as Partial<
    Record<TaskPhase, readonly TaskPhase[]>
  >;
  return transitions[from]?.includes(to) ?? false;
}

export function createTaskEventCursor(
  taskId: string,
  afterSequence: number,
  onEvent: (event: TaskEvent) => void,
): { readonly push: (input: unknown) => TaskEventCursorResult; readonly sequence: () => number } {
  let lastSequence = afterSequence;
  let awaitingSnapshot = false;
  let terminal = false;
  let lastTotal: number | null = null;
  let taskKind: z.infer<typeof TaskKindSchema> | undefined;
  let currentPhase: TaskPhase | undefined;

  return {
    sequence: () => lastSequence,
    push(input: unknown): TaskEventCursorResult {
      const parsed = TaskEventSchema.safeParse(input);
      if (!parsed.success) return { kind: "invalid", reason: "EVENT_SCHEMA_INVALID" };
      const event = parsed.data;
      if (event.taskId !== taskId) return { kind: "invalid", reason: "TASK_ID_MISMATCH" };

      if (event.type === "cursor.reset") {
        awaitingSnapshot = true;
        onEvent(event);
        return { kind: "awaiting_snapshot" };
      }
      if (event.type === "snapshot") {
        if (!awaitingSnapshot) return { kind: "invalid", reason: "UNEXPECTED_SNAPSHOT" };
        lastSequence = event.payload.lastSequence;
        awaitingSnapshot = false;
        terminal = event.payload.status !== "running";
        lastTotal = event.payload.progress.total;
        taskKind = event.payload.taskKind;
        currentPhase = event.payload.phase;
        onEvent(event);
        return { kind: "snapshot", sequence: lastSequence };
      }
      if (awaitingSnapshot) return { kind: "awaiting_snapshot" };
      if (event.sequence <= lastSequence) return { kind: "duplicate", sequence: event.sequence };
      if (event.sequence !== lastSequence + 1) {
        return {
          kind: "gap",
          expectedSequence: lastSequence + 1,
          receivedSequence: event.sequence,
        };
      }
      if (terminal) return { kind: "invalid", reason: "EVENT_AFTER_COMPLETION" };
      if (lastSequence === 0 && event.type !== "accepted") {
        return { kind: "invalid", reason: "FIRST_EVENT_NOT_ACCEPTED" };
      }
      if (event.type === "accepted") {
        taskKind = event.payload.taskKind;
        currentPhase = "queued";
      }
      if (event.type === "phase.changed") {
        if (
          taskKind === undefined ||
          currentPhase === undefined ||
          event.payload.from !== currentPhase ||
          !isPhaseTransitionAllowed(taskKind, currentPhase, event.payload.to)
        ) {
          return { kind: "invalid", reason: "PHASE_TRANSITION_INVALID" };
        }
        currentPhase = event.payload.to;
      }
      if (event.type === "progress") {
        if (event.payload.phase !== currentPhase) {
          return { kind: "invalid", reason: "PROGRESS_PHASE_NOT_ACTIVE" };
        }
        if (lastTotal !== null && event.payload.total !== null && event.payload.total < lastTotal) {
          return { kind: "invalid", reason: "PROGRESS_TOTAL_DECREASED" };
        }
        lastTotal = event.payload.total;
      }
      lastSequence = event.sequence;
      terminal = event.type === "completed";
      onEvent(event);
      return { kind: "accepted", sequence: lastSequence };
    },
  };
}

export const TASK_EVENT_CHANNEL = "ai-config-hub:v1:task.event" as const;
