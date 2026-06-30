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
        instructions: "Review carefully.",
        model: "gpt-5.1-codex",
        extensions: { description: "Reviews code", sandbox_mode: "read-only" },
      },
    });
    expect(JSON.stringify(results)).not.toContain("top-secret-canary");
    expect(JSON.stringify(results)).toContain("$DOCS_TOKEN");
    expect(JSON.stringify(results)).toContain("$REMOTE_TOKEN");
  });
});
