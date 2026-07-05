import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database.js";
import {
  databaseMigrations,
  initialMigration,
  migration,
  rollbackLinksMigration,
  type DatabaseMigration,
} from "./migrations.js";

const temporaryDirectories: string[] = [];

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "ai-config-hub-storage-"));
  temporaryDirectories.push(directory);
  return join(directory, "index.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const expectedTables = [
  "asset_disablement_records",
  "asset_references",
  "asset_status_overrides",
  "assets",
  "backups",
  "database_backups",
  "deployment_locks",
  "deployment_operations",
  "deployments",
  "diagnostics",
  "projects",
  "recovery_locks",
  "scan_runs",
  "schema_migrations",
  "scopes",
  "settings",
  "tools",
];

describe("SQLite bootstrap", () => {
  it("creates the complete strict schema with verified safety pragmas", async () => {
    const opened = await openDatabase({ path: databasePath(), appVersion: "0.1.0" });
    expect(opened.mode).toBe("read_write");
    const database = opened.database;
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(expectedTables);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(database.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(
      database.prepare("SELECT strict FROM pragma_table_list WHERE name = 'assets'").get(),
    ).toEqual({ strict: 1 });
    expect(() => database.enableLoadExtension(true)).toThrow();
    database.close();
  });

  it("enforces checks, unique keys, and documented cascade behavior", async () => {
    const opened = await openDatabase({ path: databasePath(), appVersion: "0.1.0" });
    const database = opened.database;
    expect(() =>
      database
        .prepare(
          "INSERT INTO settings(id, setting_key, value_json, visibility, revision, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
        )
        .run("s1", "theme", "{}", "public", 0, 1, 1),
    ).toThrow();
    database
      .prepare(
        "INSERT INTO tools(id, tool_installation_id, tool_key, canonical_config_root, display_name, adapter_version, capabilities_json, last_seen_at, is_detected) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("t1", "tool-1", "codex", "/x", "Codex", "0.1.0", "{}", 1, 1);
    database
      .prepare(
        "INSERT INTO projects(id, domain_id, root_path_display, root_path_normalized, name, first_seen_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
      )
      .run("p1", "project-1", "/p", "/p", "Project", 1, 1);
    database
      .prepare(
        "INSERT INTO scopes(id, domain_id, tool_id, project_id, scope_kind, root_path_display, root_path_normalized, depth, precedence, adapter_scope_key) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("sc1", "scope-1", "t1", "p1", "project", "/p", "/p", 0, 100, "project");
    database.prepare("DELETE FROM projects WHERE id = ?").run("p1");
    expect(database.prepare("SELECT count(*) AS count FROM scopes").get()).toEqual({ count: 0 });
    expect(() => database.prepare("DELETE FROM tools WHERE id = ?").run("t1")).not.toThrow();
    database.close();
  });

  it("upgrades existing databases so tools can store custom declarative tool keys", async () => {
    const path = databasePath();
    const first = await openDatabase({
      path,
      appVersion: "0.1.0",
      migrations: [initialMigration, rollbackLinksMigration],
    });
    first.database.close();

    const upgraded = await openDatabase({
      path,
      appVersion: "0.2.4",
      migrations: databaseMigrations,
    });
    expect(upgraded.mode).toBe("read_write");
    if (upgraded.mode !== "read_write") return;
    expect(() =>
      upgraded.database
        .prepare(
          "INSERT INTO tools(id, tool_installation_id, tool_key, canonical_config_root, display_name, adapter_version, capabilities_json, last_seen_at, is_detected) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("t-custom", "tool-custom", "acme-tool", "/x", "Acme", "0.1.0", "{}", 1, 1),
    ).not.toThrow();
    upgraded.database.close();
  });

  it("refuses checksum drift and returns a read-only recovery connection", async () => {
    const path = databasePath();
    const first = await openDatabase({
      path,
      appVersion: "0.1.0",
      migrations: [initialMigration],
    });
    first.database.close();
    const drifted: DatabaseMigration = {
      ...initialMigration,
      checksum: `sha256:${"f".repeat(64)}`,
    };
    const reopened = await openDatabase({ path, appVersion: "0.1.0", migrations: [drifted] });
    expect(reopened).toMatchObject({
      mode: "read_only_recovery",
      reason: "MIGRATION_CHECKSUM_MISMATCH",
    });
    expect(() => reopened.database.exec("CREATE TABLE forbidden(value TEXT)")).toThrow();
    reopened.database.close();
  });

  it("creates and verifies a private online backup before upgrading a non-empty database", async () => {
    const path = databasePath();
    const first = await openDatabase({
      path,
      appVersion: "0.1.0",
      migrations: [initialMigration],
    });
    first.database.close();
    const secondMigration = migration(
      2,
      "add_test_marker",
      "CREATE TABLE upgrade_marker(id TEXT PRIMARY KEY) STRICT;",
    );
    const upgraded = await openDatabase({
      path,
      appVersion: "0.2.0",
      migrations: [initialMigration, secondMigration],
    });
    expect(upgraded.mode).toBe("read_write");
    const backup = upgraded.database
      .prepare("SELECT state, backup_path_normalized, verified_at FROM database_backups")
      .get() as { state: string; backup_path_normalized: string; verified_at: number | null };
    expect(backup).toMatchObject({ state: "verified" });
    expect(backup.verified_at).not.toBeNull();
    if (process.platform !== "win32") {
      expect(statSync(backup.backup_path_normalized).mode & 0o777).toBe(0o600);
    }
    const migrationRow = upgraded.database
      .prepare("SELECT pre_migration_backup_id FROM schema_migrations WHERE version = 2")
      .get() as { pre_migration_backup_id: string | null };
    expect(typeof migrationRow.pre_migration_backup_id).toBe("string");
    upgraded.database.close();
  });
});
