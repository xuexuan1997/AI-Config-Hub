import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  ScanRunStatusSchema,
  ScanRunSummarySchema,
  TaskProgressSchema,
  type TaskRepository,
} from "@ai-config-hub/core";
import { ScanRunIdSchema, TaskIdSchema } from "@ai-config-hub/shared";

import { readOnlyError } from "./index-repository.js";
import { parseJson, serializeJson } from "./serialization.js";

export class SqliteTaskRepository implements TaskRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly readOnly: boolean,
  ) {}

  create(input: Parameters<TaskRepository["create"]>[0]): Promise<void> {
    if (this.readOnly) return Promise.reject(readOnlyError());
    const taskId = TaskIdSchema.parse(input.taskId);
    const scanRunId = ScanRunIdSchema.parse(input.scanRunId);
    const status = ScanRunStatusSchema.parse(input.status);
    this.database
      .prepare(
        "INSERT INTO scan_runs(id, domain_id, task_id, scan_kind, status, phase, requested_roots_json, started_at) VALUES(?, ?, ?, 'targeted', ?, ?, '[]', ?)",
      )
      .run(randomUUID(), scanRunId, taskId, status, status, Date.now());
    return Promise.resolve();
  }

  updateProgress(progress: Parameters<TaskRepository["updateProgress"]>[0]): Promise<void> {
    if (this.readOnly) return Promise.reject(readOnlyError());
    const parsed = TaskProgressSchema.parse(progress);
    const row = this.database
      .prepare("SELECT progress_json FROM scan_runs WHERE task_id = ?")
      .get(parsed.taskId) as { progress_json: string | null } | undefined;
    if (row === undefined) return Promise.reject(new Error(`Task not found: ${parsed.taskId}`));
    if (row.progress_json !== null) {
      const previous = parseJson(TaskProgressSchema, row.progress_json);
      if (parsed.sequence <= previous.sequence)
        return Promise.reject(new Error("Task progress sequence must increase"));
    }
    this.database
      .prepare("UPDATE scan_runs SET progress_json = ?, phase = ? WHERE task_id = ?")
      .run(serializeJson(parsed), parsed.phase, parsed.taskId);
    return Promise.resolve();
  }

  finish(summary: Parameters<TaskRepository["finish"]>[0]): Promise<void> {
    if (this.readOnly) return Promise.reject(readOnlyError());
    const parsed = ScanRunSummarySchema.parse(summary);
    const result = this.database
      .prepare(
        "UPDATE scan_runs SET status = ?, phase = ?, summary_json = ?, finished_at = ?, succeeded_count = ?, failed_count = ? WHERE domain_id = ?",
      )
      .run(
        parsed.status,
        parsed.status,
        serializeJson(parsed),
        Date.now(),
        parsed.succeededCount,
        parsed.failedCount,
        parsed.scanRunId,
      );
    if (result.changes !== 1)
      return Promise.reject(new Error(`Scan run not found: ${parsed.scanRunId}`));
    return Promise.resolve();
  }

  get(taskId: Parameters<TaskRepository["get"]>[0]): ReturnType<TaskRepository["get"]> {
    const parsedTaskId = TaskIdSchema.parse(taskId);
    const row = this.database
      .prepare(
        "SELECT domain_id, status, progress_json, summary_json FROM scan_runs WHERE task_id = ?",
      )
      .get(parsedTaskId) as
      | {
          domain_id: string;
          status: string;
          progress_json: string | null;
          summary_json: string | null;
        }
      | undefined;
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      taskId: parsedTaskId,
      scanRunId: ScanRunIdSchema.parse(row.domain_id),
      status: ScanRunStatusSchema.parse(row.status),
      ...(row.progress_json === null
        ? {}
        : { progress: parseJson(TaskProgressSchema, row.progress_json) }),
      ...(row.summary_json === null
        ? {}
        : { summary: parseJson(ScanRunSummarySchema, row.summary_json) }),
    });
  }
}
