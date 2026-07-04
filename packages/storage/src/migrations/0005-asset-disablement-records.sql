CREATE TABLE asset_disablement_records (
  asset_domain_id TEXT PRIMARY KEY,
  method TEXT NOT NULL CHECK(method IN ('native','move_file','remove_config_entry','hub_ignore')),
  record_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_asset_disablement_records_method ON asset_disablement_records(method, updated_at DESC);
