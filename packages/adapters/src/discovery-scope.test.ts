import type { AdapterRegistration, ToolInstallation } from "@ai-config-hub/core";
import { AbsolutePathSchema, ToolInstallationIdSchema } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { claudeCodeRegistration } from "./claude-code.js";
import { codexRegistration } from "./codex.js";
import { cursorRegistration } from "./cursor.js";
import { opencodeRegistration } from "./opencode.js";
import { failOnListedDirectory, memoryReadApi, neverCancelled } from "./test-support.js";

const root = AbsolutePathSchema.parse("/project");
const vendor = AbsolutePathSchema.parse("/project/vendor");

function tool(registration: AdapterRegistration): ToolInstallation {
  return {
    toolId: registration.toolId,
    installationId: ToolInstallationIdSchema.parse(`${registration.toolId}:project`),
    configRoots: [root],
    evidence: { scope: "project" },
  };
}

const fixtures: ReadonlyArray<{
  readonly name: string;
  readonly registration: AdapterRegistration;
  readonly files: Readonly<Record<string, string>>;
}> = [
  {
    name: "Claude Code",
    registration: claudeCodeRegistration,
    files: {
      "/project/CLAUDE.md": "# Claude guidance\nUse tests.\n",
      "/project/.claude/agents/reviewer.md": "---\nname: reviewer\n---\nReview.\n",
      "/project/vendor/unrelated.md": "# Not a Claude Code configuration file\n",
    },
  },
  {
    name: "Codex",
    registration: codexRegistration,
    files: {
      "/project/AGENTS.md": "# Codex guidance\nUse tests.\n",
      "/project/.codex/config.toml": '[mcp_servers.docs]\ncommand = "npx"\n',
      "/project/vendor/unrelated.md": "# Not a Codex configuration file\n",
    },
  },
  {
    name: "Cursor",
    registration: cursorRegistration,
    files: {
      "/project/.cursor/rules/project.mdc": "---\nalwaysApply: true\n---\nUse tests.\n",
      "/project/vendor/unrelated.md": "# Not a Cursor configuration file\n",
    },
  },
  {
    name: "OpenCode",
    registration: opencodeRegistration,
    files: {
      "/project/opencode.jsonc": '{"agent":{"planner":{"prompt":"Plan."}}}',
      "/project/vendor/unrelated.md": "# Not an OpenCode configuration file\n",
    },
  },
];

describe("documented adapter discovery scope", () => {
  it.each(fixtures)(
    "$name discovery does not descend into unrelated project directories",
    async ({ registration, files }) => {
      const adapter = registration.create({ logger: { debug() {}, warn() {} } });
      const read = failOnListedDirectory(memoryReadApi(files), vendor);

      const discovery = await adapter.discover({
        tool: tool(registration),
        allowedRoots: [root],
        read,
        signal: neverCancelled,
      });
      expect(
        discovery.candidates.some((candidate) => candidate.toolId === registration.toolId),
      ).toBe(true);
    },
  );
});
