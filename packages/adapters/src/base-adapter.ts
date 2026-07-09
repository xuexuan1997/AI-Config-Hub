import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, posix, relative, resolve, sep } from "node:path";

import type {
  AdapterCapabilities,
  AdapterDiagnostic,
  AdapterLogger,
  DiscoveredResource,
  ConversionContext,
  ConversionResult,
  DeploymentPlanningContext,
  DeploymentPlanningResult,
  DiagnosticContext,
  ResolvedConvertedOutput,
  DiagnosticResult,
  ResolutionContext,
  ResolutionResult,
  ToolAdapter,
  VerificationContext,
  VerificationResult,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  ContentHashSchema,
  type AbsolutePath,
  type AdapterId,
  type ContentHash,
  type SemVer,
  type ToolId,
} from "@ai-config-hub/shared";

import { convertAsset } from "./conversion.js";
import { resolveAssetsByScope } from "./resolution.js";

const MAX_DIFF_BYTES = 200 * 1024;
const DIFF_TRUNCATION_MARKER = "# AI Config Hub: diff truncated at a complete UTF-8 line boundary";

export abstract class BaseToolAdapter implements ToolAdapter {
  abstract readonly adapterId: AdapterId;
  abstract readonly adapterVersion: SemVer;
  abstract readonly toolId: ToolId;
  abstract readonly capabilities: AdapterCapabilities;
  protected readonly logger: AdapterLogger;

  constructor(logger: AdapterLogger) {
    this.logger = logger;
  }

  abstract detect(context: Parameters<ToolAdapter["detect"]>[0]): ReturnType<ToolAdapter["detect"]>;
  abstract discover(
    context: Parameters<ToolAdapter["discover"]>[0],
  ): ReturnType<ToolAdapter["discover"]>;
  abstract parse(context: Parameters<ToolAdapter["parse"]>[0]): ReturnType<ToolAdapter["parse"]>;

  resolveEffective(context: ResolutionContext): Promise<ResolutionResult> {
    return Promise.resolve({
      draft: resolveAssetsByScope(context),
      diagnostics: [],
    });
  }

  diagnose(context: DiagnosticContext): Promise<DiagnosticResult> {
    context.signal.throwIfAborted();
    const diagnostics: AdapterDiagnostic[] = [];
    const firstByLocator = new Map<string, (typeof context.assets)[number]>();
    const assetPaths = new Set(
      context.assets.flatMap((asset) =>
        asset.sourceFiles.length === 0
          ? [asset.canonicalSourcePath]
          : asset.sourceFiles.map((sourceFile) => sourceFile.path),
      ),
    );

    for (const asset of [...context.assets].sort((left, right) =>
      `${left.locator}:${left.canonicalSourcePath}`.localeCompare(
        `${right.locator}:${right.canonicalSourcePath}`,
      ),
    )) {
      context.signal.throwIfAborted();
      if (!context.tool.configRoots.some((root) => containsPath(root, asset.canonicalSourcePath))) {
        diagnostics.push(
          adapterDiagnostic(
            "RESOURCE_OUTSIDE_CONFIG_ROOT",
            "error",
            `Resource ${asset.locator} is outside detected ${this.toolId} configuration roots`,
            true,
            { path: asset.canonicalSourcePath },
          ),
        );
      }
      const first = firstByLocator.get(asset.locator);
      if (first === undefined) {
        firstByLocator.set(asset.locator, asset);
      } else {
        diagnostics.push(
          adapterDiagnostic(
            "DUPLICATE_RESOURCE_LOCATOR",
            "warning",
            `Multiple ${this.toolId} resources use locator ${asset.locator}`,
            false,
            { path: asset.canonicalSourcePath },
          ),
        );
      }

      if (asset.resource.kind === "skill") {
        for (const reference of [...asset.resource.data.references].sort()) {
          if (URL.canParse(reference)) continue;
          const referencePath = AbsolutePathSchema.safeParse(
            isAbsolute(reference)
              ? reference
              : resolve(dirname(asset.canonicalSourcePath), reference),
          );
          if (referencePath.success && assetPaths.has(referencePath.data)) continue;
          diagnostics.push(
            adapterDiagnostic(
              "UNRESOLVED_SKILL_REFERENCE",
              "warning",
              `Skill reference could not be resolved from ${asset.locator}`,
              false,
              { path: asset.canonicalSourcePath },
            ),
          );
        }
      }

      if (hasNonDeployableMcpSecret(asset.resource)) {
        diagnostics.push(
          adapterDiagnostic(
            "MCP_NON_DEPLOYABLE_SECRET",
            "error",
            "MCP configuration contains non-deployable secret values",
            true,
            { path: asset.canonicalSourcePath },
          ),
        );
      }

      if (resourceInstructions(asset.resource)?.trim() === "") {
        diagnostics.push(
          adapterDiagnostic(
            "RESOURCE_INSTRUCTIONS_EMPTY",
            "error",
            `${resourceKindDiagnosticLabel(asset.resource.kind)} resource has empty instructions after trimming whitespace`,
            true,
            { path: asset.canonicalSourcePath },
          ),
        );
      }

      if (hasLiteralMcpSecretRisk(asset.resource)) {
        diagnostics.push(
          adapterDiagnostic(
            "MCP_LITERAL_SECRET_RISK",
            "warning",
            "MCP configuration appears to contain a literal secret; prefer an environment reference",
            false,
            { path: asset.canonicalSourcePath },
          ),
        );
      }
    }

    if (context.effectiveConfigDraft !== undefined) {
      const byAssetId = new Map(context.assets.map((asset) => [asset.assetId, asset]));
      for (const assetId of [...context.effectiveConfigDraft.ignoredAssetIds].sort()) {
        const asset = byAssetId.get(assetId);
        if (asset === undefined) continue;
        diagnostics.push(
          adapterDiagnostic(
            "RESOURCE_IGNORED_BY_EFFECTIVE_CONFIG",
            "info",
            `Resource ${asset.locator} is ignored by the effective configuration resolution`,
            false,
            { path: asset.canonicalSourcePath },
          ),
        );
      }
    }

    return Promise.resolve({ diagnostics });
  }

  convert(context: ConversionContext): Promise<ConversionResult> {
    return Promise.resolve(convertAsset(context, this.adapterId, this.adapterVersion, this.toolId));
  }

  planDeployment(context: DeploymentPlanningContext): Promise<DeploymentPlanningResult> {
    context.signal.throwIfAborted();
    const operations: DeploymentPlanningResult["draft"]["operations"][number][] = [];
    const diffs: DeploymentPlanningResult["draft"]["diffs"][number][] = [];
    const diagnostics: AdapterDiagnostic[] = [];

    for (const output of [...context.conversion.outputs].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    )) {
      context.signal.throwIfAborted();
      const resolvedOutput = context.resolvedOutputs.get(output.relativePath);
      if (resolvedOutput === undefined) {
        diagnostics.push(
          adapterDiagnostic(
            "CONVERSION_SOURCE_OUTPUT_UNRESOLVED",
            "error",
            `Converted output was not resolved before deployment planning: ${output.relativePath}`,
            true,
          ),
        );
        continue;
      }
      const targetPath = resolveTargetPath(context.target.canonicalRootPath, output.relativePath);
      const current = context.currentTargetSnapshots.get(targetPath);
      if (current?.contentHash === resolvedOutput.contentHash) continue;

      const nextPreviewText =
        resolvedOutput.deploymentType === "generated_file"
          ? resolvedOutput.text
          : (resolvedOutput.previewText ?? sourcePreviewText(resolvedOutput));
      const operationMetadata =
        resolvedOutput.deploymentType === "generated_file"
          ? {
              nextText: resolvedOutput.text,
              deploymentType: "generated_file" as const,
            }
          : {
              deploymentType: resolvedOutput.deploymentType,
              sourcePath: resolvedOutput.sourcePath,
              sourceHash: resolvedOutput.sourceHash,
            };

      if (current === undefined) {
        operations.push({
          kind: "create",
          targetPath,
          expectedTargetHash: "absent",
          targetResourceKind: context.conversion.targetResourceKind,
          ...operationMetadata,
        });
        diffs.push({
          targetPath,
          summary: `Create ${targetPath}`,
          unifiedText: unifiedDiff(targetPath, undefined, nextPreviewText),
        });
      } else {
        operations.push({
          kind: "replace",
          targetPath,
          expectedTargetHash: current.contentHash,
          targetResourceKind: context.conversion.targetResourceKind,
          ...operationMetadata,
        });
        diffs.push({
          targetPath,
          summary: `Replace ${targetPath}`,
          unifiedText: unifiedDiff(targetPath, current.text, nextPreviewText),
        });
      }
    }

    return Promise.resolve({
      draft: {
        targetToolId: this.toolId,
        operations,
        diffs,
        verificationStrategy: `Verify generated ${this.toolId} files with hash and semantic parsing checks`,
        adapterId: this.adapterId,
        adapterVersion: this.adapterVersion,
      },
      diagnostics:
        diagnostics.length > 0
          ? diagnostics
          : operations.length === 0
            ? [
                adapterDiagnostic(
                  "DEPLOYMENT_TARGETS_ALREADY_IDENTICAL",
                  "info",
                  "All generated outputs are already byte-identical to their targets",
                  false,
                ),
              ]
            : [],
    });
  }

  async verify(context: VerificationContext): Promise<VerificationResult> {
    context.signal.throwIfAborted();
    const verifiedHashes = {} as Record<AbsolutePath, ContentHash>;
    const diagnostics: AdapterDiagnostic[] = [];

    for (const operation of context.deployment.operations) {
      context.signal.throwIfAborted();
      if (operation.kind === "delete") {
        const stat = await context.read.stat(operation.targetPath);
        if (stat.kind !== "missing") {
          diagnostics.push(
            verificationDiagnostic(
              "DEPLOYMENT_DELETE_NOT_APPLIED",
              `Deployment expected ${operation.targetPath} to be deleted`,
              operation.targetPath,
            ),
          );
        }
        continue;
      }

      try {
        const stat = await context.read.stat(operation.targetPath);
        if (stat.kind !== "file") {
          diagnostics.push(
            verificationDiagnostic(
              "DEPLOYMENT_TARGET_MISSING",
              `Deployment target is not a file: ${operation.targetPath}`,
              operation.targetPath,
            ),
          );
          continue;
        }
        const deploymentType = operation.deploymentType ?? "generated_file";
        if (deploymentType === "copy" || deploymentType === "symlink") {
          const actualSnapshot = await context.read.snapshotFile(operation.targetPath);
          if (actualSnapshot === undefined) {
            diagnostics.push(
              verificationDiagnostic(
                "DEPLOYMENT_TARGET_MISSING",
                `Deployment target is not a file: ${operation.targetPath}`,
                operation.targetPath,
              ),
            );
            continue;
          }
          const actualHash = actualSnapshot.contentHash;
          verifiedHashes[operation.targetPath] = actualHash;
          const expectedHash = context.deployment.resultingHashes[operation.targetPath];
          if (expectedHash === undefined) {
            diagnostics.push(
              verificationDiagnostic(
                "DEPLOYMENT_RESULT_HASH_MISSING",
                `Deployment result hash is missing for ${operation.targetPath}`,
                operation.targetPath,
              ),
            );
          } else if (actualHash !== expectedHash) {
            diagnostics.push(
              verificationDiagnostic(
                "DEPLOYMENT_TARGET_HASH_MISMATCH",
                `Deployment target hash does not match the recorded write: ${operation.targetPath}`,
                operation.targetPath,
              ),
            );
          }
          continue;
        }
        const actualText = await context.read.readText(operation.targetPath);
        const actualHash = hash(actualText);
        verifiedHashes[operation.targetPath] = actualHash;
        const expectedHash = context.deployment.resultingHashes[operation.targetPath];
        let hashMatches = false;
        if (expectedHash === undefined) {
          diagnostics.push(
            verificationDiagnostic(
              "DEPLOYMENT_RESULT_HASH_MISSING",
              `Deployment result hash is missing for ${operation.targetPath}`,
              operation.targetPath,
            ),
          );
        } else if (actualHash !== expectedHash) {
          diagnostics.push(
            verificationDiagnostic(
              "DEPLOYMENT_TARGET_HASH_MISMATCH",
              `Deployment target hash does not match the recorded write: ${operation.targetPath}`,
              operation.targetPath,
            ),
          );
        } else {
          hashMatches = true;
        }
        if (hashMatches && operation.targetResourceKind !== undefined) {
          const parseResult = await this.parse({
            tool: context.target.tool,
            candidate: parseCandidate({
              toolId: this.toolId,
              targetPath: operation.targetPath,
              targetResourceKind: operation.targetResourceKind,
              scope: context.target.scope,
            }),
            snapshot: {
              canonicalPath: operation.targetPath,
              text: actualText,
              contentHash: actualHash,
              modifiedAt: stat.modifiedAt,
              size: stat.size,
            },
            read: context.read,
            signal: context.signal,
          });
          if (parseResult.status === "rejected") {
            diagnostics.push(
              verificationDiagnostic(
                "DEPLOYMENT_TARGET_SEMANTIC_INVALID",
                `Deployment target could not be parsed as ${resourceKindDiagnosticLabel(
                  operation.targetResourceKind,
                )}: ${operation.targetPath}`,
                operation.targetPath,
              ),
            );
          } else if (
            !parseResult.assets.some(
              ({ resource }) => resource.kind === operation.targetResourceKind,
            )
          ) {
            diagnostics.push(
              verificationDiagnostic(
                "DEPLOYMENT_TARGET_SEMANTIC_KIND_MISMATCH",
                `Deployment target did not produce a ${resourceKindDiagnosticLabel(
                  operation.targetResourceKind,
                )} resource: ${operation.targetPath}`,
                operation.targetPath,
              ),
            );
          }
        }
      } catch (error) {
        diagnostics.push(
          verificationDiagnostic(
            "DEPLOYMENT_TARGET_UNREADABLE",
            error instanceof Error ? error.message : `Unable to read ${operation.targetPath}`,
            operation.targetPath,
          ),
        );
      }
    }

    return {
      status: diagnostics.some((diagnostic) => diagnostic.blocking) ? "failed" : "passed",
      verifiedHashes,
      diagnostics,
    };
  }
}

function sourcePreviewText(
  output: Extract<ResolvedConvertedOutput, { readonly deploymentType: "copy" | "symlink" }>,
): string {
  return `Binary source ${output.sourceHash} from ${output.sourcePath}\n`;
}

interface DiffLineGroup {
  readonly text: string;
  readonly side: "old" | "new";
}

function lineGroups(text: string, side: DiffLineGroup["side"]): readonly DiffLineGroup[] {
  if (text === "") return [];
  const hasTrailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (hasTrailingNewline) lines.pop();
  return lines.map((line, index) => ({
    side,
    text:
      `${side === "old" ? "-" : "+"}${line}` +
      (index === lines.length - 1 && !hasTrailingNewline ? "\n\\ No newline at end of file" : ""),
  }));
}

function diffHeader(
  path: AbsolutePath,
  previousExists: boolean,
  oldCount: number,
  newCount: number,
): string {
  return (
    `--- ${previousExists ? path : "/dev/null"}\n` +
    `+++ ${path}\n` +
    `@@ -${oldCount === 0 ? "0" : "1"},${String(oldCount)} ` +
    `+${newCount === 0 ? "0" : "1"},${String(newCount)} @@`
  );
}

function renderDiff(
  path: AbsolutePath,
  previousExists: boolean,
  groups: readonly DiffLineGroup[],
  truncated: boolean,
): string {
  const oldCount = groups.filter(({ side }) => side === "old").length;
  const newCount = groups.length - oldCount;
  const body = [...groups.map(({ text }) => text)].join("\n");
  const header = diffHeader(path, previousExists, oldCount, newCount);
  return `${truncated ? `${DIFF_TRUNCATION_MARKER}\n` : ""}${header}${body === "" ? "" : `\n${body}`}`;
}

function resolveTargetPath(root: AbsolutePath, relativePath: string): AbsolutePath {
  if (/^[A-Za-z]:[\\/]/.test(root)) {
    return AbsolutePathSchema.parse(resolve(root, relativePath));
  }
  return AbsolutePathSchema.parse(posix.resolve(root.replace(/\\/g, "/"), relativePath));
}

function unifiedDiff(path: AbsolutePath, previous: string | undefined, next: string): string {
  const groups = [...lineGroups(previous ?? "", "old"), ...lineGroups(next, "new")];
  const full = renderDiff(path, previous !== undefined, groups, false);
  if (Buffer.byteLength(full, "utf8") <= MAX_DIFF_BYTES) return full;

  const oldCount = groups.filter(({ side }) => side === "old").length;
  const newCount = groups.length - oldCount;
  let usedBytes = Buffer.byteLength(
    `${DIFF_TRUNCATION_MARKER}\n${diffHeader(path, previous !== undefined, oldCount, newCount)}`,
    "utf8",
  );
  const included: DiffLineGroup[] = [];
  for (const group of groups) {
    const groupBytes = Buffer.byteLength(`\n${group.text}`, "utf8");
    if (usedBytes + groupBytes > MAX_DIFF_BYTES) break;
    included.push(group);
    usedBytes += groupBytes;
  }
  return renderDiff(path, previous !== undefined, included, true);
}

function parseCandidate(input: {
  readonly toolId: ToolId;
  readonly targetPath: AbsolutePath;
  readonly targetResourceKind: NonNullable<DiscoveredResource["resourceKindHint"]>;
  readonly scope: DiscoveredResource["scope"];
}): DiscoveredResource {
  return {
    toolId: input.toolId,
    sourcePath: input.targetPath,
    sourceFormat: sourceFormat(input.targetPath),
    resourceKindHint: input.targetResourceKind,
    locatorHint: `${input.targetResourceKind}:${basename(input.targetPath, extname(input.targetPath))}`,
    scope: input.scope,
  };
}

function sourceFormat(path: AbsolutePath): string {
  const leaf = basename(path);
  if (leaf.endsWith(".toml")) return "toml";
  if (leaf.endsWith(".json") || leaf.endsWith(".jsonc")) return "jsonc";
  if (leaf.endsWith(".mdc")) return "mdc";
  if (leaf.endsWith(".md")) return "yaml-frontmatter-markdown";
  return "text";
}

function hasNonDeployableMcpSecret(
  resource: Parameters<typeof resolveAssetsByScope>[0]["assets"][number]["resource"],
): boolean {
  if (resource.kind !== "mcp") return false;
  const transport = resource.data.transport;
  if (transport.kind === "stdio") {
    return (
      transport.args.some((item) => !item.deployable) ||
      Object.values(transport.env).some((item) => !item.deployable)
    );
  }
  return (
    !transport.endpoint.baseUrl.deployable ||
    Object.values(transport.endpoint.query)
      .flat()
      .some((item) => !item.deployable) ||
    (transport.endpoint.userInfo !== undefined &&
      (!transport.endpoint.userInfo.username.deployable ||
        transport.endpoint.userInfo.password?.deployable === false)) ||
    Object.values(transport.headers).some((item) => !item.deployable)
  );
}

function resourceInstructions(
  resource: Parameters<typeof resolveAssetsByScope>[0]["assets"][number]["resource"],
): string | undefined {
  if (resource.kind === "mcp") return undefined;
  return resource.data.instructions;
}

function resourceKindDiagnosticLabel(
  resourceKind: Parameters<typeof resolveAssetsByScope>[0]["assets"][number]["resource"]["kind"],
): string {
  switch (resourceKind) {
    case "agent":
      return "Agent";
    case "rule":
      return "Rule";
    case "mcp":
      return "MCP";
    case "skill":
      return "Skill";
  }
}

function hasLiteralMcpSecretRisk(
  resource: Parameters<typeof resolveAssetsByScope>[0]["assets"][number]["resource"],
): boolean {
  if (resource.kind !== "mcp") return false;
  const transport = resource.data.transport;
  if (transport.kind === "stdio") {
    return (
      transport.args.some((item) => item.kind === "literal" && looksSecretish("", item.value)) ||
      Object.entries(transport.env).some(
        ([key, item]) => item.kind === "literal" && looksSecretish(key, item.value),
      )
    );
  }
  return (
    (transport.endpoint.baseUrl.kind === "literal" &&
      looksSecretish("url", transport.endpoint.baseUrl.value)) ||
    Object.entries(transport.endpoint.query).some(([key, values]) =>
      values.some((item) => item.kind === "literal" && looksSecretish(key, item.value)),
    ) ||
    (transport.endpoint.userInfo !== undefined &&
      ((transport.endpoint.userInfo.username.kind === "literal" &&
        looksSecretish("username", transport.endpoint.userInfo.username.value)) ||
        (transport.endpoint.userInfo.password?.kind === "literal" &&
          looksSecretish("password", transport.endpoint.userInfo.password.value)))) ||
    Object.entries(transport.headers).some(
      ([key, item]) => item.kind === "literal" && looksSecretish(key, item.value),
    )
  );
}

function looksSecretish(key: string, value: string): boolean {
  const haystack = `${key} ${value}`.toLowerCase();
  return /token|secret|password|passwd|api[_-]?key|authorization|bearer/.test(haystack);
}

function containsPath(root: AbsolutePath, candidate: AbsolutePath): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}

export function adapterDiagnostic(
  code: string,
  severity: AdapterDiagnostic["severity"],
  message: string,
  blocking: boolean,
  location?: AdapterDiagnostic["location"],
): AdapterDiagnostic {
  return {
    code,
    severity,
    message,
    ...(location === undefined ? {} : { location }),
    evidence: {},
    suggestedActions: ["Review the source configuration and scan again"],
    blocking,
  };
}

function hash(text: string): ContentHash {
  return ContentHashSchema.parse(
    `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
  );
}

function verificationDiagnostic(
  code: string,
  message: string,
  path: AbsolutePath,
): AdapterDiagnostic {
  return adapterDiagnostic(code, "error", message, true, { path });
}
