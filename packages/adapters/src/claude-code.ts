import { basename, dirname, sep } from "node:path";

import type {
  AdapterCapabilities,
  AdapterRegistration,
  DetectionContext,
  DetectionResult,
  DiscoveryContext,
  DiscoveryResult,
  ParseContext,
  ParseResult,
} from "@ai-config-hub/core";
import {
  AdapterIdSchema,
  SemVerRangeSchema,
  SemVerSchema,
  ToolInstallationIdSchema,
} from "@ai-config-hub/shared";

import { BaseToolAdapter } from "./base-adapter.js";
import { conversionCapabilities } from "./conversion.js";
import { candidate, markerPath, walkFiles } from "./discovery.js";
import { parseMarkdownAsset, parseMcpJson } from "./markdown-assets.js";

const capabilities: AdapterCapabilities = {
  supportedToolVersions: SemVerRangeSchema.parse(">=1.0.0"),
  testedToolVersions: [SemVerSchema.parse("2.1.0")],
  readableSchemaVersions: [SemVerRangeSchema.parse("^1.0.0")],
  writtenSchemaVersion: SemVerSchema.parse("1.0.0"),
  resourceKinds: ["rule", "agent", "skill", "mcp"],
  scopeKinds: ["user", "project", "directory"],
  supportsNestedScopes: true,
  conversions: conversionCapabilities,
};

class ClaudeCodeAdapter extends BaseToolAdapter {
  readonly adapterId = AdapterIdSchema.parse("builtin-claude-code");
  readonly adapterVersion = SemVerSchema.parse("0.1.0");
  readonly toolId = "claude-code" as const;
  readonly capabilities = capabilities;

  async detect(context: DetectionContext): Promise<DetectionResult> {
    const installations = [];
    for (const root of [...context.candidateRoots].sort()) {
      context.signal.throwIfAborted();
      const markers = [
        markerPath(root, "CLAUDE.md"),
        markerPath(root, ".claude"),
        markerPath(root, ".mcp.json"),
      ];
      if (
        (await Promise.all(markers.map((path) => context.read.stat(path)))).some(
          ({ kind }) => kind !== "missing",
        )
      ) {
        installations.push({
          toolId: this.toolId,
          installationId: ToolInstallationIdSchema.parse(`claude-code:${root}`),
          configRoots: [root],
          evidence: { markers: markers.map(String) },
        });
      }
    }
    return { installations, diagnostics: [] };
  }

  async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    const candidates = [];
    for (const root of [...context.tool.configRoots].sort()) {
      for (const sourcePath of await walkFiles(context.read, root, context.signal)) {
        const leaf = basename(sourcePath);
        if (leaf === "CLAUDE.md") {
          candidates.push(
            candidate({
              toolId: this.toolId,
              root,
              sourcePath,
              sourceFormat: "markdown",
              resourceKind: "rule",
              scopeRoot: dirname(sourcePath),
            }),
          );
        } else if (sourcePath.includes(`${sep}.claude${sep}agents${sep}`) && leaf.endsWith(".md")) {
          candidates.push(
            candidate({
              toolId: this.toolId,
              root,
              sourcePath,
              sourceFormat: "yaml-frontmatter-markdown",
              resourceKind: "agent",
            }),
          );
        } else if (sourcePath.includes(`${sep}.claude${sep}skills${sep}`) && leaf === "SKILL.md") {
          candidates.push(
            candidate({
              toolId: this.toolId,
              root,
              sourcePath,
              sourceFormat: "yaml-frontmatter-markdown",
              resourceKind: "skill",
            }),
          );
        } else if (leaf === ".mcp.json") {
          candidates.push(
            candidate({
              toolId: this.toolId,
              root,
              sourcePath,
              sourceFormat: "jsonc",
              resourceKind: "mcp",
            }),
          );
        }
      }
    }
    return {
      candidates: candidates.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
      diagnostics: [],
    };
  }

  parse(context: ParseContext): Promise<ParseResult> {
    context.signal.throwIfAborted();
    return Promise.resolve(
      context.candidate.resourceKindHint === "mcp"
        ? parseMcpJson(context.candidate, context.snapshot.text, context.snapshot.contentHash)
        : parseMarkdownAsset(
            context.candidate,
            context.snapshot.text,
            context.snapshot.contentHash,
          ),
    );
  }
}

export const claudeCodeRegistration: AdapterRegistration = {
  contractVersion: 1,
  adapterId: AdapterIdSchema.parse("builtin-claude-code"),
  adapterVersion: SemVerSchema.parse("0.1.0"),
  toolId: "claude-code",
  capabilities,
  create: ({ logger }) => new ClaudeCodeAdapter(logger),
};
