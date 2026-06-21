import type { DiscoveredResource, ToolInstallation } from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  ToolInstallationIdSchema,
  type ResourceKind,
} from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { claudeCodeRegistration } from "./claude-code.js";
import { fixtureSnapshot, memoryReadApi, neverCancelled } from "./test-support.js";

const files = {
  "/project/CLAUDE.md": "# Project guidance\nUse pnpm.\n",
  "/project/src/CLAUDE.md": "# Source guidance\nKeep modules small.\n",
  "/project/.claude/agents/reviewer.md":
    "---\nname: reviewer\ndescription: Reviews code\ntools: [Read, Grep]\nunknownFlag: kept\n---\nReview carefully.\n",
  "/project/.claude/skills/release/SKILL.md":
    "---\nname: release\ndescription: Ship releases\nreferences: [checklist.md]\n---\nFollow the checklist.\n",
  "/project/.mcp.json": `{
    "mcpServers": {
      "docs": { "command": "npx", "args": ["docs", "--token=top-secret-canary"], "env": { "TOKEN": "top-secret-canary" } },
      "remote": { "type": "http", "url": "https://user:top-secret-canary@example.test/mcp" }
    }
  }`,
} as const;

function tool(): ToolInstallation {
  return {
    toolId: "claude-code",
    installationId: ToolInstallationIdSchema.parse("claude-project"),
    configRoots: [AbsolutePathSchema.parse("/project")],
    evidence: { scope: "project" },
  };
}

describe("Claude Code adapter read path", () => {
  it("detects and deterministically discovers four resource kinds and nested rules", async () => {
    const read = memoryReadApi(files);
    const adapter = claudeCodeRegistration.create({ logger: { debug() {}, warn() {} } });
    const detection = await adapter.detect({
      platform: "linux",
      homeDirectory: AbsolutePathSchema.parse("/home/user"),
      candidateRoots: [AbsolutePathSchema.parse("/project")],
      read,
      signal: neverCancelled,
    });
    expect(detection.installations).toHaveLength(1);

    const discovery = await adapter.discover({
      tool: tool(),
      allowedRoots: tool().configRoots,
      read,
      signal: neverCancelled,
    });
    expect(discovery.candidates.map(({ sourcePath }) => sourcePath)).toEqual(
      [...discovery.candidates.map(({ sourcePath }) => sourcePath)].sort(),
    );
    expect(new Set(discovery.candidates.map(({ resourceKindHint }) => resourceKindHint))).toEqual(
      new Set<ResourceKind>(["rule", "agent", "skill", "mcp"]),
    );
    expect(
      discovery.candidates.find(({ sourcePath }) => sourcePath === "/project/src/CLAUDE.md")?.scope
        .kind,
    ).toBe("directory");
  });

  it("normalizes markdown and multi-server MCP while removing secret canaries", async () => {
    const read = memoryReadApi(files);
    const adapter = claudeCodeRegistration.create({ logger: { debug() {}, warn() {} } });
    const discovery = await adapter.discover({
      tool: tool(),
      allowedRoots: tool().configRoots,
      read,
      signal: neverCancelled,
    });
    const parsed = await Promise.all(
      discovery.candidates.map(async (candidate: DiscoveredResource) =>
        adapter.parse({
          tool: tool(),
          candidate,
          snapshot: await fixtureSnapshot(read, candidate.sourcePath),
          signal: neverCancelled,
        }),
      ),
    );
    const assets = parsed.flatMap((result) => result.assets);
    expect(assets.map(({ resource }) => resource.kind)).toEqual(
      expect.arrayContaining(["rule", "agent", "skill", "mcp", "mcp"]),
    );
    expect(JSON.stringify(parsed)).not.toContain("top-secret-canary");
    expect(
      new Set(assets.map(({ canonicalSourcePath, locator }) => `${canonicalSourcePath}#${locator}`))
        .size,
    ).toBe(assets.length);
    expect(assets.find(({ locator }) => locator === "agent:reviewer")?.resource).toMatchObject({
      kind: "agent",
      data: { allowedTools: ["Read", "Grep"] },
    });
  });

  it("rejects malformed frontmatter with a located diagnostic", async () => {
    const read = memoryReadApi({ "/project/.claude/agents/broken.md": "---\nname: broken\n" });
    const adapter = claudeCodeRegistration.create({ logger: { debug() {}, warn() {} } });
    const candidate: DiscoveredResource = {
      toolId: "claude-code",
      sourcePath: AbsolutePathSchema.parse("/project/.claude/agents/broken.md"),
      sourceFormat: "yaml-frontmatter-markdown",
      resourceKindHint: "agent",
      scope: {
        kind: "project",
        canonicalRootPath: AbsolutePathSchema.parse("/project"),
        projectRoot: AbsolutePathSchema.parse("/project"),
        depth: 0,
        precedence: 100,
      },
    };
    const result = await adapter.parse({
      tool: tool(),
      candidate,
      snapshot: await fixtureSnapshot(read, candidate.sourcePath),
      signal: neverCancelled,
    });
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]).toMatchObject({ severity: "error", location: { line: 1 } });
  });
});
