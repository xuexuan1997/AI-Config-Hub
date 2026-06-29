COMMIT;
PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;
BEGIN IMMEDIATE;

ALTER TABLE tools RENAME TO tools_old;

CREATE TABLE tools (
  id TEXT PRIMARY KEY,
  tool_installation_id TEXT NOT NULL UNIQUE,
  tool_key TEXT NOT NULL,
  canonical_config_root TEXT NOT NULL,
  display_name TEXT NOT NULL,
  detected_version TEXT,
  adapter_version TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  is_detected INTEGER NOT NULL DEFAULT 1 CHECK(is_detected IN (0,1)),
  UNIQUE(tool_key, canonical_config_root)
) STRICT;

INSERT INTO tools(
  id,
  tool_installation_id,
  tool_key,
  canonical_config_root,
  display_name,
  detected_version,
  adapter_version,
  capabilities_json,
  last_seen_at,
  is_detected
)
SELECT
  id,
  tool_installation_id,
  tool_key,
  canonical_config_root,
  display_name,
  detected_version,
  adapter_version,
  capabilities_json,
  last_seen_at,
  is_detected
FROM tools_old;

DROP TABLE tools_old;
CREATE INDEX idx_tools_detected ON tools(is_detected, tool_key);

COMMIT;
PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
