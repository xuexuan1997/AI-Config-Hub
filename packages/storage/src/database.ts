import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { databaseMigrations, type DatabaseMigration } from "./migrations.js";

export interface OpenDatabaseOptions {
  readonly path: string;
  readonly appVersion: string;
  readonly migrations?: readonly DatabaseMigration[];
}

export type OpenDatabaseResult =
  | { readonly mode: "read_write"; readonly database: DatabaseSync }
  | {
      readonly mode: "read_only_recovery";
      readonly database: DatabaseSync;
      readonly reason: string;
      readonly backupId?: string;
    };

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly state: string;
}

function writableDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });
}

function configure(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA busy_timeout = 5000");
  const expected = [
    ["foreign_keys", 1],
    ["journal_mode", "wal"],
    ["synchronous", 2],
    ["timeout", 5000],
  ] as const;
  const queries = [
    "PRAGMA foreign_keys",
    "PRAGMA journal_mode",
    "PRAGMA synchronous",
    "PRAGMA busy_timeout",
  ];
  for (const [index, [key, value]] of expected.entries()) {
    const result = database.prepare(queries[index] ?? "").get() as Record<string, unknown>;
    if (result[key] !== value) throw new Error(`SQLite safety pragma was not applied: ${key}`);
  }
}

function readOnlyRecovery(path: string, reason: string, backupId?: string): OpenDatabaseResult {
  const database = new DatabaseSync(path, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: 5000,
  });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  return {
    mode: "read_only_recovery",
    database,
    reason,
    ...(backupId === undefined ? {} : { backupId }),
  };
}

function validateMigrations(migrations: readonly DatabaseMigration[]): void {
  let previous = 0;
  const names = new Set<string>();
  for (const item of migrations) {
    if (item.version !== previous + 1) throw new Error("Migration versions must be contiguous");
    if (names.has(item.name)) throw new Error(`Duplicate migration name: ${item.name}`);
    names.add(item.name);
    previous = item.version;
  }
}

function hashBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hashText(text: string): `sha256:${string}` {
  return hashBytes(Buffer.from(text, "utf8"));
}

async function createVerifiedBackup(
  database: DatabaseSync,
  sourcePath: string,
  nextVersion: number,
): Promise<string> {
  const backupDirectory = join(dirname(sourcePath), "backups");
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(backupDirectory, 0o700);
  const id = randomUUID();
  const domainId = `database-backup:${id}`;
  const backupPath = resolve(backupDirectory, `before-v${String(nextVersion)}-${id}.sqlite`);
  await backup(database, backupPath);
  if (process.platform !== "win32") chmodSync(backupPath, 0o600);

  const verifier = new DatabaseSync(backupPath, {
    allowExtension: false,
    defensive: true,
    readOnly: true,
  });
  const integrity = verifier.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  verifier.close();
  if (integrity.integrity_check !== "ok") throw new Error("Database backup integrity check failed");

  const bytes = readFileSync(backupPath);
  const databaseFileHash = hashBytes(bytes);
  const currentVersion = Number(
    (
      database
        .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
        .get() as {
        version: number;
      }
    ).version,
  );
  const createdAt = Date.now();
  const manifest = JSON.stringify({
    manifestVersion: 1,
    backupPath,
    databaseFileHash,
    databaseSchemaVersion: currentVersion,
    sizeBytes: bytes.byteLength,
    createdAt,
  });
  database
    .prepare(
      `INSERT INTO database_backups(
        id, domain_id, reason, state, backup_path_normalized, manifest_version,
        manifest_hash, database_file_hash, database_schema_version, source_database_id,
        size_bytes, created_at, verified_at
      ) VALUES(?, ?, ?, 'verified', ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      domainId,
      `before_migration_${String(nextVersion)}`,
      backupPath,
      hashText(manifest),
      databaseFileHash,
      currentVersion,
      hashText(resolve(sourcePath)),
      statSync(backupPath).size,
      createdAt,
      createdAt,
    );
  return id;
}

function applyMigration(
  database: DatabaseSync,
  item: DatabaseMigration,
  appVersion: string,
  backupId?: string,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    if (item.sql.trim() !== "") database.exec(item.sql);
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO schema_migrations(
          version, name, checksum, started_at, applied_at, state, app_version, pre_migration_backup_id
        ) VALUES(?, ?, ?, ?, ?, 'applied', ?, ?)`,
      )
      .run(item.version, item.name, item.checksum, now, now, appVersion, backupId ?? null);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export async function openDatabase(options: OpenDatabaseOptions): Promise<OpenDatabaseResult> {
  const path = resolve(options.path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const migrations = options.migrations ?? databaseMigrations;
  validateMigrations(migrations);
  let database = writableDatabase(path);
  try {
    configure(database);
    const tableCount = Number(
      (
        database
          .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table'")
          .get() as {
          count: number;
        }
      ).count,
    );
    if (tableCount === 0) {
      for (const item of migrations) {
        const backupId =
          item.version === 1 ? undefined : await createVerifiedBackup(database, path, item.version);
        applyMigration(database, item, options.appVersion, backupId);
      }
      return { mode: "read_write", database };
    }

    const hasMigrationTable = database
      .prepare(
        "SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get();
    if (hasMigrationTable === undefined) {
      database.close();
      return readOnlyRecovery(path, "MIGRATION_METADATA_MISSING");
    }
    const applied = database
      .prepare("SELECT version, name, checksum, state FROM schema_migrations ORDER BY version")
      .all() as unknown as AppliedMigrationRow[];
    for (const row of applied) {
      const expected = migrations.find(({ version }) => version === row.version);
      if (
        expected === undefined ||
        row.name !== expected.name ||
        row.checksum !== expected.checksum ||
        row.state !== "applied"
      ) {
        database.close();
        return readOnlyRecovery(path, "MIGRATION_CHECKSUM_MISMATCH");
      }
    }

    for (const item of migrations.slice(applied.length)) {
      let backupId: string | undefined;
      try {
        backupId = await createVerifiedBackup(database, path, item.version);
        applyMigration(database, item, options.appVersion, backupId);
      } catch {
        database.close();
        return readOnlyRecovery(path, "MIGRATION_FAILED", backupId);
      }
    }
    return { mode: "read_write", database };
  } catch {
    try {
      database.close();
    } catch {
      // Preserve the original bootstrap failure.
    }
    database = readOnlyRecovery(path, "DATABASE_BOOTSTRAP_FAILED").database;
    return { mode: "read_only_recovery", database, reason: "DATABASE_BOOTSTRAP_FAILED" };
  }
}
