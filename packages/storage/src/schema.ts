import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const requiredText = (name: string) => text(name).notNull();
const requiredInteger = (name: string) => integer(name).notNull();

export const tools = sqliteTable("tools", {
  id: id(),
  toolInstallationId: requiredText("tool_installation_id").unique(),
  toolKey: requiredText("tool_key"),
  canonicalConfigRoot: requiredText("canonical_config_root"),
  displayName: requiredText("display_name"),
  detectedVersion: text("detected_version"),
  adapterVersion: requiredText("adapter_version"),
  capabilitiesJson: requiredText("capabilities_json"),
  lastSeenAt: requiredInteger("last_seen_at"),
  isDetected: requiredInteger("is_detected").default(1),
});

export const projects = sqliteTable("projects", {
  id: id(),
  domainId: requiredText("domain_id").unique(),
  rootPathDisplay: requiredText("root_path_display"),
  rootPathNormalized: requiredText("root_path_normalized").unique(),
  name: requiredText("name"),
  gitRootNormalized: text("git_root_normalized"),
  firstSeenAt: requiredInteger("first_seen_at"),
  lastSeenAt: requiredInteger("last_seen_at"),
});

export const scanRuns = sqliteTable("scan_runs", {
  id: id(),
  domainId: requiredText("domain_id").unique(),
  taskId: text("task_id").unique(),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  scanKind: requiredText("scan_kind"),
  status: requiredText("status"),
  phase: requiredText("phase"),
  requestedRootsJson: requiredText("requested_roots_json"),
  startedAt: requiredInteger("started_at"),
  finishedAt: integer("finished_at"),
  discoveredCount: requiredInteger("discovered_count").default(0),
  processedCount: requiredInteger("processed_count").default(0),
  succeededCount: requiredInteger("succeeded_count").default(0),
  failedCount: requiredInteger("failed_count").default(0),
  cancelRequestedAt: integer("cancel_requested_at"),
  errorSummaryJson: text("error_summary_json"),
  progressJson: text("progress_json"),
  summaryJson: text("summary_json"),
  effectiveConfigsJson: requiredText("effective_configs_json").default("[]"),
});

export const scopes = sqliteTable("scopes", {
  id: id(),
  domainId: requiredText("domain_id").unique(),
  toolId: requiredText("tool_id").references(() => tools.id, { onDelete: "restrict" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  parentScopeId: text("parent_scope_id"),
  scopeKind: requiredText("scope_kind"),
  rootPathDisplay: requiredText("root_path_display"),
  rootPathNormalized: requiredText("root_path_normalized"),
  depth: requiredInteger("depth"),
  precedence: requiredInteger("precedence"),
  adapterScopeKey: requiredText("adapter_scope_key"),
});

export const assets = sqliteTable("assets", {
  id: id(),
  domainId: requiredText("domain_id").unique(),
  toolId: requiredText("tool_id").references(() => tools.id, { onDelete: "restrict" }),
  scopeId: requiredText("scope_id").references(() => scopes.id, { onDelete: "cascade" }),
  lastScanRunId: text("last_scan_run_id").references(() => scanRuns.id, {
    onDelete: "set null",
  }),
  resourceType: requiredText("resource_type"),
  logicalKey: requiredText("logical_key"),
  sourcePathDisplay: requiredText("source_path_display"),
  sourcePathNormalized: requiredText("source_path_normalized"),
  contentHash: requiredText("content_hash"),
  observedMtimeMs: requiredInteger("observed_mtime_ms"),
  observedSize: requiredInteger("observed_size"),
  normalizedJson: requiredText("normalized_json"),
  normalizedSchemaVersion: requiredText("normalized_schema_version"),
  adapterVersion: requiredText("adapter_version"),
  parseStatus: requiredText("parse_status"),
  sensitiveSummaryJson: requiredText("sensitive_summary_json"),
  firstSeenAt: requiredInteger("first_seen_at"),
  lastSeenAt: requiredInteger("last_seen_at"),
});

export const assetReferences = sqliteTable("asset_references", {
  id: id(),
  sourceAssetId: requiredText("source_asset_id").references(() => assets.id, {
    onDelete: "cascade",
  }),
  targetAssetId: text("target_asset_id").references(() => assets.id, { onDelete: "set null" }),
  referenceKind: requiredText("reference_kind"),
  targetKey: requiredText("target_key"),
  locationJson: requiredText("location_json"),
  resolutionStatus: requiredText("resolution_status"),
});

export const assetStatusOverrides = sqliteTable("asset_status_overrides", {
  assetDomainId: text("asset_domain_id").primaryKey(),
  status: requiredText("status"),
  createdAt: requiredInteger("created_at"),
  updatedAt: requiredInteger("updated_at"),
});

export const diagnostics = sqliteTable("diagnostics", {
  id: id(),
  assetId: text("asset_id").references(() => assets.id, { onDelete: "cascade" }),
  scanRunId: requiredText("scan_run_id").references(() => scanRuns.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  code: requiredText("code"),
  severity: requiredText("severity"),
  messageKey: requiredText("message_key"),
  locationJson: requiredText("location_json"),
  evidenceJson: requiredText("evidence_json"),
  suggestedAction: text("suggested_action"),
  fingerprint: requiredText("fingerprint"),
  createdAt: requiredInteger("created_at"),
});

export const settings = sqliteTable("settings", {
  id: id(),
  settingKey: requiredText("setting_key").unique(),
  valueJson: requiredText("value_json"),
  visibility: requiredText("visibility"),
  revision: requiredInteger("revision"),
  createdAt: requiredInteger("created_at"),
  updatedAt: requiredInteger("updated_at"),
});

export const deployments = sqliteTable("deployments", {
  id: id(),
  domainId: requiredText("domain_id").unique(),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  sourceAssetId: text("source_asset_id").references(() => assets.id, { onDelete: "set null" }),
  targetToolId: requiredText("target_tool_id").references(() => tools.id, {
    onDelete: "restrict",
  }),
  planId: requiredText("plan_id").unique(),
  status: requiredText("status"),
  sourceHash: requiredText("source_hash"),
  targetHashBefore: text("target_hash_before"),
  planJson: requiredText("plan_json"),
  compatibility: requiredText("compatibility"),
  requestedAt: requiredInteger("requested_at"),
  confirmedAt: integer("confirmed_at"),
  finishedAt: integer("finished_at"),
  verificationJson: text("verification_json"),
  rollbackState: requiredText("rollback_state"),
  correlationId: requiredText("correlation_id"),
  rollbackOfDomainId: text("rollback_of_domain_id"),
});

export const deploymentOperations = sqliteTable("deployment_operations", {
  id: id(),
  deploymentId: requiredText("deployment_id").references(() => deployments.id, {
    onDelete: "cascade",
  }),
  sequenceNo: requiredInteger("sequence_no"),
  operationKind: requiredText("operation_kind"),
  targetPathNormalized: requiredText("target_path_normalized"),
  expectedHashBefore: text("expected_hash_before"),
  resultHashAfter: text("result_hash_after"),
  fenceToken: requiredInteger("fence_token"),
  state: requiredText("state"),
  compensationKind: text("compensation_kind"),
  compensationPayloadJson: text("compensation_payload_json"),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  errorCode: text("error_code"),
});

export const backups = sqliteTable("backups", {
  id: id(),
  domainId: requiredText("domain_id").unique(),
  deploymentId: requiredText("deployment_id").references(() => deployments.id, {
    onDelete: "restrict",
  }),
  operationId: requiredText("operation_id").references(() => deploymentOperations.id, {
    onDelete: "restrict",
  }),
  backupPathNormalized: requiredText("backup_path_normalized"),
  targetPathNormalized: requiredText("target_path_normalized"),
  contentHash: requiredText("content_hash"),
  sizeBytes: requiredInteger("size_bytes"),
  createdAt: requiredInteger("created_at"),
  expiresAt: integer("expires_at"),
  permissionMode: requiredText("permission_mode"),
  encryptionState: requiredText("encryption_state"),
  restoreVerifiedAt: integer("restore_verified_at"),
});

export const databaseBackups = sqliteTable("database_backups", {
  id: id(),
  domainId: requiredText("domain_id").unique(),
  reason: requiredText("reason"),
  state: requiredText("state"),
  backupPathNormalized: requiredText("backup_path_normalized").unique(),
  manifestVersion: requiredInteger("manifest_version"),
  manifestHash: requiredText("manifest_hash"),
  databaseFileHash: requiredText("database_file_hash"),
  databaseSchemaVersion: requiredInteger("database_schema_version"),
  sourceDatabaseId: requiredText("source_database_id"),
  sizeBytes: requiredInteger("size_bytes"),
  createdAt: requiredInteger("created_at"),
  verifiedAt: integer("verified_at"),
  expiresAt: integer("expires_at"),
  failureCode: text("failure_code"),
});

export const deploymentLocks = sqliteTable("deployment_locks", {
  id: id(),
  deploymentId: text("deployment_id").references(() => deployments.id, {
    onDelete: "set null",
  }),
  canonicalTargetKey: requiredText("canonical_target_key").unique(),
  ownerId: requiredText("owner_id"),
  leaseExpiresAt: requiredInteger("lease_expires_at"),
  fenceToken: requiredInteger("fence_token"),
  acquiredAt: requiredInteger("acquired_at"),
  renewedAt: requiredInteger("renewed_at"),
});

export const recoveryLocks = sqliteTable("recovery_locks", {
  canonicalTargetKey: text("canonical_target_key").primaryKey(),
  deploymentId: requiredText("deployment_id").references(() => deployments.id, {
    onDelete: "restrict",
  }),
  reason: requiredText("reason"),
  createdAt: requiredInteger("created_at"),
  resolvedAt: integer("resolved_at"),
  resolutionEvidenceJson: text("resolution_evidence_json"),
  recoveryOwnerId: text("recovery_owner_id"),
  recoveryClaimExpiresAt: integer("recovery_claim_expires_at"),
  recoveryFenceToken: requiredInteger("recovery_fence_token").default(1),
});

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: integer("version").primaryKey(),
  name: requiredText("name").unique(),
  checksum: requiredText("checksum").unique(),
  startedAt: requiredInteger("started_at"),
  appliedAt: integer("applied_at"),
  state: requiredText("state"),
  errorCode: text("error_code"),
  appVersion: requiredText("app_version"),
  preMigrationBackupId: text("pre_migration_backup_id").references(() => databaseBackups.id, {
    onDelete: "restrict",
  }),
});

export const storageSchema = Object.freeze({
  tools,
  projects,
  scopes,
  assets,
  assetReferences,
  assetStatusOverrides,
  diagnostics,
  settings,
  scanRuns,
  deployments,
  deploymentOperations,
  backups,
  databaseBackups,
  deploymentLocks,
  recoveryLocks,
  schemaMigrations,
});
