import type { DatabaseSync } from "node:sqlite";

import type {
  DeploymentRepository,
  IndexRepository,
  SettingsRepository,
  TaskRepository,
} from "@ai-config-hub/core";

import type { OpenDatabaseResult } from "./database.js";
import { SqliteDeploymentRepository } from "./deployment-repository.js";
import { SqliteIndexRepository } from "./index-repository.js";
import { SqliteSettingsRepository } from "./settings-repository.js";
import { SqliteTaskRepository } from "./task-repository.js";

export interface StorageRepositories {
  readonly database: DatabaseSync;
  readonly index: IndexRepository;
  readonly settings: SettingsRepository;
  readonly tasks: TaskRepository;
  readonly deployments: DeploymentRepository;
}

export function createStorageRepositories(opened: OpenDatabaseResult): StorageRepositories {
  const readOnly = opened.mode === "read_only_recovery";
  return Object.freeze({
    database: opened.database,
    index: new SqliteIndexRepository(opened.database, readOnly),
    settings: new SqliteSettingsRepository(opened.database, readOnly),
    tasks: new SqliteTaskRepository(opened.database, readOnly),
    deployments: new SqliteDeploymentRepository(opened.database, readOnly),
  });
}
