import { basename, dirname, extname } from "node:path";

import type {
  AdapterDiagnostic,
  DiscoveredResource,
  ParseResult,
  ParsedAsset,
} from "@ai-config-hub/core";
import { NormalizedResourceSchema } from "@ai-config-hub/core";

import { ConfigParseError, parseFrontmatter } from "./frontmatter.js";
import { redactStructuredValue, toSecretAwareString } from "./secrets.js";
import { parseJsoncObject, requireObject } from "./structured-config.js";
import { adapterDiagnostic } from "./base-adapter.js";

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function stringList(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string")
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  return [];
}

export function withoutKeys(
  source: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key))),
  );
}

export function isEmptyRecord(value: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(value).length === 0;
}

function inferredName(candidate: DiscoveredResource): string {
  const file = basename(candidate.sourcePath);
  if (file === "SKILL.md") return basename(dirname(candidate.sourcePath));
  return file.slice(0, Math.max(1, file.length - extname(file).length));
}

export function parseMarkdownAsset(
  candidate: DiscoveredResource,
  text: string,
  sourceContentHash: ParsedAsset["sourceContentHash"],
): ParseResult {
  try {
    const parsed = parseFrontmatter(text);
    const kind = candidate.resourceKindHint ?? "rule";
    const name = stringValue(parsed.attributes["name"]) ?? inferredName(candidate);
    const extensions = redactStructuredValue(
      withoutKeys(parsed.attributes, [
        "name",
        "description",
        "model",
        "tools",
        "allowedTools",
        "globs",
        "references",
      ]),
    ) as Readonly<Record<string, unknown>>;
    const instructions = parsed.body.trim() === "" ? text.trim() : parsed.body.trim();
    const resource = NormalizedResourceSchema.parse(
      kind === "agent"
        ? {
            kind,
            data: {
              name,
              instructions,
              ...(stringValue(parsed.attributes["model"]) === undefined
                ? {}
                : { model: stringValue(parsed.attributes["model"]) }),
              allowedTools: stringList(
                parsed.attributes["tools"] ?? parsed.attributes["allowedTools"],
              ),
              extensions,
            },
          }
        : kind === "skill"
          ? {
              kind,
              data: {
                name,
                ...(stringValue(parsed.attributes["description"]) === undefined
                  ? {}
                  : { description: stringValue(parsed.attributes["description"]) }),
                instructions,
                references: stringList(parsed.attributes["references"]),
                extensions,
              },
            }
          : {
              kind: "rule",
              data: {
                name,
                instructions,
                globs: stringList(parsed.attributes["globs"]),
                extensions,
              },
            },
    );
    const locator = `${kind}:${name}`;
    return {
      status: "parsed",
      assets: [
        {
          toolId: candidate.toolId,
          canonicalSourcePath: candidate.sourcePath,
          locator,
          scope: candidate.scope,
          sourceFormat: candidate.sourceFormat,
          sourceContentHash,
          resource,
          references: kind === "skill" ? stringList(parsed.attributes["references"]) : [],
          extensions: {},
        },
      ],
      diagnostics: [],
    };
  } catch (error) {
    return rejectedParse(candidate, error);
  }
}

export function mcpResource(name: string, value: unknown) {
  const config = requireObject(value, `MCP server ${name}`);
  const command = stringValue(config["command"]);
  if (command !== undefined) {
    const args = stringList(config["args"]).map((arg) => toSecretAwareString(arg));
    const envSource = config["env"] === undefined ? {} : requireObject(config["env"], "MCP env");
    const env = Object.fromEntries(
      Object.entries(envSource)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, item]) => [key, toSecretAwareString(item, environmentKey(key))]),
    );
    return NormalizedResourceSchema.parse({
      kind: "mcp",
      data: { name, transport: { kind: "stdio", command, args, env }, extensions: {} },
    });
  }
  const urlValue = stringValue(config["url"]);
  if (urlValue === undefined) throw new ConfigParseError(`MCP server ${name} needs command or url`);
  const url = new URL(urlValue);
  const headersSource =
    config["headers"] === undefined ? {} : requireObject(config["headers"], "MCP headers");
  const headers = Object.fromEntries(
    Object.entries(headersSource)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, item]) => [key, toSecretAwareString(item, key)]),
  );
  const query: Record<string, ReturnType<typeof toSecretAwareString>[]> = {};
  for (const [key, item] of url.searchParams) {
    (query[key] ??= []).push(toSecretAwareString(item, key));
  }
  const username = url.username;
  const password = url.password;
  url.username = "";
  url.password = "";
  url.search = "";
  return NormalizedResourceSchema.parse({
    kind: "mcp",
    data: {
      name,
      transport: {
        kind: config["type"] === "sse" ? "sse" : "http",
        endpoint: {
          baseUrl: toSecretAwareString(url.toString()),
          query,
          ...(username === ""
            ? {}
            : {
                userInfo: {
                  username: toSecretAwareString(username, "credential"),
                  ...(password === ""
                    ? {}
                    : { password: toSecretAwareString(password, "credential") }),
                },
              }),
        },
        headers,
      },
      extensions: redactStructuredValue(
        withoutKeys(config, ["command", "args", "env", "url", "headers", "type"]),
      ),
    },
  });
}

function environmentKey(key: string): string {
  return /^\$?\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(key) ? "credential" : key;
}

export function parseMcpJson(
  candidate: DiscoveredResource,
  text: string,
  sourceContentHash: ParsedAsset["sourceContentHash"],
): ParseResult {
  try {
    const document = parseJsoncObject(text);
    const servers = requireObject(document["mcpServers"], "mcpServers");
    const assets = Object.entries(servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, config]) => {
        const mcpConfig = requireObject(config, `MCP server ${name}`);
        if (isEmptyRecord(mcpConfig)) return [];
        return [
          {
            toolId: candidate.toolId,
            canonicalSourcePath: candidate.sourcePath,
            locator: `mcp:${name}`,
            scope: candidate.scope,
            sourceFormat: candidate.sourceFormat,
            sourceContentHash,
            resource: mcpResource(name, mcpConfig),
            references: [],
            extensions: {},
          },
        ];
      });
    return { status: "parsed", assets, diagnostics: [] };
  } catch (error) {
    return rejectedParse(candidate, error);
  }
}

export function rejectedParse(candidate: DiscoveredResource, error: unknown): ParseResult {
  const location =
    error instanceof ConfigParseError
      ? { path: candidate.sourcePath, line: error.line, column: error.column }
      : { path: candidate.sourcePath };
  const diagnostic: AdapterDiagnostic = adapterDiagnostic(
    "ADAPTER_PARSE_INVALID",
    "error",
    "The configuration file could not be parsed",
    true,
    location,
  );
  return { status: "rejected", assets: [], diagnostics: [diagnostic] };
}
