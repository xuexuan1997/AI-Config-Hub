import { createHash } from "node:crypto";

import {
  ConversionResultSchema,
  type Asset,
  type ConvertedOutput,
  ConvertedOutputSchema,
  type ConversionContext,
  type ConversionResult,
  type FieldTransformation,
  type NormalizedResource,
  type SecretAwareString,
} from "@ai-config-hub/core";
import {
  ContentHashSchema,
  ConversionResultIdSchema,
  type JsonPointer,
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

type RuleResource = Extract<NormalizedResource, { kind: "rule" }>;
type AgentResource = Extract<NormalizedResource, { kind: "agent" }>;
type SkillResource = Extract<NormalizedResource, { kind: "skill" }>;
type McpResource = Extract<NormalizedResource, { kind: "mcp" }>;
type RemoteMcpTransport = Extract<McpResource["data"]["transport"], { kind: "http" | "sse" }>;
type BuiltInToolId = "claude-code" | "cursor" | "codex" | "opencode";
type JsonMcpToolId = Exclude<BuiltInToolId, "codex">;

const agentDirectories = {
  "claude-code": ".claude/agents",
  cursor: ".cursor/agents",
  opencode: ".opencode/agents",
} as const satisfies Record<Exclude<BuiltInToolId, "codex">, string>;

const skillDirectories = {
  "claude-code": ".claude/skills",
  cursor: ".cursor/skills",
  codex: ".agents/skills",
  opencode: ".opencode/skills",
} as const satisfies Record<BuiltInToolId, string>;

const jsonMcpPaths = {
  "claude-code": ".mcp.json",
  cursor: ".cursor/mcp.json",
  opencode: "opencode.json",
} as const satisfies Record<JsonMcpToolId, string>;

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
  return ConvertedOutputSchema.parse({
    deploymentType: "generated_file",
    relativePath,
    mediaType,
    text,
    contentHash: hash(text),
  });
}

function sourceOutput(relativePath: string, source: Asset["sourceFiles"][number]): ConvertedOutput {
  return ConvertedOutputSchema.parse({
    deploymentType: "copy",
    relativePath,
    mediaType: source.mediaType,
    sourcePath: source.path,
    sourceHash: source.contentHash,
    contentHash: source.contentHash,
  });
}

function value(item: SecretAwareString): string {
  if (item.kind === "redacted") throw new TypeError("Redacted secrets are not deployable");
  return item.kind === "literal" ? item.value : item.expression;
}

function hasNonDeployableSecret(resource: NormalizedResource): boolean {
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

function renderResource(target: ToolId, resource: NormalizedResource): ConvertedOutput {
  switch (resource.kind) {
    case "rule":
      return renderRule(target, resource);
    case "agent":
      return renderAgent(target, resource);
    case "skill":
      return renderSkill(target, resource).outputs[0]!;
    case "mcp":
      return renderMcp(target, resource);
  }
}

function renderRule(target: ToolId, resource: RuleResource): ConvertedOutput {
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

function renderAgent(target: ToolId, resource: AgentResource): ConvertedOutput {
  if (target === "codex") return renderCodexAgent(resource);
  const directory = agentDirectories[jsonMcpTarget(target)];
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

interface SkillRenderResult {
  readonly outputs: readonly ConvertedOutput[];
  readonly transformedFields: readonly FieldTransformation[];
  readonly droppedFields: readonly JsonPointer[];
  readonly warnings: readonly string[];
}

function renderSkill(target: ToolId, resource: SkillResource, asset?: Asset): SkillRenderResult {
  const builtIn = builtInTarget(target);
  const targetName = skillTargetName(builtIn, resource, asset);
  const frontmatterName =
    builtIn === "cursor" || builtIn === "opencode" ? targetName : resource.data.name;
  const transformedFields: FieldTransformation[] = [];
  const droppedFields: JsonPointer[] = [];
  const warnings: string[] = [];

  if (frontmatterName !== resource.data.name) {
    transformedFields.push({
      sourceField: "/data/name",
      targetField: "/frontmatter/name",
      reason: `${target} Skill names must be lower-hyphen and match the target directory`,
    });
    warnings.push(`${target} Skill name converted to target-required name: ${frontmatterName}`);
  }

  const description = resource.data.description ?? `Imported ${resource.data.name} skill`;
  if (resource.data.description === undefined) {
    droppedFields.push("/data/description");
    warnings.push(`${target} Skill description was missing; used deterministic fallback`);
  }

  const directory = skillDirectories[builtInTarget(target)];
  const skillRoot = `${directory}/${targetName}`;
  const skillText = frontmatter(
    {
      name: frontmatterName,
      description,
      ...(resource.data.references.length === 0 ? {} : { references: resource.data.references }),
    },
    resource.data.instructions,
  );
  const outputs: ConvertedOutput[] = [output(`${skillRoot}/SKILL.md`, "text/markdown", skillText)];

  if (asset !== undefined) {
    for (const source of [...asset.sourceFiles].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    )) {
      if (source.role === "primary") continue;
      outputs.push(sourceOutput(`${skillRoot}/${source.relativePath}`, source));
    }
  }

  return { outputs, transformedFields, droppedFields, warnings };
}

function skillTargetName(target: BuiltInToolId, resource: SkillResource, asset?: Asset): string {
  switch (target) {
    case "claude-code":
      return (
        asset?.nativeIdentity.invocationName ??
        asset?.nativeIdentity.directoryName ??
        slug(resource.data.name)
      );
    case "codex":
      return asset?.nativeIdentity.directoryName ?? slug(resource.data.name);
    case "cursor":
      return slug(resource.data.name);
    case "opencode":
      return slug(resource.data.name).slice(0, 64).replace(/-+$/g, "");
  }
}

function renderMcp(target: ToolId, resource: McpResource): ConvertedOutput {
  return target === "codex"
    ? renderCodexMcp(resource)
    : renderJsonMcp(jsonMcpTarget(target), resource);
}

function renderCodexAgent(resource: AgentResource): ConvertedOutput {
  const lines = [
    `name = ${JSON.stringify(resource.data.name)}`,
    `description = ${JSON.stringify(resource.data.description ?? `Imported ${resource.data.name} agent`)}`,
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

function jsonMcpConfig(resource: McpResource, target: ToolId) {
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

function remoteUrl(transport: RemoteMcpTransport) {
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

function renderJsonMcp(target: JsonMcpToolId, resource: McpResource): ConvertedOutput {
  const document =
    target === "opencode"
      ? { mcp: { [resource.data.name]: jsonMcpConfig(resource, target) } }
      : { mcpServers: { [resource.data.name]: jsonMcpConfig(resource, target) } };
  return output(jsonMcpPaths[target], "application/json", `${JSON.stringify(document, null, 2)}\n`);
}

function builtInTarget(target: ToolId): BuiltInToolId {
  switch (target) {
    case "claude-code":
      return "claude-code";
    case "cursor":
      return "cursor";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    default:
      throw new TypeError(`Unsupported conversion target: ${target}`);
  }
}

function jsonMcpTarget(target: ToolId): JsonMcpToolId {
  const builtIn = builtInTarget(target);
  if (builtIn === "codex") throw new TypeError("Codex uses TOML MCP rendering");
  return builtIn;
}

function renderCodexMcp(resource: McpResource): ConvertedOutput {
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

function droppedFields(target: ToolId, resource: NormalizedResource): JsonPointer[] {
  const fields: JsonPointer[] = extensionPointers(resource.data.extensions);

  if (resource.kind === "rule" && target !== "cursor" && resource.data.globs.length > 0) {
    fields.push("/data/globs");
  }
  if (resource.kind === "agent" && target === "codex" && resource.data.allowedTools.length > 0) {
    fields.push("/data/allowedTools");
  }
  if (resource.kind === "agent" && target === "codex" && resource.data.description === undefined) {
    fields.push("/data/description");
  }

  return fields;
}

function extensionPointers(extensions: Readonly<Record<string, unknown>>): JsonPointer[] {
  return Object.keys(extensions)
    .sort()
    .map((key) => `/data/extensions/${escapeJsonPointerToken(key)}`);
}

function escapeJsonPointerToken(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function retainedFields(target: ToolId, resource: NormalizedResource): JsonPointer[] {
  switch (resource.kind) {
    case "rule":
      return target === "cursor" && resource.data.globs.length > 0
        ? ["/data/instructions", "/data/globs"]
        : ["/data/instructions"];
    case "agent":
      return [
        "/data/name",
        ...(resource.data.description === undefined ? [] : ["/data/description"]),
        "/data/instructions",
        ...(resource.data.model === undefined ? [] : ["/data/model"]),
        ...(target === "codex" || resource.data.allowedTools.length === 0
          ? []
          : ["/data/allowedTools"]),
      ];
    case "skill":
      return [
        "/data/name",
        "/data/instructions",
        ...(resource.data.description === undefined ? [] : ["/data/description"]),
        ...(resource.data.references.length === 0 ? [] : ["/data/references"]),
      ];
    case "mcp":
      return ["/data/name", "/data/transport"];
  }
}

function conversionWarning(fields: readonly JsonPointer[]): string {
  return `Some source fields are not expressible in the target format: ${fields.join(", ")}`;
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
  if (hasNonDeployableSecret(context.asset.resource)) {
    return ConversionResultSchema.parse({
      ...base,
      level: "unsupported",
      reasons: ["The source contains redacted values that cannot be reproduced safely"],
    });
  }
  let rendered:
    | {
        readonly outputs: readonly ConvertedOutput[];
        readonly transformedFields: readonly FieldTransformation[];
        readonly droppedFields: readonly JsonPointer[];
        readonly warnings: readonly string[];
      }
    | undefined;
  try {
    rendered =
      context.asset.resource.kind === "skill"
        ? renderSkill(targetToolId, context.asset.resource, context.asset)
        : {
            outputs: [renderResource(targetToolId, context.asset.resource)],
            transformedFields: [],
            droppedFields: [],
            warnings: [],
          };
  } catch {
    return ConversionResultSchema.parse({
      ...base,
      level: "unsupported",
      reasons: ["The normalized resource cannot be rendered safely for the target"],
    });
  }
  const fieldLosses = droppedFields(targetToolId, context.asset.resource);
  const losses = [...fieldLosses, ...rendered.droppedFields];
  const transformedFields = [...rendered.transformedFields];
  const warnings = [
    ...(fieldLosses.length === 0 ? [] : [conversionWarning(fieldLosses)]),
    ...rendered.warnings,
  ];
  return ConversionResultSchema.parse(
    losses.length === 0 && transformedFields.length === 0 && warnings.length === 0
      ? { ...base, level: "full", outputs: rendered.outputs }
      : {
          ...base,
          level: "partial",
          outputs: rendered.outputs,
          retainedFields: retainedFields(targetToolId, context.asset.resource),
          droppedFields: losses,
          transformedFields,
          warnings,
        },
  );
}
