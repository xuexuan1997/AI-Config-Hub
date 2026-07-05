import type { DiscoveredResource, ToolInstallation } from "@ai-config-hub/core";
import { AbsolutePathSchema, ToolIdSchema, ToolInstallationIdSchema } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import {
  createDeclarativeToolRegistration,
  DeclarativeToolDefinitionSchema,
} from "./declarative-tool.js";
import { createAdapterRegistry, createDefaultAdapterRegistry } from "./registry.js";
import { fixtureSnapshot, memoryReadApi, neverCancelled } from "./test-support.js";

const definition = {
  id: "acme-tool",
  name: "Acme Tool",
  icon: "acme",
  detect: {
    executables: ["acme"],
  },
  paths: {
    global: [".acme"],
    project: [".acme", "ACME.md"],
  },
  resources: {
    rules: {
      directories: ["rules"],
      files: ["ACME.md"],
      extensions: [".md"],
    },
    agents: {
      directories: ["agents"],
      extensions: [".md"],
    },
    skills: {
      directories: ["skills"],
      entry_files: ["SKILL.md"],
    },
    mcp: {
      files: ["mcp.json"],
    },
  },
} as const;

const files = {
  "/home/me/.acme/rules/global.md": "---\nname: global\n---\nGlobal rule.\n",
  "/project/ACME.md": "# Project rule\nUse Acme.\n",
  "/project/.acme/agents/reviewer.md": "---\nname: reviewer\ntools: [Read]\n---\nReview.\n",
  "/project/.acme/skills/ship/SKILL.md":
    "---\nname: ship\ndescription: Ship safely\nreferences: [guide.md]\n---\nShip it.\n",
  "/project/.acme/mcp.json": `{
    "mcpServers": {
      "docs": { "command": "acme-docs", "args": ["--mode", "local"] }
    }
  }`,
} as const;

function tool(configRoots = [AbsolutePathSchema.parse("/project")]): ToolInstallation {
  return {
    toolId: ToolIdSchema.parse("acme-tool"),
    installationId: ToolInstallationIdSchema.parse("acme-tool:/project"),
    configRoots,
    evidence: { scope: "project" },
  };
}

describe("declarative custom tool definitions", () => {
  it("rejects script-like declaration fields and unsafe ids", () => {
    expect(DeclarativeToolDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(
      DeclarativeToolDefinitionSchema.safeParse({
        ...definition,
        id: "Acme Tool",
      }).success,
    ).toBe(false);
    expect(
      DeclarativeToolDefinitionSchema.safeParse({
        ...definition,
        hooks: { postInstall: "curl https://example.test/install.sh | sh" },
      }).success,
    ).toBe(false);
    expect(
      DeclarativeToolDefinitionSchema.safeParse({
        ...definition,
        detect: { scripts: ["which acme"] },
      }).success,
    ).toBe(false);
    expect(
      DeclarativeToolDefinitionSchema.safeParse({
        ...definition,
        resources: { ...definition.resources, commands: { scan: "acme scan" } },
      }).success,
    ).toBe(false);
  });

  it("detects global and project roots from declared paths", async () => {
    const registration = createDeclarativeToolRegistration(definition);
    const adapter = registration.create({ logger: { debug() {}, warn() {} } });
    const read = memoryReadApi(files);
    const detection = await adapter.detect({
      platform: "linux",
      homeDirectory: AbsolutePathSchema.parse("/home/me"),
      candidateRoots: [AbsolutePathSchema.parse("/home/me"), AbsolutePathSchema.parse("/project")],
      read,
      signal: neverCancelled,
    });

    expect(detection.installations.map(({ installationId }) => installationId)).toEqual([
      "acme-tool:user:/home/me",
      "acme-tool:/project",
    ]);
    expect(detection.installations[0]?.configRoots).toEqual([
      AbsolutePathSchema.parse("/home/me/.acme"),
    ]);
    expect(detection.installations[1]?.configRoots).toEqual([AbsolutePathSchema.parse("/project")]);
  });

  it("discovers and parses declared rules, agents, skills and MCP without executing commands", async () => {
    const registration = createDeclarativeToolRegistration(definition);
    const adapter = registration.create({ logger: { debug() {}, warn() {} } });
    const read = memoryReadApi(files);
    const discovery = await adapter.discover({
      tool: tool(),
      allowedRoots: tool().configRoots,
      read,
      signal: neverCancelled,
    });
    const results = await Promise.all(
      discovery.candidates.map(async (candidate: DiscoveredResource) =>
        adapter.parse({
          tool: tool(),
          candidate,
          snapshot: await fixtureSnapshot(read, candidate.sourcePath),
          read,
          signal: neverCancelled,
        }),
      ),
    );
    const assets = results.flatMap(({ assets }) => assets);

    expect(discovery.candidates.map(({ sourcePath }) => sourcePath)).toEqual([
      "/project/.acme/agents/reviewer.md",
      "/project/.acme/mcp.json",
      "/project/.acme/skills/ship/SKILL.md",
      "/project/ACME.md",
    ]);
    expect(new Set(assets.map(({ resource }) => resource.kind))).toEqual(
      new Set(["rule", "agent", "skill", "mcp"]),
    );
    expect(assets.find(({ locator }) => locator === "agent:reviewer")?.resource).toMatchObject({
      kind: "agent",
      data: { allowedTools: ["Read"] },
    });
    expect(assets.find(({ locator }) => locator === "mcp:docs")?.resource).toMatchObject({
      kind: "mcp",
      data: { transport: { kind: "stdio", command: "acme-docs" } },
    });
  });

  it("registers custom declarations while preserving default built-ins", () => {
    expect(createDefaultAdapterRegistry().toolIds).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "opencode",
    ]);
    expect(createDefaultAdapterRegistry({ customTools: [definition] }).toolIds).toEqual([
      "acme-tool",
      "claude-code",
      "codex",
      "cursor",
      "opencode",
    ]);
    expect(
      createAdapterRegistry([], [definition]).create(ToolIdSchema.parse("acme-tool"), {
        debug() {},
        warn() {},
      }).toolId,
    ).toBe("acme-tool");
  });
});
