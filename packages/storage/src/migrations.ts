import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface DatabaseMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: `sha256:${string}`;
}

function checksum(sql: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update("ai-config-hub:migration:v1\0").update(sql).digest("hex")}`;
}

export function migration(version: number, name: string, sql: string): DatabaseMigration {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new TypeError("Migration version must be positive");
  if (name.trim() === "") throw new TypeError("Migration name is required");
  return Object.freeze({ version, name, sql, checksum: checksum(sql) });
}

const initialSql = readFileSync(new URL("./migrations/0001-initial.sql", import.meta.url), "utf8");
const rollbackLinksSql = readFileSync(
  new URL("./migrations/0002-rollback-links.sql", import.meta.url),
  "utf8",
);
const customToolKeysSql = readFileSync(
  new URL("./migrations/0003-custom-tool-keys.sql", import.meta.url),
  "utf8",
);
const assetStatusOverridesSql = readFileSync(
  new URL("./migrations/0004-asset-status-overrides.sql", import.meta.url),
  "utf8",
);
const assetDisablementRecordsSql = readFileSync(
  new URL("./migrations/0005-asset-disablement-records.sql", import.meta.url),
  "utf8",
);

export const initialMigration = migration(1, "initial", initialSql);
export const rollbackLinksMigration = migration(2, "rollback-links", rollbackLinksSql);
export const customToolKeysMigration = migration(3, "custom-tool-keys", customToolKeysSql);
export const assetStatusOverridesMigration = migration(
  4,
  "asset-status-overrides",
  assetStatusOverridesSql,
);
export const assetDisablementRecordsMigration = migration(
  5,
  "asset-disablement-records",
  assetDisablementRecordsSql,
);
export const databaseMigrations = Object.freeze([
  initialMigration,
  rollbackLinksMigration,
  customToolKeysMigration,
  assetStatusOverridesMigration,
  assetDisablementRecordsMigration,
]);
