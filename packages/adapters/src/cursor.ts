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

import { adapterDiagnostic, BaseToolAdapter } from "./base-adapter.js";
import { candidate, markerPath, walkFiles } from "./discovery.js";
import { parseMarkdownAsset, parseMcpJson } from "./markdown-assets.js";

const capabilities: AdapterCapabilities = {
  supportedToolVersions: SemVerRangeSchema.parse(">=1.0.0"),
  testedToolVersions: [SemVerSchema.parse("2.4.0")],
  readableSchemaVersions: [SemVerRangeSchema.parse("^1.0.0")],
  writtenSchemaVersion: SemVerSchema.parse("1.0.0"),
  resourceKinds: ["rule", "agent", "skill", "mcp"],
  scopeKinds: ["user", "project", "directory"],
  supportsNestedScopes: true,
  conversions: [],
};

class CursorAdapter extends BaseToolAdapter {
  readonly adapterId = AdapterIdSchema.parse("builtin-cursor");
  readonly adapterVersion = SemVerSchema.parse("0.1.0");
  readonly toolId = "cursor" as const;
  readonly capabilities = capabilities;

  async detect(context: DetectionContext): Promise<DetectionResult> {
    const installations = [];
    for (const root of [...context.candidateRoots].sort()) {
      context.signal.throwIfAborted();
      const markers = [
        markerPath(root, ".cursor"),
        markerPath(root, ".cursorrules"),
        markerPath(root, "AGENTS.md"),
      ];
      if (
        (await Promise.all(markers.map((path) => context.read.stat(path)))).some(
          ({ kind }) => kind !== "missing",
        )
      ) {
        installations.push({
          toolId: this.toolId,
          installationId: ToolInstallationIdSchema.parse(`cursor:${root}`),
          configRoots: [root],
          evidence: { markers: markers.map(String) },
        });
      }
    }
    return { installations, diagnostics: [] };
  }

  async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    const candidates = [];
    const diagnostics = [];
    for (const root of [...context.tool.configRoots].sort()) {
      for (const sourcePath of await walkFiles(context.read, root, context.signal)) {
        const leaf = basename(sourcePath);
        if (sourcePath.includes(`${sep}.cursor${sep}rules${sep}`) && leaf.endsWith(".mdc")) {
          const cursorDirectory = sourcePath.slice(0, sourcePath.indexOf(`${sep}.cursor${sep}`));
          candidates.push(
            candidate({
              toolId: this.toolId,
              root,
              sourcePath,
              sourceFormat: "mdc",
              resourceKind: "rule",
              scopeRoot: cursorDirectory,
            }),
          );
        } else if (leaf === "AGENTS.md") {
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
        } else if (leaf === ".cursorrules") {
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
          diagnostics.push(
            adapterDiagnostic(
              "CURSOR_LEGACY_RULE_FORMAT",
              "warning",
              "The .cursorrules format is deprecated",
              false,
              { path: sourcePath },
            ),
          );
        } else if (sourcePath.includes(`${sep}.cursor${sep}agents${sep}`) && leaf.endsWith(".md")) {
          candidates.push(
            candidate({
              toolId: this.toolId,
              root,
              sourcePath,
              sourceFormat: "yaml-frontmatter-markdown",
              resourceKind: "agent",
            }),
          );
        } else if (
          (sourcePath.includes(`${sep}.cursor${sep}skills${sep}`) ||
            sourcePath.includes(`${sep}.agents${sep}skills${sep}`)) &&
          leaf === "SKILL.md"
        ) {
          candidates.push(
            candidate({
              toolId: this.toolId,
              root,
              sourcePath,
              sourceFormat: "yaml-frontmatter-markdown",
              resourceKind: "skill",
            }),
          );
        } else if (sourcePath.endsWith(`${sep}.cursor${sep}mcp.json`)) {
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
      diagnostics,
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

export const cursorRegistration: AdapterRegistration = {
  contractVersion: 1,
  adapterId: AdapterIdSchema.parse("builtin-cursor"),
  adapterVersion: SemVerSchema.parse("0.1.0"),
  toolId: "cursor",
  capabilities,
  create: ({ logger }) => new CursorAdapter(logger),
};
