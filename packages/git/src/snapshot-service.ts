import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { Asset, DeploymentRecord, GitCommitSummary, LocalGitPort } from "@ai-config-hub/core";
import type { AbsolutePath, IsoDateTime } from "@ai-config-hub/shared";
import { AppError } from "@ai-config-hub/shared";

export interface SnapshotFileWriter {
  writeText(root: AbsolutePath, relativePath: string, text: string): Promise<void>;
}

export interface LocalHistoryServiceOptions {
  readonly git: LocalGitPort;
  readonly writer?: SnapshotFileWriter;
  readonly now: () => IsoDateTime;
}

export class LocalHistoryService {
  private readonly git: LocalGitPort;
  private readonly writer: SnapshotFileWriter;
  private readonly now: () => IsoDateTime;

  constructor(options: LocalHistoryServiceOptions) {
    this.git = options.git;
    this.writer = options.writer ?? new ConfinedSnapshotFileWriter();
    this.now = options.now;
  }

  async recordDeployment(input: {
    readonly root: AbsolutePath;
    readonly assets: readonly Asset[];
    readonly deployment: DeploymentRecord;
  }): Promise<GitCommitSummary> {
    await this.git.initialize(input.root);
    const records = [
      ...[...input.assets]
        .sort((left, right) => compareText(left.assetId, right.assetId))
        .map((asset) => ({
          path: `assets/${encodePathSegment(asset.assetId)}.json`,
          text: stableJson(projectAsset(asset)),
        })),
      {
        path: `deployments/${encodePathSegment(input.deployment.deploymentRecordId)}.json`,
        text: stableJson(projectDeployment(input.deployment)),
      },
    ];

    for (const record of records) {
      await this.writer.writeText(input.root, record.path, record.text);
    }

    return this.git.snapshot({
      root: input.root,
      paths: records.map((record) => record.path),
      message: `record deployment ${input.deployment.deploymentRecordId}`,
      authoredAt: input.deployment.finishedAt ?? input.deployment.startedAt ?? this.now(),
    });
  }

  list(root: AbsolutePath, limit: number, cursor?: string): Promise<readonly GitCommitSummary[]> {
    return this.git.history({ root, limit, ...(cursor === undefined ? {} : { cursor }) });
  }

  diff(root: AbsolutePath, from?: string, to?: string): Promise<string> {
    return this.git.diff({
      root,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
  }
}

export class ConfinedSnapshotFileWriter implements SnapshotFileWriter {
  async writeText(root: AbsolutePath, relativePath: string, text: string): Promise<void> {
    validateSnapshotPath(relativePath);
    const destination = resolve(root, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, text, { encoding: "utf8", flag: "w" });
  }
}

function projectAsset(asset: Asset): unknown {
  return {
    schemaVersion: 1,
    id: asset.assetId,
    toolId: asset.toolId,
    resource: sanitizeValue(asset.resource),
    scopeId: asset.scopeId,
    sourcePathDigest: digestText(asset.canonicalSourcePath),
    locator: asset.locator,
    sourceFormat: asset.sourceFormat,
    contentHash: asset.contentHash,
    normalizedSchemaVersion: asset.normalizedSchemaVersion,
    adapterId: asset.adapterId,
    adapterVersion: asset.adapterVersion,
    discoveredAt: asset.discoveredAt,
    referenceDigests: [...asset.references]
      .sort(compareText)
      .map((reference) => digestText(reference)),
    diagnosticSummary: asset.diagnosticSummary,
  };
}

function projectDeployment(deployment: DeploymentRecord): unknown {
  return {
    schemaVersion: 1,
    id: deployment.deploymentRecordId,
    planId: deployment.deploymentPlanId,
    rollbackOfRecordId: deployment.rollbackOfRecordId,
    confirmedPlanHash: deployment.confirmedPlanHash,
    status: deployment.status,
    operations: deployment.operations.map((operation) => ({
      kind: operation.kind,
      targetPathDigest: digestText(operation.targetPath),
      expectedTargetHash: operation.expectedTargetHash,
      nextTextHash: "nextText" in operation ? digestText(operation.nextText) : undefined,
    })),
    backupLocations: Object.fromEntries(
      Object.entries(deployment.backupLocations)
        .sort(([left], [right]) => compareText(left, right))
        .map(([targetPath, backupPath]) => [
          digestText(targetPath),
          backupPath === "previously-absent" ? backupPath : digestText(backupPath),
        ]),
    ),
    resultingHashes: mapPathKeysToDigests(deployment.resultingHashes),
    operationJournal: deployment.operationJournal?.map((entry) => ({
      targetPathDigest: digestText(entry.targetPath),
      operationKind: entry.operationKind,
      phase: entry.phase,
      expectedTargetHash: entry.expectedTargetHash,
      resultingHash: entry.resultingHash,
      recordedAt: entry.recordedAt,
    })),
    verificationResult:
      deployment.verificationResult.status === "passed" ||
      deployment.verificationResult.status === "failed"
        ? {
            status: deployment.verificationResult.status,
            verifiedHashes: mapPathKeysToDigests(deployment.verificationResult.verifiedHashes),
            diagnostics: deployment.verificationResult.diagnostics.map(
              (diagnostic) => diagnostic.diagnosticId,
            ),
          }
        : { status: deployment.verificationResult.status, diagnostics: [] },
    rollbackResults: deployment.rollbackResults.map((result) => ({
      targetPathDigest: digestText(result.targetPath),
      status: result.status,
      resultingHash: result.resultingHash,
      diagnosticIds: result.diagnosticIds,
    })),
    adapterId: deployment.adapterId,
    adapterVersion: deployment.adapterVersion,
    normalizedSchemaVersion: deployment.normalizedSchemaVersion,
    createdAt: deployment.createdAt,
    confirmedAt: deployment.confirmedAt,
    startedAt: deployment.startedAt,
    finishedAt: deployment.finishedAt,
    correlationId: deployment.correlationId,
    diagnostics: deployment.diagnostics.map((diagnostic) => diagnostic.diagnosticId),
  };
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value === null || typeof value !== "object") return value;

  if (isSecretAwareString(value)) {
    return {
      kind: value.kind,
      deployable: value.deployable,
      digest: digestText(
        value.kind === "literal"
          ? value.value
          : value.kind === "reference"
            ? value.expression
            : value.digest,
      ),
    };
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, nested]) => [key, sanitizeValue(nested)]),
  );
}

type SecretAwareSnapshotInput =
  | { readonly kind: "literal"; readonly value: string; readonly deployable: true }
  | { readonly kind: "reference"; readonly expression: string; readonly deployable: true }
  | { readonly kind: "redacted"; readonly digest: string; readonly deployable: false };

function isSecretAwareString(value: object): value is SecretAwareSnapshotInput {
  const candidate = value as Partial<SecretAwareSnapshotInput>;
  if (candidate.kind === "literal") {
    return typeof candidate.value === "string" && candidate.deployable === true;
  }
  if (candidate.kind === "reference") {
    return typeof candidate.expression === "string" && candidate.deployable === true;
  }
  return (
    candidate.kind === "redacted" &&
    typeof candidate.digest === "string" &&
    candidate.deployable === false
  );
}

function mapPathKeysToDigests(
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(values)
      .sort(([left], [right]) => compareText(left, right))
      .map(([path, hash]) => [digestText(path), hash]),
  );
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function digestText(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replaceAll("%", "_");
}

function validateSnapshotPath(path: string): void {
  const parts = path.split("/");
  if (
    parts.length !== 2 ||
    !["assets", "deployments"].includes(parts[0] ?? "") ||
    !parts[1]?.endsWith(".json") ||
    parts.some((part) => part.length === 0 || part === "." || part === ".." || part === ".git")
  ) {
    throw new AppError({
      code: "PATH_OUTSIDE_ALLOWED_ROOT",
      message: "History snapshot writes are limited to assets/ and deployments/",
      retryable: false,
      suggestedActions: ["Write only deterministic history projection files"],
      safeContext: { path },
    });
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
