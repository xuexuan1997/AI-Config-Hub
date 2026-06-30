import type { ToolInstallation } from "@ai-config-hub/core";
import { AbsolutePathSchema, ToolInstallationIdSchema } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { cursorRegistration } from "./cursor.js";
import { fixtureSnapshot, memoryReadApi, neverCancelled } from "./test-support.js";

const files = {
  "/project/.cursor/rules/project.mdc":
    "---\ndescription: Project rules\nglobs: [src/**/*.ts]\nalwaysApply: false\nunknownMode: kept\n---\nUse strict TypeScript.\n",
  "/project/src/.cursor/rules/nested.mdc": "---\nalwaysApply: true\n---\nNested rule.\n",
  "/project/AGENTS.md": "# Agent guidance\nUse tests.\n",
  "/project/.cursorrules": "Legacy guidance.\n",
  "/project/.cursor/agents/reviewer.md":
    "---\nname: reviewer\ndescription: Review code\n---\nReview only.\n",
  "/project/.cursor/skills/refactor/SKILL.md":
    "---\nname: refactor\ndescription: Refactor safely\n---\nKeep tests green.\n",
  "/project/.cursor/mcp.json": `{
    "mcpServers": {
      "docs": { "url": "https://example.test/mcp", "headers": { "Authorization": "top-secret-canary" } }
    }
  }`,
} as const;

const tool: ToolInstallation = {
  toolId: "cursor",
  installationId: ToolInstallationIdSchema.parse("cursor-project"),
  configRoots: [AbsolutePathSchema.parse("/project")],
  evidence: { scope: "project" },
};

describe("Cursor adapter read path", () => {
  it("discovers and parses rules, agents, skills and MCP with nested scope evidence", async () => {
    const read = memoryReadApi(files);
    const adapter = cursorRegistration.create({ logger: { debug() {}, warn() {} } });
    const discovery = await adapter.discover({
      tool,
      allowedRoots: tool.configRoots,
      read,
      signal: neverCancelled,
    });
    const results = await Promise.all(
      discovery.candidates.map(async (candidate) =>
        adapter.parse({
          tool,
          candidate,
          snapshot: await fixtureSnapshot(read, candidate.sourcePath),
          signal: neverCancelled,
        }),
      ),
    );
    const assets = results.flatMap(({ assets }) => assets);

    expect(new Set(assets.map(({ resource }) => resource.kind))).toEqual(
      new Set(["rule", "agent", "skill", "mcp"]),
    );
    expect(JSON.stringify(results)).not.toContain("top-secret-canary");
    expect(discovery.candidates.map(({ sourcePath }) => sourcePath)).not.toContain(
      "/project/src/.cursor/rules/nested.mdc",
    );
    expect(discovery.diagnostics).toContainEqual(
      expect.objectContaining({ code: "CURSOR_LEGACY_RULE_FORMAT", severity: "warning" }),
    );
  });
});
