import { AssetSchema, ScopeSchema } from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  ContentHashSchema,
  ToolInstallationIdSchema,
} from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { codexRegistration } from "./codex.js";
import { claudeCodeRegistration } from "./claude-code.js";
import { neverCancelled } from "./test-support.js";

const scopes = [
  ScopeSchema.parse({
    scopeId: "scope-root",
    toolId: "codex",
    scopeKind: "project",
    canonicalRootPath: "/project",
    projectId: "project-1",
    depth: 0,
    precedence: 100,
    discoveryEvidence: {},
  }),
  ScopeSchema.parse({
    scopeId: "scope-src",
    toolId: "codex",
    scopeKind: "directory",
    canonicalRootPath: "/project/src",
    projectId: "project-1",
    parentScopeId: "scope-root",
    depth: 1,
    precedence: 101,
    discoveryEvidence: {},
  }),
];

function asset(input: {
  id: string;
  toolId?: "codex" | "claude-code";
  scopeId: string;
  path: string;
  resource: unknown;
  hash: string;
}) {
  const sourcePath = AbsolutePathSchema.parse(input.path);
  const contentHash = ContentHashSchema.parse(`sha256:${input.hash.repeat(64)}`);
  return AssetSchema.parse({
    assetId: input.id,
    toolId: input.toolId ?? "codex",
    resource: input.resource,
    scopeId: input.scopeId,
    canonicalSourcePath: sourcePath,
    locator: input.id,
    sourceFormat: "markdown",
    contentHash,
    sourceFiles: [
      {
        path: sourcePath,
        relativePath: input.path.split("/").at(-1) ?? "source.md",
        role: "primary",
        mediaType: "text/markdown",
        isText: true,
        contentHash,
      },
    ],
    nativeIdentity: {
      nativeId: input.id,
      displayName: input.id,
    },
    normalizedSchemaVersion: "1.0.0",
    adapterId: "builtin-codex",
    adapterVersion: "0.1.0",
    discoveredAt: "2026-06-21T08:00:00.000Z",
    references: [],
    diagnosticSummary: { info: 0, warning: 0, error: 0 },
  });
}

const assets = [
  asset({
    id: "root-rule",
    scopeId: "scope-root",
    path: "/project/AGENTS.md",
    hash: "a",
    resource: {
      kind: "rule",
      data: { name: "AGENTS", instructions: "Root", globs: [], extensions: {} },
    },
  }),
  asset({
    id: "src-rule",
    scopeId: "scope-src",
    path: "/project/src/AGENTS.override.md",
    hash: "b",
    resource: {
      kind: "rule",
      data: { name: "AGENTS.override", instructions: "Nested", globs: [], extensions: {} },
    },
  }),
  asset({
    id: "root-mcp",
    scopeId: "scope-root",
    path: "/project/.codex/config.toml",
    hash: "c",
    resource: {
      kind: "mcp",
      data: {
        name: "docs",
        transport: { kind: "stdio", command: "root-docs", args: [], env: {} },
        extensions: {},
      },
    },
  }),
  asset({
    id: "src-mcp",
    scopeId: "scope-src",
    path: "/project/src/.codex/config.toml",
    hash: "d",
    resource: {
      kind: "mcp",
      data: {
        name: "docs",
        transport: { kind: "stdio", command: "src-docs", args: [], env: {} },
        extensions: {},
      },
    },
  }),
];

const tool = {
  toolId: "codex" as const,
  installationId: ToolInstallationIdSchema.parse("codex-project"),
  configRoots: [AbsolutePathSchema.parse("/project")],
  evidence: {},
};

describe("effective resolution", () => {
  it("inherits applicable rules and lets deeper scopes override named resources", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const result = await adapter.resolveEffective({
      tool,
      targetPath: AbsolutePathSchema.parse("/project/src/components"),
      assets,
      scopes,
      signal: neverCancelled,
    });
    expect(result.draft.contributingAssetIds).toEqual(["root-rule", "src-rule", "src-mcp"]);
    expect(result.draft.ignoredAssetIds).toEqual(["root-mcp"]);
    expect(result.draft.resolvedResources).toHaveLength(3);
    expect(result.draft.steps.find(({ assetId }) => assetId === "root-mcp")).toMatchObject({
      action: "ignore",
      coveredByAssetId: "src-mcp",
    });
  });

  it("filters non-applicable scopes and requested resource kinds", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const result = await adapter.resolveEffective({
      tool,
      targetPath: AbsolutePathSchema.parse("/project/docs"),
      assets,
      scopes,
      resourceKinds: ["mcp"],
      signal: neverCancelled,
    });
    expect(result.draft.contributingAssetIds).toEqual(["root-mcp"]);
    expect(result.draft.resourceKinds).toEqual(["mcp"]);
  });

  it("keeps same-name Codex skills from different project directories available", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const result = await adapter.resolveEffective({
      tool,
      targetPath: AbsolutePathSchema.parse("/project/src/components"),
      assets: [
        asset({
          id: "root-skill",
          scopeId: "scope-root",
          path: "/project/.agents/skills/deploy/SKILL.md",
          hash: "e",
          resource: {
            kind: "skill",
            data: {
              name: "deploy",
              description: "Deploy from the repository root",
              instructions: "Root deploy",
              references: [],
              extensions: {},
            },
          },
        }),
        asset({
          id: "src-skill",
          scopeId: "scope-src",
          path: "/project/src/.agents/skills/deploy/SKILL.md",
          hash: "f",
          resource: {
            kind: "skill",
            data: {
              name: "deploy",
              description: "Deploy from src",
              instructions: "Src deploy",
              references: [],
              extensions: {},
            },
          },
        }),
      ],
      scopes,
      signal: neverCancelled,
    });

    expect(result.draft.contributingAssetIds).toEqual(["root-skill", "src-skill"]);
    expect(result.draft.ignoredAssetIds).toEqual([]);
  });

  it("keeps same-name nested Claude Code project skills available", async () => {
    const claudeScopes = scopes.map((scope) =>
      ScopeSchema.parse({ ...scope, toolId: "claude-code" }),
    );
    const adapter = claudeCodeRegistration.create({ logger: { debug() {}, warn() {} } });
    const result = await adapter.resolveEffective({
      tool: { ...tool, toolId: "claude-code" as const },
      targetPath: AbsolutePathSchema.parse("/project/src/components"),
      assets: [
        asset({
          id: "root-skill",
          toolId: "claude-code",
          scopeId: "scope-root",
          path: "/project/.claude/skills/deploy/SKILL.md",
          hash: "e",
          resource: {
            kind: "skill",
            data: {
              name: "deploy",
              description: "Deploy from the repository root",
              instructions: "Root deploy",
              references: [],
              extensions: {},
            },
          },
        }),
        asset({
          id: "src-skill",
          toolId: "claude-code",
          scopeId: "scope-src",
          path: "/project/src/.claude/skills/deploy/SKILL.md",
          hash: "f",
          resource: {
            kind: "skill",
            data: {
              name: "deploy",
              description: "Deploy from src",
              instructions: "Src deploy",
              references: [],
              extensions: {},
            },
          },
        }),
      ],
      scopes: claudeScopes,
      signal: neverCancelled,
    });

    expect(result.draft.contributingAssetIds).toEqual(["root-skill", "src-skill"]);
    expect(result.draft.ignoredAssetIds).toEqual([]);
  });
});
