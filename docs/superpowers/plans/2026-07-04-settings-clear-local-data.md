# Settings Clear Local Data Implementation Plan

Design: `docs/superpowers/specs/2026-07-04-settings-clear-local-data-design.md`

## Task 1: API, Storage, and Service Command

Owner: backend/API worker

Write scope:

- `packages/core/src/use-cases/contracts.ts`
- `packages/api/src/commands.ts`
- `packages/api/src/commands.test.ts`
- `packages/storage/src/maintenance-repository.ts`
- `packages/storage/src/repositories.ts`
- `packages/storage/src/index.ts`
- `packages/storage/src/repositories.test.ts` or a focused storage test file
- `apps/desktop/src/main/composition.ts`
- `apps/desktop/src/main/composition.test.ts`
- `apps/cli/src/app-services.ts`
- `apps/cli/src/app-services.test.ts` if needed for compile/test coverage

Requirements:

1. Add the shared command name `settings.clearLocalData`.
2. Add strict API schemas:
   - Request categories: `scan_cache`, `deployment_history`, `settings`
   - Non-empty categories array with no duplicates
   - Confirmation literal: `clear-local-data`
3. Add a response schema with:
   - `clearedAt`
   - `categories`
   - `counts`
   - `retained`
   - `requiresRestart: false`
4. Add a storage maintenance repository that:
   - Rejects writes in read-only recovery mode
   - Runs database cleanup in a transaction
   - Counts rows before deleting
   - Clears scan cache by deleting `diagnostics`, `asset_references`, `assets`, `scopes`, `projects`, and `scan_runs`
   - Clears settings by deleting `settings` row with `setting_key = 'public_settings'`
   - Clears deployment history only if `backups` and unresolved `recovery_locks` have zero rows; otherwise throw `AppError` with a safe, user-actionable message
   - Removes resolved `recovery_locks` with deployment history because they reference deployment rows and no longer represent active recovery work
   - Deletes `deployment_operations` and `deployments` when deployment history is allowed
   - Bumps `PRAGMA user_version` after any database mutation
5. Desktop and CLI service handlers should call the maintenance repository.
6. For `deployment_history`, remove `history/local-git` and recreate it with private permissions.
7. Do not remove database migration backups, deployment backup files, disabled-assets files, schema migrations, unresolved recovery locks, or user source config files.
8. Add focused tests proving scan cache is cleared and protected data is retained.

Verification:

- `pnpm vitest run packages/api/src/commands.test.ts packages/storage/src/repositories.test.ts apps/desktop/src/main/composition.test.ts`

Report:

- Status
- Files changed
- Tests run and results
- Any concerns

## Task 2: Renderer Settings UI and State

Owner: renderer worker

Write scope:

- `apps/desktop/src/renderer/model.ts`
- `apps/desktop/src/renderer/app.tsx`
- `apps/desktop/src/renderer/views/settings.tsx`
- `apps/desktop/src/renderer/styles.css`
- `apps/desktop/src/renderer/i18n.ts`
- `apps/desktop/src/renderer/model.test.ts`
- `apps/desktop/src/renderer/views/view-structure.test.ts`

Requirements:

1. Add renderer state for clearing local data.
2. Build a `settings.clearLocalData` request using selected categories and confirmation literal.
3. On success:
   - Show a concise success message with cleared categories/counts.
   - If `scan_cache` was cleared, reset in-memory assets, diagnostics, asset detail, effective config, migration source/target assets, and migration preview state.
   - If `settings` was cleared, reload settings or reset settings state to defaults.
4. Settings view should render a "Local data" section with:
   - Checkbox for scan cache, selected by default
   - Checkbox for deployment history, not selected by default
   - Checkbox for settings, not selected by default
   - Confirmation checkbox
   - Destructive button disabled unless at least one category is selected and confirmation is checked
   - Disabled state during settings load/save/clear and read-only recovery
   - Copy that protected backup/disabled-asset recovery data is retained
5. Do not add a landing-style explanation page; keep the control compact inside Settings.
6. Add English and Simplified Chinese translation keys matching existing i18n style.
7. Add tests for reducer/request behavior and static rendering.

Verification:

- `pnpm vitest run apps/desktop/src/renderer/model.test.ts apps/desktop/src/renderer/views/view-structure.test.ts`

Report:

- Status
- Files changed
- Tests run and results
- Any concerns

## Controller Review Tasks

After both workers return:

1. Inspect `git diff`.
2. Re-run targeted tests from both tasks.
3. Run typecheck or a narrower package typecheck if full typecheck is too slow.
4. Review against the design doc:
   - No source config file deletion
   - Protected recovery/backup data retained; unresolved recovery locks are not deleted
   - Clear command blocked in read-only recovery
   - Renderer state clears stale scan data
   - UI requires explicit confirmation
