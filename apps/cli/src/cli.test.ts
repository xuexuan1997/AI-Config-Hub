import type { CommandServiceMap } from "@ai-config-hub/api";
import {
  AssetIdSchema,
  ContentHashSchema,
  DeploymentPlanIdSchema,
  DiagnosticIdSchema,
  TaskIdSchema,
} from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { createCliProgram, runCli } from "./cli.js";

const now = "2026-06-24T08:00:00.000Z";
const hash = ContentHashSchema.parse(`sha256:${"a".repeat(64)}`);
type MigrationPreviewResponse = Awaited<ReturnType<CommandServiceMap["migration.preview"]>>;

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
            sourceSummary: {
              kind: "file",
              fileName: "AGENTS.md",
              mediaType: "text/markdown",
              isText: true,
            },
            contentHash: hash,
            status: "enabled",
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
          status: "enabled",
          disablementOptions: [],
          normalized: { kind: "rule", instructions: "Use local conventions." },
          references: [],
          diagnosticIds: [],
        },
        source: {
          pathDisplay: "AGENTS.md",
          contentHash: hash,
          observedAt: now,
          sourceSummary: {
            kind: "file",
            fileName: "AGENTS.md",
            mediaType: "text/markdown",
            isText: true,
          },
          files: [
            {
              pathDisplay: "AGENTS.md",
              relativePath: "AGENTS.md",
              role: "primary",
              mediaType: "text/markdown",
              isText: true,
              contentHash: hash,
            },
          ],
        },
        redactions: [],
      }),
    "assets.openSource": (payload) =>
      Promise.resolve({
        assetId: (payload as { readonly assetId: string }).assetId,
        opened: true,
      }),
    "assets.disable": (payload) =>
      Promise.resolve({
        assetId: (payload as { readonly assetId: string }).assetId,
        status: "disabled",
      }),
    "assets.enable": (payload) =>
      Promise.resolve({
        assetId: (payload as { readonly assetId: string }).assetId,
        status: "enabled",
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
    "diagnostics.export": () =>
      Promise.resolve({
        format: "markdown",
        generatedAt: now,
        filters: { toolKeys: ["codex"], severities: ["warning"] },
        summary: { total: 1, info: 0, warning: 1, error: 0 },
        items: [
          {
            id: "diagnostic-1",
            code: "MISSING_REFERENCE",
            severity: "warning",
            message: "A referenced file is missing",
            suggestedAction: "Create the referenced file or remove the reference",
            blocking: false,
            location: { pathDisplay: "~/project/AGENTS.md", line: 1 },
          },
        ],
        redactions: [{ pointer: "/items/0/message", reason: "secret" }],
        content:
          "# Diagnostic report\n\n- warning MISSING_REFERENCE: A referenced file is missing\n",
      }),
    "migration.preview": () =>
      Promise.resolve({
        planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
        planHash: hash,
        compatibility: "full",
        fieldLosses: [],
        requiredConfirmations: [],
        changeGroups: [
          {
            groupId: "group-1",
            operation: "create",
            resourceType: "rule",
            sourceAssetId: "asset-1",
            targetRootPathDisplay: ".cursor/rules/AGENTS.mdc",
            targetRootRelativePath: ".cursor/rules/AGENTS.mdc",
            operationCount: 1,
            createCount: 1,
            replaceCount: 0,
            deleteCount: 0,
            generatedFileCount: 1,
            copyCount: 0,
            symlinkCount: 0,
            changedTargetCount: 1,
            targetPathSample: [".cursor/rules/AGENTS.mdc"],
            visibleDetailCount: 1,
            detailsTruncated: false,
          },
        ],
        differenceSummary: {
          addedToTarget: 1,
          overwrittenInTarget: 0,
          unchangedPlannedTargetOutputs: 0,
          conflictsOrWarnings: 0,
          changedGroupCount: 1,
          changedFileCount: 1,
        },
        changes: [
          {
            groupId: "group-1",
            operation: "create",
            deploymentType: "generated_file",
            pathDisplay: ".cursor/rules/AGENTS.mdc",
            beforeHash: null,
            afterHash: hash,
            diff: "+ Use local conventions.",
          },
        ],
        changesTruncated: false,
        changeDetailLimit: 50,
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
    "history.get": () =>
      Promise.resolve({
        entry: {
          id: "deployment-1",
          kind: "deployment",
          status: "succeeded",
          createdAt: now,
        },
        plan: {
          planId: "deployment-plan-1",
          planHash: hash,
          requiredConfirmations: [],
        },
        changeGroups: [
          {
            groupId: "group-1",
            operation: "create",
            resourceType: "rule",
            sourceAssetId: "asset-1",
            targetRootPathDisplay: ".cursor/rules/AGENTS.mdc",
            targetRootRelativePath: ".cursor/rules/AGENTS.mdc",
            operationCount: 1,
            createCount: 1,
            replaceCount: 0,
            deleteCount: 0,
            generatedFileCount: 1,
            copyCount: 0,
            symlinkCount: 0,
            changedTargetCount: 1,
            targetPathSample: [".cursor/rules/AGENTS.mdc"],
            visibleDetailCount: 1,
            detailsTruncated: false,
          },
        ],
        differenceSummary: {
          addedToTarget: 1,
          overwrittenInTarget: 0,
          unchangedPlannedTargetOutputs: 0,
          conflictsOrWarnings: 0,
          changedGroupCount: 1,
          changedFileCount: 1,
        },
        changes: [
          {
            groupId: "group-1",
            operation: "create",
            deploymentType: "generated_file",
            pathDisplay: ".cursor/rules/AGENTS.mdc",
            beforeHash: null,
            afterHash: hash,
            diff: "+ Use local conventions.",
          },
        ],
        changesTruncated: false,
        changeDetailLimit: 50,
      }),
    "settings.get": () =>
      Promise.resolve({
        values: { pathDisplay: "abbreviated", fileWatching: true },
        revision: 1,
        readOnlyRecovery: false,
      }),
    "settings.clearLocalData": () =>
      Promise.resolve({
        clearedAt: now,
        categories: ["scan_cache"],
        counts: {
          scanRuns: 0,
          projects: 0,
          scopes: 0,
          assets: 0,
          diagnostics: 0,
          deploymentRecords: 0,
          deploymentOperations: 0,
          settings: 0,
          localHistoryDirectories: 0,
        },
        retained: {
          databaseBackups: true,
          deploymentBackups: true,
          disabledAssets: true,
        },
        requiresRestart: false,
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
  it("maps scan to scan.start and prints a CLI JSON envelope with final status", async () => {
    const calls: unknown[] = [];
    const statusCalls: unknown[] = [];
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
          "scan.status": (payload) => {
            statusCalls.push(payload);
            return Promise.resolve({
              taskId: TaskIdSchema.parse("task-1"),
              status: "succeeded",
              phase: "completed",
              progress: { phase: "completed", completed: 1, total: 1, unit: "items" },
              resultSummary: {
                succeededCount: 1,
                failedCount: 0,
                skippedCount: 0,
                diagnosticIds: [],
              },
              lastSequence: 2,
              cancellable: false,
              startedAt: now,
              finishedAt: now,
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
    expect(statusCalls).toEqual([{ taskId: "task-1" }]);
    expect(JSON.parse(output.join(""))).toMatchObject({
      schemaVersion: 1,
      command: "scan",
      ok: true,
      data: { taskId: "task-1", status: "succeeded", phase: "completed" },
      meta: { partialSuccess: false },
    });
  });

  it("maps incremental scan changed paths to scan.start", async () => {
    const calls: unknown[] = [];
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
        stdout: () => undefined,
        stderr: () => undefined,
      }),
      [
        "scan",
        "/workspace/project",
        "--mode",
        "incremental",
        "--changed-path",
        "/workspace/project/AGENTS.md",
        "--changed-path",
        "/workspace/project/.codex/config.toml",
        "--json",
      ],
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(calls).toEqual([
      {
        mode: "incremental",
        roots: ["/workspace/project"],
        changedPaths: ["/workspace/project/AGENTS.md", "/workspace/project/.codex/config.toml"],
      },
    ]);
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
      ["assets", "--tool", "codex"],
      ["assets", "get", "asset-1"],
      ["assets", "disable", "asset-1", "--method", "hub_ignore"],
      ["assets", "enable", "asset-1"],
      ["effective", "--tool", "codex", "--project", "project-1", "--scope", "scope-1"],
      ["diagnose", "--severity", "warning", "--code", "UNRESOLVED_SKILL_REFERENCE"],
      ["diagnose", "export", "--tool", "codex", "--severity", "warning", "--format", "markdown"],
      ["migrate", "--dry-run", "--asset", "asset-1", "--to", "cursor", "--scope", "scope-1"],
      [
        "deploy",
        "--plan",
        "deployment-plan-1",
        "--plan-hash",
        hash,
        "--confirm",
        "overwrite",
        "--yes",
      ],
      ["rollback", "deployment-1", "--yes"],
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
      "assets.disable",
      "assets.enable",
      "effective.resolve",
      "diagnostics.list",
      "diagnostics.export",
      "migration.preview",
      "deployment.execute",
      "history.get",
      "deployment.rollback",
      "history.get",
      "history.list",
    ]);
    const diagnoseCall = calls.find((call) => call.startsWith("diagnostics.list:"));
    if (diagnoseCall === undefined) throw new Error("Expected diagnostics.list call");
    expect(JSON.parse(diagnoseCall.slice("diagnostics.list:".length))).toEqual({
      severities: ["warning"],
      codes: ["UNRESOLVED_SKILL_REFERENCE"],
      limit: 50,
    });
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
    const exportCall = calls.find((call) => call.startsWith("diagnostics.export:"));
    if (exportCall === undefined) throw new Error("Expected diagnostics.export call");
    expect(JSON.parse(exportCall.slice("diagnostics.export:".length))).toEqual({
      format: "markdown",
      toolKeys: ["codex"],
      severities: ["warning"],
    });
  });

  it("maps asset disable and enable commands to status-changing API calls", async () => {
    const calls: unknown[] = [];
    const output: string[] = [];
    const programOptions = {
      services: services({
        "assets.disable": (payload) => {
          calls.push({ command: "disable", payload });
          return Promise.resolve({ assetId: AssetIdSchema.parse("asset-1"), status: "disabled" });
        },
        "assets.enable": (payload) => {
          calls.push({ command: "enable", payload });
          return Promise.resolve({ assetId: AssetIdSchema.parse("asset-1"), status: "enabled" });
        },
      }),
      stdout: (text: string) => output.push(text),
      stderr: () => undefined,
    };

    const disabled = await runCli(createCliProgram(programOptions), [
      "assets",
      "disable",
      "asset-1",
      "--method",
      "hub_ignore",
      "--json",
    ]);
    const enabled = await runCli(createCliProgram(programOptions), ["assets", "enable", "asset-1"]);

    expect(disabled).toEqual({ exitCode: 0 });
    expect(enabled).toEqual({ exitCode: 0 });
    expect(calls).toEqual([
      { command: "disable", payload: { assetId: "asset-1", method: "hub_ignore" } },
      { command: "enable", payload: { assetId: "asset-1" } },
    ]);
    expect(JSON.parse(output[0] ?? "")).toMatchObject({
      command: "assets.disable",
      data: { assetId: "asset-1", status: "disabled" },
    });
    expect(output.join("")).toContain("asset-1 enabled");
  });

  it("returns a failed CLI JSON envelope and validation exit code for invalid command payloads", async () => {
    const output: string[] = [];
    const result = await runCli(
      createCliProgram({
        services: services(),
        stdout: (text) => output.push(text),
        stderr: () => undefined,
      }),
      ["assets", "list", "--limit", "201", "--json"],
    );

    expect(result).toEqual({ exitCode: 2 });
    expect(JSON.parse(output.join(""))).toMatchObject({
      schemaVersion: 1,
      command: "assets.list",
      ok: false,
      error: { code: "VALIDATION_FAILED" },
      meta: { partialSuccess: false },
    });
  });

  it("wraps invalid invoke JSON without leaking a stack trace", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const result = await runCli(
      createCliProgram({
        services: services(),
        stdout: (text) => output.push(text),
        stderr: (text) => errors.push(text),
      }),
      ["invoke", "scan.start", "--payload", "not-json", "--json"],
    );

    expect(result).toEqual({ exitCode: 2 });
    expect(errors.join("")).toBe("");
    expect(output.join("")).not.toContain("SyntaxError");
    expect(JSON.parse(output.join(""))).toMatchObject({
      schemaVersion: 1,
      command: "invoke",
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("requires migrate --dry-run so preview is explicit", async () => {
    const output: string[] = [];
    const result = await runCli(
      createCliProgram({
        services: services(),
        stdout: (text) => output.push(text),
        stderr: () => undefined,
      }),
      ["migrate", "--asset", "asset-1", "--to", "cursor", "--scope", "scope-1", "--json"],
    );

    expect(result).toEqual({ exitCode: 2 });
    expect(JSON.parse(output.join(""))).toMatchObject({
      command: "migrate",
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("requires --yes before non-interactive deployment and rollback", async () => {
    const output: string[] = [];
    const program = createCliProgram({
      services: services(),
      stdout: (text) => output.push(text),
      stderr: () => undefined,
    });

    const deploy = await runCli(program, [
      "deploy",
      "--plan",
      "deployment-plan-1",
      "--plan-hash",
      hash,
      "--json",
    ]);
    const rollback = await runCli(
      createCliProgram({
        services: services(),
        stdout: (text) => output.push(text),
        stderr: () => undefined,
      }),
      ["rollback", "deployment-1", "--json"],
    );

    expect(deploy).toEqual({ exitCode: 4 });
    expect(rollback).toEqual({ exitCode: 4 });
    const parsedOutput = output.map((text): unknown => JSON.parse(text) as unknown);
    expect(parsedOutput).toMatchObject([
      {
        command: "deploy",
        ok: false,
        error: { code: "USER_CANCELLED" },
      },
      {
        command: "rollback",
        ok: false,
        error: { code: "USER_CANCELLED" },
      },
    ]);
  });

  it("prints useful text summaries for list commands", async () => {
    const output: string[] = [];
    const result = await runCli(
      createCliProgram({
        services: services(),
        stdout: (text) => output.push(text),
        stderr: () => undefined,
      }),
      ["assets"],
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(output.join("")).toContain("asset-1");
    expect(output.join("")).toContain("codex");
    expect(output.join("")).toContain("AGENTS.md");
    expect(output.join("")).toContain("warnings:1");
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

  it("prints migration preview metadata as a readable text summary", async () => {
    const output: string[] = [];
    const result = await runCli(
      createCliProgram({
        services: services({
          "migration.preview": () =>
            Promise.resolve({
              planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
              planHash: hash,
              compatibility: "partial",
              fieldLosses: [
                {
                  assetId: AssetIdSchema.parse("asset-1"),
                  droppedFields: ["/data/extensions", "/data/allowedTools"],
                  retainedFields: ["/kind", "/data/name", "/data/instructions"],
                  transformedFields: [],
                  warnings: ["Some source fields are not expressible in the target format."],
                },
              ],
              requiredConfirmations: ["partial_conversion", "overwrite"],
              changeGroups: [
                {
                  groupId: "group-1",
                  operation: "replace",
                  resourceType: "rule",
                  sourceAssetId: AssetIdSchema.parse("asset-1"),
                  targetRootPathDisplay: ".cursor/rules/AGENTS.mdc",
                  targetRootRelativePath: ".cursor/rules/AGENTS.mdc",
                  operationCount: 1,
                  createCount: 0,
                  replaceCount: 1,
                  deleteCount: 0,
                  generatedFileCount: 1,
                  copyCount: 0,
                  symlinkCount: 0,
                  changedTargetCount: 1,
                  targetPathSample: [".cursor/rules/AGENTS.mdc"],
                  visibleDetailCount: 1,
                  detailsTruncated: false,
                },
              ],
              differenceSummary: {
                addedToTarget: 0,
                overwrittenInTarget: 1,
                unchangedPlannedTargetOutputs: 0,
                conflictsOrWarnings: 1,
                changedGroupCount: 1,
                changedFileCount: 1,
              },
              changes: [
                {
                  groupId: "group-1",
                  operation: "replace",
                  deploymentType: "generated_file",
                  pathDisplay: ".cursor/rules/AGENTS.mdc",
                  beforeHash: hash,
                  afterHash: hash,
                  diff: "- Old\n+ Use local conventions.",
                },
              ],
              changesTruncated: false,
              changeDetailLimit: 50,
              warnings: [],
              sourceHashes: { "asset-1": hash },
              targetHashes: { ".cursor/rules/AGENTS.mdc": hash },
              expiresAt: now,
            }),
        }),
        stdout: (text) => output.push(text),
        stderr: () => undefined,
      }),
      ["migrate", "--dry-run", "--source", "asset-1", "--target", "cursor", "--scope", "scope-1"],
    );

    const text = output.join("");
    expect(result).toEqual({ exitCode: 0 });
    expect(text).toContain("Plan deployment-plan-1");
    expect(text).toContain("Compatibility: partial");
    expect(text).toContain("Required confirmations: partial_conversion, overwrite");
    expect(text).toContain("Expires: 2026-06-24T08:00:00.000Z");
    expect(text).toContain("Plan hash: sha256:");
    expect(text).toContain("Source hashes (1):");
    expect(text).toContain("  asset-1: sha256:");
    expect(text).toContain("Target hashes (1):");
    expect(text).toContain("  .cursor/rules/AGENTS.mdc: sha256:");
    expect(text).toContain("Field loss asset-1: dropped /data/extensions, /data/allowedTools");
    expect(text).toContain("replace .cursor/rules/AGENTS.mdc");
    expect(text.indexOf("replace .cursor/rules/AGENTS.mdc")).toBeLessThan(
      text.indexOf("Source hashes (1):"),
    );
    expect(text).toContain("- Old");
    expect(text).toContain("+ Use local conventions.");
  });

  it("prints bounded hash samples for large migration previews", async () => {
    const output: string[] = [];
    const result = await runCli(
      createCliProgram({
        services: services({
          "migration.preview": () =>
            Promise.resolve({
              planId: DeploymentPlanIdSchema.parse("deployment-plan-1"),
              planHash: hash,
              compatibility: "full",
              fieldLosses: [],
              requiredConfirmations: [],
              changeGroups: [
                {
                  groupId: "group-1",
                  operation: "create",
                  resourceType: "rule",
                  targetRootPathDisplay: ".cursor/rules/AGENTS.mdc",
                  targetRootRelativePath: ".cursor/rules/AGENTS.mdc",
                  operationCount: 1,
                  createCount: 1,
                  replaceCount: 0,
                  deleteCount: 0,
                  generatedFileCount: 1,
                  copyCount: 0,
                  symlinkCount: 0,
                  changedTargetCount: 1,
                  targetPathSample: [".cursor/rules/AGENTS.mdc"],
                  visibleDetailCount: 1,
                  detailsTruncated: false,
                },
              ],
              differenceSummary: {
                addedToTarget: 1,
                overwrittenInTarget: 0,
                unchangedPlannedTargetOutputs: 0,
                conflictsOrWarnings: 0,
                changedGroupCount: 1,
                changedFileCount: 1,
              },
              changes: [
                {
                  groupId: "group-1",
                  operation: "create",
                  deploymentType: "generated_file",
                  pathDisplay: ".cursor/rules/AGENTS.mdc",
                  beforeHash: null,
                  afterHash: hash,
                  diff: "+ Use local conventions.",
                },
              ],
              changesTruncated: false,
              changeDetailLimit: 50,
              warnings: [],
              sourceHashes: sourceHashes(22),
              targetHashes: targetHashes(21),
              expiresAt: now,
            }),
        }),
        stdout: (text) => output.push(text),
        stderr: () => undefined,
      }),
      ["migrate", "--dry-run", "--source", "asset-1", "--target", "cursor", "--scope", "scope-1"],
    );

    const text = output.join("");
    expect(result).toEqual({ exitCode: 0 });
    expect(text).toContain("Source hashes (22):");
    expect(text).toContain("  asset-020: sha256:");
    expect(text).not.toContain("asset-021: sha256:");
    expect(text).toContain("  ... 2 more");
    expect(text).toContain("Target hashes (21):");
    expect(text).toContain("  target-020.mdc: sha256:");
    expect(text).not.toContain("target-021.mdc: sha256:");
    expect(text).toContain("  ... 1 more");
  });

  it("prints a redacted diagnostic report in text mode", async () => {
    const output: string[] = [];
    const result = await runCli(
      createCliProgram({
        services: services({
          "diagnostics.export": () =>
            Promise.resolve({
              format: "markdown",
              generatedAt: now,
              filters: { toolKeys: ["codex"], severities: ["warning"] },
              summary: { total: 1, info: 0, warning: 1, error: 0 },
              items: [
                {
                  id: DiagnosticIdSchema.parse("diagnostic-1"),
                  code: "MISSING_REFERENCE",
                  severity: "warning",
                  message: "A referenced file is missing; token=[REDACTED]",
                  suggestedAction: "Create the referenced file or remove the reference",
                  blocking: false,
                  location: { pathDisplay: "~/project/AGENTS.md", line: 1 },
                },
              ],
              redactions: [{ pointer: "/items/0/message", reason: "secret" }],
              content:
                "# Diagnostic report\n\n- warning MISSING_REFERENCE ~/project/AGENTS.md:1 A referenced file is missing; token=[REDACTED]\n",
            }),
        }),
        stdout: (text) => output.push(text),
        stderr: () => undefined,
      }),
      ["diagnose", "export", "--format", "markdown", "--tool", "codex", "--severity", "warning"],
    );

    const text = output.join("");
    expect(result).toEqual({ exitCode: 0 });
    expect(text).toContain("# Diagnostic report");
    expect(text).toContain("~/project/AGENTS.md");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("/Users/alice/project/AGENTS.md");
    expect(text).not.toContain("sk-live-secret");
  });
});

function sourceHashes(count: number): MigrationPreviewResponse["sourceHashes"] {
  const hashes: MigrationPreviewResponse["sourceHashes"] = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      AssetIdSchema.parse(`asset-${String(index + 1).padStart(3, "0")}`),
      hash,
    ]),
  );
  return hashes;
}

function targetHashes(count: number): MigrationPreviewResponse["targetHashes"] {
  const hashes: MigrationPreviewResponse["targetHashes"] = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `target-${String(index + 1).padStart(3, "0")}.mdc`,
      hash,
    ]),
  );
  return hashes;
}
