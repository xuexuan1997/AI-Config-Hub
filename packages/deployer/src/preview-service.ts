import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { AdapterRegistry } from "@ai-config-hub/adapters";
import {
  DeploymentPlanSchema,
  DeploymentRecordSchema,
  ConversionResultSchema,
  type Asset,
  type ConversionResult,
  type ConversionTarget,
  type DeploymentOperation,
  type DeploymentPlan,
  type DeploymentRecord,
  type DeploymentRepository,
  type FileSnapshot,
  type FileSnapshotPort,
  type NormalizedResource,
  type PathPolicyPort,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AppError,
  ContentHashSchema,
  DeploymentPlanIdSchema,
  DeploymentRecordIdSchema,
  type AbsolutePath,
  type ContentHash,
  type CorrelationId,
  type IsoDateTime,
} from "@ai-config-hub/shared";

const MAX_DIFF_BYTES = 200 * 1024;
const PLAN_TTL_MS = 10 * 60 * 1_000;
const DIFF_TRUNCATION_MARKER = "# AI Config Hub: diff truncated at a complete UTF-8 line boundary";
export type PreviewConflictPolicy = "fail" | "replace" | "merge";

export interface PreviewRequest {
  readonly assets: readonly Asset[];
  readonly target: ConversionTarget;
  readonly targetRoot: AbsolutePath;
  readonly backupRoot: AbsolutePath;
  readonly allowedRoots: readonly AbsolutePath[];
  readonly conflictPolicy?: PreviewConflictPolicy;
  readonly now: IsoDateTime;
  readonly correlationId: CorrelationId;
  readonly signal: AbortSignal;
}

export interface DeploymentPreviewServiceOptions {
  readonly registry: AdapterRegistry;
  readonly snapshots: FileSnapshotPort;
  readonly pathPolicy: PathPolicyPort;
  readonly deploymentRepository: DeploymentRepository;
}

interface PlannedOutput {
  readonly targetPath: AbsolutePath;
  readonly text: string;
  readonly contentHash: ContentHash;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function error(
  code: "UNSUPPORTED_CONVERSION" | "TARGET_CONFLICT" | "VALIDATION_FAILED" | "PREVIEW_TOO_LARGE",
  message: string,
): AppError {
  return new AppError({
    code,
    message,
    retryable: false,
    suggestedActions: ["Refresh the source assets and choose a supported deployment target"],
  });
}

function hash(namespace: string, value: string): ContentHash {
  return ContentHashSchema.parse(
    `sha256:${createHash("sha256").update(namespace).update("\0").update(value).digest("hex")}`,
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasRedactedValue(resource: NormalizedResource): boolean {
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
    Object.values(transport.endpoint.query).some((items) =>
      items.some((item) => !item.deployable),
    ) ||
    (transport.endpoint.userInfo !== undefined &&
      (!transport.endpoint.userInfo.username.deployable ||
        transport.endpoint.userInfo.password?.deployable === false)) ||
    Object.values(transport.headers).some((item) => !item.deployable)
  );
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
  const truncated = renderDiff(path, previous !== undefined, included, true);
  if (Buffer.byteLength(truncated, "utf8") > MAX_DIFF_BYTES) {
    throw error("PREVIEW_TOO_LARGE", "Diff headers exceed the preview byte limit");
  }
  return truncated;
}

function outputHash(text: string): ContentHash {
  return ContentHashSchema.parse(
    `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
  );
}

export class DeploymentPreviewService {
  constructor(private readonly options: DeploymentPreviewServiceOptions) {}

  async preview(request: PreviewRequest): Promise<{
    readonly plan: DeploymentPlan;
    readonly record: DeploymentRecord;
    readonly conversions: readonly ConversionResult[];
  }> {
    request.signal.throwIfAborted();
    if (request.assets.length === 0) throw error("VALIDATION_FAILED", "Preview requires assets");
    const sourceAssetIds = new Set(request.assets.map(({ assetId }) => assetId));
    if (sourceAssetIds.size !== request.assets.length) {
      throw error("VALIDATION_FAILED", "Preview source asset identities must be unique");
    }
    if (request.assets.some(({ resource }) => hasRedactedValue(resource))) {
      throw error("UNSUPPORTED_CONVERSION", "Redacted MCP values are not deployable");
    }
    const conflictPolicy = request.conflictPolicy ?? "replace";
    if (conflictPolicy === "merge") {
      throw error("UNSUPPORTED_CONVERSION", "Merge conflict policy is not supported yet");
    }

    const canonicalRoot = await this.options.pathPolicy.canonicalize({
      path: request.targetRoot,
      allowedRoots: request.allowedRoots,
      intent: "read",
    });
    const adapter = this.options.registry.create(request.target.toolId, {
      debug() {},
      warn() {},
    });
    const assets = [...request.assets].sort((left, right) =>
      compareText(left.assetId, right.assetId),
    );
    const conversions: ConversionResult[] = [];
    const conversionResultIds = new Set<string>();
    const outputs: PlannedOutput[] = [];
    const targetKeys = new Set<string>();

    for (const asset of assets) {
      request.signal.throwIfAborted();
      const parsedConversion = ConversionResultSchema.safeParse(
        await adapter.convert({
          asset,
          target: request.target,
          signal: request.signal,
        }),
      );
      request.signal.throwIfAborted();
      if (!parsedConversion.success) {
        throw error("VALIDATION_FAILED", "Adapter returned an invalid conversion result");
      }
      const conversion = parsedConversion.data;
      if (
        conversion.sourceAssetId !== asset.assetId ||
        conversion.sourceContentHash !== asset.contentHash ||
        conversion.targetToolId !== request.target.toolId ||
        conversion.targetResourceKind !== request.target.resourceKind ||
        conversion.targetSchemaVersion !== request.target.targetSchemaVersion ||
        conversion.adapterId !== adapter.adapterId ||
        conversion.adapterVersion !== adapter.adapterVersion
      ) {
        throw error("VALIDATION_FAILED", "Conversion result is not bound to its request");
      }
      if (conversionResultIds.has(conversion.conversionResultId)) {
        throw error("VALIDATION_FAILED", "Conversion result identities must be unique");
      }
      conversionResultIds.add(conversion.conversionResultId);
      conversions.push(conversion);
      if (conversion.level === "unsupported") {
        throw error("UNSUPPORTED_CONVERSION", conversion.reasons.join("; "));
      }
      for (const output of [...conversion.outputs].sort((left, right) =>
        compareText(left.relativePath, right.relativePath),
      )) {
        if (outputHash(output.text) !== output.contentHash) {
          throw error("VALIDATION_FAILED", "Converted output hash does not match its text");
        }
        const candidate = AbsolutePathSchema.parse(
          resolve(canonicalRoot.path, output.relativePath),
        );
        const canonicalTarget = await this.options.pathPolicy.canonicalize({
          path: candidate,
          allowedRoots: [canonicalRoot.path],
          intent: "read",
        });
        if (targetKeys.has(canonicalTarget.comparisonKey)) {
          throw error("TARGET_CONFLICT", `Multiple outputs target ${canonicalTarget.path}`);
        }
        targetKeys.add(canonicalTarget.comparisonKey);
        outputs.push({
          targetPath: canonicalTarget.path,
          text: output.text,
          contentHash: output.contentHash,
        });
      }
    }

    outputs.sort((left, right) => compareText(left.targetPath, right.targetPath));
    const operations: DeploymentOperation[] = [];
    const diffs: DeploymentPlan["diffs"][number][] = [];
    const expectedTargetHashes: Record<AbsolutePath, ContentHash | "absent"> = {};
    for (const output of outputs) {
      request.signal.throwIfAborted();
      const current: FileSnapshot | undefined = await this.options.snapshots.snapshot({
        path: output.targetPath,
        allowedRoots: [canonicalRoot.path],
      });
      request.signal.throwIfAborted();
      expectedTargetHashes[output.targetPath] = current?.contentHash ?? "absent";
      if (current?.contentHash === output.contentHash && current.text === output.text) continue;
      if (current === undefined) {
        operations.push({
          kind: "create",
          targetPath: output.targetPath,
          nextText: output.text,
          expectedTargetHash: "absent",
        });
        diffs.push({
          targetPath: output.targetPath,
          summary: `Create ${output.targetPath}`,
          unifiedText: unifiedDiff(output.targetPath, undefined, output.text),
        });
      } else {
        if (conflictPolicy === "fail") {
          throw error("TARGET_CONFLICT", `Target already exists: ${output.targetPath}`);
        }
        operations.push({
          kind: "replace",
          targetPath: output.targetPath,
          nextText: output.text,
          expectedTargetHash: current.contentHash,
        });
        diffs.push({
          targetPath: output.targetPath,
          summary: `Replace ${output.targetPath}`,
          unifiedText: unifiedDiff(output.targetPath, current.text, output.text),
        });
      }
    }
    if (operations.length === 0) {
      throw error("TARGET_CONFLICT", "All converted outputs are already byte-identical");
    }

    const expectedSourceHashes = Object.fromEntries(
      assets.map(({ assetId, contentHash }) => [assetId, contentHash]),
    );
    const partials = conversions.filter(
      (conversion): conversion is Extract<ConversionResult, { readonly level: "partial" }> =>
        conversion.level === "partial",
    );
    const confirmations = [
      ...(partials.length === 0 ? [] : (["partial_conversion"] as const)),
      ...(operations.some(({ kind }) => kind === "replace") ? (["overwrite"] as const) : []),
    ];
    const planPayload = {
      conversionResultIds: conversions.map(({ conversionResultId }) => conversionResultId),
      operations,
      diffs,
      expectedSourceHashes,
      expectedTargetHashes,
      backupPolicy: { mode: "required" as const, backupRoot: request.backupRoot },
      verificationStrategy: {
        kind: "adapter" as const,
        description: `Verify resulting files with ${adapter.adapterId}@${adapter.adapterVersion}`,
      },
      requiredConfirmations: confirmations,
      warnings: partials.flatMap(({ warnings }) => warnings),
      adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion,
      createdAt: request.now,
      expiresAt: new Date(Date.parse(request.now) + PLAN_TTL_MS).toISOString(),
    };
    const planHash = hash("ai-config-hub:deployment-plan:v1", stableJson(planPayload));
    const deploymentPlanId = DeploymentPlanIdSchema.parse(
      `deployment-plan:${planHash.slice("sha256:".length)}`,
    );
    const plan = DeploymentPlanSchema.parse({
      deploymentPlanId,
      ...planPayload,
      planHash,
    });
    const recordHash = hash(
      "ai-config-hub:deployment-record:v1",
      stableJson({ deploymentPlanId, correlationId: request.correlationId }),
    );
    const record = DeploymentRecordSchema.parse({
      deploymentRecordId: DeploymentRecordIdSchema.parse(
        `deployment-record:${recordHash.slice("sha256:".length)}`,
      ),
      deploymentPlanId,
      status: "planned",
      operations: plan.operations,
      backupLocations: {},
      resultingHashes: {},
      verificationResult: { status: "not_started", diagnostics: [] },
      rollbackResults: [],
      adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion,
      normalizedSchemaVersion: assets[0]?.normalizedSchemaVersion,
      createdAt: request.now,
      correlationId: request.correlationId,
      diagnostics: conversions.flatMap(({ diagnostics }) => diagnostics),
    });
    request.signal.throwIfAborted();
    await this.options.deploymentRepository.savePlanAndRecord({ plan, record });
    return Object.freeze({ plan, record, conversions: Object.freeze(conversions) });
  }
}
