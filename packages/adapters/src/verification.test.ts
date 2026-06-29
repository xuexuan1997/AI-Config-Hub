import { createHash } from "node:crypto";

import { AssetSchema, DeploymentRecordSchema } from "@ai-config-hub/core";
import type {
  Asset,
  DeploymentRecord,
  DeploymentTarget,
  FileSnapshot,
  ParsedAsset,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  ContentHashSchema,
  CorrelationIdSchema,
  DeploymentPlanIdSchema,
  DeploymentRecordIdSchema,
  IsoDateTimeSchema,
  ToolInstallationIdSchema,
  type AbsolutePath,
  type ContentHash,
} from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { claudeCodeRegistration } from "./claude-code.js";
import { codexRegistration } from "./codex.js";
import { cursorRegistration } from "./cursor.js";
import { opencodeRegistration } from "./opencode.js";
import { memoryReadApi, neverCancelled } from "./test-support.js";

const target = AbsolutePathSchema.parse("/project/AGENTS.md");

describe("adapter deployment verification", () => {
  it("passes when written targets match deployment result hashes", async () => {
    const text = "Use local TypeScript conventions.\n";
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });

    const result = await adapter.verify({
      deployment: record({
        operations: [
          {
            kind: "create",
            targetPath: target,
            expectedTargetHash: "absent",
            nextText: text,
            deploymentType: "generated_file",
            targetResourceKind: "rule",
          },
        ],
        resultingHashes: { [target]: hash(text) },
      }),
      target: deploymentTarget(),
      read: memoryReadApi({ [target]: text }),
      signal: neverCancelled,
    });

    expect(result.status).toBe("passed");
    expect(result.verifiedHashes[target]).toBe(hash(text));
    expect(result.diagnostics).toEqual([]);
  });

  it("fails when written target content drifts after deployment", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });

    const result = await adapter.verify({
      deployment: record({
        operations: [
          {
            kind: "replace",
            targetPath: target,
            expectedTargetHash: hash("old\n"),
            nextText: "new\n",
            deploymentType: "generated_file",
          },
        ],
        resultingHashes: { [target]: hash("new\n") },
      }),
      target: deploymentTarget(),
      read: memoryReadApi({ [target]: "edited outside deployer\n" }),
      signal: neverCancelled,
    });

    expect(result.status).toBe("failed");
    expect(result.verifiedHashes[target]).toBe(hash("edited outside deployer\n"));
    expect(result.diagnostics).toMatchObject([
      {
        code: "DEPLOYMENT_TARGET_HASH_MISMATCH",
        blocking: true,
      },
    ]);
  });

  it("passes deleted targets only when the target is absent", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });

    const result = await adapter.verify({
      deployment: record({
        operations: [
          {
            kind: "delete",
            targetPath: target,
            expectedTargetHash: hash("remove me\n"),
            deploymentType: "generated_file",
          },
        ],
        resultingHashes: {},
      }),
      target: deploymentTarget(),
      read: memoryReadApi({}),
      signal: neverCancelled,
    });

    expect(result.status).toBe("passed");
    expect(result.verifiedHashes).toEqual({});
    expect(result.diagnostics).toEqual([]);
  });

  it("fails generated-file verification when the written target hash matches but target parsing rejects", async () => {
    const text = "name = ";
    const agentPath = AbsolutePathSchema.parse("/project/.codex/agents/broken.toml");
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });

    const result = await adapter.verify({
      deployment: record({
        operations: [
          {
            kind: "create",
            targetPath: agentPath,
            expectedTargetHash: "absent",
            nextText: text,
            deploymentType: "generated_file",
            targetResourceKind: "agent",
          },
        ],
        resultingHashes: { [agentPath]: hash(text) },
      }),
      target: deploymentTarget(),
      read: memoryReadApi({ [agentPath]: text }),
      signal: neverCancelled,
    });

    expect(result.status).toBe("failed");
    expect(result.verifiedHashes[agentPath]).toBe(hash(text));
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DEPLOYMENT_TARGET_SEMANTIC_INVALID",
          blocking: true,
          location: { path: agentPath },
        }),
      ]),
    );
  });

  it("passes generated-file verification when the written target reparses as the expected kind", async () => {
    const text = "---\ndescription: Generated rule\nglobs: [src/**/*.ts]\n---\nUse TypeScript.\n";
    const cursorRulePath = AbsolutePathSchema.parse("/project/.cursor/rules/generated.mdc");
    const adapter = cursorRegistration.create({ logger: { debug() {}, warn() {} } });

    const result = await adapter.verify({
      deployment: record({
        adapterId: cursorRegistration.adapterId,
        operations: [
          {
            kind: "replace",
            targetPath: cursorRulePath,
            expectedTargetHash: hash("old\n"),
            nextText: text,
            deploymentType: "generated_file",
            targetResourceKind: "rule",
          },
        ],
        resultingHashes: { [cursorRulePath]: hash(text) },
      }),
      target: { ...deploymentTarget(), tool: { ...deploymentTarget().tool, toolId: "cursor" } },
      read: memoryReadApi({ [cursorRulePath]: text }),
      signal: neverCancelled,
    });

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
  });

  it("fails generated-file verification when the target reparses as a different resource kind", async () => {
    const text = "Use local TypeScript conventions.\n";
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    Object.defineProperty(adapter, "parse", {
      value: () =>
        Promise.resolve({
          status: "parsed" as const,
          assets: [parsedAgentAsset(target, hash(text))],
          diagnostics: [],
        }),
    });

    const result = await adapter.verify({
      deployment: record({
        operations: [
          {
            kind: "create",
            targetPath: target,
            expectedTargetHash: "absent",
            nextText: text,
            deploymentType: "generated_file",
            targetResourceKind: "rule",
          },
        ],
        resultingHashes: { [target]: hash(text) },
      }),
      target: deploymentTarget(),
      read: memoryReadApi({ [target]: text }),
      signal: neverCancelled,
    });

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DEPLOYMENT_TARGET_SEMANTIC_KIND_MISMATCH",
          blocking: true,
          location: { path: target },
        }),
      ]),
    );
  });
});

describe("adapter generated-file deployment planning", () => {
  it("creates generated-file operations for all built-in adapters and resource kinds", async () => {
    const registrations = [
      claudeCodeRegistration,
      codexRegistration,
      cursorRegistration,
      opencodeRegistration,
    ] as const;
    const resources = [
      ruleAsset(),
      agentAsset(),
      skillAsset(),
      mcpAsset(),
    ] as const satisfies readonly Asset[];

    for (const registration of registrations) {
      const adapter = registration.create({ logger: { debug() {}, warn() {} } });
      for (const source of resources) {
        const conversion = await adapter.convert({
          asset: source,
          target: {
            toolId: registration.toolId,
            resourceKind: source.resource.kind,
            targetSchemaVersion: registration.capabilities.writtenSchemaVersion,
          },
          signal: neverCancelled,
        });
        if (conversion.level === "unsupported") {
          throw new Error(`${registration.toolId} did not convert ${source.resource.kind}`);
        }

        const result = await adapter.planDeployment({
          conversion,
          target: deploymentTargetFor(registration.toolId),
          currentTargetSnapshots: new Map(),
          signal: neverCancelled,
        });

        expect(result.diagnostics).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "ADAPTER_WRITE_CAPABILITY_UNAVAILABLE" }),
          ]),
        );
        expect(result.draft).toMatchObject({
          targetToolId: registration.toolId,
          adapterId: registration.adapterId,
          adapterVersion: registration.adapterVersion,
        });
        expect(result.draft.verificationStrategy).toContain(registration.toolId);
        expect(result.draft.operations).toEqual([
          expect.objectContaining({
            kind: "create",
            deploymentType: "generated_file",
            targetResourceKind: source.resource.kind,
            expectedTargetHash: "absent",
          }),
        ]);
      }
    }
  });

  it("skips byte-identical generated outputs", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const source = ruleAsset();
    const conversion = await adapter.convert({
      asset: source,
      target: { toolId: "codex", resourceKind: "rule", targetSchemaVersion: "1.0.0" },
      signal: neverCancelled,
    });
    if (conversion.level === "unsupported") throw new Error("unexpected unsupported conversion");
    const output = conversion.outputs[0];
    if (output === undefined) throw new Error("missing output");
    const targetPath = AbsolutePathSchema.parse(`/project/${output.relativePath}`);

    const result = await adapter.planDeployment({
      conversion,
      target: deploymentTarget(),
      currentTargetSnapshots: new Map([[targetPath, snapshot(targetPath, output.text)]]),
      signal: neverCancelled,
    });

    expect(result.draft.operations).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DEPLOYMENT_TARGETS_ALREADY_IDENTICAL", blocking: false }),
      ]),
    );
  });
});

describe("adapter baseline diagnostics", () => {
  it("warns about duplicate resource locators and unresolved skill references", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });

    const result = await adapter.diagnose({
      tool: deploymentTarget().tool,
      assets: [
        ruleAsset("first", "rule:duplicate", "/project/first.md"),
        ruleAsset("second", "rule:duplicate", "/project/second.md"),
        skillAsset(["missing.md"]),
      ],
      signal: neverCancelled,
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DUPLICATE_RESOURCE_LOCATOR",
          severity: "warning",
          blocking: false,
          location: { path: "/project/second.md" },
        }),
        expect.objectContaining({
          code: "UNRESOLVED_SKILL_REFERENCE",
          severity: "warning",
          blocking: false,
        }),
      ]),
    );
  });

  it("blocks non-deployable MCP secret values", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });

    const result = await adapter.diagnose({
      tool: deploymentTarget().tool,
      assets: [
        mcpAsset({
          kind: "redacted",
          digest: hash("private-token"),
          deployable: false,
        }),
      ],
      signal: neverCancelled,
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MCP_NON_DEPLOYABLE_SECRET",
          severity: "error",
          blocking: true,
        }),
      ]),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain("private-token");
  });

  it("reports content, hierarchy, and MCP literal secret diagnostics", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const active = ruleAsset("active", "rule:active", "/project/active.md");
    const ignored = ruleAsset("ignored", "rule:ignored", "/project/ignored.md");
    const blank = baseAsset("blank", "rule:blank", "/project/blank.md", {
      kind: "rule",
      data: { name: "blank", instructions: "   ", globs: [], extensions: {} },
    });
    const mcp = mcpAsset({ kind: "literal", value: "--api-token=secret-value", deployable: true });

    const result = await adapter.diagnose({
      tool: deploymentTarget().tool,
      assets: [active, ignored, blank, mcp],
      effectiveConfigDraft: {
        canonicalTargetPath: AbsolutePathSchema.parse("/project"),
        resourceKinds: ["rule", "mcp"],
        resolvedResources: [active.resource, mcp.resource],
        contributingAssetIds: [active.assetId, mcp.assetId],
        ignoredAssetIds: [ignored.assetId],
        steps: [
          { action: "inherit", assetId: active.assetId, reason: "Active rule wins" },
          { action: "ignore", assetId: ignored.assetId, reason: "Lower precedence" },
          { action: "inherit", assetId: mcp.assetId, reason: "MCP applies" },
        ],
        resolutionInputHash: hash("resolution"),
      },
      signal: neverCancelled,
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RESOURCE_INSTRUCTIONS_EMPTY",
          severity: "error",
          blocking: true,
          location: { path: "/project/blank.md" },
        }),
        expect.objectContaining({
          code: "RESOURCE_IGNORED_BY_EFFECTIVE_CONFIG",
          severity: "info",
          blocking: false,
          location: { path: "/project/ignored.md" },
        }),
        expect.objectContaining({
          code: "MCP_LITERAL_SECRET_RISK",
          severity: "warning",
          blocking: false,
          location: { path: "/project/mcp.json" },
        }),
      ]),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain("secret-value");
  });

  it("blocks assets that are outside the detected tool configuration roots", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });

    const result = await adapter.diagnose({
      tool: deploymentTarget().tool,
      assets: [ruleAsset("outside", "rule:outside", "/outside/AGENTS.md")],
      signal: neverCancelled,
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RESOURCE_OUTSIDE_CONFIG_ROOT",
          severity: "error",
          blocking: true,
          location: { path: "/outside/AGENTS.md" },
        }),
      ]),
    );
  });
});

function record(input: {
  readonly operations: DeploymentRecord["operations"];
  readonly resultingHashes: DeploymentRecord["resultingHashes"];
  readonly adapterId?: DeploymentRecord["adapterId"];
}): DeploymentRecord {
  return DeploymentRecordSchema.parse({
    deploymentRecordId: DeploymentRecordIdSchema.parse("deployment-record:test"),
    deploymentPlanId: DeploymentPlanIdSchema.parse("deployment-plan:test"),
    status: "verifying",
    operations: input.operations,
    backupLocations: Object.fromEntries(
      input.operations.map((operation) => [operation.targetPath, "previously-absent"]),
    ),
    resultingHashes: input.resultingHashes,
    verificationResult: { status: "not_started", diagnostics: [] },
    rollbackResults: [],
    adapterId: input.adapterId ?? codexRegistration.adapterId,
    adapterVersion: codexRegistration.adapterVersion,
    normalizedSchemaVersion: "1.0.0",
    createdAt: "2026-06-21T08:00:00.000Z",
    confirmedAt: "2026-06-21T08:00:01.000Z",
    confirmedPlanHash: hash("plan"),
    startedAt: "2026-06-21T08:00:02.000Z",
    correlationId: CorrelationIdSchema.parse("correlation:test"),
    diagnostics: [],
  });
}

function deploymentTarget(): DeploymentTarget {
  return {
    tool: {
      toolId: "codex" as const,
      installationId: ToolInstallationIdSchema.parse("codex:/project"),
      configRoots: [AbsolutePathSchema.parse("/project")],
      evidence: {},
    },
    scope: {
      kind: "project" as const,
      canonicalRootPath: AbsolutePathSchema.parse("/project"),
      depth: 0,
      precedence: 0,
    },
    canonicalRootPath: AbsolutePathSchema.parse("/project"),
  };
}

function deploymentTargetFor(toolId: DeploymentTarget["tool"]["toolId"]): DeploymentTarget {
  return {
    ...deploymentTarget(),
    tool: {
      ...deploymentTarget().tool,
      toolId,
      installationId: ToolInstallationIdSchema.parse(`${toolId}:/project`),
    },
  };
}

function parsedAgentAsset(path: AbsolutePath, contentHash: ContentHash): ParsedAsset {
  return {
    toolId: "codex",
    canonicalSourcePath: path,
    locator: "agent:wrong-kind",
    scope: {
      kind: "project",
      canonicalRootPath: AbsolutePathSchema.parse("/project"),
      depth: 0,
      precedence: 0,
    },
    sourceFormat: "toml",
    sourceContentHash: contentHash,
    resource: {
      kind: "agent",
      data: {
        name: "wrong-kind",
        instructions: "This parsed as an agent.",
        allowedTools: [],
        extensions: {},
      },
    },
    references: [],
    extensions: {},
  };
}

function snapshot(path: AbsolutePath, text: string): FileSnapshot {
  return {
    canonicalPath: path,
    text,
    contentHash: hash(text),
    modifiedAt: IsoDateTimeSchema.parse("2026-06-21T08:00:00.000Z"),
    size: Buffer.byteLength(text),
  };
}

function baseAsset(
  id: string,
  locator: string,
  path: string,
  resource: Asset["resource"],
  references: readonly string[] = [],
): Asset {
  return AssetSchema.parse({
    assetId: id,
    toolId: "codex",
    canonicalSourcePath: path,
    locator,
    scopeId: "scope-project",
    sourceFormat: "markdown",
    contentHash: hash(`source:${id}`),
    normalizedSchemaVersion: "1.0.0",
    adapterId: "builtin-codex",
    adapterVersion: "0.1.0",
    discoveredAt: "2026-06-21T08:00:00.000Z",
    resource,
    references,
    diagnosticSummary: { info: 0, warning: 0, error: 0 },
  });
}

function ruleAsset(id = "rule", locator = `rule:${id}`, path = `/project/${id}.md`): Asset {
  return baseAsset(id, locator, path, {
    kind: "rule",
    data: { name: id, instructions: "Use project conventions.", globs: [], extensions: {} },
  });
}

function agentAsset(): Asset {
  return baseAsset("agent", "agent:reviewer", "/project/agent.md", {
    kind: "agent",
    data: {
      name: "reviewer",
      instructions: "Review changes carefully.",
      allowedTools: [],
      extensions: {},
    },
  });
}

function skillAsset(references: readonly string[] = []): Asset {
  return baseAsset(
    "skill",
    "skill:release",
    "/project/skills/release/SKILL.md",
    {
      kind: "skill",
      data: {
        name: "release",
        instructions: "Ship releases safely.",
        references,
        extensions: {},
      },
    },
    references,
  );
}

type McpSecretArg =
  | { readonly kind: "literal"; readonly value: string; readonly deployable: true }
  | { readonly kind: "reference"; readonly expression: string; readonly deployable: true }
  | { readonly kind: "redacted"; readonly digest: ContentHash; readonly deployable: false };

function mcpAsset(
  arg: McpSecretArg = { kind: "literal", value: "--stdio", deployable: true },
): Asset {
  return baseAsset("mcp", "mcp:local", "/project/mcp.json", {
    kind: "mcp",
    data: {
      name: "local",
      transport: {
        kind: "stdio",
        command: "node",
        args: [arg],
        env: {},
      },
      extensions: {},
    },
  });
}

function hash(text: string): ContentHash {
  return ContentHashSchema.parse(
    `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
  );
}
