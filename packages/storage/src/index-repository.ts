import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  AssetSchema,
  DiagnosticSchema,
  EffectiveConfigSchema,
  ScopeSchema,
  type DerivedIndexReplacement,
  type IndexRepository,
} from "@ai-config-hub/core";
import {
  AppError,
  PaginationCursorSchema,
  SemVerSchema,
  ToolIdSchema,
  ToolInstallationIdSchema,
} from "@ai-config-hub/shared";

import { parseJson, serializeJson } from "./serialization.js";

function readOnlyError() {
  return new AppError({
    code: "READ_ONLY_RECOVERY",
    message: "Storage is open in read-only recovery mode",
    retryable: false,
    suggestedActions: ["Repair or restore the database before making changes"],
  });
}

export class SqliteIndexRepository implements IndexRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly readOnly: boolean,
  ) {}

  replaceDerivedIndex(
    replacement: DerivedIndexReplacement,
  ): Promise<{ readonly revision: string }> {
    if (this.readOnly) return Promise.reject(readOnlyError());
    let prepared: ReturnType<typeof prepareReplacement>;
    try {
      prepared = prepareReplacement(replacement);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("Index validation failed"));
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const scanId = ensureScanRun(this.database, prepared);
      this.database.exec(
        "DELETE FROM diagnostics; DELETE FROM asset_references; DELETE FROM assets; DELETE FROM scopes; DELETE FROM projects;",
      );
      const toolIds = insertTools(this.database, prepared);
      const projectIds = insertProjects(this.database, prepared);
      const scopeIds = insertScopes(this.database, prepared, toolIds, projectIds);
      const assetIds = insertAssets(this.database, prepared, toolIds, scopeIds, scanId);
      insertReferences(this.database, prepared, assetIds);
      insertDiagnostics(this.database, prepared, assetIds, scanId);
      const current = Number(
        (this.database.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      );
      const next = current + 1;
      this.database.exec(`PRAGMA user_version = ${String(next)}`);
      this.database.exec("COMMIT");
      return Promise.resolve({ revision: String(next) });
    } catch (error) {
      this.database.exec("ROLLBACK");
      return Promise.reject(error instanceof Error ? error : new Error("Index replacement failed"));
    }
  }

  listAssets(
    query: Parameters<IndexRepository["listAssets"]>[0],
  ): ReturnType<IndexRepository["listAssets"]> {
    const revision = this.revision();
    let assets = (
      this.database.prepare("SELECT normalized_json FROM assets").all() as {
        normalized_json: string;
      }[]
    )
      .map(({ normalized_json }) => parseJson(AssetSchema, normalized_json))
      .filter((asset) => query.toolIds === undefined || query.toolIds.includes(asset.toolId))
      .filter((asset) => query.scopeIds === undefined || query.scopeIds.includes(asset.scopeId))
      .filter(
        (asset) =>
          query.resourceKinds === undefined || query.resourceKinds.includes(asset.resource.kind),
      )
      .filter(
        (asset) =>
          query.search === undefined ||
          JSON.stringify(asset).toLowerCase().includes(query.search.toLowerCase()),
      )
      .sort((left, right) => left.assetId.localeCompare(right.assetId));
    if (query.cursor !== undefined) {
      const cursor = String(query.cursor);
      assets = assets.filter(({ assetId }) => assetId.localeCompare(cursor) > 0);
    }
    const items = assets.slice(0, query.limit);
    const last = items.at(-1);
    return Promise.resolve({
      items,
      snapshotRevision: revision,
      ...(assets.length > items.length && last !== undefined
        ? { nextCursor: PaginationCursorSchema.parse(last.assetId) }
        : {}),
    });
  }

  getAsset(
    assetId: Parameters<IndexRepository["getAsset"]>[0],
  ): ReturnType<IndexRepository["getAsset"]> {
    const row = this.database
      .prepare("SELECT normalized_json FROM assets WHERE domain_id = ?")
      .get(assetId) as { normalized_json: string } | undefined;
    return Promise.resolve(
      row === undefined ? undefined : parseJson(AssetSchema, row.normalized_json),
    );
  }

  getEffectiveConfig(
    id: Parameters<IndexRepository["getEffectiveConfig"]>[0],
  ): ReturnType<IndexRepository["getEffectiveConfig"]> {
    const rows = this.database
      .prepare("SELECT effective_configs_json FROM scan_runs ORDER BY started_at DESC")
      .all() as {
      effective_configs_json: string;
    }[];
    for (const row of rows) {
      const found = parseJson(EffectiveConfigSchema.array(), row.effective_configs_json).find(
        ({ effectiveConfigId }) => effectiveConfigId === id,
      );
      if (found !== undefined) return Promise.resolve(found);
    }
    return Promise.resolve(undefined);
  }

  listDiagnostics(
    query: Parameters<IndexRepository["listDiagnostics"]>[0],
  ): ReturnType<IndexRepository["listDiagnostics"]> {
    let diagnostics = (
      this.database.prepare("SELECT evidence_json FROM diagnostics").all() as {
        evidence_json: string;
      }[]
    )
      .map(({ evidence_json }) => parseJson(DiagnosticSchema, evidence_json))
      .filter(
        (item) =>
          query.assetId === undefined ||
          (item.subject.kind === "asset" && item.subject.id === query.assetId),
      )
      .filter((item) => query.severity === undefined || query.severity.includes(item.severity))
      .sort((left, right) => left.diagnosticId.localeCompare(right.diagnosticId));
    if (query.cursor !== undefined) {
      const cursor = String(query.cursor);
      diagnostics = diagnostics.filter(
        ({ diagnosticId }) => diagnosticId.localeCompare(cursor) > 0,
      );
    }
    const items = diagnostics.slice(0, query.limit);
    const last = items.at(-1);
    return Promise.resolve({
      items,
      snapshotRevision: this.revision(),
      ...(diagnostics.length > items.length && last !== undefined
        ? { nextCursor: PaginationCursorSchema.parse(last.diagnosticId) }
        : {}),
    });
  }

  getDiagnostic(
    id: Parameters<IndexRepository["getDiagnostic"]>[0],
  ): ReturnType<IndexRepository["getDiagnostic"]> {
    const row = this.database
      .prepare("SELECT evidence_json FROM diagnostics WHERE id = ?")
      .get(id) as { evidence_json: string } | undefined;
    return Promise.resolve(
      row === undefined ? undefined : parseJson(DiagnosticSchema, row.evidence_json),
    );
  }

  private revision(): string {
    return String(
      (this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    );
  }
}

function prepareReplacement(replacement: DerivedIndexReplacement) {
  ToolInstallationIdSchema.parse(replacement.scanRunId);
  const tools = replacement.tools.map((tool) => ({
    ...tool,
    toolId: ToolIdSchema.parse(tool.toolId),
    installationId: ToolInstallationIdSchema.parse(tool.installationId),
    ...(tool.detectedVersion === undefined
      ? {}
      : { detectedVersion: SemVerSchema.parse(tool.detectedVersion) }),
  }));
  const scopes = replacement.scopes.map((scope) => ScopeSchema.parse(scope));
  const assets = replacement.assets.map((asset) => AssetSchema.parse(asset));
  const effectiveConfigs = replacement.effectiveConfigs.map((value) =>
    EffectiveConfigSchema.parse(value),
  );
  const diagnostics = replacement.diagnostics.map((value) => DiagnosticSchema.parse(value));
  for (const value of [tools, scopes, assets, effectiveConfigs, diagnostics]) serializeJson(value);
  return { ...replacement, tools, scopes, assets, effectiveConfigs, diagnostics };
}

function ensureScanRun(database: DatabaseSync, replacement: ReturnType<typeof prepareReplacement>) {
  const existing = database
    .prepare("SELECT id FROM scan_runs WHERE domain_id = ?")
    .get(replacement.scanRunId) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  if (existing === undefined) {
    database
      .prepare(
        `INSERT INTO scan_runs(id, domain_id, scan_kind, status, phase, requested_roots_json, started_at, effective_configs_json) VALUES(?, ?, 'targeted', 'indexing', 'committing', '[]', ?, ?)`,
      )
      .run(id, replacement.scanRunId, Date.now(), serializeJson(replacement.effectiveConfigs));
  } else {
    database
      .prepare("UPDATE scan_runs SET effective_configs_json = ?, phase = 'committing' WHERE id = ?")
      .run(serializeJson(replacement.effectiveConfigs), id);
  }
  return id;
}

function insertTools(database: DatabaseSync, replacement: ReturnType<typeof prepareReplacement>) {
  const result = new Map<string, string>();
  for (const tool of replacement.tools) {
    const existing = database
      .prepare("SELECT id FROM tools WHERE tool_installation_id = ?")
      .get(tool.installationId) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    database
      .prepare(
        `INSERT INTO tools(id, tool_installation_id, tool_key, canonical_config_root, display_name, detected_version, adapter_version, capabilities_json, last_seen_at, is_detected) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(tool_installation_id) DO UPDATE SET detected_version=excluded.detected_version, capabilities_json=excluded.capabilities_json, last_seen_at=excluded.last_seen_at, is_detected=1`,
      )
      .run(
        id,
        tool.installationId,
        tool.toolId,
        tool.configRoots[0] ?? "/",
        tool.toolId,
        tool.detectedVersion ?? null,
        "0.0.0",
        serializeJson(tool.evidence),
        Date.now(),
      );
    result.set(tool.installationId, id);
  }
  return result;
}

function insertProjects(
  database: DatabaseSync,
  replacement: ReturnType<typeof prepareReplacement>,
) {
  const result = new Map<string, string>();
  for (const scope of replacement.scopes.filter(({ projectId }) => projectId !== undefined)) {
    if (scope.projectId === undefined || result.has(scope.projectId)) continue;
    const id = randomUUID();
    database
      .prepare(
        "INSERT INTO projects(id, domain_id, root_path_display, root_path_normalized, name, first_seen_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        scope.projectId,
        scope.canonicalRootPath,
        scope.canonicalRootPath,
        basename(scope.canonicalRootPath),
        Date.now(),
        Date.now(),
      );
    result.set(scope.projectId, id);
  }
  return result;
}

function installationForScope(
  scope: ReturnType<typeof ScopeSchema.parse>,
  replacement: ReturnType<typeof prepareReplacement>,
) {
  const evidence = scope.discoveryEvidence["installationId"];
  if (typeof evidence === "string") return evidence;
  return replacement.tools.find(({ toolId }) => toolId === scope.toolId)?.installationId;
}

function insertScopes(
  database: DatabaseSync,
  replacement: ReturnType<typeof prepareReplacement>,
  toolIds: Map<string, string>,
  projectIds: Map<string, string>,
) {
  const result = new Map<string, string>();
  for (const scope of [...replacement.scopes].sort((left, right) => left.depth - right.depth)) {
    const installation = installationForScope(scope, replacement);
    const toolId = installation === undefined ? undefined : toolIds.get(installation);
    if (toolId === undefined)
      throw new Error(`Scope has no matching tool installation: ${scope.scopeId}`);
    const id = randomUUID();
    database
      .prepare(
        "INSERT INTO scopes(id, domain_id, tool_id, project_id, parent_scope_id, scope_kind, root_path_display, root_path_normalized, depth, precedence, adapter_scope_key) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        scope.scopeId,
        toolId,
        scope.projectId === undefined ? null : (projectIds.get(scope.projectId) ?? null),
        scope.parentScopeId === undefined ? null : (result.get(scope.parentScopeId) ?? null),
        scope.scopeKind,
        scope.canonicalRootPath,
        scope.canonicalRootPath,
        scope.depth,
        scope.precedence,
        scope.scopeId,
      );
    result.set(scope.scopeId, id);
  }
  return result;
}

function insertAssets(
  database: DatabaseSync,
  replacement: ReturnType<typeof prepareReplacement>,
  toolIds: Map<string, string>,
  scopeIds: Map<string, string>,
  scanId: string,
) {
  const result = new Map<string, string>();
  for (const item of replacement.assets) {
    const scope = replacement.scopes.find(({ scopeId }) => scopeId === item.scopeId);
    const installation = scope === undefined ? undefined : installationForScope(scope, replacement);
    const toolId = installation === undefined ? undefined : toolIds.get(installation);
    const scopeId = scopeIds.get(item.scopeId);
    if (toolId === undefined || scopeId === undefined)
      throw new Error(`Asset has unresolved ownership: ${item.assetId}`);
    const serialized = serializeJson(item);
    const id = randomUUID();
    const observed = Date.parse(item.discoveredAt);
    database
      .prepare(
        `INSERT INTO assets(id, domain_id, tool_id, scope_id, last_scan_run_id, resource_type, logical_key, source_path_display, source_path_normalized, content_hash, observed_mtime_ms, observed_size, normalized_json, normalized_schema_version, adapter_version, parse_status, sensitive_summary_json, first_seen_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'parsed', '{}', ?, ?)`,
      )
      .run(
        id,
        item.assetId,
        toolId,
        scopeId,
        scanId,
        item.resource.kind,
        item.locator,
        item.canonicalSourcePath,
        item.canonicalSourcePath,
        item.contentHash,
        observed,
        Buffer.byteLength(serialized),
        serialized,
        item.normalizedSchemaVersion,
        item.adapterVersion,
        observed,
        observed,
      );
    result.set(item.assetId, id);
  }
  return result;
}

function insertReferences(
  database: DatabaseSync,
  replacement: ReturnType<typeof prepareReplacement>,
  assetIds: Map<string, string>,
) {
  for (const item of replacement.assets) {
    const sourceAssetId = assetIds.get(item.assetId);
    if (sourceAssetId === undefined)
      throw new Error(`Reference source is missing: ${item.assetId}`);
    for (const target of item.references)
      database
        .prepare(
          "INSERT INTO asset_references(id, source_asset_id, reference_kind, target_key, location_json, resolution_status) VALUES(?, ?, 'resource', ?, '{}', 'unresolved')",
        )
        .run(randomUUID(), sourceAssetId, target);
  }
}

function insertDiagnostics(
  database: DatabaseSync,
  replacement: ReturnType<typeof prepareReplacement>,
  assetIds: Map<string, string>,
  scanId: string,
) {
  for (const item of replacement.diagnostics) {
    const assetId = item.subject.kind === "asset" ? (assetIds.get(item.subject.id) ?? null) : null;
    database
      .prepare(
        "INSERT INTO diagnostics(id, asset_id, scan_run_id, code, severity, message_key, location_json, evidence_json, suggested_action, fingerprint, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        item.diagnosticId,
        assetId,
        scanId,
        item.code,
        item.severity,
        item.message,
        serializeJson(item.location ?? {}),
        serializeJson(item),
        item.suggestedActions[0] ?? null,
        item.diagnosticId,
        Date.parse(item.createdAt),
      );
  }
}

export { readOnlyError };
