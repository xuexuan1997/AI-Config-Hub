import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { AdapterRegistry } from "@ai-config-hub/adapters";
import {
  DeploymentPlanSchema,
  DeploymentRecordSchema,
  ConversionResultSchema,
  type AdapterDiagnostic,
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
  ToolInstallationIdSchema,
  type AbsolutePath,
  type ContentHash,
  type CorrelationId,
  type IsoDateTime,
} from "@ai-config-hub/shared";

const PLAN_TTL_MS = 10 * 60 * 1_000;
const MAX_DIFF_BYTES = 200 * 1024;
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
  readonly conversionResultId: ConversionResult["conversionResultId"];
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
    const outputsByConversion = new Map<
      ConversionResult["conversionResultId"],
      Map<AbsolutePath, PlannedOutput>
    >();
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
        const plannedOutput = {
          conversionResultId: conversion.conversionResultId,
          targetPath: canonicalTarget.path,
          text: output.text,
          contentHash: output.contentHash,
        };
        outputs.push(plannedOutput);
        const conversionOutputs =
          outputsByConversion.get(conversion.conversionResultId) ??
          new Map<AbsolutePath, PlannedOutput>();
        conversionOutputs.set(canonicalTarget.path, plannedOutput);
        outputsByConversion.set(conversion.conversionResultId, conversionOutputs);
      }
    }

    outputs.sort((left, right) => compareText(left.targetPath, right.targetPath));
    const currentTargetSnapshots = new Map<AbsolutePath, FileSnapshot>();
    const expectedTargetHashes: Record<AbsolutePath, ContentHash | "absent"> = {};
    for (const output of outputs) {
      request.signal.throwIfAborted();
      const current: FileSnapshot | undefined = await this.options.snapshots.snapshot({
        path: output.targetPath,
        allowedRoots: [canonicalRoot.path],
      });
      request.signal.throwIfAborted();
      expectedTargetHashes[output.targetPath] = current?.contentHash ?? "absent";
      if (current !== undefined) currentTargetSnapshots.set(output.targetPath, current);
    }

    const planningDiagnostics = [];
    const plannedOperations: DeploymentOperation[] = [];
    const plannedDiffs: DeploymentPlan["diffs"][number][] = [];
    const plannedTargetKeys = new Set<string>();
    const verificationStrategies = new Set<string>();
    for (const conversion of conversions) {
      if (conversion.level === "unsupported") continue;
      const planning = await adapter.planDeployment({
        conversion,
        target: {
          tool: {
            toolId: request.target.toolId,
            installationId: ToolInstallationIdSchema.parse(
              `${request.target.toolId}:${canonicalRoot.path}`,
            ),
            configRoots: [canonicalRoot.path],
            evidence: {},
          },
          scope: {
            kind: "project",
            canonicalRootPath: canonicalRoot.path,
            depth: 0,
            precedence: 0,
          },
          canonicalRootPath: canonicalRoot.path,
        },
        currentTargetSnapshots,
        signal: request.signal,
      });
      if (
        planning.draft.targetToolId !== request.target.toolId ||
        planning.draft.adapterId !== adapter.adapterId ||
        planning.draft.adapterVersion !== adapter.adapterVersion
      ) {
        throw error("VALIDATION_FAILED", "Adapter deployment planning is not bound to its request");
      }
      verificationStrategies.add(planning.draft.verificationStrategy);
      planningDiagnostics.push(...planning.diagnostics);
      if (planning.diagnostics.some(({ blocking }) => blocking)) {
        throw error(
          "VALIDATION_FAILED",
          "Adapter deployment planning returned blocking diagnostics",
        );
      }
      const conversionOutputs = outputsByConversion.get(conversion.conversionResultId);
      if (conversionOutputs === undefined) {
        throw error("VALIDATION_FAILED", "Adapter deployment planning has no converted outputs");
      }
      const conversionOperationTargets = new Set<string>();
      for (const operation of planning.draft.operations) {
        const canonicalTarget = await this.options.pathPolicy.canonicalize({
          path: operation.targetPath,
          allowedRoots: [canonicalRoot.path],
          intent: "read",
        });
        if (canonicalTarget.path !== operation.targetPath) {
          throw error(
            "VALIDATION_FAILED",
            "Adapter deployment planning returned a non-canonical target",
          );
        }
        if (plannedTargetKeys.has(canonicalTarget.comparisonKey)) {
          throw error("TARGET_CONFLICT", `Multiple operations target ${canonicalTarget.path}`);
        }
        if (conversionOperationTargets.has(canonicalTarget.comparisonKey)) {
          throw error("TARGET_CONFLICT", `Multiple operations target ${canonicalTarget.path}`);
        }
        conversionOperationTargets.add(canonicalTarget.comparisonKey);
        const convertedOutput = conversionOutputs.get(operation.targetPath);
        if (convertedOutput === undefined) {
          throw error(
            "VALIDATION_FAILED",
            "Adapter deployment planning returned a target not produced by the conversion",
          );
        }
        if (operation.kind !== "create" && operation.kind !== "replace") {
          throw error(
            "VALIDATION_FAILED",
            "Adapter deployment planning returned an unsupported operation kind",
          );
        }
        if ((operation.deploymentType ?? "generated_file") !== "generated_file") {
          throw error(
            "VALIDATION_FAILED",
            "Adapter deployment planning returned an unsupported deployment operation type",
          );
        }
        if (outputHash(operation.nextText) !== convertedOutput.contentHash) {
          throw error(
            "VALIDATION_FAILED",
            "Adapter deployment planning returned content that does not match conversion output",
          );
        }
        if (operation.expectedTargetHash !== expectedTargetHashes[operation.targetPath]) {
          throw error(
            "VALIDATION_FAILED",
            "Adapter deployment planning returned a stale expected target hash",
          );
        }
        if (operation.targetResourceKind !== conversion.targetResourceKind) {
          throw error(
            "VALIDATION_FAILED",
            "Adapter deployment planning returned mismatched target resource metadata",
          );
        }
        plannedTargetKeys.add(canonicalTarget.comparisonKey);
        if (operation.kind === "replace" && conflictPolicy === "fail") {
          throw error("TARGET_CONFLICT", `Target already exists: ${operation.targetPath}`);
        }
        plannedOperations.push(operation);
      }
      const operationTargets = new Set(
        planning.draft.operations.map(({ targetPath }) => targetPath),
      );
      for (const convertedOutput of conversionOutputs.values()) {
        if (
          expectedTargetHashes[convertedOutput.targetPath] !== convertedOutput.contentHash &&
          !operationTargets.has(convertedOutput.targetPath)
        ) {
          throw error(
            "VALIDATION_FAILED",
            "Adapter deployment planning omitted a changed conversion output",
          );
        }
      }
      for (const diff of planning.draft.diffs) {
        const canonicalDiffTarget = await this.options.pathPolicy.canonicalize({
          path: diff.targetPath,
          allowedRoots: [canonicalRoot.path],
          intent: "read",
        });
        if (canonicalDiffTarget.path !== diff.targetPath) {
          throw error(
            "VALIDATION_FAILED",
            "Adapter deployment planning returned a non-canonical diff target",
          );
        }
        if (!operationTargets.has(diff.targetPath)) {
          throw error(
            "VALIDATION_FAILED",
            "Adapter deployment planning returned a diff without a matching operation",
          );
        }
        if (Buffer.byteLength(diff.unifiedText, "utf8") > MAX_DIFF_BYTES) {
          throw error(
            "PREVIEW_TOO_LARGE",
            "Adapter deployment planning returned an oversized diff",
          );
        }
        plannedDiffs.push(diff);
      }
    }
    const operations = plannedOperations.sort((left, right) =>
      compareText(left.targetPath, right.targetPath),
    );
    const diffs = plannedDiffs.sort((left, right) =>
      compareText(left.targetPath, right.targetPath),
    );
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
        description:
          [...verificationStrategies].sort(compareText).join("; ") ||
          `Verify resulting files with ${adapter.adapterId}@${adapter.adapterVersion}`,
      },
      requiredConfirmations: confirmations,
      warnings: [
        ...partials.flatMap(({ warnings }) => warnings),
        ...planningWarnings(planningDiagnostics),
      ],
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

function planningWarnings(diagnostics: readonly AdapterDiagnostic[]): readonly string[] {
  return diagnostics
    .filter(({ blocking }) => !blocking)
    .map(({ message }) => message.trim())
    .filter((message, index, messages) => message !== "" && messages.indexOf(message) === index)
    .sort(compareText);
}
