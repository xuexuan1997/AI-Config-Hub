import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  DeploymentPlanSchema,
  DeploymentRecordSchema,
  type DeploymentRepository,
} from "@ai-config-hub/core";
import { PaginationCursorSchema, type ToolId } from "@ai-config-hub/shared";

import { readOnlyError } from "./index-repository.js";
import { parseJson, serializeJson } from "./serialization.js";

function toolForAdapter(adapterId: string): ToolId {
  if (adapterId.includes("claude")) return "claude-code";
  if (adapterId.includes("cursor")) return "cursor";
  if (adapterId.includes("opencode")) return "opencode";
  return "codex";
}

export class SqliteDeploymentRepository implements DeploymentRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly readOnly: boolean,
  ) {}

  savePlanAndRecord(
    input: Parameters<DeploymentRepository["savePlanAndRecord"]>[0],
  ): Promise<void> {
    if (this.readOnly) return Promise.reject(readOnlyError());
    const plan = DeploymentPlanSchema.parse(input.plan);
    const record = DeploymentRecordSchema.parse(input.record);
    if (record.deploymentPlanId !== plan.deploymentPlanId) {
      return Promise.reject(new TypeError("Deployment plan and record identity mismatch"));
    }
    const planJson = serializeJson(plan);
    const recordJson = serializeJson(record);
    const targetToolId = this.ensureTool(record.adapterId);
    const targetBefore = Object.values(plan.expectedTargetHashes)[0];
    this.database
      .prepare(
        `INSERT INTO deployments(
          id, domain_id, target_tool_id, plan_id, status, source_hash, target_hash_before,
          plan_json, compatibility, requested_at, confirmed_at, finished_at, verification_json,
          rollback_state, correlation_id, rollback_of_domain_id
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'native', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        record.deploymentRecordId,
        targetToolId,
        plan.deploymentPlanId,
        record.status,
        plan.planHash,
        targetBefore === undefined || targetBefore === "absent" ? null : targetBefore,
        planJson,
        Date.parse(record.createdAt),
        record.confirmedAt === undefined ? null : Date.parse(record.confirmedAt),
        record.finishedAt === undefined ? null : Date.parse(record.finishedAt),
        recordJson,
        record.status,
        record.correlationId,
        record.rollbackOfRecordId ?? null,
      );
    return Promise.resolve();
  }

  getPlan(
    id: Parameters<DeploymentRepository["getPlan"]>[0],
  ): ReturnType<DeploymentRepository["getPlan"]> {
    const row = this.database
      .prepare("SELECT plan_json FROM deployments WHERE plan_id = ?")
      .get(id) as { plan_json: string } | undefined;
    return Promise.resolve(
      row === undefined ? undefined : parseJson(DeploymentPlanSchema, row.plan_json),
    );
  }

  getRecord(
    id: Parameters<DeploymentRepository["getRecord"]>[0],
  ): ReturnType<DeploymentRepository["getRecord"]> {
    const row = this.database
      .prepare("SELECT verification_json FROM deployments WHERE domain_id = ?")
      .get(id) as { verification_json: string } | undefined;
    return Promise.resolve(
      row === undefined ? undefined : parseJson(DeploymentRecordSchema, row.verification_json),
    );
  }

  compareAndSetRecord(
    input: Parameters<DeploymentRepository["compareAndSetRecord"]>[0],
  ): Promise<boolean> {
    if (this.readOnly) return Promise.reject(readOnlyError());
    const record = DeploymentRecordSchema.parse(input.record);
    const result = this.database
      .prepare(
        "UPDATE deployments SET status = ?, verification_json = ?, rollback_state = ?, confirmed_at = ?, finished_at = ? WHERE domain_id = ? AND status = ?",
      )
      .run(
        record.status,
        serializeJson(record),
        record.status,
        record.confirmedAt === undefined ? null : Date.parse(record.confirmedAt),
        record.finishedAt === undefined ? null : Date.parse(record.finishedAt),
        record.deploymentRecordId,
        input.expectedStatus,
      );
    return Promise.resolve(result.changes === 1);
  }

  listRecords(
    input: Parameters<DeploymentRepository["listRecords"]>[0],
  ): ReturnType<DeploymentRepository["listRecords"]> {
    let records = (
      this.database.prepare("SELECT verification_json FROM deployments").all() as {
        verification_json: string;
      }[]
    )
      .map(({ verification_json }) => parseJson(DeploymentRecordSchema, verification_json))
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
          right.deploymentRecordId.localeCompare(left.deploymentRecordId),
      );
    if (input.kinds !== undefined) {
      const kinds = new Set(input.kinds);
      records = records.filter((record) =>
        kinds.has(record.rollbackOfRecordId === undefined ? "deployment" : "rollback"),
      );
    }
    if (input.statuses !== undefined) {
      const statuses = new Set(input.statuses);
      records = records.filter((record) => statuses.has(record.status));
    }
    if (input.from !== undefined) {
      const from = Date.parse(input.from);
      records = records.filter((record) => Date.parse(record.createdAt) >= from);
    }
    if (input.to !== undefined) {
      const to = Date.parse(input.to);
      records = records.filter((record) => Date.parse(record.createdAt) <= to);
    }
    if (input.cursor !== undefined) {
      const cursor = String(input.cursor);
      const cursorIndex = records.findIndex(
        ({ deploymentRecordId }) => deploymentRecordId === cursor,
      );
      records = cursorIndex === -1 ? [] : records.slice(cursorIndex + 1);
    }
    const items = records.slice(0, input.limit);
    const last = items.at(-1);
    return Promise.resolve({
      items,
      snapshotRevision: String(
        (this.database.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ),
      ...(records.length > items.length && last !== undefined
        ? { nextCursor: PaginationCursorSchema.parse(last.deploymentRecordId) }
        : {}),
    });
  }

  private ensureTool(adapterId: string): string {
    const toolId = toolForAdapter(adapterId);
    const installationId = `deployment-target:${adapterId}`;
    const existing = this.database
      .prepare("SELECT id FROM tools WHERE tool_installation_id = ?")
      .get(installationId) as { id: string } | undefined;
    if (existing !== undefined) return existing.id;
    const id = randomUUID();
    this.database
      .prepare(
        "INSERT INTO tools(id, tool_installation_id, tool_key, canonical_config_root, display_name, adapter_version, capabilities_json, last_seen_at, is_detected) VALUES(?, ?, ?, ?, ?, '0.0.0', '{}', ?, 0)",
      )
      .run(id, installationId, toolId, `/virtual/${toolId}/${adapterId}`, toolId, Date.now());
    return id;
  }
}
