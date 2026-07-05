import type { ToolInstallation } from "@ai-config-hub/core";
import { AbsolutePathSchema, ToolInstallationIdSchema } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { codexRegistration } from "./codex.js";
import { fixtureSnapshot, memoryReadApi, neverCancelled } from "./test-support.js";

const files = {
  "/project/AGENTS.md": "# Root guidance\nUse tests.\n",
  "/project/AGENTS.override.md": "# Root override\nUse strict TypeScript.\n",
  "/project/src/AGENTS.md": "Ignored outside the scanned Codex config scope.\n",
  "/project/src/AGENTS.override.md": "Ignored outside the scanned Codex config scope.\n",
  "/project/.codex/agents/reviewer.toml": `
name = "reviewer"
description = "Reviews code"
developer_instructions = "Review carefully."
model = "gpt-5.1-codex"
sandbox_mode = "read-only"
model_reasoning_effort = "high"
`,
  "/project/.agents/skills/release/SKILL.md":
    "---\nname: release\ndescription: Release safely\n---\nRun the checklist.\n",
  "/project/.codex/config.toml": `
[mcp_servers.docs]
command = "npx"
args = ["docs", "--token=top-secret-canary"]
env_vars = ["DOCS_TOKEN"]

[mcp_servers.remote]
url = "https://example.test/mcp"
bearer_token_env_var = "REMOTE_TOKEN"
[mcp_servers.remote.http_headers]
X-Safe = "ok"
[mcp_servers.remote.env_http_headers]
Authorization = "REMOTE_TOKEN"
`,
} as const;

const tool: ToolInstallation = {
  toolId: "codex",
  installationId: ToolInstallationIdSchema.parse("codex-project"),
  configRoots: [AbsolutePathSchema.parse("/project")],
  evidence: { scope: "project" },
};

describe("Codex adapter read path", () => {
  it("applies override precedence and normalizes all official resource kinds", async () => {
    const read = memoryReadApi(files);
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const discovery = await adapter.discover({
      tool,
      allowedRoots: tool.configRoots,
      read,
      signal: neverCancelled,
    });
    const paths = discovery.candidates.map(({ sourcePath }) => sourcePath);
    expect(paths).toContain("/project/AGENTS.override.md");
    expect(paths).not.toContain("/project/AGENTS.md");
    expect(paths).not.toContain("/project/src/AGENTS.override.md");
    expect(paths).not.toContain("/project/src/AGENTS.md");

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
    expect(assets.find(({ locator }) => locator === "agent:reviewer")?.resource).toMatchObject({
      kind: "agent",
      data: {
        name: "reviewer",
        description: "Reviews code",
        instructions: "Review carefully.",
        model: "gpt-5.1-codex",
        extensions: { sandbox_mode: "read-only", model_reasoning_effort: "high" },
      },
    });
    expect(results.flatMap(({ diagnostics }) => diagnostics)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "AGENT_UNSUPPORTED_NATIVE_FIELD",
          blocking: false,
          evidence: expect.objectContaining({ field: "sandbox_mode" }) as unknown,
        }),
      ]),
    );
    expect(JSON.stringify(results)).not.toContain("top-secret-canary");
    expect(JSON.stringify(results)).toContain("$DOCS_TOKEN");
    expect(JSON.stringify(results)).toContain("$REMOTE_TOKEN");
  });

  it("diagnoses Codex agents that omit required descriptions", async () => {
    const read = memoryReadApi({
      "/project/.codex/agents/reviewer.toml": `
name = "reviewer"
developer_instructions = "Review carefully."
`,
    });
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const discovery = await adapter.discover({
      tool,
      allowedRoots: tool.configRoots,
      read,
      signal: neverCancelled,
    });
    const candidate = discovery.candidates.find(
      ({ sourcePath }) => sourcePath === "/project/.codex/agents/reviewer.toml",
    );
    if (candidate === undefined) throw new Error("Expected Codex agent candidate");

    const result = await adapter.parse({
      tool,
      candidate,
      snapshot: await fixtureSnapshot(read, candidate.sourcePath),
      read,
      signal: neverCancelled,
    });

    expect(result.status).toBe("parsed");
    expect(result.assets[0]?.resource).toMatchObject({
      kind: "agent",
      data: { name: "reviewer" },
    });
    expect(
      "description" in
        (result.assets[0]?.resource.kind === "agent" ? result.assets[0].resource.data : {}),
    ).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "AGENT_DESCRIPTION_REQUIRED",
          blocking: true,
          evidence: expect.objectContaining({ field: "description" }) as unknown,
        }),
      ]),
    );
  });

  it("skips empty MCP server dictionaries instead of rejecting the config", async () => {
    const read = memoryReadApi({
      "/project/.codex/config.toml": `
[mcp_servers.empty]

[mcp_servers.docs]
command = "npx"
args = ["docs"]
`,
    });
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const discovery = await adapter.discover({
      tool,
      allowedRoots: tool.configRoots,
      read,
      signal: neverCancelled,
    });
    const candidate = discovery.candidates.find(
      ({ sourcePath }) => sourcePath === "/project/.codex/config.toml",
    );
    if (candidate === undefined) throw new Error("Expected Codex config candidate");

    const result = await adapter.parse({
      tool,
      candidate,
      snapshot: await fixtureSnapshot(read, candidate.sourcePath),
      read,
      signal: neverCancelled,
    });

    expect(result.status).toBe("parsed");
    expect(result.assets.map(({ locator }) => locator)).toEqual(["mcp:docs"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("diagnoses Codex skills that omit required package metadata", async () => {
    const read = memoryReadApi({
      "/project/.agents/skills/release/SKILL.md": "---\nname: release\n---\nRun checks.\n",
    });
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const discovery = await adapter.discover({
      tool,
      allowedRoots: tool.configRoots,
      read,
      signal: neverCancelled,
    });
    const candidate = discovery.candidates.find(
      ({ sourcePath }) => sourcePath === "/project/.agents/skills/release/SKILL.md",
    );
    if (candidate === undefined) throw new Error("Expected Codex skill candidate");

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
          code: "SKILL_DESCRIPTION_REQUIRED",
          blocking: true,
          evidence: expect.objectContaining({ field: "description" }) as unknown,
        }),
      ]),
    );
  });
});
