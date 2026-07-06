import type { ToolInstallation } from "@ai-config-hub/core";
import { AbsolutePathSchema, ToolInstallationIdSchema } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { cursorRegistration } from "./cursor.js";
import { fixtureSnapshot, memoryReadApi, neverCancelled } from "./test-support.js";

const files = {
  "/project/.cursor/rules/project.mdc":
    "---\ndescription: Project rules\nglobs: [src/**/*.ts]\nversion: 2\nx-owner: platform\nalwaysApply: false\nunknownMode: kept\n---\nUse strict TypeScript.\n",
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
          read,
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
    expect(assets.find(({ locator }) => locator === "rule:project")?.resource).toMatchObject({
      kind: "rule",
      data: {
        globs: ["src/**/*.ts"],
        extensions: {
          description: "Project rules",
          version: 2,
          "x-owner": "platform",
          alwaysApply: false,
          unknownMode: "kept",
        },
      },
    });
    expect(assets.find(({ locator }) => locator === "agent:reviewer")?.resource).toMatchObject({
      kind: "agent",
      data: { name: "reviewer", description: "Review code" },
    });
    expect(results.flatMap(({ diagnostics }) => diagnostics)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RULE_UNSUPPORTED_NATIVE_FIELD",
        }),
      ]),
    );
    expect(discovery.diagnostics).toContainEqual(
      expect.objectContaining({ code: "CURSOR_LEGACY_RULE_FORMAT", severity: "warning" }),
    );
  });

  it("diagnoses Cursor skill names that do not match the package directory", async () => {
    const read = memoryReadApi({
      "/project/.cursor/skills/refactor/SKILL.md":
        "---\nname: safer-refactor\ndescription: Refactor safely\n---\nKeep tests green.\n",
    });
    const adapter = cursorRegistration.create({ logger: { debug() {}, warn() {} } });
    const discovery = await adapter.discover({
      tool,
      allowedRoots: tool.configRoots,
      read,
      signal: neverCancelled,
    });
    const candidate = discovery.candidates.find(
      ({ sourcePath }) => sourcePath === "/project/.cursor/skills/refactor/SKILL.md",
    );
    if (candidate === undefined) throw new Error("Expected Cursor skill candidate");

    const result = await adapter.parse({
      tool,
      candidate,
      snapshot: await fixtureSnapshot(read, candidate.sourcePath),
      read,
      signal: neverCancelled,
    });

    expect(result.status).toBe("parsed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SKILL_NAME_DIRECTORY_MISMATCH",
          blocking: true,
          evidence: expect.objectContaining({
            field: "name",
            relativePath: "SKILL.md",
          }) as unknown,
        }),
      ]),
    );
  });
});
