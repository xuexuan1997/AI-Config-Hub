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

export interface PreviewRequest {
  readonly assets: readonly Asset[];
  readonly target: ConversionTarget;
  readonly targetRoot: AbsolutePath;
  readonly backupRoot: AbsolutePath;
  readonly allowedRoots: readonly AbsolutePath[];
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
  code: "UNSUPPORTED_CONVERSION" | "TARGET_CONFLICT" | "VALIDATION_FAILED",
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

function isMissing(errorValue: unknown): boolean {
  return (
    typeof errorValue === "object" &&
    errorValue !== null &&
    "code" in errorValue &&
    errorValue.code === "ENOENT"
  );
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

function bounded(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= MAX_DIFF_BYTES) return text;
  let result = bytes.subarray(0, MAX_DIFF_BYTES).toString("utf8");
  while (Buffer.byteLength(result, "utf8") > MAX_DIFF_BYTES) result = result.slice(0, -1);
  return result;
}

function unifiedDiff(path: AbsolutePath, previous: string | undefined, next: string): string {
  const before = previous === undefined ? "/dev/null" : path;
  const previousLines = previous === undefined ? [] : previous.split("\n");
  const nextLines = next.split("\n");
  const oldText = previousLines.map((line) => `-${line}`).join("\n");
  const newText = nextLines.map((line) => `+${line}`).join("\n");
  return bounded(
    `--- ${before}\n+++ ${path}\n@@ -1,${String(previousLines.length)} +1,${String(nextLines.length)} @@\n${oldText}${oldText === "" ? "" : "\n"}${newText}`,
  );
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
    if (request.assets.some(({ resource }) => hasRedactedValue(resource))) {
      throw error("UNSUPPORTED_CONVERSION", "Redacted MCP values are not deployable");
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
    const outputs: PlannedOutput[] = [];
    const targetKeys = new Set<string>();

    for (const asset of assets) {
      request.signal.throwIfAborted();
      const conversion = ConversionResultSchema.parse(
        await adapter.convert({
          asset,
          target: request.target,
          signal: request.signal,
        }),
      );
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
      let current: FileSnapshot | undefined;
      try {
        current = await this.options.snapshots.snapshot({
          path: output.targetPath,
          allowedRoots: [canonicalRoot.path],
        });
      } catch (cause) {
        if (!isMissing(cause)) throw cause;
      }
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
    await this.options.deploymentRepository.savePlanAndRecord({ plan, record });
    return Object.freeze({ plan, record, conversions: Object.freeze(conversions) });
  }
}
