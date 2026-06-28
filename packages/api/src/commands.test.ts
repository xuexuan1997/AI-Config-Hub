import { describe, expect, it } from "vitest";

import { ApiFailureSchema, createApiRequestSchema } from "./envelope.js";
import {
  API_COMMAND_NAMES,
  CommandRequestSchemas,
  CommandResponseSchemas,
  commandChannel,
} from "./commands.js";

const now = "2026-06-21T08:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;

describe("command schemas", () => {
  it("publishes exactly the approved MVP command catalog", () => {
    expect([...API_COMMAND_NAMES].sort()).toEqual([
      "assets.get",
      "assets.list",
      "deployment.execute",
      "deployment.rollback",
      "diagnostics.list",
      "effective.resolve",
      "history.list",
      "migration.preview",
      "scan.cancel",
      "scan.start",
      "scan.status",
      "settings.get",
      "settings.update",
    ]);
    expect(Object.keys(CommandRequestSchemas).sort()).toEqual([...API_COMMAND_NAMES].sort());
    expect("fs.read" in CommandRequestSchemas).toBe(false);
  });

  it("rejects undeclared request keys and unbounded pages", () => {
    expect(
      CommandRequestSchemas["scan.start"].safeParse({ mode: "full", arbitrary: true }).success,
    ).toBe(false);
    expect(CommandRequestSchemas["assets.list"].safeParse({ limit: 201 }).success).toBe(false);
    expect(CommandRequestSchemas["assets.list"].safeParse({ limit: 200 }).success).toBe(true);
  });

  it("never transports confirmation grants or caller-controlled paths", () => {
    expect(
      CommandRequestSchemas["deployment.execute"].safeParse({
        planId: "plan-1",
        confirmationGrant: "forged",
      }).success,
    ).toBe(false);
    expect(
      CommandRequestSchemas["deployment.rollback"].safeParse({
        deploymentId: "deployment-1",
        backupPath: "/tmp/forged",
      }).success,
    ).toBe(false);
  });

  it("requires deployment execution to confirm the exact preview hash and confirmation set", () => {
    expect(
      CommandRequestSchemas["deployment.execute"].safeParse({ planId: "plan-1" }).success,
    ).toBe(false);
    expect(
      CommandRequestSchemas["deployment.execute"].safeParse({
        planId: "plan-1",
        confirmedPlanHash: hash,
        confirmations: ["overwrite"],
      }).success,
    ).toBe(true);
  });

  it("uses stable, versioned IPC channels", () => {
    expect(commandChannel("scan.start")).toBe("ai-config-hub:v1:scan.start");
  });

  it("validates a request and response fixture for every command", () => {
    const requests: Record<string, unknown> = {
      "scan.start": { mode: "full" },
      "scan.status": { taskId: "task-1" },
      "scan.cancel": { taskId: "task-1" },
      "assets.list": {},
      "assets.get": { assetId: "asset-1" },
      "effective.resolve": {
        toolKey: "codex",
        projectId: "project-1",
        targetScopeId: "scope-1",
      },
      "diagnostics.list": {},
      "migration.preview": {
        sourceAssetIds: ["asset-1"],
        targetToolKey: "cursor",
        targetScopeId: "scope-1",
        conflictPolicy: "fail",
      },
      "deployment.execute": {
        planId: "plan-1",
        confirmedPlanHash: hash,
        confirmations: ["overwrite"],
      },
      "deployment.rollback": { deploymentId: "deployment-1" },
      "history.list": {},
      "settings.get": {},
      "settings.update": { patch: { theme: "dark" }, expectedRevision: 1 },
    };
    const progress = { phase: "queued", completed: 0, total: null, unit: "items" };
    const diagnosticCounts = { info: 0, warning: 0, error: 0 };
    const responses: Record<string, unknown> = {
      "scan.start": { taskId: "task-1", status: "queued", acceptedAt: now },
      "scan.status": {
        taskId: "task-1",
        status: "queued",
        phase: "queued",
        progress,
        lastSequence: 1,
        cancellable: true,
      },
      "scan.cancel": {
        taskId: "task-1",
        cancelRequested: true,
        effectiveAfterPhase: "discovering",
      },
      "assets.list": {
        items: [
          {
            id: "asset-1",
            toolKey: "codex",
            resourceType: "rule",
            scopeKind: "project",
            logicalKey: "repository-policy",
            contentHash: hash,
            diagnosticCounts,
          },
        ],
        nextCursor: null,
        snapshotRevision: "revision-1",
        stale: false,
      },
      "assets.get": {
        asset: {
          id: "asset-1",
          toolKey: "codex",
          resourceType: "rule",
          scopeId: "scope-1",
          logicalKey: "repository-policy",
          normalized: { kind: "rule", instructions: "redacted view" },
        },
        source: { pathDisplay: "AGENTS.md", contentHash: hash, observedAt: now },
        redactions: [],
      },
      "effective.resolve": {
        effective: { counts: { rule: 1 } },
        contributors: [{ assetId: "asset-1", action: "inherit", reasonCode: "PROJECT_SCOPE" }],
        ignored: [],
        diagnostics: [],
        snapshotRevision: "revision-1",
      },
      "diagnostics.list": {
        items: [],
        nextCursor: null,
        countsBySeverity: diagnosticCounts,
        snapshotRevision: "revision-1",
      },
      "migration.preview": {
        planId: "plan-1",
        planHash: hash,
        compatibility: "full",
        changes: [
          {
            operation: "create",
            pathDisplay: ".cursor/rules/repository-policy.mdc",
            beforeHash: null,
            afterHash: hash,
            diff: "+ content",
          },
        ],
        requiredConfirmations: ["overwrite"],
        warnings: [],
        sourceHashes: { "asset-1": hash },
        targetHashes: { ".cursor/rules/repository-policy.mdc": null },
        expiresAt: now,
      },
      "deployment.execute": {
        taskId: "task-1",
        deploymentId: "deployment-1",
        status: "queued",
        acceptedAt: now,
      },
      "deployment.rollback": {
        taskId: "task-1",
        rollbackId: "rollback-1",
        status: "queued",
        acceptedAt: now,
      },
      "history.list": { items: [], nextCursor: null },
      "settings.get": {
        values: { theme: "system" },
        revision: 1,
        readOnlyRecovery: false,
      },
      "settings.update": {
        values: { theme: "dark" },
        revision: 2,
        requiresRestart: false,
      },
    };

    for (const name of API_COMMAND_NAMES) {
      expect(CommandRequestSchemas[name].safeParse(requests[name]).success, `${name} request`).toBe(
        true,
      );
      expect(
        CommandResponseSchemas[name].safeParse(responses[name]).success,
        `${name} response`,
      ).toBe(true);
    }
  });
});

describe("API envelope", () => {
  it("is strict and versioned", () => {
    const schema = createApiRequestSchema(CommandRequestSchemas["scan.status"]);
    expect(
      schema.safeParse({ apiVersion: 1, requestId: "req-1", payload: { taskId: "task-1" } })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({
        apiVersion: 2,
        requestId: "req-1",
        payload: { taskId: "task-1" },
      }).success,
    ).toBe(false);
  });

  it("rejects unsafe and unknown error context", () => {
    const base = {
      apiVersion: 1,
      requestId: "req-1",
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "redacted",
        retryable: false,
        correlationId: "correlation-1",
      },
    } as const;
    expect(ApiFailureSchema.safeParse(base).success).toBe(true);
    expect(
      ApiFailureSchema.safeParse({
        ...base,
        error: { ...base.error, details: { stack: { secret: true } } },
      }).success,
    ).toBe(false);
    expect(ApiFailureSchema.safeParse({ ...base, stack: "secret" }).success).toBe(false);
  });
});
