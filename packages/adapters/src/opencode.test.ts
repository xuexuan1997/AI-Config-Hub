import type { ToolInstallation } from "@ai-config-hub/core";
import { AbsolutePathSchema, ToolInstallationIdSchema } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { opencodeRegistration } from "./opencode.js";
import { fixtureSnapshot, memoryReadApi, neverCancelled } from "./test-support.js";

const files = {
  "/project/AGENTS.md": "# OpenCode guidance\nUse tests.\n",
  "/project/CLAUDE.md": "# Compatible guidance\nKeep changes small.\n",
  "/project/docs/local.md": "# Configured instruction\nDo not fetch remote instructions.\n",
  "/project/.opencode/agents/reviewer.md":
    "---\nname: reviewer\ndescription: Reviews code\nmodel: openai/gpt-5\ntools: [read, grep]\n---\nReview carefully.\n",
  "/project/.opencode/skills/release/SKILL.md":
    "---\nname: release\ndescription: Release safely\n---\nRun checks.\n",
  "/project/opencode.jsonc": `{
    // Local instruction paths only; URLs are ignored.
    "instructions": ["docs/local.md", "https://example.test/never-fetch.md"],
    "agent": {
      "planner": { "description": "Plans work", "prompt": "Plan carefully.", "model": "openai/gpt-5", "mode": "subagent" },
      "archived": { "description": "Old reviewer", "prompt": "Review carefully.", "disable": true }
    },
    "mcp": {
      "empty": {},
      "local": { "type": "local", "command": ["npx", "docs", "--api-key=top-secret-canary"], "environment": { "TOKEN": "top-secret-canary" } },
      "remote": { "type": "remote", "url": "https://example.test/mcp", "headers": { "Authorization": "Bearer top-secret-canary" } },
      "disabledDocs": { "type": "remote", "url": "https://disabled.example.test/mcp", "enabled": false }
    }
  }`,
} as const;

const tool: ToolInstallation = {
  toolId: "opencode",
  installationId: ToolInstallationIdSchema.parse("opencode-project"),
  configRoots: [AbsolutePathSchema.parse("/project")],
  evidence: { scope: "project" },
};

describe("OpenCode adapter read path", () => {
  it("normalizes markdown plus config agents and MCP without remote access", async () => {
    const read = memoryReadApi(files);
    const adapter = opencodeRegistration.create({ logger: { debug() {}, warn() {} } });
    const discovery = await adapter.discover({
      tool,
      allowedRoots: tool.configRoots,
      read,
      signal: neverCancelled,
    });
    expect(discovery.candidates.map(({ sourcePath }) => sourcePath)).toContain(
      "/project/docs/local.md",
    );
    expect(discovery.candidates.every(({ sourcePath }) => !sourcePath.startsWith("https:"))).toBe(
      true,
    );

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
    expect(assets.find(({ locator }) => locator === "agent:planner")?.resource).toMatchObject({
      kind: "agent",
      data: {
        name: "planner",
        description: "Plans work",
        instructions: "Plan carefully.",
        extensions: { mode: "subagent" },
      },
    });
    expect(assets.find(({ locator }) => locator === "agent:reviewer")?.resource).toMatchObject({
      kind: "agent",
      data: { name: "reviewer", description: "Reviews code" },
    });
    expect(results.flatMap(({ diagnostics }) => diagnostics)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "AGENT_UNSUPPORTED_NATIVE_FIELD",
          evidence: expect.objectContaining({ field: "mode" }) as unknown,
        }),
        expect.objectContaining({
          code: "MCP_UNSUPPORTED_NATIVE_FIELD",
          evidence: expect.objectContaining({ field: "enabled" }) as unknown,
        }),
      ]),
    );
    expect(
      (assets.find(({ locator }) => locator === "agent:archived") as { status?: string })?.status,
    ).toBe("disabled");
    expect(
      (assets.find(({ locator }) => locator === "mcp:disabledDocs") as { status?: string })?.status,
    ).toBe("disabled");
    expect(assets.map(({ locator }) => locator)).not.toContain("mcp:empty");
    expect(JSON.stringify(results)).not.toContain("top-secret-canary");
  });

  it("diagnoses OpenCode skills with invalid native names", async () => {
    const read = memoryReadApi({
      "/project/.opencode/skills/release/SKILL.md":
        "---\nname: Release Skill With Spaces\ndescription: Release safely\n---\nRun checks.\n",
    });
    const adapter = opencodeRegistration.create({ logger: { debug() {}, warn() {} } });
    const discovery = await adapter.discover({
      tool,
      allowedRoots: tool.configRoots,
      read,
      signal: neverCancelled,
    });
    const candidate = discovery.candidates.find(
      ({ sourcePath }) => sourcePath === "/project/.opencode/skills/release/SKILL.md",
    );
    if (candidate === undefined) throw new Error("Expected OpenCode skill candidate");

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
          code: "SKILL_NAME_INVALID",
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
