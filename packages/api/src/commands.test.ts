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
      "assets.disable",
      "assets.enable",
      "assets.get",
      "assets.list",
      "assets.openSource",
      "deployment.execute",
      "deployment.rollback",
      "diagnostics.export",
      "diagnostics.list",
      "effective.resolve",
      "history.get",
      "history.list",
      "migration.preview",
      "scan.cancel",
      "scan.start",
      "scan.status",
      "settings.clearLocalData",
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
    expect(
      CommandRequestSchemas["scan.start"].safeParse({
        mode: "full",
        clientContext: "migration-source",
      }).success,
    ).toBe(true);
    expect(
      CommandRequestSchemas["scan.start"].safeParse({ mode: "full", clientContext: "unknown" })
        .success,
    ).toBe(false);
  });

  it("requires asset disable requests to declare the selected disablement method", () => {
    expect(CommandRequestSchemas["assets.disable"].safeParse({ assetId: "asset-1" }).success).toBe(
      false,
    );
    expect(
      CommandRequestSchemas["assets.disable"].safeParse({
        assetId: "asset-1",
        method: "move_file",
      }).success,
    ).toBe(true);
    expect(
      CommandRequestSchemas["assets.disable"].safeParse({
        assetId: "asset-1",
        method: "rename_randomly",
      }).success,
    ).toBe(false);
    expect(CommandRequestSchemas["assets.enable"].safeParse({ assetId: "asset-1" }).success).toBe(
      true,
    );
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

  it("accepts file source summaries in asset list responses", () => {
    expect(
      CommandResponseSchemas["assets.list"].safeParse({
        items: [
          {
            id: "asset-1",
            toolKey: "codex",
            resourceType: "rule",
            scopeKind: "project",
            logicalKey: "rule:AGENTS",
            sourceDirectory: "/workspace/project",
            sourceSummary: {
              kind: "file",
              fileName: "AGENTS.md",
              mediaType: "text/markdown",
              isText: true,
            },
            contentHash: hash,
            status: "enabled",
            diagnosticCounts: { info: 0, warning: 0, error: 0 },
          },
        ],
        nextCursor: null,
        snapshotRevision: "revision-1",
        stale: false,
      }).success,
    ).toBe(true);
  });

  it("accepts package source summaries in asset detail responses", () => {
    expect(
      CommandResponseSchemas["assets.get"].safeParse({
        asset: {
          id: "asset-1",
          toolKey: "codex",
          resourceType: "skill",
          scopeId: "scope-1",
          logicalKey: "skill:release",
          status: "enabled",
          disablementOptions: [],
        },
        source: {
          pathDisplay: "/workspace/project/.agents/skills/release/SKILL.md",
          contentHash: hash,
          observedAt: now,
          sourceSummary: {
            kind: "package",
            rootName: "release",
            fileCount: 2,
            folderCount: 1,
            textCount: 2,
            binaryCount: 0,
            roleCounts: {
              primary: 1,
              metadata: 0,
              support: 1,
            },
          },
          files: [
            {
              pathDisplay: "/workspace/project/.agents/skills/release/SKILL.md",
              relativePath: "SKILL.md",
              role: "primary",
              mediaType: "text/markdown",
              isText: true,
              contentHash: hash,
            },
            {
              pathDisplay: "/workspace/project/.agents/skills/release/assets/notes.md",
              relativePath: "assets/notes.md",
              role: "support",
              mediaType: "text/markdown",
              isText: true,
              contentHash: hash,
            },
          ],
        },
        redactions: [],
      }).success,
    ).toBe(true);
  });

  it("limits history records to supported deployment record kinds", () => {
    expect(
      CommandRequestSchemas["history.list"].safeParse({
        kinds: ["deployment", "rollback"],
        taskId: "task-1",
        projectId: "project-1",
        snapshotRevision: "42",
      }).success,
    ).toBe(true);
    expect(CommandRequestSchemas["history.list"].safeParse({ kinds: ["scan"] }).success).toBe(
      false,
    );
    expect(
      CommandResponseSchemas["history.list"].safeParse({
        items: [{ id: "scan-1", kind: "scan", status: "succeeded", createdAt: now }],
        nextCursor: null,
        snapshotRevision: "42",
      }).success,
    ).toBe(false);
    expect(
      CommandResponseSchemas["history.list"].safeParse({ items: [], nextCursor: null }).success,
    ).toBe(false);
  });

  it("uses stable, versioned IPC channels", () => {
    expect(commandChannel("scan.start")).toBe("ai-config-hub:v1:scan.start");
  });

  it("validates diagnostic export time windows by instant", () => {
    expect(
      CommandRequestSchemas["diagnostics.export"].safeParse({
        format: "markdown",
        from: "2026-06-28T18:00:00+08:00",
        to: "2026-06-28T11:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      CommandRequestSchemas["diagnostics.export"].safeParse({
        format: "markdown",
        from: "2026-06-28T12:00:00.000Z",
        to: "2026-06-28T18:00:00+08:00",
      }).success,
    ).toBe(false);
  });

  it("accepts language alongside theme in public settings commands", () => {
    expect(
      CommandRequestSchemas["settings.get"].safeParse({ keys: ["theme", "language"] }).success,
    ).toBe(true);
    expect(
      CommandRequestSchemas["settings.update"].safeParse({
        patch: { theme: "dark", language: "zh-CN" },
        expectedRevision: 1,
      }).success,
    ).toBe(true);
    expect(
      CommandRequestSchemas["settings.update"].safeParse({
        patch: { language: "fr-FR" },
        expectedRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      CommandResponseSchemas["settings.get"].safeParse({
        values: { theme: "system", language: "en" },
        revision: 1,
        readOnlyRecovery: false,
      }).success,
    ).toBe(true);
  });

  it("requires explicit confirmation and unique categories before clearing local data", () => {
    const schema =
      CommandRequestSchemas["settings.clearLocalData" as keyof typeof CommandRequestSchemas];
    expect(
      schema.safeParse({
        categories: ["scan_cache", "settings"],
        confirmation: "clear-local-data",
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ categories: [], confirmation: "clear-local-data" }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        categories: ["scan_cache", "scan_cache"],
        confirmation: "clear-local-data",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        categories: ["scan_cache"],
        confirmation: "delete-everything",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        categories: ["source_configs"],
        confirmation: "clear-local-data",
      }).success,
    ).toBe(false);
  });

  it("validates a request and response fixture for every command", () => {
    const requests: Record<string, unknown> = {
      "scan.start": { mode: "full" },
      "scan.status": { taskId: "task-1" },
      "scan.cancel": { taskId: "task-1" },
      "assets.list": {},
      "assets.get": { assetId: "asset-1" },
      "assets.openSource": { assetId: "asset-1" },
      "assets.disable": { assetId: "asset-1", method: "move_file" },
      "assets.enable": { assetId: "asset-1" },
      "effective.resolve": {
        toolKey: "codex",
        projectId: "project-1",
        targetScopeId: "scope-1",
      },
      "diagnostics.list": {},
      "diagnostics.export": {
        format: "markdown",
        taskId: "task-1",
        toolKeys: ["codex"],
        severities: ["warning"],
        from: now,
        to: now,
      },
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
      "history.get": { id: "deployment-1" },
      "settings.get": {},
      "settings.clearLocalData": {
        categories: ["scan_cache", "deployment_history", "settings"],
        confirmation: "clear-local-data",
      },
      "settings.update": { patch: { theme: "dark", language: "zh-CN" }, expectedRevision: 1 },
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
            sourceSummary: {
              kind: "file",
              fileName: "AGENTS.md",
              mediaType: "text/markdown",
              isText: true,
            },
            contentHash: hash,
            status: "enabled",
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
          status: "enabled",
          disablementOptions: [
            {
              method: "move_file",
              label: "Move file out of the tool load path",
              description: "Move the source file into the AI Config Hub disabled-assets area.",
              recommended: true,
            },
            {
              method: "hub_ignore",
              label: "Ignore inside AI Config Hub only",
              description: "Keep the tool configuration unchanged and ignore the asset in Hub.",
              recommended: false,
            },
          ],
          normalized: { kind: "rule", instructions: "redacted view" },
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
      },
      "assets.openSource": { assetId: "asset-1", opened: true },
      "assets.disable": { assetId: "asset-1", status: "disabled" },
      "assets.enable": { assetId: "asset-1", status: "enabled" },
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
      "diagnostics.export": {
        format: "markdown",
        generatedAt: now,
        filters: {
          taskId: "task-1",
          toolKeys: ["codex"],
          severities: ["warning"],
          from: now,
          to: now,
        },
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
      },
      "migration.preview": {
        planId: "plan-1",
        planHash: hash,
        compatibility: "full",
        fieldLosses: [],
        changeGroups: [
          {
            groupId: "group-1",
            operation: "create",
            resourceType: "rule",
            sourceAssetId: "asset-1",
            targetRootPathDisplay: ".cursor/rules/repository-policy.mdc",
            targetRootRelativePath: ".cursor/rules/repository-policy.mdc",
            operationCount: 1,
            createCount: 1,
            replaceCount: 0,
            deleteCount: 0,
            generatedFileCount: 1,
            copyCount: 0,
            symlinkCount: 0,
            changedTargetCount: 1,
            targetPathSample: [".cursor/rules/repository-policy.mdc"],
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
            pathDisplay: ".cursor/rules/repository-policy.mdc",
            beforeHash: null,
            afterHash: hash,
            diff: "+ content",
          },
        ],
        changesTruncated: false,
        changeDetailLimit: 50,
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
        snapshot: {
          status: "recorded",
          commitId: "abc123",
          authoredAt: now,
          message: "record deployment deployment-1",
        },
      },
      "deployment.rollback": {
        taskId: "task-1",
        rollbackId: "rollback-1",
        status: "queued",
        acceptedAt: now,
        snapshot: {
          status: "failed",
          error: {
            code: "CONFLICT",
            message: "Local history snapshot contains unlisted working-tree changes",
          },
        },
      },
      "history.list": {
        items: [
          {
            id: "deployment-1",
            kind: "deployment",
            status: "succeeded",
            createdAt: now,
            snapshot: {
              status: "recorded",
              commitId: "abc123",
              authoredAt: now,
              message: "record deployment deployment-1",
            },
          },
          {
            id: "deployment-2",
            kind: "deployment",
            status: "succeeded",
            createdAt: now,
            snapshot: { status: "missing" },
          },
          {
            id: "rollback-1",
            kind: "rollback",
            status: "succeeded",
            createdAt: now,
            snapshot: {
              status: "unavailable",
              error: { code: "INTERNAL_ERROR", message: "Git history could not be read" },
            },
          },
        ],
        nextCursor: null,
        snapshotRevision: "42",
      },
      "history.get": {
        entry: {
          id: "deployment-1",
          kind: "deployment",
          status: "succeeded",
          createdAt: now,
          finishedAt: now,
          snapshot: {
            status: "recorded",
            commitId: "abc123",
            authoredAt: now,
            message: "record deployment deployment-1",
          },
        },
        plan: {
          planId: "plan-1",
          planHash: hash,
          requiredConfirmations: ["overwrite"],
        },
        changeGroups: [
          {
            groupId: "group-1",
            operation: "replace",
            resourceType: "rule",
            sourceAssetId: "asset-1",
            targetRootPathDisplay: ".cursor/rules/repository-policy.mdc",
            targetRootRelativePath: ".cursor/rules/repository-policy.mdc",
            operationCount: 1,
            createCount: 0,
            replaceCount: 1,
            deleteCount: 0,
            generatedFileCount: 1,
            copyCount: 0,
            symlinkCount: 0,
            changedTargetCount: 1,
            targetPathSample: [".cursor/rules/repository-policy.mdc"],
            visibleDetailCount: 1,
            detailsTruncated: false,
          },
        ],
        differenceSummary: {
          addedToTarget: 0,
          overwrittenInTarget: 1,
          unchangedPlannedTargetOutputs: 0,
          conflictsOrWarnings: 0,
          changedGroupCount: 1,
          changedFileCount: 1,
        },
        changes: [
          {
            groupId: "group-1",
            operation: "replace",
            deploymentType: "generated_file",
            pathDisplay: ".cursor/rules/repository-policy.mdc",
            beforeHash: hash,
            afterHash: hash,
            diff: "- old\n+ new",
          },
        ],
        changesTruncated: false,
        changeDetailLimit: 50,
      },
      "settings.get": {
        values: { theme: "system", language: "system" },
        revision: 1,
        readOnlyRecovery: false,
      },
      "settings.clearLocalData": {
        clearedAt: now,
        categories: ["scan_cache", "deployment_history", "settings"],
        counts: {
          scanRuns: 1,
          projects: 1,
          scopes: 1,
          assets: 1,
          diagnostics: 1,
          deploymentRecords: 1,
          deploymentOperations: 1,
          settings: 1,
          localHistoryDirectories: 1,
        },
        retained: {
          databaseBackups: true,
          deploymentBackups: true,
          disabledAssets: true,
        },
        requiresRestart: false,
      },
      "settings.update": {
        values: { theme: "dark", language: "zh-CN" },
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

  it("exposes structured field loss details in migration previews", () => {
    expect(
      CommandResponseSchemas["migration.preview"].safeParse({
        planId: "plan-1",
        planHash: hash,
        compatibility: "partial",
        fieldLosses: [
          {
            assetId: "asset-1",
            droppedFields: ["/data/extensions", "/data/allowedTools"],
            retainedFields: ["/kind", "/data/name", "/data/instructions"],
            transformedFields: [
              {
                sourceField: "/data/globs",
                targetField: "/frontmatter/globs",
                reason: "Cursor stores rule globs in frontmatter.",
              },
            ],
            warnings: ["Some source fields are not expressible in the target format."],
          },
        ],
        changeGroups: [
          {
            groupId: "group-1",
            operation: "replace",
            resourceType: "rule",
            sourceAssetId: "asset-1",
            targetRootPathDisplay: ".cursor/rules/repository-policy.mdc",
            targetRootRelativePath: ".cursor/rules/repository-policy.mdc",
            operationCount: 1,
            createCount: 0,
            replaceCount: 1,
            deleteCount: 0,
            generatedFileCount: 1,
            copyCount: 0,
            symlinkCount: 0,
            changedTargetCount: 1,
            targetPathSample: [".cursor/rules/repository-policy.mdc"],
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
            pathDisplay: ".cursor/rules/repository-policy.mdc",
            beforeHash: hash,
            afterHash: hash,
            diff: "- old\n+ new",
          },
        ],
        changesTruncated: false,
        changeDetailLimit: 50,
        requiredConfirmations: ["partial_conversion", "overwrite"],
        warnings: [],
        sourceHashes: { "asset-1": hash },
        targetHashes: { ".cursor/rules/repository-policy.mdc": hash },
        expiresAt: now,
      }).success,
    ).toBe(true);
  });

  it("accepts grouped migration preview summaries with bounded file details", () => {
    expect(
      CommandResponseSchemas["migration.preview"].safeParse({
        planId: "plan-1",
        planHash: hash,
        compatibility: "full",
        fieldLosses: [],
        changeGroups: [
          {
            groupId: "group:asset-1:skill:.agents/skills/release",
            operation: "mixed",
            resourceType: "skill",
            sourceAssetId: "asset-1",
            targetRootPathDisplay: "/project/.agents/skills/release",
            targetRootRelativePath: ".agents/skills/release",
            operationCount: 2,
            createCount: 1,
            replaceCount: 1,
            deleteCount: 0,
            generatedFileCount: 1,
            copyCount: 1,
            symlinkCount: 0,
            changedTargetCount: 2,
            targetPathSample: [
              ".agents/skills/release/SKILL.md",
              ".agents/skills/release/assets/logo.png",
            ],
            packageOutputCount: 203,
            packagePathSample: [
              ".agents/skills/release/SKILL.md",
              ".agents/skills/release/assets/logo.png",
            ],
            visibleDetailCount: 1,
            detailsTruncated: true,
          },
        ],
        differenceSummary: {
          addedToTarget: 1,
          overwrittenInTarget: 1,
          unchangedPlannedTargetOutputs: 201,
          conflictsOrWarnings: 0,
          changedGroupCount: 1,
          changedFileCount: 2,
        },
        changes: [
          {
            groupId: "group:asset-1:skill:.agents/skills/release",
            operation: "create",
            deploymentType: "copy",
            pathDisplay: ".agents/skills/release/assets/logo.png",
            sourcePathDisplay: "/project/.codex/skills/release/assets/logo.png",
            beforeHash: null,
            afterHash: hash,
            diff: "",
          },
        ],
        changesTruncated: true,
        changeDetailLimit: 50,
        requiredConfirmations: [],
        warnings: [],
        sourceHashes: { "asset-1": hash },
        targetHashes: { ".agents/skills/release/assets/logo.png": null },
        expiresAt: now,
      }).success,
    ).toBe(true);
  });

  it("accepts source deployment changes without generated text", () => {
    expect(
      CommandResponseSchemas["migration.preview"].safeParse({
        planId: "plan-1",
        planHash: hash,
        compatibility: "full",
        fieldLosses: [],
        changeGroups: [
          {
            groupId: "group-1",
            operation: "create",
            resourceType: "skill",
            sourceAssetId: "asset-1",
            targetRootPathDisplay: ".agents/skills/release/assets/logo.png",
            targetRootRelativePath: ".agents/skills/release/assets/logo.png",
            operationCount: 1,
            createCount: 1,
            replaceCount: 0,
            deleteCount: 0,
            generatedFileCount: 0,
            copyCount: 1,
            symlinkCount: 0,
            changedTargetCount: 1,
            targetPathSample: [".agents/skills/release/assets/logo.png"],
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
            deploymentType: "copy",
            pathDisplay: ".agents/skills/release/assets/logo.png",
            sourcePathDisplay: "/project/.claude/skills/release/assets/logo.png",
            beforeHash: null,
            afterHash: hash,
            diff: "",
          },
        ],
        changesTruncated: false,
        changeDetailLimit: 50,
        requiredConfirmations: [],
        warnings: [],
        sourceHashes: { "asset-1": hash },
        targetHashes: { ".agents/skills/release/assets/logo.png": null },
        expiresAt: now,
      }).success,
    ).toBe(true);
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
