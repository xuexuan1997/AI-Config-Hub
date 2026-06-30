import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  AssetSchema,
  AssetStatusSchema,
  DiagnosticSchema,
  EffectiveConfigSchema,
  ScopeSchema,
  type Asset,
  type AssetStatus,
  type DerivedIndexIncrementalReplacement,
  type DerivedIndexReplacement,
  type IndexRepository,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AppError,
  AssetIdSchema,
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

function withAssetStatus(asset: Asset, status: AssetStatus): Asset {
  return AssetSchema.parse({ ...asset, status });
}

function assetStatusOverrides(
  database: DatabaseSync,
  assetIds: readonly string[],
): ReadonlyMap<string, AssetStatus> {
  if (assetIds.length === 0) return new Map();
  const placeholders = assetIds.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT asset_domain_id, status FROM asset_status_overrides WHERE asset_domain_id IN (${placeholders})`,
    )
    .all(...assetIds) as { readonly asset_domain_id: string; readonly status: string }[];
  return new Map(rows.map((row) => [row.asset_domain_id, AssetStatusSchema.parse(row.status)]));
}

function applyAssetStatus(database: DatabaseSync, asset: Asset): Asset {
  const status = assetStatusOverrides(database, [asset.assetId]).get(asset.assetId) ?? "enabled";
  return withAssetStatus(asset, status);
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
      const next = bumpRevision(this.database);
      this.database.exec("COMMIT");
      return Promise.resolve({ revision: String(next) });
    } catch (error) {
      this.database.exec("ROLLBACK");
      return Promise.reject(error instanceof Error ? error : new Error("Index replacement failed"));
    }
  }

  mergeIncrementalIndex(
    replacement: DerivedIndexIncrementalReplacement,
  ): Promise<{ readonly revision: string }> {
    if (this.readOnly) return Promise.reject(readOnlyError());
    let prepared: ReturnType<typeof prepareReplacement>;
    let changedPaths: readonly ReturnType<typeof AbsolutePathSchema.parse>[];
    try {
      prepared = prepareReplacement(replacement);
      changedPaths = replacement.changedPaths.map((path) => AbsolutePathSchema.parse(path));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("Index validation failed"));
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const scanId = ensureScanRun(this.database, prepared, "incremental");
      const toolIds = insertTools(this.database, prepared);
      const projectIds = insertProjects(this.database, prepared);
      const scopeIds = insertScopes(this.database, prepared, toolIds, projectIds);
      deleteChangedPathRows(this.database, changedPaths);
      const assetIds = insertAssets(this.database, prepared, toolIds, scopeIds, scanId);
      insertReferences(this.database, prepared, assetIds);
      insertDiagnostics(this.database, prepared, assetIds, scanId);
      const next = bumpRevision(this.database);
      this.database.exec("COMMIT");
      return Promise.resolve({ revision: String(next) });
    } catch (error) {
      this.database.exec("ROLLBACK");
      return Promise.reject(error instanceof Error ? error : new Error("Index merge failed"));
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
      .map(({ normalized_json }) =>
        applyAssetStatus(this.database, parseJson(AssetSchema, normalized_json)),
      )
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
      row === undefined
        ? undefined
        : applyAssetStatus(this.database, parseJson(AssetSchema, row.normalized_json)),
    );
  }

  getAssetStatuses(
    assetIds: Parameters<IndexRepository["getAssetStatuses"]>[0],
  ): ReturnType<IndexRepository["getAssetStatuses"]> {
    const parsedAssetIds = assetIds.map((assetId) => AssetIdSchema.parse(assetId));
    if (parsedAssetIds.length === 0) return Promise.resolve(new Map());
    const overrides = assetStatusOverrides(this.database, parsedAssetIds);
    return Promise.resolve(
      new Map(parsedAssetIds.map((assetId) => [assetId, overrides.get(assetId) ?? "enabled"])),
    );
  }

  setAssetStatus(
    assetId: Parameters<IndexRepository["setAssetStatus"]>[0],
    status: Parameters<IndexRepository["setAssetStatus"]>[1],
  ): ReturnType<IndexRepository["setAssetStatus"]> {
    if (this.readOnly) return Promise.reject(readOnlyError());
    const parsedAssetId = AssetIdSchema.parse(assetId);
    const parsedStatus = AssetStatusSchema.parse(status);
    const existing = this.database
      .prepare("SELECT 1 AS found FROM assets WHERE domain_id = ?")
      .get(parsedAssetId);
    if (existing === undefined) {
      return Promise.reject(
        new AppError({
          code: "NOT_FOUND",
          message: "Asset not found",
          retryable: false,
          suggestedActions: ["Scan the project and choose an existing asset"],
        }),
      );
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (parsedStatus === "enabled") {
        this.database
          .prepare("DELETE FROM asset_status_overrides WHERE asset_domain_id = ?")
          .run(parsedAssetId);
      } else {
        const now = Date.now();
        this.database
          .prepare(
            `INSERT INTO asset_status_overrides(asset_domain_id, status, created_at, updated_at)
             VALUES(?, ?, ?, ?)
             ON CONFLICT(asset_domain_id) DO UPDATE SET
               status = excluded.status,
               updated_at = excluded.updated_at`,
          )
          .run(parsedAssetId, parsedStatus, now, now);
      }
      const revision = String(bumpRevision(this.database));
      this.database.exec("COMMIT");
      return Promise.resolve({ assetId: parsedAssetId, status: parsedStatus, revision });
    } catch (error) {
      this.database.exec("ROLLBACK");
      return Promise.reject(
        error instanceof Error ? error : new Error("Asset status update failed"),
      );
    }
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

  listScopes(): ReturnType<IndexRepository["listScopes"]> {
    const rows = this.database
      .prepare(
        `SELECT
          scopes.domain_id AS scope_id,
          scopes.scope_kind AS scope_kind,
          scopes.root_path_normalized AS root_path,
          scopes.depth AS depth,
          scopes.precedence AS precedence,
          parent.domain_id AS parent_scope_id,
          projects.domain_id AS project_id,
          tools.tool_key AS tool_key,
          tools.tool_installation_id AS installation_id
        FROM scopes
        JOIN tools ON tools.id = scopes.tool_id
        LEFT JOIN scopes AS parent ON parent.id = scopes.parent_scope_id
        LEFT JOIN projects ON projects.id = scopes.project_id`,
      )
      .all() as {
      readonly scope_id: string;
      readonly scope_kind: string;
      readonly root_path: string;
      readonly depth: number;
      readonly precedence: number;
      readonly parent_scope_id: string | null;
      readonly project_id: string | null;
      readonly tool_key: string;
      readonly installation_id: string;
    }[];
    return Promise.resolve(
      rows
        .map((row) =>
          ScopeSchema.parse({
            scopeId: row.scope_id,
            toolId: row.tool_key,
            scopeKind: row.scope_kind,
            canonicalRootPath: row.root_path,
            ...(row.project_id === null ? {} : { projectId: row.project_id }),
            ...(row.parent_scope_id === null ? {} : { parentScopeId: row.parent_scope_id }),
            depth: row.depth,
            precedence: row.precedence,
            discoveryEvidence: { installationId: row.installation_id },
          }),
        )
        .sort((left, right) => left.scopeId.localeCompare(right.scopeId)),
    );
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

function ensureScanRun(
  database: DatabaseSync,
  replacement: ReturnType<typeof prepareReplacement>,
  kind: "incremental" | "targeted" = "targeted",
) {
  const existing = database
    .prepare("SELECT id FROM scan_runs WHERE domain_id = ?")
    .get(replacement.scanRunId) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  if (existing === undefined) {
    database
      .prepare(
        `INSERT INTO scan_runs(id, domain_id, scan_kind, status, phase, requested_roots_json, started_at, effective_configs_json) VALUES(?, ?, ?, 'indexing', 'committing', '[]', ?, ?)`,
      )
      .run(
        id,
        replacement.scanRunId,
        kind,
        Date.now(),
        serializeJson(replacement.effectiveConfigs),
      );
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
    const existing = database
      .prepare("SELECT id FROM projects WHERE domain_id = ?")
      .get(scope.projectId) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    if (existing !== undefined) {
      database
        .prepare(
          "UPDATE projects SET root_path_display = ?, root_path_normalized = ?, name = ?, last_seen_at = ? WHERE id = ?",
        )
        .run(
          scope.canonicalRootPath,
          scope.canonicalRootPath,
          basename(scope.canonicalRootPath),
          Date.now(),
          id,
        );
      result.set(scope.projectId, id);
      continue;
    }
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
    const existing = database
      .prepare("SELECT id FROM scopes WHERE domain_id = ?")
      .get(scope.scopeId) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    if (existing !== undefined) {
      database
        .prepare(
          "UPDATE scopes SET tool_id = ?, project_id = ?, parent_scope_id = ?, scope_kind = ?, root_path_display = ?, root_path_normalized = ?, depth = ?, precedence = ?, adapter_scope_key = ? WHERE id = ?",
        )
        .run(
          toolId,
          scope.projectId === undefined ? null : (projectIds.get(scope.projectId) ?? null),
          scope.parentScopeId === undefined ? null : (result.get(scope.parentScopeId) ?? null),
          scope.scopeKind,
          scope.canonicalRootPath,
          scope.canonicalRootPath,
          scope.depth,
          scope.precedence,
          scope.scopeId,
          id,
        );
      result.set(scope.scopeId, id);
      continue;
    }
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

function deleteChangedPathRows(database: DatabaseSync, changedPaths: readonly string[]): void {
  if (changedPaths.length === 0) return;
  const changed = new Set(changedPaths);
  for (const path of changed) {
    const assets = database
      .prepare("SELECT id FROM assets WHERE source_path_normalized = ?")
      .all(path) as { id: string }[];
    for (const asset of assets)
      database.prepare("DELETE FROM diagnostics WHERE asset_id = ?").run(asset.id);
    database.prepare("DELETE FROM assets WHERE source_path_normalized = ?").run(path);
  }

  const diagnostics = database.prepare("SELECT id, evidence_json FROM diagnostics").all() as {
    id: string;
    evidence_json: string;
  }[];
  for (const row of diagnostics) {
    const diagnostic = parseJson(DiagnosticSchema, row.evidence_json);
    const evidenceSource =
      typeof diagnostic.evidence["sourcePath"] === "string"
        ? diagnostic.evidence["sourcePath"]
        : undefined;
    if (
      (diagnostic.location?.path !== undefined && changed.has(diagnostic.location.path)) ||
      (evidenceSource !== undefined && changed.has(evidenceSource))
    ) {
      database.prepare("DELETE FROM diagnostics WHERE id = ?").run(row.id);
    }
  }
}

function bumpRevision(database: DatabaseSync): number {
  const current = Number(
    (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  const next = current + 1;
  database.exec(`PRAGMA user_version = ${String(next)}`);
  return next;
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
