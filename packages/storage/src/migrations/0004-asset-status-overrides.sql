CREATE TABLE asset_status_overrides (
  asset_domain_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('enabled','disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_asset_status_overrides_status ON asset_status_overrides(status, updated_at DESC);
