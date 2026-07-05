import type { DatabaseSync } from "node:sqlite";

import type {
  ClearLocalDataCounts,
  ClearLocalDataResult,
  LocalDataCategory,
} from "@ai-config-hub/core";
import { AppError, IsoDateTimeSchema } from "@ai-config-hub/shared";

import { readOnlyError } from "./index-repository.js";

export interface StorageMaintenanceRepository {
  assertCanClearLocalData(input: {
    readonly categories: readonly LocalDataCategory[];
  }): Promise<void>;
  clearLocalData(input: {
    readonly categories: readonly LocalDataCategory[];
    readonly now: string;
  }): Promise<ClearLocalDataResult>;
}

export class SqliteMaintenanceRepository implements StorageMaintenanceRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly readOnly: boolean,
  ) {}

  assertCanClearLocalData(
    input: Parameters<StorageMaintenanceRepository["assertCanClearLocalData"]>[0],
  ): ReturnType<StorageMaintenanceRepository["assertCanClearLocalData"]> {
    if (this.readOnly) return Promise.reject(readOnlyError());
    try {
      assertDeploymentHistoryCanBeCleared(this.database, uniqueCategories(input.categories));
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("Local data preflight failed"),
      );
    }
  }

  clearLocalData(
    input: Parameters<StorageMaintenanceRepository["clearLocalData"]>[0],
  ): ReturnType<StorageMaintenanceRepository["clearLocalData"]> {
    if (this.readOnly) return Promise.reject(readOnlyError());
    const categories = uniqueCategories(input.categories);
    const clearedAt = IsoDateTimeSchema.parse(input.now);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertDeploymentHistoryCanBeCleared(this.database, categories);
      const counts = countRowsBeforeCleanup(this.database, categories);
      clearDatabaseRows(this.database, categories);
      if (databaseMutationCount(counts) > 0) bumpRevision(this.database);
      this.database.exec("COMMIT");
      return Promise.resolve({
        clearedAt,
        categories,
        counts,
        retained: {
          databaseBackups: true,
          deploymentBackups: true,
          disabledAssets: true,
        },
        requiresRestart: false,
      });
    } catch (error) {
      this.database.exec("ROLLBACK");
      return Promise.reject(
        error instanceof Error ? error : new Error("Local data cleanup failed"),
      );
    }
  }
}

function uniqueCategories(categories: readonly LocalDataCategory[]): readonly LocalDataCategory[] {
  return [...new Set(categories)];
}

function assertDeploymentHistoryCanBeCleared(
  database: DatabaseSync,
  categories: readonly LocalDataCategory[],
): void {
  if (!categories.includes("deployment_history")) return;
  const backups = rowCount(database, "backups");
  const unresolvedRecoveryLocks = countWhere(database, "recovery_locks", "resolved_at IS NULL");
  if (backups === 0 && unresolvedRecoveryLocks === 0) return;
  throw new AppError({
    code: "CONFLICT",
    message: "Resolve recovery or rollback state before clearing deployment history.",
    retryable: true,
    suggestedActions: [
      "Complete or resolve pending recovery, then retry clearing deployment history.",
    ],
    safeContext: {
      backupRows: backups,
      unresolvedRecoveryLocks,
    },
  });
}

function countRowsBeforeCleanup(
  database: DatabaseSync,
  categories: readonly LocalDataCategory[],
): ClearLocalDataCounts {
  return {
    scanRuns: categories.includes("scan_cache") ? rowCount(database, "scan_runs") : 0,
    projects: categories.includes("scan_cache") ? rowCount(database, "projects") : 0,
    scopes: categories.includes("scan_cache") ? rowCount(database, "scopes") : 0,
    assets: categories.includes("scan_cache") ? rowCount(database, "assets") : 0,
    diagnostics: categories.includes("scan_cache") ? rowCount(database, "diagnostics") : 0,
    deploymentRecords: categories.includes("deployment_history")
      ? rowCount(database, "deployments")
      : 0,
    deploymentOperations: categories.includes("deployment_history")
      ? rowCount(database, "deployment_operations")
      : 0,
    settings: categories.includes("settings")
      ? countWhere(database, "settings", "setting_key = 'public_settings'")
      : 0,
    localHistoryDirectories: 0,
  };
}

function clearDatabaseRows(database: DatabaseSync, categories: readonly LocalDataCategory[]): void {
  if (categories.includes("scan_cache")) {
    database.exec(
      "DELETE FROM diagnostics; DELETE FROM asset_references; DELETE FROM assets; DELETE FROM scopes; DELETE FROM projects; DELETE FROM scan_runs;",
    );
  }
  if (categories.includes("settings")) {
    database.prepare("DELETE FROM settings WHERE setting_key = 'public_settings'").run();
  }
  if (categories.includes("deployment_history")) {
    database.exec(
      "DELETE FROM recovery_locks WHERE resolved_at IS NOT NULL; DELETE FROM deployment_operations; DELETE FROM deployments;",
    );
  }
}

function databaseMutationCount(counts: ClearLocalDataCounts): number {
  return (
    counts.scanRuns +
    counts.projects +
    counts.scopes +
    counts.assets +
    counts.diagnostics +
    counts.deploymentRecords +
    counts.deploymentOperations +
    counts.settings
  );
}

function rowCount(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    readonly count: number;
  };
  return row.count;
}

function countWhere(database: DatabaseSync, table: string, where: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as {
    readonly count: number;
  };
  return row.count;
}

function bumpRevision(database: DatabaseSync): number {
  const current = Number(
    (database.prepare("PRAGMA user_version").get() as { readonly user_version: number })
      .user_version,
  );
  const next = current + 1;
  database.exec(`PRAGMA user_version = ${String(next)}`);
  return next;
}
