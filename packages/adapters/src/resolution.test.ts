import { AssetSchema, ScopeSchema } from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  ContentHashSchema,
  ToolInstallationIdSchema,
} from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { codexRegistration } from "./codex.js";
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
  scopeId: string;
  path: string;
  resource: unknown;
  hash: string;
}) {
  return AssetSchema.parse({
    assetId: input.id,
    toolId: "codex",
    resource: input.resource,
    scopeId: input.scopeId,
    canonicalSourcePath: input.path,
    locator: input.id,
    sourceFormat: "markdown",
    contentHash: ContentHashSchema.parse(`sha256:${input.hash.repeat(64)}`),
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
});
