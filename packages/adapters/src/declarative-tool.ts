import { basename, dirname, extname, isAbsolute, relative, sep } from "node:path";

import type {
  AdapterCapabilities,
  AdapterLogger,
  AdapterRegistration,
  AdapterReadApi,
  CancellationSignal,
  DetectionContext,
  DetectionResult,
  DiscoveryContext,
  DiscoveryResult,
  ParseContext,
  ParseResult,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AdapterIdSchema,
  SemVerRangeSchema,
  SemVerSchema,
  ToolIdSchema,
  ToolInstallationIdSchema,
  type AbsolutePath,
  type ResourceKind,
  type ScopeKind,
} from "@ai-config-hub/shared";

import { BaseToolAdapter } from "./base-adapter.js";
import { conversionCapabilities } from "./conversion.js";
import {
  candidate,
  createAdapterDiscoveryBudget,
  markerPath,
  scopeKindFromEvidence,
  uniquePaths,
  walkFiles,
} from "./discovery.js";
import { parseMarkdownAsset, parseMcpJson } from "./markdown-assets.js";
import { parseSkillPackage } from "./skill-packages.js";

export interface DeclarativeResourceRule {
  readonly directories?: readonly string[];
  readonly extensions?: readonly string[];
  readonly entry_files?: readonly string[];
  readonly files?: readonly string[];
}

export interface DeclarativeToolDefinition {
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
  readonly detect?: {
    readonly executables?: readonly string[];
  };
  readonly paths: {
    readonly global?: readonly string[];
    readonly project?: readonly string[];
  };
  readonly resources: {
    readonly rules?: DeclarativeResourceRule;
    readonly agents?: DeclarativeResourceRule;
    readonly skills?: DeclarativeResourceRule;
    readonly mcp?: DeclarativeResourceRule;
  };
  readonly defaults?: {
    readonly scope?: ScopeKind;
    readonly precedence?: number;
    readonly deploymentMode?: "generated_file" | "in_place";
  };
}

interface ParsedDeclarativeResourceRule {
  readonly directories: readonly string[];
  readonly extensions: readonly string[];
  readonly entry_files: readonly string[];
  readonly files: readonly string[];
}

interface ParsedDeclarativeToolDefinition {
  readonly id: ReturnType<typeof ToolIdSchema.parse>;
  readonly name: string;
  readonly icon?: string;
  readonly detect: {
    readonly executables: readonly string[];
  };
  readonly paths: {
    readonly global: readonly string[];
    readonly project: readonly string[];
  };
  readonly resources: {
    readonly rules?: ParsedDeclarativeResourceRule;
    readonly agents?: ParsedDeclarativeResourceRule;
    readonly skills?: ParsedDeclarativeResourceRule;
    readonly mcp?: ParsedDeclarativeResourceRule;
  };
  readonly defaults?: {
    readonly scope?: ScopeKind;
    readonly precedence?: number;
    readonly deploymentMode?: "generated_file" | "in_place";
  };
}

export const DeclarativeToolDefinitionSchema = Object.freeze({
  parse(input: unknown): ParsedDeclarativeToolDefinition {
    return parseDefinition(input);
  },
  safeParse(
    input: unknown,
  ):
    | { readonly success: true; readonly data: ParsedDeclarativeToolDefinition }
    | { readonly success: false; readonly error: Error } {
    try {
      return { success: true, data: parseDefinition(input) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },
});

const adapterVersion = SemVerSchema.parse("0.1.0");

function parseDefinition(input: unknown): ParsedDeclarativeToolDefinition {
  const source = object(input, "declarative tool definition");
  exactKeys(source, ["id", "name", "icon", "detect", "paths", "resources", "defaults"]);
  const icon = optionalString(source["icon"], "icon", 120);
  const defaults =
    source["defaults"] === undefined
      ? undefined
      : parseDefaults(object(source["defaults"], "defaults"));
  return freezeDefined({
    id: ToolIdSchema.parse(requiredString(source["id"], "id", 200)),
    name: requiredString(source["name"], "name", 120),
    ...(icon === undefined ? {} : { icon }),
    detect: parseDetect(source["detect"]),
    paths: parsePaths(object(source["paths"], "paths")),
    resources: parseResources(object(source["resources"], "resources")),
    ...(defaults === undefined ? {} : { defaults }),
  });
}

function parseDetect(input: unknown): ParsedDeclarativeToolDefinition["detect"] {
  if (input === undefined) return Object.freeze({ executables: [] });
  const source = object(input, "detect");
  exactKeys(source, ["executables"]);
  return Object.freeze({
    executables: stringArray(source["executables"], "detect.executables", executableName),
  });
}

function parsePaths(source: Record<string, unknown>): ParsedDeclarativeToolDefinition["paths"] {
  exactKeys(source, ["global", "project"]);
  return Object.freeze({
    global: stringArray(source["global"], "paths.global", relativePath),
    project: stringArray(source["project"], "paths.project", relativePath),
  });
}

function parseResources(
  source: Record<string, unknown>,
): ParsedDeclarativeToolDefinition["resources"] {
  exactKeys(source, ["rules", "agents", "skills", "mcp"]);
  const rules = parseResourceRule(source["rules"], "resources.rules");
  const agents = parseResourceRule(source["agents"], "resources.agents");
  const skills = parseResourceRule(source["skills"], "resources.skills");
  const mcp = parseResourceRule(source["mcp"], "resources.mcp");
  return Object.freeze({
    ...(rules === undefined ? {} : { rules }),
    ...(agents === undefined ? {} : { agents }),
    ...(skills === undefined ? {} : { skills }),
    ...(mcp === undefined ? {} : { mcp }),
  });
}

function parseResourceRule(
  input: unknown,
  label: string,
): ParsedDeclarativeResourceRule | undefined {
  if (input === undefined) return undefined;
  const source = object(input, label);
  exactKeys(source, ["directories", "extensions", "entry_files", "files"]);
  return Object.freeze({
    directories: stringArray(source["directories"], `${label}.directories`, relativePath),
    extensions: stringArray(source["extensions"], `${label}.extensions`, extension),
    entry_files: stringArray(source["entry_files"], `${label}.entry_files`, relativePath),
    files: stringArray(source["files"], `${label}.files`, relativePath),
  });
}

function parseDefaults(
  source: Record<string, unknown>,
): ParsedDeclarativeToolDefinition["defaults"] {
  exactKeys(source, ["scope", "precedence", "deploymentMode"]);
  const scope = source["scope"];
  if (scope !== undefined && scope !== "user" && scope !== "project" && scope !== "directory") {
    throw new TypeError("defaults.scope must be user, project or directory");
  }
  const precedence = source["precedence"];
  if (
    precedence !== undefined &&
    (typeof precedence !== "number" || !Number.isInteger(precedence))
  ) {
    throw new TypeError("defaults.precedence must be an integer");
  }
  const deploymentMode = source["deploymentMode"];
  if (
    deploymentMode !== undefined &&
    deploymentMode !== "generated_file" &&
    deploymentMode !== "in_place"
  ) {
    throw new TypeError("defaults.deploymentMode must be generated_file or in_place");
  }
  const parsedDefaults: NonNullable<ParsedDeclarativeToolDefinition["defaults"]> = {
    ...(scope === undefined ? {} : { scope }),
    ...(precedence === undefined ? {} : { precedence }),
    ...(deploymentMode === undefined ? {} : { deploymentMode }),
  };
  return Object.freeze(parsedDefaults);
}

function object(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function exactKeys(source: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) throw new TypeError(`Unsupported declarative field: ${key}`);
  }
}

function requiredString(input: unknown, label: string, maxLength: number): string {
  const value = optionalString(input, label, maxLength);
  if (value === undefined) throw new TypeError(`${label} is required`);
  return value;
}

function optionalString(input: unknown, label: string, maxLength: number): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") throw new TypeError(`${label} must be a string`);
  const value = input.trim();
  if (value === "" || value.length > maxLength) {
    throw new TypeError(`${label} must be between 1 and ${String(maxLength)} characters`);
  }
  return value;
}

function stringArray(
  input: unknown,
  label: string,
  validate: (value: string, label: string) => string,
): readonly string[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array`);
  return Object.freeze(input.map((value) => validate(requiredString(value, label, 240), label)));
}

function relativePath(value: string, label: string): string {
  if (isAbsolute(value) || value.split(/[\\/]/).includes("..") || value.includes("\0")) {
    throw new TypeError(`${label} must contain safe relative paths`);
  }
  return value;
}

function extension(value: string, label: string): string {
  if (!/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new TypeError(`${label} must contain extensions like .md`);
  }
  return value;
}

function executableName(value: string, label: string): string {
  if (value.length > 120 || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new TypeError(`${label} must contain executable names, not shell commands`);
  }
  return value;
}

function freezeDefined<T extends Record<string, unknown>>(value: T): T {
  return Object.freeze(value);
}

function capabilitiesFor(definition: ParsedDeclarativeToolDefinition): AdapterCapabilities {
  return {
    supportedToolVersions: SemVerRangeSchema.parse(">=0.0.0"),
    testedToolVersions: [],
    readableSchemaVersions: [SemVerRangeSchema.parse("^1.1.0")],
    writtenSchemaVersion: SemVerSchema.parse("1.1.0"),
    resourceKinds: resourceKinds(definition),
    scopeKinds: ["user", "project", "directory"],
    supportsNestedScopes: true,
    conversions: conversionCapabilities,
  };
}

function resourceKinds(definition: ParsedDeclarativeToolDefinition): readonly ResourceKind[] {
  return (["rule", "agent", "skill", "mcp"] as const).filter((kind) => {
    const rule = ruleFor(definition, kind);
    return rule !== undefined && hasAnyDeclaration(rule);
  });
}

function ruleFor(
  definition: ParsedDeclarativeToolDefinition,
  kind: ResourceKind,
): ParsedDeclarativeResourceRule | undefined {
  if (kind === "rule") return definition.resources.rules;
  if (kind === "agent") return definition.resources.agents;
  if (kind === "skill") return definition.resources.skills;
  return definition.resources.mcp;
}

function hasAnyDeclaration(rule: ParsedDeclarativeResourceRule): boolean {
  return (
    rule.directories.length > 0 ||
    rule.extensions.length > 0 ||
    rule.entry_files.length > 0 ||
    rule.files.length > 0
  );
}

class DeclarativeToolAdapter extends BaseToolAdapter {
  readonly adapterId;
  readonly adapterVersion = adapterVersion;
  readonly toolId;
  readonly capabilities;
  readonly #definition: ParsedDeclarativeToolDefinition;

  constructor(definition: ParsedDeclarativeToolDefinition, logger: AdapterLogger) {
    super(logger);
    this.#definition = definition;
    this.toolId = definition.id;
    this.adapterId = AdapterIdSchema.parse(`custom-${definition.id}`);
    this.capabilities = capabilitiesFor(definition);
  }

  async detect(context: DetectionContext): Promise<DetectionResult> {
    const installations = [];
    for (const root of [...context.candidateRoots].sort()) {
      context.signal.throwIfAborted();
      const isHome = root === context.homeDirectory;
      const declaredPaths = isHome ? this.#definition.paths.global : this.#definition.paths.project;
      if (declaredPaths.length === 0) continue;

      const existing = await existingDeclaredPaths(context, root, declaredPaths);
      if (existing.length === 0) continue;
      installations.push({
        toolId: this.toolId,
        installationId: ToolInstallationIdSchema.parse(
          isHome ? `${this.toolId}:user:${root}` : `${this.toolId}:${root}`,
        ),
        configRoots: isHome ? existing : [root],
        evidence: {
          scope: isHome ? "user" : "project",
          markers: existing,
          executables: this.#definition.detect.executables,
        },
      });
    }
    return { installations, diagnostics: [] };
  }

  async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    const candidates = [];
    const scopeKind = declaredScopeKind(this.#definition, context.tool.evidence);
    for (const root of [...context.tool.configRoots].sort()) {
      for (const sourcePath of await declarativeDiscoveryFiles({
        read: context.read,
        root,
        evidence: context.tool.evidence,
        signal: context.signal,
      })) {
        for (const kind of resourceKinds(this.#definition)) {
          if (!matchesResource(this.#definition, kind, root, sourcePath)) continue;
          candidates.push(
            candidate({
              toolId: this.toolId,
              root,
              sourcePath,
              sourceFormat: kind === "mcp" ? "jsonc" : "yaml-frontmatter-markdown",
              resourceKind: kind,
              ...(kind === "rule" ? { scopeRoot: dirname(sourcePath) } : {}),
              ...(scopeKind === undefined ? {} : { scopeKind }),
            }),
          );
          break;
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
      context.candidate.resourceKindHint === "skill"
        ? parseSkillPackage(context)
        : context.candidate.resourceKindHint === "mcp"
          ? parseMcpJson(context.candidate, context.snapshot.text, context.snapshot.contentHash)
          : parseMarkdownAsset(
              context.candidate,
              context.snapshot.text,
              context.snapshot.contentHash,
            );
    return Promise.resolve(result);
  }
}

async function declarativeDiscoveryFiles(input: {
  readonly read: AdapterReadApi;
  readonly root: AbsolutePath;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly signal: CancellationSignal;
}): Promise<readonly AbsolutePath[]> {
  const markers = declaredMarkers(input.evidence);
  const roots = markers.length === 0 ? [input.root] : markers;
  const files = [];
  const budget = createAdapterDiscoveryBudget(await input.read.realpath(input.root));
  for (const root of roots) {
    const stat = await input.read.stat(root);
    if (stat.kind === "file") {
      files.push(await input.read.realpath(root));
    } else if (stat.kind === "directory") {
      files.push(
        ...(await walkFiles(input.read, await input.read.realpath(root), input.signal, budget)),
      );
    }
  }
  return uniquePaths(files);
}

function declaredMarkers(evidence: Readonly<Record<string, unknown>>): readonly AbsolutePath[] {
  const markers = evidence["markers"];
  if (!Array.isArray(markers)) return [];
  return uniquePaths(
    markers.flatMap((marker) => {
      if (typeof marker !== "string") return [];
      const parsed = AbsolutePathSchema.safeParse(marker);
      return parsed.success ? [parsed.data] : [];
    }),
  );
}

async function existingDeclaredPaths(
  context: DetectionContext,
  root: AbsolutePath,
  declaredPaths: readonly string[],
): Promise<readonly AbsolutePath[]> {
  const existing = await Promise.all(
    declaredPaths.map(async (path) => {
      const absolutePath = markerPath(root, ...path.split(/[\\/]/));
      return { path: absolutePath, stat: await context.read.stat(absolutePath) };
    }),
  );
  return existing.filter(({ stat }) => stat.kind !== "missing").map(({ path }) => path);
}

function declaredScopeKind(
  definition: ParsedDeclarativeToolDefinition,
  evidence: Readonly<Record<string, unknown>>,
): ScopeKind | undefined {
  return definition.defaults?.scope ?? scopeKindFromEvidence(evidence);
}

function matchesResource(
  definition: ParsedDeclarativeToolDefinition,
  kind: ResourceKind,
  root: AbsolutePath,
  sourcePath: AbsolutePath,
): boolean {
  const rule = ruleFor(definition, kind);
  if (rule === undefined) return false;
  const relativePath = relative(root, sourcePath).split(sep).join("/");
  if (relativePath.startsWith("..")) return false;
  if (rule.files.some((file) => relativePath === file || basename(sourcePath) === file))
    return true;
  if (
    rule.entry_files.some(
      (file) => relativePath.endsWith(`/${file}`) || basename(sourcePath) === file,
    )
  ) {
    return rule.directories.length === 0 || underDeclaredDirectory(relativePath, rule.directories);
  }
  if (rule.extensions.length > 0 && !rule.extensions.includes(extname(sourcePath))) return false;
  return rule.directories.length > 0 && underDeclaredDirectory(relativePath, rule.directories);
}

function underDeclaredDirectory(relativePath: string, directories: readonly string[]): boolean {
  return directories.some((directory) => {
    const normalized = directory.split(/[\\/]/).join("/");
    return relativePath.startsWith(`${normalized}/`) || relativePath.includes(`/${normalized}/`);
  });
}

export function createDeclarativeToolRegistration(
  definitionInput: DeclarativeToolDefinition,
): AdapterRegistration {
  const definition = DeclarativeToolDefinitionSchema.parse(definitionInput);
  const adapterId = AdapterIdSchema.parse(`custom-${definition.id}`);
  const capabilities = capabilitiesFor(definition);
  return {
    contractVersion: 1,
    adapterId,
    adapterVersion,
    toolId: definition.id,
    capabilities,
    create: ({ logger }) => new DeclarativeToolAdapter(definition, logger),
  };
}
