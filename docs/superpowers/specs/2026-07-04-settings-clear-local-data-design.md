# Settings Clear Local Data Design

Date: 2026-07-04

## Goal

Add a Settings entry point for clearing AI Config Hub local cache and selected persisted data without deleting user source configuration files or compromising upgrade/recovery safety.

The feature should answer three user-facing questions clearly:

1. What local data does the app keep?
2. Which data can be safely removed and rebuilt?
3. Which data is intentionally retained because it is needed for recovery, rollback, or future upgrades?

## Current Local Data Model

The desktop runtime stores application data under `userDataPath`, resolved from `AI_CONFIG_HUB_USER_DATA` when present, otherwise Electron `app.getPath("userData")`.

The CLI stores data under `AI_CONFIG_HUB_USER_DATA` when present, otherwise a platform data root:

- Windows: `%APPDATA%\AI Config Hub`
- macOS: `~/Library/Application Support/AI Config Hub`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/ai-config-hub`

The runtime creates:

- `ai-config-hub.sqlite`
- SQLite WAL/SHM sidecars when SQLite uses WAL
- `backups/deployments/`
- `disabled-assets/`
- `history/local-git/`
- `backups/before-v*.sqlite` database migration backups

The SQLite database contains both rebuildable index data and persisted operational data:

- Rebuildable scan/index cache: `projects`, `scopes`, `assets`, `asset_references`, `diagnostics`, `scan_runs.effective_configs_json`
- Task metadata: `scan_runs` task/progress rows
- Persisted settings: `settings.public_settings`
- Deployment history and previews: `deployments`, `deployment_operations`
- Deployment recovery metadata: `backups`, `deployment_locks`, `recovery_locks`
- Asset disablement restore metadata: `asset_status_overrides`, `asset_disablement_records`
- Migration/recovery metadata: `database_backups`, `schema_migrations`

The app also persists normalized asset JSON in the database. These rows are derived from user source files and can be rebuilt by scanning, but they may include redacted/normalized instructions and source paths. Clearing the scan cache removes this derived copy.

## Upgrade Safety

The first version of this feature must not delete data that protects the user during upgrades or rollback:

- Keep `database_backups` rows and `backups/before-v*.sqlite` migration backups.
- Keep `schema_migrations` rows.
- Keep deployment backup files and deployment backup rows unless a future feature introduces a dedicated backup-retention workflow.
- Keep `disabled-assets/` files and `asset_disablement_records` by default, because deleting them can make disabled assets hard or impossible to restore.
- Keep unresolved recovery locks. Resolved recovery locks are no longer active recovery
  blockers and may be removed together with deployment history, because the current
  schema links them to deployment rows with `ON DELETE RESTRICT`.

This means "clear local data" is intentionally not "delete the whole userData folder while the app is running." Deleting the folder while SQLite is open risks database corruption and can remove recovery evidence needed by later app versions.

## User-Facing Behavior

Settings gets a new "Local data" section with a destructive action panel.

Supported cleanup categories:

1. `scan_cache`
   - Default selected.
   - Clears rebuildable scan/index cache and task scan history.
   - Deletes database rows from `diagnostics`, `asset_references`, `assets`, `scopes`, `projects`, and `scan_runs`.
   - Leaves tools, deployment records, settings, disablement records, migration backups, and recovery records intact.
   - Resets currently loaded renderer asset/diagnostic/migration-preview state after success.

2. `deployment_history`
   - Optional, not selected by default.
   - Clears deployment history rows that are safe to forget only when there are no recovery locks or backup rows requiring the records.
   - Deletes `deployment_operations` and `deployments` rows, relying on FK cascade where safe.
   - Removes `history/local-git/` snapshots if present.
   - Does not remove `backups/deployments/` files in this first version.
   - If unresolved recovery locks or backup rows exist, the command fails with a clear error and instructs the user to resolve recovery/rollback state first.
   - Resolved recovery lock rows may be removed with deployment history because they still reference deployment rows and no longer represent active recovery state.

3. `settings`
   - Optional, not selected by default.
   - Resets public settings to defaults by removing the `settings.public_settings` row.
   - The renderer reloads settings after success.

Confirmation:

- The renderer uses an explicit confirmation checkbox before enabling the action.
- The API also requires `confirmation: "clear-local-data"` so a caller cannot invoke the command accidentally.
- The command is blocked in read-only recovery mode.

Response:

- Return `clearedAt`, `categories`, and row/file counts.
- Include retained safety notes, e.g. `databaseBackups`, `deploymentBackups`, and `disabledAssets` are retained.
- The command should not require app restart for supported categories.

## API Shape

Add a command:

```ts
"settings.clearLocalData"
```

Request:

```ts
{
  categories: readonly ("scan_cache" | "deployment_history" | "settings")[];
  confirmation: "clear-local-data";
}
```

Response:

```ts
{
  clearedAt: string;
  categories: readonly ("scan_cache" | "deployment_history" | "settings")[];
  counts: {
    scanRuns: number;
    projects: number;
    scopes: number;
    assets: number;
    diagnostics: number;
    deploymentRecords: number;
    deploymentOperations: number;
    settings: number;
    localHistoryDirectories: number;
  };
  retained: {
    databaseBackups: true;
    deploymentBackups: true;
    disabledAssets: true;
  };
  requiresRestart: false;
}
```

## Implementation Notes

### API/Core

- Add `"settings.clearLocalData"` to `CORE_COMMAND_NAMES`.
- Add request/response Zod schemas to `packages/api/src/commands.ts`.
- Update API fixtures in `packages/api/src/commands.test.ts`.

### Storage

Create a small storage maintenance repository instead of scattering SQL through UI code:

- `packages/storage/src/maintenance-repository.ts`
- Export it through `packages/storage/src/index.ts` and `repositories.ts`

The repository should:

- Respect read-only recovery mode using the existing `readOnlyError()`.
- Run cleanup in a single transaction.
- Count rows before deletion.
- Delete scan cache in FK-safe order.
- Delete deployment history only when no rows exist in `backups` or unresolved `recovery_locks`.
- Delete resolved `recovery_locks` rows with deployment history so the referenced deployment rows can be removed without weakening active recovery protection.
- Bump `PRAGMA user_version` after database mutation so existing snapshot revision behavior remains consistent.

### Runtime Services

Add service handlers in both desktop and CLI service maps because API command names are shared.

Desktop handler:

- Calls maintenance repository.
- Removes `runtime.historyRoot` when `deployment_history` is requested.
- Recreates `historyRoot` afterward with private permissions.
- Returns counts and retained notes.

CLI handler:

- Mirrors desktop behavior so local API/CLI command coverage does not break.

### Renderer

Model changes:

- Add local-data clear state to `AppSettingsState`, e.g. `clearLocalDataStatus`.
- Add actions for clearing, success, and failure.
- Add a helper to build the API request.
- On success for `scan_cache`, clear local renderer asset/diagnostic/detail/effective/preview state.
- On success for `settings`, reload settings or apply defaults from the response path.

Settings UI:

- Add "Local data" section below General.
- Use checkboxes for the three categories.
- Default to scan cache selected.
- Add an explicit confirmation checkbox.
- Disable while settings are loading/saving/clearing or in read-only recovery.
- Show concise copy that backups and disabled-asset recovery files are retained.

### Tests

Add/adjust tests for:

- API command catalog and request/response fixtures.
- Maintenance repository clearing scan cache and settings while retaining protected rows.
- Desktop service clearing scan cache after a scan.
- Renderer model request/action behavior.
- Settings view renders the local data controls.

## Non-Goals

- Do not delete user source config files from projects or tool config directories.
- Do not delete the whole app data directory while the app is running.
- Do not delete database migration backups in this feature.
- Do not delete deployment backup files in this feature.
- Do not delete disabled-assets recovery files in this feature.
- Do not delete unresolved recovery locks in this feature.
- Do not introduce automatic cleanup policies or scheduled retention.
