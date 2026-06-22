import { createHash } from "node:crypto";

import {
  ConversionResultSchema,
  ConvertedOutputSchema,
  type ConversionContext,
  type ConversionResult,
  type NormalizedResource,
  type SecretAwareString,
} from "@ai-config-hub/core";
import {
  ContentHashSchema,
  ConversionResultIdSchema,
  type AdapterId,
  type SemVer,
  type ToolId,
} from "@ai-config-hub/shared";
import { stringify as stringifyYaml } from "yaml";

export const conversionCapabilities = (["rule", "agent", "skill", "mcp"] as const).map(
  (resourceKind) => ({
    resourceKind,
    targets: ["claude-code", "cursor", "codex", "opencode"] as const,
  }),
);

function hash(text: string) {
  return ContentHashSchema.parse(
    `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
  );
}

function slug(value: string): string {
  const result = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (result === "") throw new TypeError("Resource name cannot form a safe target filename");
  return result;
}

function frontmatter(attributes: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(attributes, { lineWidth: 0 })}---\n${body.trim()}\n`;
}

function output(relativePath: string, mediaType: string, text: string) {
  return ConvertedOutputSchema.parse({ relativePath, mediaType, text, contentHash: hash(text) });
}

function value(item: SecretAwareString): string {
  if (item.kind === "redacted") throw new TypeError("Redacted secrets are not deployable");
  return item.kind === "literal" ? item.value : item.expression;
}

function hasRedacted(resource: NormalizedResource): boolean {
  if (resource.kind !== "mcp") return false;
  const transport = resource.data.transport;
  if (transport.kind === "stdio") {
    return (
      transport.args.some(({ deployable }) => !deployable) ||
      Object.values(transport.env).some(({ deployable }) => !deployable)
    );
  }
  return (
    !transport.endpoint.baseUrl.deployable ||
    Object.values(transport.endpoint.query)
      .flat()
      .some(({ deployable }) => !deployable) ||
    (transport.endpoint.userInfo !== undefined &&
      (!transport.endpoint.userInfo.username.deployable ||
        transport.endpoint.userInfo.password?.deployable === false)) ||
    Object.values(transport.headers).some(({ deployable }) => !deployable)
  );
}

function renderMarkdownResource(target: ToolId, resource: NormalizedResource) {
  if (resource.kind === "rule") {
    if (target === "cursor") {
      return output(
        `.cursor/rules/${slug(resource.data.name ?? "rule")}.mdc`,
        "text/markdown",
        frontmatter(
          {
            description: resource.data.name ?? "AI Config Hub rule",
            ...(resource.data.globs.length === 0 ? {} : { globs: resource.data.globs }),
          },
          resource.data.instructions,
        ),
      );
    }
    return output(
      target === "claude-code" ? "CLAUDE.md" : "AGENTS.md",
      "text/markdown",
      `${resource.data.instructions.trim()}\n`,
    );
  }
  if (resource.kind === "agent") {
    if (target === "codex") return renderCodexAgent(resource);
    const directory =
      target === "claude-code"
        ? ".claude/agents"
        : target === "cursor"
          ? ".cursor/agents"
          : ".opencode/agents";
    return output(
      `${directory}/${slug(resource.data.name)}.md`,
      "text/markdown",
      frontmatter(
        {
          name: resource.data.name,
          ...(resource.data.model === undefined ? {} : { model: resource.data.model }),
          ...(resource.data.allowedTools.length === 0 ? {} : { tools: resource.data.allowedTools }),
        },
        resource.data.instructions,
      ),
    );
  }
  if (resource.kind === "skill") {
    const directory =
      target === "claude-code"
        ? ".claude/skills"
        : target === "cursor"
          ? ".cursor/skills"
          : target === "codex"
            ? ".agents/skills"
            : ".opencode/skills";
    return output(
      `${directory}/${slug(resource.data.name)}/SKILL.md`,
      "text/markdown",
      frontmatter(
        {
          name: resource.data.name,
          ...(resource.data.description === undefined
            ? {}
            : { description: resource.data.description }),
          ...(resource.data.references.length === 0
            ? {}
            : { references: resource.data.references }),
        },
        resource.data.instructions,
      ),
    );
  }
  return target === "codex" ? renderCodexMcp(resource) : renderJsonMcp(target, resource);
}

function renderCodexAgent(resource: Extract<NormalizedResource, { kind: "agent" }>) {
  const lines = [
    `name = ${JSON.stringify(resource.data.name)}`,
    `description = ${JSON.stringify(resource.data.name)}`,
    `developer_instructions = ${JSON.stringify(resource.data.instructions)}`,
  ];
  if (resource.data.model !== undefined)
    lines.push(`model = ${JSON.stringify(resource.data.model)}`);
  return output(
    `.codex/agents/${slug(resource.data.name)}.toml`,
    "application/toml",
    `${lines.join("\n")}\n`,
  );
}

function jsonMcpConfig(resource: Extract<NormalizedResource, { kind: "mcp" }>, target: ToolId) {
  const transport = resource.data.transport;
  if (transport.kind === "stdio") {
    if (target === "opencode") {
      return {
        type: "local",
        command: [transport.command, ...transport.args.map(value)],
        environment: Object.fromEntries(
          Object.entries(transport.env).map(([key, item]) => [key, value(item)]),
        ),
      };
    }
    return {
      command: transport.command,
      args: transport.args.map(value),
      env: Object.fromEntries(
        Object.entries(transport.env).map(([key, item]) => [key, value(item)]),
      ),
    };
  }
  return {
    type: target === "opencode" ? "remote" : transport.kind,
    url: remoteUrl(transport),
    headers: Object.fromEntries(
      Object.entries(transport.headers).map(([key, item]) => [key, value(item)]),
    ),
  };
}

function remoteUrl(
  transport: Extract<
    Extract<NormalizedResource, { kind: "mcp" }>["data"]["transport"],
    { kind: "http" | "sse" }
  >,
) {
  const base = value(transport.endpoint.baseUrl);
  const url = new URL(base);
  for (const [key, items] of Object.entries(transport.endpoint.query)) {
    for (const item of items) url.searchParams.append(key, value(item));
  }
  if (transport.endpoint.userInfo !== undefined) {
    url.username = value(transport.endpoint.userInfo.username);
    if (transport.endpoint.userInfo.password !== undefined)
      url.password = value(transport.endpoint.userInfo.password);
  }
  return url.toString();
}

function renderJsonMcp(target: ToolId, resource: Extract<NormalizedResource, { kind: "mcp" }>) {
  const document =
    target === "opencode"
      ? { mcp: { [resource.data.name]: jsonMcpConfig(resource, target) } }
      : { mcpServers: { [resource.data.name]: jsonMcpConfig(resource, target) } };
  const path =
    target === "claude-code"
      ? ".mcp.json"
      : target === "cursor"
        ? ".cursor/mcp.json"
        : "opencode.json";
  return output(path, "application/json", `${JSON.stringify(document, null, 2)}\n`);
}

function renderCodexMcp(resource: Extract<NormalizedResource, { kind: "mcp" }>) {
  const transport = resource.data.transport;
  const section = `mcp_servers.${JSON.stringify(resource.data.name)}`;
  const lines = [`[${section}]`];
  if (transport.kind === "stdio") {
    lines.push(`command = ${JSON.stringify(transport.command)}`);
    if (transport.args.length > 0)
      lines.push(
        `args = [${transport.args.map((item) => JSON.stringify(value(item))).join(", ")}]`,
      );
    const references: string[] = [];
    const literals: [string, string][] = [];
    for (const [key, item] of Object.entries(transport.env)) {
      if (item.kind === "reference") references.push(item.expression.replace(/^\$\{?|\}$/g, ""));
      else literals.push([key, value(item)]);
    }
    if (references.length > 0)
      lines.push(`env_vars = [${references.map((item) => JSON.stringify(item)).join(", ")}]`);
    if (literals.length > 0) {
      lines.push(
        "",
        `[${section}.env]`,
        ...literals.map(([key, item]) => `${JSON.stringify(key)} = ${JSON.stringify(item)}`),
      );
    }
  } else {
    lines.push(`url = ${JSON.stringify(remoteUrl(transport))}`);
    if (Object.keys(transport.headers).length > 0) {
      lines.push("", `[${section}.http_headers]`);
      for (const [key, item] of Object.entries(transport.headers))
        lines.push(`${JSON.stringify(key)} = ${JSON.stringify(value(item))}`);
    }
  }
  return output(".codex/config.toml", "application/toml", `${lines.join("\n")}\n`);
}

function conversionId(context: ConversionContext, adapterId: AdapterId, adapterVersion: SemVer) {
  return ConversionResultIdSchema.parse(
    `conversion:${hash([context.asset.assetId, context.asset.contentHash, context.target.toolId, context.target.resourceKind, context.target.targetSchemaVersion, adapterId, adapterVersion].join("\0"))}`,
  );
}

export function convertAsset(
  context: ConversionContext,
  adapterId: AdapterId,
  adapterVersion: SemVer,
  targetToolId: ToolId,
): ConversionResult {
  context.signal.throwIfAborted();
  const base = {
    conversionResultId: conversionId(context, adapterId, adapterVersion),
    sourceAssetId: context.asset.assetId,
    sourceContentHash: context.asset.contentHash,
    targetToolId: context.target.toolId,
    targetResourceKind: context.target.resourceKind,
    targetSchemaVersion: context.target.targetSchemaVersion,
    adapterId,
    adapterVersion,
    diagnostics: [],
  };
  if (
    context.target.toolId !== targetToolId ||
    context.target.resourceKind !== context.asset.resource.kind
  ) {
    return ConversionResultSchema.parse({
      ...base,
      level: "unsupported",
      reasons: ["The requested target does not match this adapter or resource kind"],
    });
  }
  if (hasRedacted(context.asset.resource)) {
    return ConversionResultSchema.parse({
      ...base,
      level: "unsupported",
      reasons: ["The source contains redacted values that cannot be reproduced safely"],
    });
  }
  let rendered;
  try {
    rendered = renderMarkdownResource(targetToolId, context.asset.resource);
  } catch {
    return ConversionResultSchema.parse({
      ...base,
      level: "unsupported",
      reasons: ["The normalized resource cannot be rendered safely for the target"],
    });
  }
  const losses: string[] = [];
  if (Object.keys(context.asset.resource.data.extensions).length > 0)
    losses.push("/data/extensions");
  if (
    context.asset.resource.kind === "rule" &&
    targetToolId !== "cursor" &&
    context.asset.resource.data.globs.length > 0
  )
    losses.push("/data/globs");
  return ConversionResultSchema.parse(
    losses.length === 0
      ? { ...base, level: "full", outputs: [rendered] }
      : {
          ...base,
          level: "partial",
          outputs: [rendered],
          retainedFields: ["/data/instructions"],
          droppedFields: losses,
          transformedFields: [],
          warnings: ["Some source fields are not expressible in the target format"],
        },
  );
}
