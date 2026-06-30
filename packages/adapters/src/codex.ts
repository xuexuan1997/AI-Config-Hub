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
  ParsedAsset,
} from "@ai-config-hub/core";
import { NormalizedResourceSchema } from "@ai-config-hub/core";
import {
  AdapterIdSchema,
  SemVerRangeSchema,
  SemVerSchema,
  ToolInstallationIdSchema,
} from "@ai-config-hub/shared";

import { BaseToolAdapter } from "./base-adapter.js";
import { conversionCapabilities } from "./conversion.js";
import { candidate, documentedFiles, markerPath, scopeKindFromEvidence } from "./discovery.js";
import {
  parseMarkdownAsset,
  rejectedParse,
  stringList,
  stringValue,
  withoutKeys,
} from "./markdown-assets.js";
import { redactStructuredValue, toSecretAwareString } from "./secrets.js";
import { parseTomlObject, requireObject } from "./structured-config.js";

const capabilities: AdapterCapabilities = {
  supportedToolVersions: SemVerRangeSchema.parse(">=0.1.0"),
  testedToolVersions: [SemVerSchema.parse("0.101.0")],
  readableSchemaVersions: [SemVerRangeSchema.parse("^1.0.0")],
  writtenSchemaVersion: SemVerSchema.parse("1.0.0"),
  resourceKinds: ["rule", "agent", "skill", "mcp"],
  scopeKinds: ["user", "project", "directory"],
  supportsNestedScopes: true,
  conversions: conversionCapabilities,
};

function baseAsset(
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

function parseAgent(context: ParseContext): ParseResult {
  try {
    const document = parseTomlObject(context.snapshot.text);
    const name = stringValue(document["name"]);
    const instructions = stringValue(document["developer_instructions"]);
    if (name === undefined || instructions === undefined) {
      throw new TypeError("Codex agent requires name and developer_instructions");
    }
    const resource = NormalizedResourceSchema.parse({
      kind: "agent",
      data: {
        name,
        instructions,
        ...(stringValue(document["model"]) === undefined
          ? {}
          : { model: stringValue(document["model"]) }),
        allowedTools: [],
        extensions: redactStructuredValue(
          withoutKeys(document, ["name", "developer_instructions", "model"]),
        ),
      },
    });
    return {
      status: "parsed",
      assets: [baseAsset(context, `agent:${name}`, resource)],
      diagnostics: [],
    };
  } catch (error) {
    return rejectedParse(context.candidate, error);
  }
}

function reference(name: string) {
  return toSecretAwareString(`$${name}`);
}

function parseMcp(context: ParseContext): ParseResult {
  try {
    const document = parseTomlObject(context.snapshot.text);
    const servers = requireObject(document["mcp_servers"], "mcp_servers");
    const assets = Object.entries(servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => {
        const config = requireObject(value, `MCP server ${name}`);
        const command = stringValue(config["command"]);
        const url = stringValue(config["url"]);
        const resource =
          command !== undefined
            ? NormalizedResourceSchema.parse({
                kind: "mcp",
                data: {
                  name,
                  transport: {
                    kind: "stdio",
                    command,
                    args: stringList(config["args"]).map((item) => toSecretAwareString(item)),
                    env: Object.fromEntries(
                      stringList(config["env_vars"]).map((item) => [item, reference(item)]),
                    ),
                  },
                  extensions: redactStructuredValue(
                    withoutKeys(config, ["command", "args", "env_vars"]),
                  ),
                },
              })
            : remoteMcp(name, config, url);
        return baseAsset(context, `mcp:${name}`, resource);
      });
    return { status: "parsed", assets, diagnostics: [] };
  } catch (error) {
    return rejectedParse(context.candidate, error);
  }
}

function remoteMcp(name: string, config: Record<string, unknown>, url: string | undefined) {
  if (url === undefined) throw new TypeError(`MCP server ${name} requires command or url`);
  const headers = requireObject(config["http_headers"] ?? {}, "http_headers");
  const envHeaders = requireObject(config["env_http_headers"] ?? {}, "env_http_headers");
  const bearer = stringValue(config["bearer_token_env_var"]);
  return NormalizedResourceSchema.parse({
    kind: "mcp",
    data: {
      name,
      transport: {
        kind: "http",
        endpoint: { baseUrl: toSecretAwareString(url), query: {} },
        headers: {
          ...Object.fromEntries(
            Object.entries(headers)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string")
              .map(([key, value]) => [key, toSecretAwareString(value, key)]),
          ),
          ...Object.fromEntries(
            Object.entries(envHeaders)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string")
              .map(([key, value]) => [key, reference(value)]),
          ),
          ...(bearer === undefined ? {} : { Authorization: reference(bearer) }),
        },
      },
      extensions: redactStructuredValue(
        withoutKeys(config, ["url", "bearer_token_env_var", "http_headers", "env_http_headers"]),
      ),
    },
  });
}

class CodexAdapter extends BaseToolAdapter {
  readonly adapterId = AdapterIdSchema.parse("builtin-codex");
  readonly adapterVersion = SemVerSchema.parse("0.1.0");
  readonly toolId = "codex" as const;
  readonly capabilities = capabilities;

  async detect(context: DetectionContext): Promise<DetectionResult> {
    const installations = [];
    for (const root of [...context.candidateRoots].sort()) {
      if (root === context.homeDirectory) {
        const userRoots = await existingUserRoots(context, [
          markerPath(root, ".codex"),
          markerPath(root, ".agents"),
          markerPath(root, "AGENTS.md"),
        ]);
        if (userRoots.length > 0) {
          installations.push({
            toolId: this.toolId,
            installationId: ToolInstallationIdSchema.parse(`codex:user:${root}`),
            configRoots: userRoots,
            evidence: { scope: "user", markers: userRoots.map(String) },
          });
        }
        continue;
      }
      const markers = [markerPath(root, "AGENTS.md"), markerPath(root, ".codex")];
      if (
        (await Promise.all(markers.map((path) => context.read.stat(path)))).some(
          ({ kind }) => kind !== "missing",
        )
      ) {
        installations.push({
          toolId: this.toolId,
          installationId: ToolInstallationIdSchema.parse(`codex:${root}`),
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
        rootFileNames: ["AGENTS.override.md", "AGENTS.md", "config.toml"],
        relativeFiles:
          basename(root) === ".codex"
            ? ["config.toml"]
            : basename(root) === ".agents"
              ? []
              : ["AGENTS.override.md", "AGENTS.md", ".codex/config.toml"],
        relativeDirectories:
          basename(root) === ".codex"
            ? ["agents"]
            : basename(root) === ".agents"
              ? ["skills"]
              : [".codex/agents", ".agents/skills"],
        signal: context.signal,
      });
      const overrides = new Set(
        files
          .filter((path) => basename(path) === "AGENTS.override.md")
          .map((path) => dirname(path)),
      );
      for (const sourcePath of files) {
        const leaf = basename(sourcePath);
        if (
          leaf === "AGENTS.override.md" ||
          (leaf === "AGENTS.md" && !overrides.has(dirname(sourcePath)))
        ) {
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
        } else if (
          sourcePath.includes(`${sep}.codex${sep}agents${sep}`) &&
          leaf.endsWith(".toml")
        ) {
          candidates.push(
            candidate({
              toolId: this.toolId,
              root,
              sourcePath,
              sourceFormat: "toml",
              resourceKind: "agent",
              scopeKind,
            }),
          );
        } else if (sourcePath.includes(`${sep}.agents${sep}skills${sep}`) && leaf === "SKILL.md") {
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
        } else if (sourcePath.endsWith(`${sep}.codex${sep}config.toml`)) {
          candidates.push(
            candidate({
              toolId: this.toolId,
              root,
              sourcePath,
              sourceFormat: "toml",
              resourceKind: "mcp",
              scopeKind,
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
    const result =
      context.candidate.resourceKindHint === "agent"
        ? parseAgent(context)
        : context.candidate.resourceKindHint === "mcp"
          ? parseMcp(context)
          : parseMarkdownAsset(
              context.candidate,
              context.snapshot.text,
              context.snapshot.contentHash,
            );
    return Promise.resolve(result);
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

export const codexRegistration: AdapterRegistration = {
  contractVersion: 1,
  adapterId: AdapterIdSchema.parse("builtin-codex"),
  adapterVersion: SemVerSchema.parse("0.1.0"),
  toolId: "codex",
  capabilities,
  create: ({ logger }) => new CodexAdapter(logger),
};
