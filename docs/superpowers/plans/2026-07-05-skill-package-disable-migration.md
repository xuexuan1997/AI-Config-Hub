# Skill Package Disablement and Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make skill assets behave as full directory packages during disable/enable and migration.

**Architecture:** Keep `Asset.sourceFiles` as the authoritative package manifest. Disablement moves a skill package root as a directory with restore metadata, while migration emits one generated `SKILL.md` plus copy outputs for every non-primary package member, including binary files. Deployment preview resolves copy sources with byte snapshots so binary support files can be planned and verified.

**Tech Stack:** TypeScript, Vitest, Node 24, pnpm workspaces.

---

### Task 1: Directory-Level Skill Disablement

**Files:**
- Modify: `packages/core/src/ports/repositories.ts`
- Modify: `packages/storage/src/index-repository.ts`
- Modify: `packages/deployer/src/asset-disablement-service.ts`
- Test: `packages/deployer/src/asset-disablement-service.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests showing that disabling a multi-file skill with `move_file` moves the whole skill directory, restoring it brings every file back, restore conflicts on a recreated directory, and persistence failure compensates the whole directory.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm --filter @ai-config-hub/deployer test -- src/asset-disablement-service.test.ts`

Expected: FAIL because only `SKILL.md` is moved and restore records only carry one `movedPath`.

- [ ] **Step 3: Implement minimal code**

Add directory move metadata to `AssetDisablementRecord.restore`, parse/persist it in storage, and make `AssetDisablementService.disableByMovingFile` choose package-root movement for skill assets whose primary file is `SKILL.md`.

- [ ] **Step 4: Verify tests pass**

Run: `pnpm --filter @ai-config-hub/deployer test -- src/asset-disablement-service.test.ts`

Expected: PASS.

### Task 2: Complete Skill Package Migration Outputs

**Files:**
- Modify: `packages/adapters/src/conversion.ts`
- Modify: `packages/deployer/src/preview-service.ts`
- Modify: `packages/core/src/ports/adapter.ts`
- Test: `packages/adapters/src/conversion.test.ts`
- Test: `packages/deployer/src/preview-service.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests showing skill migration includes binary support files as copy outputs and deployment preview can plan a copy operation for a binary file without requiring UTF-8 text.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm --filter @ai-config-hub/adapters test -- src/conversion.test.ts` and `pnpm --filter @ai-config-hub/deployer test -- src/preview-service.test.ts`

Expected: FAIL because binary package files are omitted and preview currently uses text-only snapshots for copy sources.

- [ ] **Step 3: Implement minimal code**

Remove the binary omission path in skill conversion, extend resolved copy output metadata to allow binary previews without text, and make preview resolve copy/symlink sources through `snapshotFile`.

- [ ] **Step 4: Verify tests pass**

Run: `pnpm --filter @ai-config-hub/adapters test -- src/conversion.test.ts` and `pnpm --filter @ai-config-hub/deployer test -- src/preview-service.test.ts`

Expected: PASS.

### Task 3: Regression Verification

**Files:**
- No direct source edits expected.

- [ ] **Step 1: Run targeted suites**

Run: `pnpm --filter @ai-config-hub/deployer test -- src/asset-disablement-service.test.ts src/preview-service.test.ts`

Expected: PASS.

- [ ] **Step 2: Run adapter suite**

Run: `pnpm --filter @ai-config-hub/adapters test -- src/conversion.test.ts src/verification.test.ts`

Expected: PASS.

- [ ] **Step 3: Typecheck touched packages**

Run: `pnpm --filter @ai-config-hub/core typecheck && pnpm --filter @ai-config-hub/adapters typecheck && pnpm --filter @ai-config-hub/deployer typecheck`

Expected: PASS.
