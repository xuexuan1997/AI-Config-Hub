import type { CommandServiceMap } from "@ai-config-hub/api";
import { ContentHashSchema, TaskIdSchema } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { createCliProgram, runCli } from "./cli.js";

const now = "2026-06-24T08:00:00.000Z";
const hash = ContentHashSchema.parse(`sha256:${"a".repeat(64)}`);

function services(overrides: Partial<CommandServiceMap> = {}): CommandServiceMap {
  const base: Record<keyof CommandServiceMap, (payload: never) => Promise<unknown>> = {
    "scan.start": () =>
      Promise.resolve({
        taskId: TaskIdSchema.parse("task-1"),
        status: "queued",
        acceptedAt: now,
      }),
    "scan.status": (payload) =>
      Promise.resolve({
        taskId: (payload as { readonly taskId: string }).taskId,
        status: "succeeded",
        phase: "completed",
        progress: { phase: "completed", completed: 1, total: 1, unit: "items" },
        resultSummary: { succeededCount: 1, failedCount: 0, skippedCount: 0, diagnosticIds: [] },
        lastSequence: 2,
        cancellable: false,
        startedAt: now,
        finishedAt: now,
      }),
    "scan.cancel": (payload) =>
      Promise.resolve({
        taskId: (payload as { readonly taskId: string }).taskId,
        cancelRequested: true,
        effectiveAfterPhase: "discovering",
      }),
    "assets.list": () =>
      Promise.resolve({
        items: [
          {
            id: "asset-1",
            toolKey: "codex",
            resourceType: "rule",
            scopeKind: "project",
            logicalKey: "AGENTS.md",
            contentHash: hash,
            diagnosticCounts: { info: 0, warning: 1, error: 0 },
          },
        ],
        nextCursor: null,
        snapshotRevision: "1",
        stale: false,
      }),
    "assets.get": (payload) =>
      Promise.resolve({
        asset: {
          id: (payload as { readonly assetId: string }).assetId,
          toolKey: "codex",
          resourceType: "rule",
          scopeId: "scope-1",
          logicalKey: "AGENTS.md",
          normalized: { kind: "rule", instructions: "Use local conventions." },
          references: [],
          diagnosticIds: [],
        },
        source: { pathDisplay: "AGENTS.md", contentHash: hash, observedAt: now },
        redactions: [],
      }),
    "effective.resolve": () =>
      Promise.resolve({
        effective: { rules: ["Use local conventions."] },
        contributors: [{ assetId: "asset-1", action: "inherit", reasonCode: "PROJECT_SCOPE" }],
        ignored: [],
        diagnostics: [],
        snapshotRevision: "1",
      }),
    "diagnostics.list": () =>
      Promise.resolve({
        items: [
          {
            id: "diagnostic-1",
            code: "MISSING_REFERENCE",
            severity: "warning",
            assetId: "asset-1",
            message: "A referenced file is missing",
            suggestedAction: "Create the referenced file or remove the reference",
            blocking: false,
          },
        ],
        nextCursor: null,
        countsBySeverity: { info: 0, warning: 1, error: 0 },
        snapshotRevision: "1",
      }),
    "migration.preview": () =>
      Promise.resolve({
        planId: "deployment-plan-1",
        planHash: hash,
        compatibility: "full",
        requiredConfirmations: [],
        changes: [
          {
            operation: "create",
            pathDisplay: ".cursor/rules/AGENTS.mdc",
            beforeHash: null,
            afterHash: hash,
            diff: "+ Use local conventions.",
          },
        ],
        warnings: [],
        sourceHashes: { "asset-1": hash },
        targetHashes: { ".cursor/rules/AGENTS.mdc": null },
        expiresAt: now,
      }),
    "deployment.execute": () =>
      Promise.resolve({
        taskId: TaskIdSchema.parse("task-deploy"),
        status: "queued",
        acceptedAt: now,
        deploymentId: "deployment-1",
      }),
    "deployment.rollback": () =>
      Promise.resolve({
        taskId: TaskIdSchema.parse("task-rollback"),
        status: "queued",
        acceptedAt: now,
        rollbackId: "rollback-1",
      }),
    "history.list": () =>
      Promise.resolve({
        items: [
          {
            id: "deployment-1",
            kind: "deployment",
            status: "succeeded",
            createdAt: now,
            snapshot: {
              status: "recorded",
              commitId: "abc123def456",
              authoredAt: now,
              message: "record deployment deployment-1",
            },
          },
        ],
        nextCursor: null,
      }),
    "settings.get": () =>
      Promise.resolve({
        values: { pathDisplay: "abbreviated", fileWatching: true },
        revision: 1,
        readOnlyRecovery: false,
      }),
    "settings.update": () =>
      Promise.resolve({
        values: { pathDisplay: "full" },
        revision: 2,
        requiresRestart: false,
      }),
  };
  return { ...base, ...overrides } as CommandServiceMap;
}

describe("CLI program", () => {
  it("maps scan to scan.start and prints a JSON API envelope", async () => {
    const calls: unknown[] = [];
    const output: string[] = [];
    const result = await runCli(
      createCliProgram({
        services: services({
          "scan.start": (payload) => {
            calls.push(payload);
            return Promise.resolve({
              taskId: TaskIdSchema.parse("task-1"),
              status: "queued",
              acceptedAt: now,
            });
          },
        }),
        stdout: (text) => output.push(text),
        stderr: () => undefined,
      }),
      ["scan", "/workspace/project", "--tool", "codex", "--json"],
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(calls).toEqual([{ mode: "full", roots: ["/workspace/project"], toolKeys: ["codex"] }]);
    expect(JSON.parse(output.join(""))).toMatchObject({
      apiVersion: 1,
      ok: true,
      data: { taskId: "task-1", status: "queued" },
    });
  });

  it("maps the friendly command set onto the stable API catalog", async () => {
    const calls: string[] = [];
    const proxied = Object.fromEntries(
      Object.entries(services()).map(([name, handler]) => [
        name,
        async (payload: never) => {
          calls.push(`${name}:${JSON.stringify(payload)}`);
          return handler(payload);
        },
      ]),
    ) as CommandServiceMap;

    for (const argv of [
      ["assets", "list", "--tool", "codex"],
      ["assets", "get", "asset-1"],
      ["effective", "resolve", "--tool", "codex", "--project", "project-1", "--scope", "scope-1"],
      ["diagnose", "--severity", "warning"],
      ["migrate", "--dry-run", "--source", "asset-1", "--target", "cursor", "--scope", "scope-1"],
      ["deploy", "deployment-plan-1", "--plan-hash", hash, "--confirm", "overwrite"],
      ["rollback", "deployment-1"],
      [
        "history",
        "--kind",
        "deployment",
        "--status",
        "succeeded",
        "--from",
        "2026-06-24T00:00:00.000Z",
        "--to",
        "2026-06-25T00:00:00.000Z",
      ],
    ]) {
      const result = await runCli(
        createCliProgram({
          services: proxied,
          stdout: () => undefined,
          stderr: () => undefined,
        }),
        [...argv, "--json"],
      );
      expect(result.exitCode, argv.join(" ")).toBe(0);
    }

    expect(calls.map((call) => call.split(":")[0])).toEqual([
      "assets.list",
      "assets.get",
      "effective.resolve",
      "diagnostics.list",
      "migration.preview",
      "deployment.execute",
      "deployment.rollback",
      "history.list",
    ]);
    expect(calls).toContain(
      `deployment.execute:${JSON.stringify({
        planId: "deployment-plan-1",
        confirmedPlanHash: hash,
        confirmations: ["overwrite"],
      })}`,
    );
    const historyCall = calls.find((call) => call.startsWith("history.list:"));
    if (historyCall === undefined) throw new Error("Expected history.list call");
    expect(JSON.parse(historyCall.slice("history.list:".length))).toEqual({
      kinds: ["deployment"],
      statuses: ["succeeded"],
      from: "2026-06-24T00:00:00.000Z",
      to: "2026-06-25T00:00:00.000Z",
      limit: 50,
    });
  });

  it("returns a failed JSON envelope and non-zero exit code for invalid command payloads", async () => {
    const output: string[] = [];
    const result = await runCli(
      createCliProgram({
        services: services(),
        stdout: (text) => output.push(text),
        stderr: () => undefined,
      }),
      ["assets", "list", "--limit", "201", "--json"],
    );

    expect(result).toEqual({ exitCode: 1 });
    expect(JSON.parse(output.join(""))).toMatchObject({
      apiVersion: 1,
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("prints snapshot commit metadata in history text output", async () => {
    const output: string[] = [];
    const result = await runCli(
      createCliProgram({
        services: services(),
        stdout: (text) => output.push(text),
        stderr: () => undefined,
      }),
      ["history"],
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(output.join("")).toContain("deployment deployment-1 succeeded");
    expect(output.join("")).toContain("snapshot abc123def456");
  });
});
