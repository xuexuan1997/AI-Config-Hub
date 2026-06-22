# Deployment and Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build drift-protected preview, backup-first atomic deployment, verification, compensation, and explicit rollback services.

**Architecture:** `packages/deployer` implements core file ports and orchestration while `packages/core` retains immutable plan/record schemas and `packages/storage` provides compare-and-set persistence. All writes are confined to authorized roots and backed by integration tests using temporary directories.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest, SQLite repositories, existing adapters

---

### Task 1: Implement safe deployment filesystem and locks

**Files:**
- Create: `packages/deployer/src/file-port.ts`
- Create: `packages/deployer/src/path-locks.ts`
- Create: `packages/deployer/src/file-port.test.ts`
- Modify: `packages/deployer/src/index.ts`
- Modify: `packages/deployer/package.json`

- [ ] **Step 1: Write failing confinement and atomicity tests**

Create tests that instantiate `NodeDeploymentFilePort({ allowedRoots, backupRoot })` in a temporary directory and assert: create/replace/delete reject escaping paths and symlink escapes; stale hashes reject without mutation; backups preserve content and mode; atomic replacement returns the SHA-256 hash. Add a lock test proving two `withPaths([target])` callbacks never overlap and sorted multi-path acquisition cannot deadlock.

Run: `pnpm --filter @ai-config-hub/deployer test`

Expected: FAIL because the two classes are not exported.

- [ ] **Step 2: Implement the file port**

Implement this public surface in `file-port.ts`:

```ts
export interface NodeDeploymentFilePortOptions {
  readonly allowedRoots: readonly AbsolutePath[];
  readonly backupRoot: AbsolutePath;
}

export class NodeDeploymentFilePort implements DeploymentFilePort {
  constructor(private readonly options: NodeDeploymentFilePortOptions) {}
  createBackup(input: {
    readonly source: AbsolutePath;
    readonly destination: AbsolutePath;
    readonly expectedHash: ContentHash;
  }): Promise<{ readonly backupPath: AbsolutePath; readonly backupHash: ContentHash }>;
  atomicReplace(input: {
    readonly target: AbsolutePath;
    readonly text: string;
    readonly expectedHash: ContentHash | "absent";
  }): Promise<{ readonly resultingHash: ContentHash }>;
  remove(input: { readonly target: AbsolutePath; readonly expectedHash: ContentHash }): Promise<void>;
}
```

Use `realpath` on the nearest existing parent, compare canonical paths against canonical allowed roots, open temporary files with mode `0o600`, call `FileHandle.sync()`, rename within the target directory, and fsync the parent directory. Hash bytes with SHA-256 and remove temporary files in `finally`.

Add `"test": "vitest run src"` to `packages/deployer/package.json` so focused package commands are executable.

- [ ] **Step 3: Implement deterministic path locks**

Expose:

```ts
export class PathLockManager {
  withPaths<T>(paths: readonly AbsolutePath[], operation: () => Promise<T>): Promise<T>;
}
```

Deduplicate and lexicographically sort paths, chain one promise per path, and release every acquired lock in `finally`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @ai-config-hub/deployer test && pnpm typecheck && pnpm lint`

Expected: all commands exit 0.

Commit:

```bash
git add packages/deployer
git commit -m "feat(deployer): add confined atomic file operations"
```

### Task 2: Generate immutable migration previews

**Files:**
- Create: `packages/deployer/src/preview-service.ts`
- Create: `packages/deployer/src/preview-service.test.ts`
- Modify: `packages/deployer/src/index.ts`

- [ ] **Step 1: Write failing preview tests**

Test create, replace, unchanged, and partial-conversion cases. Assert deterministic IDs and plan hashes, bounded unified diffs, exact source/target hashes, overwrite confirmation, no writes, and rejection of redacted MCP output or targets outside authorized roots.

Run: `pnpm --filter @ai-config-hub/deployer test -- preview-service`

Expected: FAIL because `DeploymentPreviewService` does not exist.

- [ ] **Step 2: Implement preview orchestration**

Expose:

```ts
export interface PreviewRequest {
  readonly assets: readonly Asset[];
  readonly target: ConversionTarget;
  readonly targetRoot: AbsolutePath;
  readonly backupRoot: AbsolutePath;
  readonly allowedRoots: readonly AbsolutePath[];
  readonly now: IsoDateTime;
  readonly correlationId: CorrelationId;
  readonly signal: AbortSignal;
}

export class DeploymentPreviewService {
  preview(request: PreviewRequest): Promise<{
    readonly plan: DeploymentPlan;
    readonly record: DeploymentRecord;
    readonly conversions: readonly ConversionResult[];
  }>;
}
```

Resolve the registered target adapter, convert every asset, reject unsupported results, map outputs beneath `targetRoot`, snapshot existing targets, derive create/replace operations, omit byte-identical outputs, cap each diff at 200 KiB, compute the canonical plan hash, save plan and planned record in one repository call, and return the persisted values.

- [ ] **Step 3: Verify and commit**

Run: `pnpm --filter @ai-config-hub/deployer test && pnpm test:integration`

Expected: preview tests pass and existing integration tests stay green.

Commit:

```bash
git add packages/deployer
git commit -m "feat(deployer): create immutable deployment previews"
```

### Task 3: Execute and compensate deployments

**Files:**
- Create: `packages/deployer/src/execution-service.ts`
- Create: `packages/deployer/src/execution-service.test.ts`
- Modify: `packages/deployer/src/index.ts`

- [ ] **Step 1: Write failing state-machine tests**

Cover confirmation mismatch, expired plan, source/target drift, backup failure, failure after the second write, adapter verification failure, successful deployment, and concurrent execution. Assert repository transitions use compare-and-set and failed batches restore completed operations in reverse order.

Run: `pnpm --filter @ai-config-hub/deployer test -- execution-service`

Expected: FAIL because `DeploymentExecutionService` is missing.

- [ ] **Step 2: Implement execution**

Expose:

```ts
export interface ExecuteDeploymentRequest {
  readonly deploymentRecordId: DeploymentRecordId;
  readonly confirmedPlanHash: ContentHash;
  readonly confirmations: readonly ("partial_conversion" | "overwrite" | "delete")[];
  readonly allowedRoots: readonly AbsolutePath[];
  readonly now: IsoDateTime;
}

export class DeploymentExecutionService {
  execute(request: ExecuteDeploymentRequest): Promise<DeploymentRecord>;
}
```

Load plan/record, validate plan hash/expiry/confirmations, acquire all target locks, resnapshot every target, transition `planned → confirmed → backed_up → writing → verifying → succeeded`, create backups before writes, append journal entries after each completed operation, call adapter verification, and persist hashes/diagnostics. On any post-write error, transition to `rolling_back`, compensate reverse journal order, and finish `rolled_back` only when every target is verified; otherwise finish `failed` with the recovery lock set by the task result.

- [ ] **Step 3: Verify and commit**

Run: `pnpm --filter @ai-config-hub/deployer test && pnpm typecheck && pnpm lint`

Expected: all execution and package checks pass.

Commit:

```bash
git add packages/deployer
git commit -m "feat(deployer): execute verified atomic deployments"
```

### Task 4: Add explicit rollback and end-to-end integration

**Files:**
- Create: `packages/deployer/src/rollback-service.ts`
- Create: `packages/deployer/src/rollback-service.test.ts`
- Create: `tests/integration/deployment-lifecycle.test.ts`
- Create: `packages/storage/src/migrations/0002-rollback-links.sql`
- Modify: `packages/storage/src/schema.ts`
- Modify: `packages/deployer/src/index.ts`

- [ ] **Step 1: Write failing rollback tests**

Test rollback preview, current-target drift rejection, missing/corrupt backup rejection, inverse create/replace/delete operations, verified restore, linked rollback record, and preservation of unresolved backups.

Run: `pnpm --filter @ai-config-hub/deployer test -- rollback-service`

Expected: FAIL because rollback service is absent.

- [ ] **Step 2: Implement rollback surface**

Expose:

```ts
export class DeploymentRollbackService {
  preview(deploymentRecordId: DeploymentRecordId): Promise<DeploymentPlan>;
  execute(input: {
    readonly deploymentRecordId: DeploymentRecordId;
    readonly rollbackPlanHash: ContentHash;
    readonly now: IsoDateTime;
  }): Promise<DeploymentRecord>;
}
```

Create a new immutable inverse plan, validate backup and live hashes, execute it through the same lock/file primitives, verify restored hashes, and link the new record to the original through a migration that adds `rollback_of_domain_id` to deployments.

- [ ] **Step 3: Verify full lifecycle and commit**

Run: `pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build`

Expected: all repository gates pass; integration test proves scan fixture → preview → deploy → verify → rollback → verify original bytes.

Commit:

```bash
git add packages/deployer packages/storage tests/integration
git commit -m "feat(deployer): add verified deployment rollback"
```
