import { basename, dirname } from "node:path";

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
import { conversionCapabilities } from "./conversion.js";
import {
  candidate,
  createAdapterDiscoveryBudget,
  documentedFiles,
  markerPath,
  scopeKindFromEvidence,
} from "./discovery.js";
import { parseMarkdownAsset, parseMcpJson } from "./markdown-assets.js";
import { parseSkillPackage } from "./skill-packages.js";

const capabilities: AdapterCapabilities = {
  supportedToolVersions: SemVerRangeSchema.parse(">=1.0.0"),
  testedToolVersions: [SemVerSchema.parse("2.4.0")],
  readableSchemaVersions: [SemVerRangeSchema.parse("^1.1.0")],
  writtenSchemaVersion: SemVerSchema.parse("1.1.0"),
  resourceKinds: ["rule", "agent", "skill", "mcp"],
  scopeKinds: ["user", "project", "directory"],
  supportsNestedScopes: true,
  conversions: conversionCapabilities,
};

class CursorAdapter extends BaseToolAdapter {
  readonly adapterId = AdapterIdSchema.parse("builtin-cursor");
  readonly adapterVersion = SemVerSchema.parse("0.2.0");
  readonly toolId = "cursor" as const;
  readonly capabilities = capabilities;

  async detect(context: DetectionContext): Promise<DetectionResult> {
    const installations = [];
    for (const root of [...context.candidateRoots].sort()) {
      context.signal.throwIfAborted();
      if (root === context.homeDirectory) {
        const userRoots = await existingUserRoots(context, [
          markerPath(root, ".cursor"),
          markerPath(root, ".cursorrules"),
          markerPath(root, "AGENTS.md"),
        ]);
        if (userRoots.length > 0) {
          installations.push({
            toolId: this.toolId,
            installationId: ToolInstallationIdSchema.parse(`cursor:user:${root}`),
            configRoots: userRoots,
            evidence: { scope: "user", markers: userRoots.map(String) },
          });
        }
        continue;
      }
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
    const scopeKind = scopeKindFromEvidence(context.tool.evidence);
    let budget: ReturnType<typeof createAdapterDiscoveryBudget> | undefined;
    for (const root of [...context.tool.configRoots].sort()) {
      budget ??= createAdapterDiscoveryBudget(await context.read.realpath(root));
      const files = await documentedFiles({
        read: context.read,
        root,
        rootFileNames: ["AGENTS.md", ".cursorrules", "mcp.json"],
        relativeFiles:
          basename(root) === ".cursor"
            ? ["mcp.json"]
            : ["AGENTS.md", ".cursorrules", ".cursor/mcp.json"],
        relativeDirectories:
          basename(root) === ".cursor"
            ? ["rules", "agents", "skills"]
            : [".cursor/rules", ".cursor/agents", ".cursor/skills", ".agents/skills"],
        signal: context.signal,
        budget,
      });
      for (const sourcePath of files) {
        const leaf = basename(sourcePath);
        const normalizedSourcePath = normalizePathSeparators(sourcePath);
        if (normalizedSourcePath.includes("/.cursor/rules/") && leaf.endsWith(".mdc")) {
          const cursorDirectory = sourcePath.slice(0, normalizedSourcePath.indexOf("/.cursor/"));
          candidates.push(
            candidate({
              toolId: this.toolId,
              root,
              sourcePath,
              sourceFormat: "mdc",
              resourceKind: "rule",
              scopeRoot: cursorDirectory,
              scopeKind,
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
              scopeKind,
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
              scopeKind,
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
        } else if (normalizedSourcePath.includes("/.cursor/agents/") && leaf.endsWith(".md")) {
          candidates.push(
            candidate({
              toolId: this.toolId,
              root,
              sourcePath,
              sourceFormat: "yaml-frontmatter-markdown",
              resourceKind: "agent",
              scopeKind,
            }),
          );
        } else if (
          (normalizedSourcePath.includes("/.cursor/skills/") ||
            normalizedSourcePath.includes("/.agents/skills/")) &&
          leaf === "SKILL.md"
        ) {
          candidates.push(
            candidate({
              toolId: this.toolId,
              root,
              sourcePath,
              sourceFormat: "yaml-frontmatter-markdown",
              resourceKind: "skill",
              scopeKind,
            }),
          );
        } else if (normalizedSourcePath.endsWith("/.cursor/mcp.json")) {
          candidates.push(
            candidate({
              toolId: this.toolId,
              root,
              sourcePath,
              sourceFormat: "jsonc",
              resourceKind: "mcp",
              scopeKind,
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
    if (context.candidate.resourceKindHint === "skill") return parseSkillPackage(context);
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

async function existingUserRoots(
  context: DetectionContext,
  roots: readonly ReturnType<typeof markerPath>[],
) {
  const existing = await Promise.all(
    roots.map(async (root) => ({
      root,
      stat: await context.read.stat(root),
    })),
  );
  return existing.filter(({ stat }) => stat.kind !== "missing").map(({ root }) => root);
}

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

export const cursorRegistration: AdapterRegistration = {
  contractVersion: 1,
  adapterId: AdapterIdSchema.parse("builtin-cursor"),
  adapterVersion: SemVerSchema.parse("0.2.0"),
  toolId: "cursor",
  capabilities,
  create: ({ logger }) => new CursorAdapter(logger),
};
