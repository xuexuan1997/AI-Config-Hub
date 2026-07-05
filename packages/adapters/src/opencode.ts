import { basename, dirname, isAbsolute, relative, sep } from "node:path";

import type {
  AdapterCapabilities,
  AdapterRegistration,
  DetectionContext,
  DetectionResult,
  DiscoveryContext,
  DiscoveryResult,
  ParseContext,
  ParseResult,
  ParsedAsset,
} from "@ai-config-hub/core";
import { NormalizedResourceSchema } from "@ai-config-hub/core";
import {
  AdapterIdSchema,
  SemVerRangeSchema,
  SemVerSchema,
  ToolInstallationIdSchema,
  type AbsolutePath,
} from "@ai-config-hub/shared";

import { BaseToolAdapter } from "./base-adapter.js";
import { conversionCapabilities } from "./conversion.js";
import {
  candidate,
  documentedFiles,
  markerPath,
  scopeKindFromEvidence,
  uniquePaths,
  walkRelativeDirectories,
} from "./discovery.js";
import {
  parseMarkdownAsset,
  isEmptyRecord,
  rejectedParse,
  stringList,
  stringValue,
  unsupportedNativeFieldDiagnostics,
  withoutKeys,
} from "./markdown-assets.js";
import { redactStructuredValue, toSecretAwareString } from "./secrets.js";
import { parseJsoncObject, requireObject } from "./structured-config.js";
import { nativeIdentity, singleSourceFile } from "./source-files.js";
import { parseSkillPackage } from "./skill-packages.js";

const capabilities: AdapterCapabilities = {
  supportedToolVersions: SemVerRangeSchema.parse(">=1.0.0"),
  testedToolVersions: [SemVerSchema.parse("1.0.0")],
  readableSchemaVersions: [SemVerRangeSchema.parse("^1.1.0")],
  writtenSchemaVersion: SemVerSchema.parse("1.1.0"),
  resourceKinds: ["rule", "agent", "skill", "mcp"],
  scopeKinds: ["user", "project", "directory"],
  supportsNestedScopes: true,
  conversions: conversionCapabilities,
};

function asset(
  context: ParseContext,
  locator: string,
  resource: ParsedAsset["resource"],
  status?: ParsedAsset["status"],
): ParsedAsset {
  return {
    toolId: context.candidate.toolId,
    canonicalSourcePath: context.candidate.sourcePath,
    locator,
    scope: context.candidate.scope,
    sourceFormat: context.candidate.sourceFormat,
    sourceContentHash: context.snapshot.contentHash,
    contentHash: context.snapshot.contentHash,
    sourceFiles: [
      singleSourceFile({
        path: context.candidate.sourcePath,
        relativePath: basename(context.candidate.sourcePath),
        sourceFormat: context.candidate.sourceFormat,
        contentHash: context.snapshot.contentHash,
      }),
    ],
    nativeIdentity: nativeIdentity({
      nativeId: locator,
      displayName: locator.split(":").slice(1).join(":") || locator,
    }),
    resource,
    references: [],
    extensions: {},
    ...(status === undefined ? {} : { status }),
  };
}

function assetStatusFromConfig(config: Readonly<Record<string, unknown>>): ParsedAsset["status"] {
  return config["disable"] === true || config["enabled"] === false ? "disabled" : undefined;
}

function parseConfigAgents(context: ParseContext): ParseResult {
  try {
    const document = parseJsoncObject(context.snapshot.text);
    const agents = requireObject(document["agent"], "agent");
    const assets = Object.entries(agents)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => {
        const config = requireObject(value, `agent ${name}`);
        const instructions = stringValue(config["prompt"]);
        if (instructions === undefined) throw new TypeError(`Agent ${name} requires prompt`);
        const description = stringValue(config["description"]);
        const resource = NormalizedResourceSchema.parse({
          kind: "agent",
          data: {
            name,
            ...(description === undefined ? {} : { description }),
            instructions,
            ...(stringValue(config["model"]) === undefined
              ? {}
              : { model: stringValue(config["model"]) }),
            allowedTools: stringList(config["tools"]),
            extensions: redactStructuredValue(
              withoutKeys(config, ["description", "prompt", "model", "tools"]),
            ),
          },
        });
        return asset(context, `agent:${name}`, resource, assetStatusFromConfig(config));
      });
    return {
      status: "parsed",
      assets,
      diagnostics: assets.flatMap((item) =>
        item.resource.kind === "agent"
          ? unsupportedNativeFieldDiagnostics(
              "agent",
              item.canonicalSourcePath,
              item.resource.data.extensions,
            )
          : [],
      ),
    };
  } catch (error) {
    return rejectedParse(context.candidate, error);
  }
}

function parseConfigMcp(context: ParseContext): ParseResult {
  try {
    const document = parseJsoncObject(context.snapshot.text);
    const servers = requireObject(document["mcp"], "mcp");
    const assets = Object.entries(servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, value]) => {
        const config = requireObject(value, `MCP server ${name}`);
        if (isEmptyRecord(config)) return [];
        const command = stringList(config["command"]);
        const resource =
          command.length > 0 ? localMcp(name, config, command) : remoteMcp(name, config);
        return [asset(context, `mcp:${name}`, resource, assetStatusFromConfig(config))];
      });
    return {
      status: "parsed",
      assets,
      diagnostics: assets.flatMap((item) =>
        item.resource.kind === "mcp"
          ? unsupportedNativeFieldDiagnostics(
              "mcp",
              item.canonicalSourcePath,
              item.resource.data.extensions,
            )
          : [],
      ),
    };
  } catch (error) {
    return rejectedParse(context.candidate, error);
  }
}

function localMcp(name: string, config: Record<string, unknown>, command: readonly string[]) {
  const executable = command[0];
  if (executable === undefined) throw new TypeError(`MCP server ${name} requires command`);
  const environment = requireObject(config["environment"] ?? {}, "MCP environment");
  return NormalizedResourceSchema.parse({
    kind: "mcp",
    data: {
      name,
      transport: {
        kind: "stdio",
        command: executable,
        args: command.slice(1).map((item) => toSecretAwareString(item)),
        env: Object.fromEntries(
          Object.entries(environment)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(([key, value]) => [key, toSecretAwareString(value, key)]),
        ),
      },
      extensions: redactStructuredValue(withoutKeys(config, ["type", "command", "environment"])),
    },
  });
}

function remoteMcp(name: string, config: Record<string, unknown>) {
  const url = stringValue(config["url"]);
  if (url === undefined) throw new TypeError(`MCP server ${name} requires command or url`);
  const headers = requireObject(config["headers"] ?? {}, "MCP headers");
  return NormalizedResourceSchema.parse({
    kind: "mcp",
    data: {
      name,
      transport: {
        kind: config["type"] === "sse" ? "sse" : "http",
        endpoint: { baseUrl: toSecretAwareString(url), query: {} },
        headers: Object.fromEntries(
          Object.entries(headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(([key, value]) => [key, toSecretAwareString(value, key)]),
        ),
      },
      extensions: redactStructuredValue(withoutKeys(config, ["type", "url", "headers"])),
    },
  });
}

class OpenCodeAdapter extends BaseToolAdapter {
  readonly adapterId = AdapterIdSchema.parse("builtin-opencode");
  readonly adapterVersion = SemVerSchema.parse("0.2.0");
  readonly toolId = "opencode" as const;
  readonly capabilities = capabilities;

  async detect(context: DetectionContext): Promise<DetectionResult> {
    const installations = [];
    for (const root of [...context.candidateRoots].sort()) {
      if (root === context.homeDirectory) {
        const userRoots = await existingUserRoots(context, [
          markerPath(root, ".opencode"),
          markerPath(root, "opencode.json"),
          markerPath(root, "opencode.jsonc"),
          markerPath(root, "AGENTS.md"),
          markerPath(root, "CLAUDE.md"),
        ]);
        if (userRoots.length > 0) {
          installations.push({
            toolId: this.toolId,
            installationId: ToolInstallationIdSchema.parse(`opencode:user:${root}`),
            configRoots: userRoots,
            evidence: { scope: "user", markers: userRoots.map(String) },
          });
        }
        continue;
      }
      const markers = [
        markerPath(root, "opencode.json"),
        markerPath(root, "opencode.jsonc"),
        markerPath(root, ".opencode"),
        markerPath(root, "AGENTS.md"),
      ];
      if (
        (await Promise.all(markers.map((path) => context.read.stat(path)))).some(
          ({ kind }) => kind !== "missing",
        )
      ) {
        installations.push({
          toolId: this.toolId,
          installationId: ToolInstallationIdSchema.parse(`opencode:${root}`),
          configRoots: [root],
          evidence: { markers: markers.map(String) },
        });
      }
    }
    return { installations, diagnostics: [] };
  }

  async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    const candidates = [];
    const scopeKind = scopeKindFromEvidence(context.tool.evidence);
    for (const root of [...context.tool.configRoots].sort()) {
      const files = await documentedFiles({
        read: context.read,
        root,
        rootFileNames: ["AGENTS.md", "CLAUDE.md", "opencode.json", "opencode.jsonc"],
        relativeFiles:
          basename(root) === ".opencode"
            ? []
            : ["AGENTS.md", "CLAUDE.md", "opencode.json", "opencode.jsonc"],
        relativeDirectories:
          basename(root) === ".opencode"
            ? ["agents", "skills"]
            : [".opencode/agents", ".opencode/skills", ".agents/skills", ".claude/skills"],
        signal: context.signal,
      });
      for (const sourcePath of files) {
        const leaf = basename(sourcePath);
        const normalizedSourcePath = normalizePathSeparators(sourcePath);
        if (leaf === "AGENTS.md" || leaf === "CLAUDE.md") {
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
        } else if (normalizedSourcePath.includes("/.opencode/agents/") && leaf.endsWith(".md")) {
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
          (normalizedSourcePath.includes("/.opencode/skills/") ||
            normalizedSourcePath.includes("/.agents/skills/") ||
            normalizedSourcePath.includes("/.claude/skills/")) &&
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
        } else if (leaf === "opencode.json" || leaf === "opencode.jsonc") {
          const document = parseJsoncObject(await context.read.readText(sourcePath));
          if (document["agent"] !== undefined)
            candidates.push(
              candidate({
                toolId: this.toolId,
                root,
                sourcePath,
                sourceFormat: "jsonc",
                resourceKind: "agent",
                scopeKind,
              }),
            );
          if (document["mcp"] !== undefined)
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
          for (const instructionPath of await configuredInstructionPaths({
            read: context.read,
            baseRoot: dirname(sourcePath),
            instructions: stringList(document["instructions"]),
            signal: context.signal,
          })) {
            candidates.push(
              candidate({
                toolId: this.toolId,
                root,
                sourcePath: instructionPath,
                sourceFormat: "markdown",
                resourceKind: "rule",
                scopeRoot: dirname(instructionPath),
                scopeKind,
              }),
            );
          }
        }
      }
    }
    return {
      candidates: candidates.sort((left, right) =>
        `${left.sourcePath}:${left.resourceKindHint ?? ""}`.localeCompare(
          `${right.sourcePath}:${right.resourceKindHint ?? ""}`,
        ),
      ),
      diagnostics: [],
    };
  }

  parse(context: ParseContext): Promise<ParseResult> {
    context.signal.throwIfAborted();
    if (context.candidate.resourceKindHint === "skill") return parseSkillPackage(context);
    const isConfig = basename(context.candidate.sourcePath).startsWith("opencode.json");
    const result =
      isConfig && context.candidate.resourceKindHint === "agent"
        ? parseConfigAgents(context)
        : isConfig && context.candidate.resourceKindHint === "mcp"
          ? parseConfigMcp(context)
          : parseMarkdownAsset(
              context.candidate,
              context.snapshot.text,
              context.snapshot.contentHash,
            );
    return Promise.resolve(result);
  }
}

async function configuredInstructionPaths(input: {
  readonly read: DiscoveryContext["read"];
  readonly baseRoot: AbsolutePath;
  readonly instructions: readonly string[];
  readonly signal: DiscoveryContext["signal"];
}): Promise<readonly AbsolutePath[]> {
  const files = [];
  for (const instruction of input.instructions) {
    if (isAbsolute(instruction) || URL.canParse(instruction)) continue;
    const normalized = instruction.split(/[\\/]/).filter((segment) => segment.length > 0);
    if (
      normalized.length === 0 ||
      normalized.includes("..") ||
      normalized.some((segment) => segment.includes("\0"))
    ) {
      continue;
    }
    if (!hasGlobSyntax(instruction)) {
      const path = markerPath(input.baseRoot, ...pathSegments(instruction));
      if ((await input.read.stat(path)).kind === "file") {
        files.push(await input.read.realpath(path));
      }
      continue;
    }

    const staticRoot = staticGlobRoot(normalized);
    const searchRoot =
      staticRoot.length === 0 ? input.baseRoot : markerPath(input.baseRoot, ...staticRoot);
    const candidates =
      (await input.read.stat(searchRoot)).kind === "directory"
        ? await walkRelativeDirectories(input.read, searchRoot, ["."], input.signal)
        : [];
    const pattern = globPattern(instruction);
    for (const path of candidates) {
      if (pattern.test(relative(input.baseRoot, path).split(sep).join("/"))) files.push(path);
    }
  }
  return uniquePaths(files);
}

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function pathSegments(path: string): readonly string[] {
  return path.split(/[\\/]/).filter((segment) => segment.length > 0 && segment !== ".");
}

function hasGlobSyntax(path: string): boolean {
  return /[*?[\]{}]/.test(path);
}

function staticGlobRoot(segments: readonly string[]): readonly string[] {
  const staticSegments = [];
  for (const segment of segments) {
    if (hasGlobSyntax(segment)) break;
    staticSegments.push(segment);
  }
  return staticSegments;
}

function globPattern(glob: string): RegExp {
  const normalized = glob.split(/[\\/]/).join("/");
  let pattern = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized.charAt(index);
    const next = normalized.charAt(index + 1);
    if (character === "*" && next === "*") {
      pattern += ".*";
      index += 1;
    } else if (character === "*") {
      pattern += "[^/]*";
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegExp(character);
    }
  }
  return new RegExp(`${pattern}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
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

export const opencodeRegistration: AdapterRegistration = {
  contractVersion: 1,
  adapterId: AdapterIdSchema.parse("builtin-opencode"),
  adapterVersion: SemVerSchema.parse("0.2.0"),
  toolId: "opencode",
  capabilities,
  create: ({ logger }) => new OpenCodeAdapter(logger),
};
