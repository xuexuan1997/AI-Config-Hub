import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

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
  AbsolutePathSchema,
  AdapterIdSchema,
  SemVerRangeSchema,
  SemVerSchema,
  ToolInstallationIdSchema,
} from "@ai-config-hub/shared";

import { BaseToolAdapter } from "./base-adapter.js";
import { conversionCapabilities } from "./conversion.js";
import { candidate, markerPath, walkFiles } from "./discovery.js";
import {
  parseMarkdownAsset,
  rejectedParse,
  stringList,
  stringValue,
  withoutKeys,
} from "./markdown-assets.js";
import { redactStructuredValue, toSecretAwareString } from "./secrets.js";
import { parseJsoncObject, requireObject } from "./structured-config.js";

const capabilities: AdapterCapabilities = {
  supportedToolVersions: SemVerRangeSchema.parse(">=1.0.0"),
  testedToolVersions: [SemVerSchema.parse("1.0.0")],
  readableSchemaVersions: [SemVerRangeSchema.parse("^1.0.0")],
  writtenSchemaVersion: SemVerSchema.parse("1.0.0"),
  resourceKinds: ["rule", "agent", "skill", "mcp"],
  scopeKinds: ["user", "project", "directory"],
  supportsNestedScopes: true,
  conversions: conversionCapabilities,
};

function asset(
  context: ParseContext,
  locator: string,
  resource: ParsedAsset["resource"],
): ParsedAsset {
  return {
    toolId: context.candidate.toolId,
    canonicalSourcePath: context.candidate.sourcePath,
    locator,
    scope: context.candidate.scope,
    sourceFormat: context.candidate.sourceFormat,
    sourceContentHash: context.snapshot.contentHash,
    resource,
    references: [],
    extensions: {},
  };
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
        const resource = NormalizedResourceSchema.parse({
          kind: "agent",
          data: {
            name,
            instructions,
            ...(stringValue(config["model"]) === undefined
              ? {}
              : { model: stringValue(config["model"]) }),
            allowedTools: stringList(config["tools"]),
            extensions: redactStructuredValue(withoutKeys(config, ["prompt", "model", "tools"])),
          },
        });
        return asset(context, `agent:${name}`, resource);
      });
    return { status: "parsed", assets, diagnostics: [] };
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
      .map(([name, value]) => {
        const config = requireObject(value, `MCP server ${name}`);
        const command = stringList(config["command"]);
        const resource =
          command.length > 0 ? localMcp(name, config, command) : remoteMcp(name, config);
        return asset(context, `mcp:${name}`, resource);
      });
    return { status: "parsed", assets, diagnostics: [] };
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
  readonly adapterVersion = SemVerSchema.parse("0.1.0");
  readonly toolId = "opencode" as const;
  readonly capabilities = capabilities;

  async detect(context: DetectionContext): Promise<DetectionResult> {
    const installations = [];
    for (const root of [...context.candidateRoots].sort()) {
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
    for (const root of [...context.tool.configRoots].sort()) {
      const files = await walkFiles(context.read, root, context.signal);
      const fileSet = new Set(files);
      for (const sourcePath of files) {
        const leaf = basename(sourcePath);
        if (leaf === "AGENTS.md" || leaf === "CLAUDE.md") {
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
        } else if (
          sourcePath.includes(`${sep}.opencode${sep}agents${sep}`) &&
          leaf.endsWith(".md")
        ) {
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
          (sourcePath.includes(`${sep}.opencode${sep}skills${sep}`) ||
            sourcePath.includes(`${sep}.agents${sep}skills${sep}`) ||
            sourcePath.includes(`${sep}.claude${sep}skills${sep}`)) &&
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
              }),
            );
          for (const instruction of stringList(document["instructions"])) {
            if (isAbsolute(instruction) || URL.canParse(instruction)) continue;
            const instructionPath = AbsolutePathSchema.safeParse(resolve(root, instruction));
            if (instructionPath.success && fileSet.has(instructionPath.data)) {
              candidates.push(
                candidate({
                  toolId: this.toolId,
                  root,
                  sourcePath: instructionPath.data,
                  sourceFormat: "markdown",
                  resourceKind: "rule",
                  scopeRoot: dirname(instructionPath.data),
                }),
              );
            }
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

export const opencodeRegistration: AdapterRegistration = {
  contractVersion: 1,
  adapterId: AdapterIdSchema.parse("builtin-opencode"),
  adapterVersion: SemVerSchema.parse("0.1.0"),
  toolId: "opencode",
  capabilities,
  create: ({ logger }) => new OpenCodeAdapter(logger),
};
