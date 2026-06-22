CREATE TABLE tools (
  id TEXT PRIMARY KEY,
  tool_installation_id TEXT NOT NULL UNIQUE,
  tool_key TEXT NOT NULL CHECK(tool_key IN ('claude-code','cursor','codex','opencode')),
  canonical_config_root TEXT NOT NULL,
  display_name TEXT NOT NULL,
  detected_version TEXT,
  adapter_version TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  is_detected INTEGER NOT NULL DEFAULT 1 CHECK(is_detected IN (0,1)),
  UNIQUE(tool_key, canonical_config_root)
) STRICT;
CREATE INDEX idx_tools_detected ON tools(is_detected, tool_key);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL UNIQUE,
  root_path_display TEXT NOT NULL,
  root_path_normalized TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  git_root_normalized TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_projects_last_seen ON projects(last_seen_at DESC);
CREATE INDEX idx_projects_git_root ON projects(git_root_normalized);

CREATE TABLE scan_runs (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL UNIQUE,
  task_id TEXT UNIQUE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  scan_kind TEXT NOT NULL CHECK(scan_kind IN ('full','incremental','targeted')),
  status TEXT NOT NULL CHECK(status IN ('queued','detecting','discovering','parsing','resolving','diagnosing','indexing','succeeded','partially_succeeded','failed','cancelled')),
  phase TEXT NOT NULL,
  requested_roots_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  discovered_count INTEGER NOT NULL DEFAULT 0 CHECK(discovered_count >= 0),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK(processed_count >= 0),
  succeeded_count INTEGER NOT NULL DEFAULT 0 CHECK(succeeded_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK(failed_count >= 0),
  cancel_requested_at INTEGER,
  error_summary_json TEXT,
  progress_json TEXT,
  summary_json TEXT,
  effective_configs_json TEXT NOT NULL DEFAULT '[]'
) STRICT;
CREATE INDEX idx_scan_runs_status ON scan_runs(status, started_at DESC);
CREATE INDEX idx_scan_runs_project ON scan_runs(project_id, started_at DESC);

CREATE TABLE scopes (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL UNIQUE,
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  parent_scope_id TEXT REFERENCES scopes(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('user','project','directory')),
  root_path_display TEXT NOT NULL,
  root_path_normalized TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK(depth >= 0),
  precedence INTEGER NOT NULL,
  adapter_scope_key TEXT NOT NULL,
  UNIQUE(tool_id, project_id, root_path_normalized, adapter_scope_key)
) STRICT;
CREATE UNIQUE INDEX uq_scopes_identity_null_project ON scopes(tool_id, IFNULL(project_id, ''), root_path_normalized, adapter_scope_key);
CREATE INDEX idx_scopes_resolution ON scopes(tool_id, project_id, precedence DESC, depth DESC);
CREATE INDEX idx_scopes_parent ON scopes(parent_scope_id);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL UNIQUE,
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
  scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  last_scan_run_id TEXT REFERENCES scan_runs(id) ON DELETE SET NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('rule','agent','skill','mcp')),
  logical_key TEXT NOT NULL,
  source_path_display TEXT NOT NULL,
  source_path_normalized TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK(content_hash GLOB 'sha256:[0-9a-f]*' AND length(content_hash) = 71),
  observed_mtime_ms INTEGER NOT NULL,
  observed_size INTEGER NOT NULL CHECK(observed_size >= 0),
  normalized_json TEXT NOT NULL,
  normalized_schema_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  parse_status TEXT NOT NULL CHECK(parse_status IN ('parsed','rejected')),
  sensitive_summary_json TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE(tool_id, scope_id, source_path_normalized, logical_key)
) STRICT;
CREATE INDEX idx_assets_list ON assets(tool_id, resource_type, last_seen_at DESC);
CREATE INDEX idx_assets_scope ON assets(scope_id, resource_type, logical_key);
CREATE INDEX idx_assets_path ON assets(source_path_normalized);
CREATE INDEX idx_assets_hash ON assets(content_hash);
CREATE INDEX idx_assets_resolution ON assets(tool_id, logical_key, scope_id);

CREATE TABLE asset_references (
  id TEXT PRIMARY KEY,
  source_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  target_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  reference_kind TEXT NOT NULL,
  target_key TEXT NOT NULL,
  location_json TEXT NOT NULL,
  resolution_status TEXT NOT NULL CHECK(resolution_status IN ('resolved','unresolved','ambiguous')),
  UNIQUE(source_asset_id, reference_kind, target_key, location_json)
) STRICT;
CREATE INDEX idx_asset_refs_source ON asset_references(source_asset_id);
CREATE INDEX idx_asset_refs_target ON asset_references(target_asset_id);
CREATE INDEX idx_asset_refs_unresolved ON asset_references(resolution_status, target_key);

CREATE TABLE diagnostics (
  id TEXT PRIMARY KEY,
  asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,
  scan_run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info','warning','error')),
  message_key TEXT NOT NULL,
  location_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  suggested_action TEXT,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(scan_run_id, fingerprint)
) STRICT;
CREATE INDEX idx_diagnostics_query ON diagnostics(project_id, severity, code, created_at DESC);
CREATE INDEX idx_diagnostics_asset ON diagnostics(asset_id, severity);
CREATE INDEX idx_diagnostics_scan ON diagnostics(scan_run_id);

CREATE TABLE settings (
  id TEXT PRIMARY KEY,
  setting_key TEXT NOT NULL UNIQUE,
  value_json TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','privileged')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_settings_visibility ON settings(visibility, setting_key);
CREATE INDEX idx_settings_updated ON settings(updated_at DESC);

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL UNIQUE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  source_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  target_tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('planned','confirmed','backed_up','writing','verifying','succeeded','failed','rolling_back','rolled_back')),
  source_hash TEXT NOT NULL,
  target_hash_before TEXT,
  plan_json TEXT NOT NULL,
  compatibility TEXT NOT NULL CHECK(compatibility IN ('native','lossless','lossy','unsupported')),
  requested_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  finished_at INTEGER,
  verification_json TEXT,
  rollback_state TEXT NOT NULL,
  correlation_id TEXT NOT NULL
) STRICT;
CREATE INDEX idx_deployments_history ON deployments(project_id, requested_at DESC);
CREATE INDEX idx_deployments_status ON deployments(status, requested_at);
CREATE INDEX idx_deployments_target ON deployments(target_tool_id, requested_at DESC);

CREATE TABLE deployment_operations (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL CHECK(sequence_no >= 0),
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('create','replace','delete','mkdir')),
  target_path_normalized TEXT NOT NULL,
  expected_hash_before TEXT,
  result_hash_after TEXT,
  fence_token INTEGER NOT NULL CHECK(fence_token >= 1),
  state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','failed','compensating','compensated')),
  compensation_kind TEXT,
  compensation_payload_json TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  error_code TEXT,
  UNIQUE(deployment_id, sequence_no)
) STRICT;
CREATE UNIQUE INDEX uq_deployment_ops_active_target ON deployment_operations(deployment_id, target_path_normalized) WHERE state IN ('pending','running');
CREATE INDEX idx_deployment_ops_resume ON deployment_operations(deployment_id, state, sequence_no);
CREATE INDEX idx_deployment_ops_target ON deployment_operations(target_path_normalized, started_at DESC);

CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL UNIQUE,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES deployment_operations(id) ON DELETE RESTRICT,
  backup_path_normalized TEXT NOT NULL,
  target_path_normalized TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  permission_mode TEXT NOT NULL,
  encryption_state TEXT NOT NULL,
  restore_verified_at INTEGER
) STRICT;
CREATE INDEX idx_backups_retention ON backups(expires_at);
CREATE INDEX idx_backups_deployment ON backups(deployment_id);
CREATE INDEX idx_backups_target ON backups(target_path_normalized, created_at DESC);

CREATE TABLE database_backups (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('creating','verified','failed','expired')),
  backup_path_normalized TEXT NOT NULL UNIQUE,
  manifest_version INTEGER NOT NULL CHECK(manifest_version >= 1),
  manifest_hash TEXT NOT NULL,
  database_file_hash TEXT NOT NULL,
  database_schema_version INTEGER NOT NULL CHECK(database_schema_version >= 0),
  source_database_id TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  expires_at INTEGER,
  failure_code TEXT,
  CHECK((state = 'verified' AND verified_at IS NOT NULL) OR state <> 'verified')
) STRICT;
CREATE INDEX idx_database_backups_retention ON database_backups(state, expires_at);
CREATE INDEX idx_database_backups_schema ON database_backups(database_schema_version, created_at DESC);
CREATE INDEX idx_database_backups_reason ON database_backups(reason, created_at DESC);

CREATE TABLE deployment_locks (
  id TEXT PRIMARY KEY,
  deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  canonical_target_key TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  fence_token INTEGER NOT NULL CHECK(fence_token >= 1),
  acquired_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_deployment_locks_lease ON deployment_locks(lease_expires_at);
CREATE INDEX idx_deployment_locks_owner ON deployment_locks(owner_id);

CREATE TABLE recovery_locks (
  canonical_target_key TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution_evidence_json TEXT,
  recovery_owner_id TEXT,
  recovery_claim_expires_at INTEGER,
  recovery_fence_token INTEGER NOT NULL DEFAULT 1 CHECK(recovery_fence_token >= 1),
  CHECK((resolved_at IS NULL AND resolution_evidence_json IS NULL) OR (resolved_at IS NOT NULL AND resolution_evidence_json IS NOT NULL))
) STRICT;
CREATE INDEX idx_recovery_locks_unresolved ON recovery_locks(resolved_at, created_at);
CREATE INDEX idx_recovery_locks_deployment ON recovery_locks(deployment_id);
CREATE INDEX idx_recovery_locks_claim ON recovery_locks(recovery_claim_expires_at);

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL UNIQUE,
  started_at INTEGER NOT NULL,
  applied_at INTEGER,
  state TEXT NOT NULL CHECK(state IN ('started','applied','failed')),
  error_code TEXT,
  app_version TEXT NOT NULL,
  pre_migration_backup_id TEXT REFERENCES database_backups(id) ON DELETE RESTRICT,
  CHECK(version = 1 OR pre_migration_backup_id IS NOT NULL)
) STRICT;
CREATE INDEX idx_schema_migrations_state ON schema_migrations(state, version DESC);
CREATE INDEX idx_schema_migrations_backup ON schema_migrations(pre_migration_backup_id);
