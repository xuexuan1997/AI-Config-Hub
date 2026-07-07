# Asset Package Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Keep deployment execution file-level for safety, and add folder/package summaries as a compatible API and presentation layer. Use Node 24 for project commands: `fnm use 24 && node --version`.

**Goal:** Implement package-level summaries for asset review and migration preview/execution, especially for multi-file Skill assets.

**Architecture:** Treat `Asset.sourceFiles` and `DeploymentPlan.operations` as authoritative low-level manifests. New deployment previews persist deterministic operation groups, while legacy plans and rollback plans are handled through deterministic fallback groups. Desktop and CLI default to folder-level rows; file-level operations remain available internally for audit, hash verification, execution, rollback, and history reconstruction.

**Tech Stack:** TypeScript, React, Zod, Vitest, pnpm workspaces, Node 24.

---

## Review Conclusion

The direction is sound: keep file-level execution semantics, but introduce package/folder-level summaries for review and migration presentation. This preserves deployment safety while preventing Skill packages with many support files from overwhelming UI and CLI output.

The plan must be compatibility-first. `DeploymentPlan` JSON is already persisted in SQLite and rollback code constructs rollback plans directly, so adding group data cannot break old stored plans or non-preview plan producers. Grouping also cannot be derived from `operations` alone because operations do not retain converted relative paths, conversion result IDs, or source asset IDs. The preview service must build groups while conversion output metadata is still available.

## Scope

Included:

- Asset review list and asset detail summaries for multi-file packages.
- Migration preview response grouped by target package folder.
- Desktop migration UI changed from file-first to group-first rendering.
- CLI text output changed from file-first to group-first rendering.
- History detail response and UI/CLI summary aligned with preview grouping.
- Compatibility for old stored deployment plans and rollback-generated plans.
- Tests for large Skill packages, unchanged single-file assets, legacy plans, and rollback plans.

Excluded:

- Changing deployment execution, backup, verification, or rollback semantics.
- Lazy-loading file details from a new endpoint.
- Replacing `Asset.sourceFiles` with a new package model.
- Changing Skill parsing limits.
- Adding a public full-file-detail export endpoint.

## Design Decisions

1. **File-level execution remains unchanged**

   `DeploymentPlan.operations` continues to contain one operation per target file. `DeploymentExecutionService` keeps backing up, writing, journaling, verifying, and rolling back each file independently.

2. **Operation groups are additive and backward compatible**

   New preview-created plans should persist `operationGroups`. `DeploymentPlanSchema` must still parse legacy plans that lack this field. Consumers must use a helper such as `operationGroupsForPlan(plan)` that returns persisted groups when present and deterministic one-file fallback groups when absent.

3. **Package summaries are deterministic**

   Asset package summaries are derived from `Asset.sourceFiles` at response time. Migration operation groups are derived from conversion outputs, operation targets, and stable sorted paths. `groupId` must be deterministic because plan hashes are computed from stable JSON.

4. **Migration responses become group-first**

   `migration.preview` should return complete `changeGroups` for normal rendering. File-level `changes` is a bounded compatibility/detail preview, not the complete audit surface. The complete internal audit source remains the persisted deployment plan and its `operations`.

5. **Single-file assets use a one-file group**

   Rules, agents, MCP files, rollback plans, legacy plans, and any single-output conversion should keep user-visible behavior stable through one-file fallback groups. This includes Skill assets whose conversion output set contains only `SKILL.md`; only Skill conversions with more than one output use the Skill package root group.

6. **Skill grouping root is the target Skill package folder**

   For a multi-output Skill target path like `.agents/skills/release/references/checklist.md`, the group root is `.agents/skills/release/`. The package root is inferred from the full conversion output set, so support-file changes still group under the Skill folder even when `SKILL.md` is byte-identical and omitted from `operations`. `operationGroups[].targetPaths` contains only changed operation targets; unchanged package outputs may contribute to `packageOutputCount` and `packagePathSample`, but never to operation coverage.

7. **Summary counts never depend on truncated details**

   Desktop and CLI summaries must use server-computed `differenceSummary` and complete group counts. They must not use bounded `changes` or bounded `targetPathSample` to compute unchanged planned output counts or changed-file totals.

8. **History summaries use persisted data only**

   Fresh migration previews can use transient conversion results to build `fieldLosses`, but `history.get` runs after those conversion objects are gone. Persist a compact warning/loss summary in the plan, and compute history `differenceSummary` only from persisted `DeploymentPlan` fields and deployment records. Legacy plans without this compact summary must fall back to `plan.warnings.length` plus a coarse partial-conversion indicator from `requiredConfirmations`.

9. **Preview/history summaries only describe planned outputs**

   Preview and history cannot reconstruct true target-only assets from `DeploymentPlan.expectedTargetHashes`, because those hashes cover converted/planned outputs only. The grouped preview/history summary must therefore expose `unchangedPlannedTargetOutputs`. Pre-preview live comparisons may continue to show true target-only assets from the target asset inventory.

10. **Bounded display limits are shared constants**

Use consistent limits across API schemas, CLI service mappers, Desktop main mappers, and renderer/CLI tests:

- `CHANGE_DETAIL_LIMIT = 50`
- `GROUP_TARGET_PATH_SAMPLE_LIMIT = 10`
- `PACKAGE_PATH_SAMPLE_LIMIT = 10`
- `HASH_SAMPLE_LIMIT = 20`

## Data Model Changes

Modify `packages/core/src/domain/deployment.ts`:

- Add `DeploymentOperationGroupSchema`.
- Add optional `operationGroups` to `DeploymentPlanSchema`.
- Validate group coverage only when `operationGroups` is present:
  - every grouped `targetPath` exists in `operations`;
  - every operation target appears in exactly one group;
  - group target paths are unique across groups.
- Validate group-derived statistics when `operationGroups` is present:
  - `targetPaths` is non-empty;
  - `operationCount >= 1`;
  - `targetPaths.length === operationCount`;
  - `createCount`, `replaceCount`, and `deleteCount` match the grouped operations;
  - `createCount + replaceCount + deleteCount === operationCount`;
  - `generatedFileCount`, `copyCount`, and `symlinkCount` match grouped operation deployment types;
  - `generatedFileCount + copyCount + symlinkCount === operationCount`;
  - `operation` is the single operation kind when all grouped operations match, otherwise `mixed`.
- Validate package context when present:
  - `packageOutputCount` is a non-negative integer and must be `>= operationCount`;
  - `packagePathSample` is bounded by `PACKAGE_PATH_SAMPLE_LIMIT`, unique, stable sorted display data;
  - `packagePathSample.length <= packageOutputCount`.
- Validate `issueSummary.planWarningCount + issueSummary.conversionWarningCount === warnings.length` when `issueSummary` is present; field-level issue counts must be non-negative integers and are verified against conversion results in preview-service tests.
- Export or colocate a deterministic helper used by API/service code:
  - `operationGroupsForPlan(plan)` returns `plan.operationGroups` when present;
  - otherwise it returns one-file fallback groups from `plan.operations`.
- Add optional persisted `issueSummary` to new preview-created plans:
  - `planWarningCount` counts non-conversion planning warnings;
  - `conversionWarningCount` counts warnings emitted by partial conversion results;
  - `partialConversionCount` counts conversion results that contain dropped fields, transformed fields, or conversion warnings;
  - `droppedFieldCount`, `transformedFieldCount`, and `conversionWarningCount` are derived while preview metadata is still available;
  - legacy plans without `issueSummary` use `planWarningCount = plan.warnings.length`, `conversionWarningCount = 0`, `partialConversionCount = requiredConfirmations.includes("partial_conversion") ? 1 : 0`, and zero field-level counts as a safe coarse fallback for history summaries.

Suggested group shape:

```ts
{
  groupId: string;
  sourceAssetId?: AssetId;
  resourceKind?: ResourceKind;
  targetRootPath: AbsolutePath;
  targetRootRelativePath?: string;
  operation: "create" | "replace" | "delete" | "mixed";
  operationCount: number;
  createCount: number;
  replaceCount: number;
  deleteCount: number;
  generatedFileCount: number;
  copyCount: number;
  symlinkCount: number;
  targetPaths: readonly AbsolutePath[];
  packageOutputCount?: number;
  packagePathSample?: readonly string[];
}
```

`targetPaths` is the complete list of changed operation targets in the group, and `targetPaths.length` must equal `operationCount`. `packageOutputCount` and `packagePathSample` are optional package-context metadata from conversion outputs; they must not be used for execution, rollback, operation coverage, or changed-file summaries.

Fallback group rule for legacy and rollback plans: create one group per operation with `targetRootPath = operation.targetPath`, no `targetRootRelativePath`, `targetPaths = [operation.targetPath]`, `operationCount = 1`, counts derived from that operation, and `sourceAssetId`/`resourceKind` left `undefined` when the plan lacks that metadata. API response mappers should expose `targetRootRelativePath` as `group.targetRootRelativePath ?? group.targetRootPath` for display compatibility, while callers must treat it as a display string when fallback groups are involved.

`groupId` derivation:

- For new preview groups: `group:${sourceAssetId}:${resourceKind}:${targetRootRelativePath}`.
- If duplicate target roots exist, append a short stable hash of sorted `targetPaths`.
- For fallback groups: `group:operation:${targetPath}` with filesystem-unsafe characters encoded or hashed.

Asset source summary schema:

```ts
type AssetSourceSummary =
  | {
      readonly kind: "file";
      readonly fileName: string;
      readonly mediaType: string;
      readonly isText: boolean;
    }
  | {
      readonly kind: "package";
      readonly rootName: string;
      readonly fileCount: number;
      readonly folderCount: number;
      readonly textCount: number;
      readonly binaryCount: number;
      readonly roleCounts: {
        readonly primary: number;
        readonly metadata: number;
        readonly support: number;
      };
    };
```

`folderCount` counts unique subdirectories below the package root, excluding the package root itself.

`rootName` derivation must be deterministic and shared by CLI and Desktop mappers: for package assets use `asset.nativeIdentity.directoryName ?? basename(dirname(primarySourceFile.path))`; for file assets use `basename(primarySourceFile.path)`.

Modify `packages/api/src/commands.ts`:

- Add `AssetSourceSummarySchema`.
- Add `sourceSummary` to asset list items and asset detail source.
- Add `MigrationChangeGroupSchema`.
- Add `MigrationDifferenceSummarySchema`.
- Add `changeGroups`, `differenceSummary`, `changesTruncated`, and `changeDetailLimit` to `migration.preview`.
- Add the same grouped fields to `history.get`.
- Keep `changes` temporarily for compatibility, but document it as bounded detail data and add a `groupId` field so each bounded detail row links to a change group without path inference.

Suggested migration change group response shape:

```ts
{
  groupId: string;
  operation: "create" | "replace" | "delete" | "mixed";
  resourceType?: ResourceKind;
  sourceAssetId?: AssetId;
  targetRootPathDisplay: string;
  targetRootRelativePath: string;
  operationCount: number;
  createCount: number;
  replaceCount: number;
  deleteCount: number;
  generatedFileCount: number;
  copyCount: number;
  symlinkCount: number;
  changedTargetCount: number;
  targetPathSample: readonly string[];
  packageOutputCount?: number;
  packagePathSample?: readonly string[];
  visibleDetailCount: number;
  detailsTruncated: boolean;
}
```

`targetPathSample` is bounded changed-target display data and must not be used for summary calculations. `packagePathSample` is optional bounded package-context display data from conversion outputs and can include unchanged package outputs; it must not be used for operation coverage or changed-file summaries. Complete changed per-file paths remain internal in `DeploymentPlan.operationGroups[].targetPaths`. `visibleDetailCount` and `detailsTruncated` describe how much of this group is represented in the bounded `changes` array.

Suggested migration difference summary response shape:

```ts
{
  addedToTarget: number;
  overwrittenInTarget: number;
  unchangedPlannedTargetOutputs: number;
  conflictsOrWarnings: number;
  changedGroupCount: number;
  changedFileCount: number;
}
```

Fresh preview `differenceSummary` is computed server-side from the complete plan, operation groups, expected target hashes, warnings, and current conversion issue data so desktop and CLI do not need complete target path arrays. The formulas are file-count based unless the field name says group: `addedToTarget = sum(changeGroups.createCount)`, `overwrittenInTarget = sum(changeGroups.replaceCount)`, `changedFileCount = plan.operations.length`, and `changedGroupCount = operationGroupsForPlan(plan).length`. `unchangedPlannedTargetOutputs` counts planned conversion outputs with an existing target hash and no planned operation; it is not a true target-only inventory count. History `differenceSummary` must not require transient conversion results; it uses the persisted plan, `operationGroupsForPlan(plan)`, `plan.issueSummary`, and the legacy fallback described above. `conflictsOrWarnings = issueSummary.planWarningCount + issueSummary.partialConversionCount`; `conversionWarningCount` and field-level counts are retained for detail/history fidelity and are not separately added to avoid double counting conversion warnings.

Bounded planned change detail rows should add:

```ts
{
  groupId: string;
}
```

The `groupId` must match one `changeGroups[].groupId`.

## Implementation Tasks

Run blocks below use the repository's existing package scripts. Some package `test` scripts run a broader package suite even when file arguments are supplied; this is expected unless a task explicitly uses `pnpm exec vitest run --root ../.. <exact-file>`.

### Task 1: Asset Source Summary API

**Files:**

- Modify: `packages/api/src/commands.ts`
- Modify: `packages/core/src/use-cases/contracts.ts`
- Modify: `apps/cli/src/app-services.ts`
- Modify: `apps/desktop/src/main/composition.ts`
- Test: `packages/api/src/commands.test.ts`
- Test: `packages/core/src/ports/contracts.test.ts`
- Test: `apps/cli/src/app-services.test.ts`
- Test: `apps/cli/src/cli.test.ts`
- Test: `apps/desktop/src/main/composition.test.ts`

Steps:

- [ ] Write schema tests for both `sourceSummary.kind === "file"` and `sourceSummary.kind === "package"`.
- [ ] For Skill package tests, assert `rootName`, `fileCount`, `folderCount`, `textCount`, `binaryCount`, and role counts.
- [ ] Add `AssetSourceSummarySchema` to the API command schemas.
- [ ] Add `AssetSourceSummary`, `AssetListResult`, and `AssetGetResult` DTOs to `packages/core/src/use-cases/contracts.ts`; update `UseCaseContractMap["assets.list"]["output"]` and `UseCaseContractMap["assets.get"]["output"]` so the core contract includes `sourceSummary` rather than raw domain `Asset` output.
- [ ] Update `packages/core/src/ports/contracts.test.ts` to assert `assets.list` and `assets.get` outputs include `sourceSummary`.
- [ ] Implement `assetSourceSummary(asset)` from `asset.sourceFiles`. Prefer a shared helper if one can be introduced without broad refactoring; otherwise add identical mapper coverage in both service layers.
- [ ] Derive package `rootName` as `asset.nativeIdentity.directoryName ?? basename(dirname(primarySourceFile.path))`, and use the same helper or identical fixtures in CLI and Desktop tests.
- [ ] Include `sourceSummary` in `assets.list` and `assets.get` from both `apps/cli/src/app-services.ts` and `apps/desktop/src/main/composition.ts`.
- [ ] Add CLI app-service and Desktop composition tests proving both command surfaces return `sourceSummary` for file and package assets.
- [ ] Run:

```sh
fnm use 24
pnpm --filter @ai-config-hub/core test -- src/ports/contracts.test.ts
pnpm --filter @ai-config-hub/api test -- src/commands.test.ts
pnpm --filter @ai-config-hub/cli test -- src/app-services.test.ts src/cli.test.ts
pnpm --filter @ai-config-hub/desktop test -- src/main/composition.test.ts
```

Expected result: asset API, CLI service, and Desktop composition tests pass.

### Task 2: Asset Review UI Summary

**Files:**

- Modify: `apps/desktop/src/renderer/views/assets.tsx`
- Modify: `apps/desktop/src/renderer/i18n.ts`
- Test: `apps/desktop/src/renderer/views/assets.test.ts`

Steps:

- [ ] Add a failing test for a multi-file Skill row that renders folder-level text such as `release/`, `2 files`, and `1 folder`.
- [ ] Add a failing test that asset detail defaults to package summary and keeps the full file tree behind a collapsed disclosure.
- [ ] Update `AssetTypeTable` to use `sourceSummary` for package rows.
- [ ] Update `AssetSourceTree` to show package counts before the file tree.
- [ ] Add Simplified Chinese strings for new labels.
- [ ] Run:

```sh
fnm use 24
pnpm --filter @ai-config-hub/desktop test -- src/renderer/views/assets.test.ts
```

Expected result: asset review tests pass and single-file assets render as before.

### Task 3: Deployment Operation Groups and Compatibility

**Files:**

- Modify: `packages/core/src/domain/deployment.ts`
- Modify: `packages/deployer/src/preview-service.ts`
- Modify: `packages/deployer/src/rollback-service.ts`
- Modify: `packages/storage/src/deployment-repository.ts`
- Test: `packages/core/src/domain/deployment.test.ts`
- Test: `packages/deployer/src/preview-service.test.ts`
- Test: `packages/deployer/src/rollback-service.test.ts`
- Test: `packages/storage/src/repositories.test.ts`

Steps:

- [ ] Add failing domain tests for operation group validation when `operationGroups` is present:
  - every operation is covered by one group;
  - unknown group target paths are rejected;
  - duplicate grouped target paths are rejected.
- [ ] Add failing domain tests for group-derived statistics:
  - empty groups and unchanged-only groups are rejected;
  - `operationCount` must be at least 1;
  - `targetPaths.length` must equal `operationCount`;
  - operation kind counts must match grouped operations;
  - `createCount + replaceCount + deleteCount` must equal `operationCount`;
  - deployment type counts must match grouped operations;
  - `generatedFileCount + copyCount + symlinkCount` must equal `operationCount`;
  - `operation` must be the single operation kind or `mixed`.
- [ ] Add failing domain tests for package context metadata: `packageOutputCount >= operationCount`, `packagePathSample` bounded by `PACKAGE_PATH_SAMPLE_LIMIT`, unique, stable sorted, and `packagePathSample.length <= packageOutputCount`.
- [ ] Add a domain test proving legacy plans without `operationGroups` still parse.
- [ ] Add domain tests for optional `issueSummary`, including `planWarningCount + conversionWarningCount === warnings.length`, non-negative field-level counts, and legacy plans where it is absent.
- [ ] Add storage tests proving old `plan_json` without groups or issue summary can still be read through the repository.
- [ ] Add rollback tests proving rollback-created plans either include one-file groups or are correctly handled by `operationGroupsForPlan(plan)`.
- [ ] Add rollback/legacy fallback tests that assert one-file groups use the operation target as `targetRootPath`, omit `targetRootRelativePath`, and use the operation target as the sole `targetPaths` entry.
- [ ] In `DeploymentPreviewService`, maintain a `targetPath -> metadata` map while `PlannedOutput` is still available. Metadata must include `relativePath`, `conversionResultId`, `sourceAssetId`, `resourceKind`, and deployment type.
- [ ] Build operation groups from conversion outputs plus changed operation targets, not from operations alone.
- [ ] Build `issueSummary` while conversion results are still available, with exact `partialConversionCount`, `droppedFieldCount`, `transformedFieldCount`, `conversionWarningCount`, and `planWarningCount` from non-conversion planning warnings.
- [ ] For Skill groups, use a one-file group when the conversion output count is 1, including Skills whose only output is `SKILL.md`.
- [ ] For multi-output Skill groups, derive the package root from the conversion output set for the same source asset. This covers the case where `SKILL.md` is unchanged but support files changed, while keeping `targetPaths` limited to changed operation targets only.
- [ ] Populate optional `packageOutputCount` and bounded `packagePathSample` from conversion outputs when useful for package context; do not include unchanged outputs in `targetPaths`.
- [ ] For non-Skill groups and fallback plans, create deterministic one-file groups.
- [ ] Store groups and `issueSummary` in new preview-generated `DeploymentPlan` payloads.
- [ ] Run:

```sh
fnm use 24
pnpm --filter @ai-config-hub/core test -- src/domain/deployment.test.ts
pnpm --filter @ai-config-hub/deployer test -- src/preview-service.test.ts src/rollback-service.test.ts
pnpm --filter @ai-config-hub/storage test -- src/repositories.test.ts
```

Expected result: deployment plan schema, preview grouping, rollback, and legacy storage tests pass.

### Task 4: Migration Preview Response Groups

**Files:**

- Modify: `packages/api/src/commands.ts`
- Modify: `apps/cli/src/app-services.ts`
- Modify: `apps/desktop/src/main/composition.ts`
- Test: `packages/api/src/commands.test.ts`
- Test: `apps/cli/src/app-services.test.ts`
- Test: `apps/cli/src/cli.test.ts`
- Test: `apps/desktop/src/main/composition.test.ts`

Steps:

- [ ] Add API schema tests for `changeGroups`, `differenceSummary`, `changes[].groupId`, `targetPathSample.max(GROUP_TARGET_PATH_SAMPLE_LIMIT)`, optional `packagePathSample.max(PACKAGE_PATH_SAMPLE_LIMIT)`, `packageOutputCount`, `changesTruncated`, and `changeDetailLimit === CHANGE_DETAIL_LIMIT`.
- [ ] Add `MigrationPreviewResult` to `packages/core/src/use-cases/contracts.ts` and update `UseCaseContractMap["migration.preview"]["output"]` from raw `DeploymentPlan` to the grouped response contract.
- [ ] Update `packages/core/src/ports/contracts.test.ts` to assert `migration.preview` output includes `changeGroups`, `differenceSummary`, `changesTruncated`, `changeDetailLimit`, and bounded `changes` rows with `groupId`.
- [ ] Update both `apps/cli/src/app-services.ts` and `apps/desktop/src/main/composition.ts` `migrationPreviewResponse(plan, conversions, generatedAt)` implementations, or extract a shared response mapper if that keeps imports clean.
- [ ] Map `operationGroupsForPlan(plan)` into `changeGroups`.
- [ ] Keep `changes` as a bounded file detail array using `CHANGE_DETAIL_LIMIT`.
- [ ] Add `groupId` to each bounded `changes` item so UI and CLI can attach detail rows to groups without re-deriving membership from path strings.
- [ ] Set `changesTruncated` when `plan.operations.length > changeDetailLimit`.
- [ ] For each `changeGroup`, set `visibleDetailCount` to the number of bounded `changes` that belong to the group and `detailsTruncated` when `visibleDetailCount < operationCount`.
- [ ] Set `changedTargetCount` from the complete group target count and `targetPathSample` from the first `GROUP_TARGET_PATH_SAMPLE_LIMIT` stable sorted display paths only.
- [ ] Set optional `packageOutputCount` and `packagePathSample` from conversion-output package context when present; keep `packagePathSample` bounded by `PACKAGE_PATH_SAMPLE_LIMIT`, unique, stable sorted, and independent from changed-target counts.
- [ ] Compute preview `differenceSummary` server-side from complete plan data, warnings, and current conversion issue data using `conflictsOrWarnings = issueSummary.planWarningCount + issueSummary.partialConversionCount`.
- [ ] Add a mixed Skill group test where one group contains create and replace operations, proving `addedToTarget`, `overwrittenInTarget`, and `changedFileCount` are file counts while `changedGroupCount` remains the group count.
- [ ] Keep `targetHashes` complete in API/JSON responses for drift checks, but do not require default text/UI rendering to list every hash row.
- [ ] Add CLI app-service and Desktop composition tests with more than 200 Skill support files to prove both service layers return valid bounded responses.
- [ ] Add a test where `SKILL.md` is unchanged and support files changed, proving the response still groups by the Skill folder.
- [ ] Add a single-output Skill preview test proving a Skill with only `SKILL.md` renders as a one-file group, not a package folder row.
- [ ] Run:

```sh
fnm use 24
pnpm --filter @ai-config-hub/core test -- src/ports/contracts.test.ts
pnpm --filter @ai-config-hub/api test -- src/commands.test.ts
pnpm --filter @ai-config-hub/cli test -- src/app-services.test.ts src/cli.test.ts
pnpm --filter @ai-config-hub/desktop test -- src/main/composition.test.ts
```

Expected result: large Skill preview responses validate without exposing hundreds of default rows.

### Task 5: Migration Desktop UI Group-First Rendering

**Files:**

- Modify: `apps/desktop/src/renderer/model.ts`
- Modify: `apps/desktop/src/renderer/views/migration.tsx`
- Modify: `apps/desktop/src/renderer/i18n.ts`
- Test: `apps/desktop/src/renderer/model.test.ts`
- Test: `apps/desktop/src/renderer/views/migration.test.ts`

Steps:

- [ ] Update `migrationDifferenceSummaryForState` to use `preview.differenceSummary` when a preview exists.
- [ ] Stop using bounded `preview.changes` to calculate unchanged planned output counts or changed-file totals.
- [ ] Update preview-state UI labels/tests so `unchangedPlannedTargetOutputs` is not presented as true target-only asset inventory. Keep pre-preview live comparisons free to show true target-only assets from the target asset list.
- [ ] Add a separate file count helper if the UI needs to show total changed files.
- [ ] Change target preview rows to render `changeGroups` rather than raw `changes`.
- [ ] Render group details as collapsed file detail rows using bounded `changes` filtered by `change.groupId`.
- [ ] Show a per-group truncation note when `changeGroup.detailsTruncated` is true.
- [ ] Update `HashSnapshot` to render source/target hash counts and a `HASH_SAMPLE_LIMIT` bounded sample by default instead of every hash row for large previews; keep complete hashes in state/API data for drift checks.
- [ ] Add tests that a Skill package with multiple file changes renders one preview row and does not render every file as a top-level row.
- [ ] Add tests that unchanged planned output and changed-file counts remain correct when `changesTruncated` is true.
- [ ] Add tests that single-output Skill previews keep the existing one-file visual behavior.
- [ ] Add tests that large target hash snapshots render a count/sample and do not render hundreds of default rows.
- [ ] Run:

```sh
fnm use 24
pnpm --filter @ai-config-hub/desktop test -- src/renderer/model.test.ts src/renderer/views/migration.test.ts
```

Expected result: migration UI is group-first, summary counts are complete, and current pre-preview live differences still work.

### Task 6: CLI and History Group Output

**Files:**

- Modify: `apps/cli/src/cli.ts`
- Modify: `apps/cli/src/app-services.ts`
- Modify: `apps/desktop/src/main/composition.ts`
- Modify: `packages/api/src/commands.ts`
- Modify: `packages/core/src/use-cases/contracts.ts`
- Test: `packages/core/src/ports/contracts.test.ts`
- Test: `apps/cli/src/app-services.test.ts`
- Test: `apps/cli/src/cli.test.ts`
- Test: `apps/desktop/src/main/composition.test.ts`
- Test: `tests/e2e/cli.spec.ts`

Steps:

- [ ] Update text rendering for `migrate --dry-run` to print `changeGroups` first.
- [ ] Print bounded file details under a detail section and include a truncation line when `changesTruncated` or any `changeGroup.detailsTruncated` is true.
- [ ] Attach bounded file details to groups using `change.groupId`, not path-prefix inference.
- [ ] Change CLI text output for source/target hashes to show counts and `HASH_SAMPLE_LIMIT` bounded samples instead of printing every hash row by default. Keep complete `sourceHashes` and `targetHashes` in JSON output.
- [ ] Do not describe CLI JSON as a complete file-level audit when `changes` is bounded. CLI JSON should expose the same grouped response plus truncation metadata.
- [ ] Update `packages/core/src/use-cases/contracts.ts` so `HistoryGetResult` includes `changeGroups`, `differenceSummary`, `changesTruncated`, and `changeDetailLimit` while retaining bounded `changes`.
- [ ] Update `packages/core/src/ports/contracts.test.ts` to assert the grouped history fields are part of the use-case contract.
- [ ] Add `changeGroups`, `differenceSummary`, `changesTruncated`, and `changeDetailLimit` to `history.get` schemas and mappers.
- [ ] Update both CLI and Desktop `historyDetail(record, plan, snapshot)` implementations. Use `operationGroupsForPlan(plan)` so legacy and rollback plans render safely.
- [ ] Compute history `differenceSummary` only from persisted data: complete plan operations/groups, expected target hashes, `plan.warnings`, `plan.issueSummary`, and the legacy fallback where `planWarningCount = plan.warnings.length`, `conversionWarningCount = 0`, and `partialConversionCount = requiredConfirmations.includes("partial_conversion") ? 1 : 0`. Do not require transient `conversions`, preview-only `fieldLosses`, or target asset inventory.
- [ ] Update `renderHistoryDetail` to use `differenceSummary.changedGroupCount` and `differenceSummary.changedFileCount` instead of bounded `changes.length`.
- [ ] Show a history truncation note when `changesTruncated` is true or any `changeGroup.detailsTruncated` is true.
- [ ] Add CLI app-service and Desktop composition tests for grouped history output from a legacy plan.
- [ ] Update `tests/e2e/cli.spec.ts` JSON expectations to assert `changeGroups`, `differenceSummary`, `changesTruncated`, and bounded `changes[].groupId` while preserving compatibility checks for `changes`.
- [ ] Add CLI text tests proving large previews print hash counts/samples instead of every hash row.
- [ ] Add CLI text tests proving `history.get` with more than `CHANGE_DETAIL_LIMIT` operations still shows complete group/file counts from `differenceSummary`.
- [ ] Run:

```sh
fnm use 24
pnpm --filter @ai-config-hub/core test -- src/ports/contracts.test.ts
pnpm --filter @ai-config-hub/cli test -- src/app-services.test.ts src/cli.test.ts
pnpm --filter @ai-config-hub/desktop test -- src/main/composition.test.ts
pnpm test:e2e -- tests/e2e/cli.spec.ts
```

Expected result: CLI default output is package-level for Skill migration previews and does not imply bounded JSON contains every file operation.

### Task 7: Regression and Integration Verification

**Files:**

- No source edits expected.

Steps:

- [ ] Run package test scripts for touched areas. Existing package `test` scripts may run broader package suites even when file arguments are supplied; that is acceptable for this verification step.

```sh
fnm use 24
pnpm --filter @ai-config-hub/core test -- src/domain/deployment.test.ts
pnpm --filter @ai-config-hub/core test -- src/ports/contracts.test.ts
pnpm --filter @ai-config-hub/deployer test -- src/preview-service.test.ts src/execution-service.test.ts src/rollback-service.test.ts
pnpm --filter @ai-config-hub/storage test -- src/repositories.test.ts
pnpm --filter @ai-config-hub/api test -- src/commands.test.ts
pnpm --filter @ai-config-hub/desktop test -- src/main/composition.test.ts src/renderer/model.test.ts src/renderer/views/assets.test.ts src/renderer/views/migration.test.ts
pnpm --filter @ai-config-hub/cli test -- src/app-services.test.ts src/cli.test.ts
```

- [ ] Run type checks for touched packages:

```sh
fnm use 24
pnpm --filter @ai-config-hub/core typecheck
pnpm --filter @ai-config-hub/deployer typecheck
pnpm --filter @ai-config-hub/storage typecheck
pnpm --filter @ai-config-hub/api typecheck
pnpm --filter @ai-config-hub/desktop typecheck
pnpm --filter @ai-config-hub/cli typecheck
```

- [ ] Run the existing integration preview suite:

```sh
fnm use 24
pnpm test:integration -- tests/integration/deployment-preview.test.ts
```

- [ ] Run the CLI e2e contract path:

```sh
fnm use 24
pnpm test:e2e -- tests/e2e/cli.spec.ts
```

Expected result: all targeted tests and type checks pass.

## Risks and Mitigations

- **Risk: new plan schema breaks old deployment history.**
  Mitigation: make `operationGroups` optional in the domain schema, add fallback groups, and test legacy `plan_json` reads.

- **Risk: rollback plans fail because they are constructed outside preview.**
  Mitigation: update rollback plan construction or rely on `operationGroupsForPlan(plan)` fallback groups, with rollback tests.

- **Risk: grouped counts drift from file operations.**
  Mitigation: validate persisted groups against `operations` when groups are present.

- **Risk: grouping root inference is wrong when `SKILL.md` is unchanged.**
  Mitigation: build groups from conversion output metadata before it is discarded, not from operations alone.

- **Risk: truncated file details corrupt summary counts.**
  Mitigation: compute `differenceSummary` server-side from complete plan data; use bounded `changes` only for detail previews.

- **Risk: unchanged package outputs are accidentally treated as changed operations.**
  Mitigation: keep `operationGroups[].targetPaths` limited to changed operation targets, and store optional package context separately as `packageOutputCount` and bounded `packagePathSample`.

- **Risk: complete hash rows still overwhelm large Skill previews.**
  Mitigation: keep complete hashes in API/JSON for drift checks, but render counts and bounded samples in default CLI text and Desktop hash snapshot views.

- **Risk: UI hides important file-level details.**
  Mitigation: keep collapsed bounded file details, hashes, diffs, truncation notices, and the persisted plan as the internal audit source.

- **Risk: backward compatibility for existing consumers of `changes`.**
  Mitigation: retain bounded `changes` in the response and add explicit truncation metadata.

- **Risk: history differs from preview after execution.**
  Mitigation: persist groups and `issueSummary` in new preview plans, use the same `operationGroupsForPlan(plan)` mapping for preview and history, and define a legacy fallback when `issueSummary` is absent.

## Acceptance Criteria

- A Skill package with more than 200 files can produce a valid migration preview response.
- A Skill package whose `SKILL.md` is unchanged but support files changed still renders as one target Skill folder group.
- Old deployment history without `operationGroups` still loads and renders through fallback groups.
- Rollback-created plans still parse and render safely.
- The migration preview page shows one row per Skill target folder by default.
- Summary counts do not depend on bounded `changes`.
- Summary counts come from server-computed `differenceSummary`, not bounded file details or path samples.
- Preview/history `differenceSummary.unchangedPlannedTargetOutputs` is documented and rendered as unchanged planned outputs, not true target-only asset inventory.
- History `differenceSummary` is computed from persisted plan data and does not require transient conversion results.
- Desktop main and CLI service command handlers both expose `sourceSummary`, `changeGroups`, and truncation metadata.
- Operation group validation rejects drifted group count fields and never requires unchanged package outputs to appear in `targetPaths`.
- Operation group validation rejects empty groups and unchanged-only groups.
- CLI text output and Desktop hash snapshot views summarize large hash sets with counts and bounded samples while JSON/API data keeps complete hashes.
- CLI history text uses `differenceSummary` complete counts, not bounded `changes.length`.
- The execution service still writes, verifies, and rolls back file-by-file.
- Asset review shows Skill packages as folders with file counts instead of a flat default file list.
- CLI text preview shows grouped folder changes by default and clearly marks bounded file details.
- Existing single-file asset review and migration behavior remains visually and contractually compatible, including Skills whose only conversion output is `SKILL.md`.
