# Local History and Application Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add sanitized local Git history and compose scanner, migration, deployment, rollback, history, settings, and task services behind validated API handlers.

**Architecture:** `packages/git` wraps the system Git executable but exposes only a dedicated local repository. A new application-service layer in `packages/core` coordinates existing ports, while `packages/api` adapts versioned Zod commands and task events without exposing filesystem or subprocess primitives.

**Tech Stack:** TypeScript, system Git, Zod, Vitest, SQLite

---

### Task 1: Replace remote-oriented Git access with a local snapshot port

**Files:**
- Modify: `packages/core/src/ports/git.ts`
- Create: `packages/git/src/local-git.ts`
- Create: `packages/git/src/local-git.test.ts`
- Modify: `packages/git/src/index.ts`
- Modify: `packages/git/package.json`

- [ ] **Step 1: Write failing local repository tests**

Use a temporary repository and a controlled command runner. Assert initialization uses branch `main`, commits only provided relative paths, rejects `..`, absolute paths, symlink escapes, `.git`, and unlisted files, returns deterministic history/diff data, and never invokes fetch/pull/push or a network URL.

Run: `pnpm --filter @ai-config-hub/git test`

Expected: FAIL because the local implementation does not exist.

- [ ] **Step 2: Define the local-only port**

Replace the unused remote methods with:

```ts
export interface LocalGitPort {
  initialize(root: AbsolutePath): Promise<void>;
  snapshot(input: {
    readonly root: AbsolutePath;
    readonly paths: readonly string[];
    readonly message: string;
    readonly authoredAt: IsoDateTime;
  }): Promise<GitCommitSummary>;
  diff(input: { readonly root: AbsolutePath; readonly from?: string; readonly to?: string }): Promise<string>;
  history(input: { readonly root: AbsolutePath; readonly limit: number; readonly cursor?: string }): Promise<readonly GitCommitSummary[]>;
}
```

No public core type contains remote, clone, pull, or push operations.

- [ ] **Step 3: Implement system Git wrapper**

Create `SystemLocalGitPort` with a constructor-injected `runGit(args, cwd)` function. Invoke Git with `--no-optional-locks`, `-c credential.helper=`, `-c core.hooksPath=/dev/null`, and a scrubbed environment. Use `git add -- <validated paths>`, require a clean status outside the allowlist, commit with deterministic author metadata, and parse NUL-delimited output.

Add `"test": "vitest run src"` to `packages/git/package.json`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @ai-config-hub/git test && pnpm typecheck && pnpm lint`

Expected: all checks exit 0.

Commit:

```bash
git add packages/core/src/ports/git.ts packages/git
git commit -m "feat(git): add isolated local snapshot history"
```

### Task 2: Build sanitized snapshot projection

**Files:**
- Create: `packages/git/src/snapshot-service.ts`
- Create: `packages/git/src/snapshot-service.test.ts`
- Modify: `packages/git/src/index.ts`

- [ ] **Step 1: Write failing secret and scoping tests**

Assert canonical snapshots contain normalized Rule/Agent/Skill data, replace MCP literal/reference/redacted values with kind plus digest metadata, omit original absolute paths and user names, write only `assets/` and `deployments/`, and produce identical bytes for identical inputs.

Run: `pnpm --filter @ai-config-hub/git test -- snapshot-service`

Expected: FAIL because `LocalHistoryService` is absent.

- [ ] **Step 2: Implement projection and commits**

Expose:

```ts
export class LocalHistoryService {
  recordDeployment(input: {
    readonly root: AbsolutePath;
    readonly assets: readonly Asset[];
    readonly deployment: DeploymentRecord;
  }): Promise<GitCommitSummary>;
  list(root: AbsolutePath, limit: number, cursor?: string): Promise<readonly GitCommitSummary[]>;
  diff(root: AbsolutePath, from?: string, to?: string): Promise<string>;
}
```

Serialize sorted JSON with a trailing newline, derive paths from stable IDs, and write through a confined snapshot file writer before calling `LocalGitPort.snapshot`.

- [ ] **Step 3: Verify and commit**

Run: `pnpm --filter @ai-config-hub/git test && pnpm test:integration`

Expected: all local history checks pass without network access.

Commit:

```bash
git add packages/git
git commit -m "feat(git): record sanitized deployment snapshots"
```

### Task 3: Implement application services and API handlers

**Files:**
- Create: `packages/core/src/use-cases/application-services.ts`
- Create: `packages/core/src/use-cases/application-services.test.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/api/src/handlers.ts`
- Create: `packages/api/src/handlers.test.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/core/package.json`
- Modify: `packages/api/package.json`

- [ ] **Step 1: Write failing orchestration tests**

Cover all command names already declared in `commands.ts`: scan start/status/cancel, asset list/get, effective resolve, diagnostics list, migration preview, deployment execute/rollback, history list, settings get/update. Assert validation occurs before service calls, domain errors map to stable API errors, and accepted long operations return task IDs and ordered events.

Run: `pnpm --filter @ai-config-hub/api test`

Expected: FAIL because handler registry is missing.

- [ ] **Step 2: Implement one typed application facade**

Expose:

```ts
export interface ApplicationServices {
  readonly scan: ScanUseCase;
  readonly assets: AssetQueryUseCase;
  readonly effective: EffectiveConfigUseCase;
  readonly diagnostics: DiagnosticQueryUseCase;
  readonly migration: MigrationPreviewUseCase;
  readonly deployments: DeploymentUseCase;
  readonly history: HistoryUseCase;
  readonly settings: SettingsUseCase;
}
```

Implement concrete services by composing repositories, scanner, deployer, and local history ports. Do not import Electron in any package.

Add `"test": "vitest run src"` to both `packages/core/package.json` and `packages/api/package.json`.

- [ ] **Step 3: Implement validated handler registry**

Expose `createCommandHandlers(services, requestId, now)` returning an exact mapped handler for every `ApiCommandName`. Parse request envelopes, parse command payload, call the matching service, parse response data, and return a success/error envelope with redacted context.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @ai-config-hub/core test && pnpm --filter @ai-config-hub/api test && pnpm typecheck && pnpm lint`

Expected: all command and orchestration tests pass.

Commit:

```bash
git add packages/core packages/api
git commit -m "feat(api): compose validated application services"
```

### Task 4: Integrate task events and recovery locks

**Files:**
- Create: `packages/core/src/use-cases/task-service.ts`
- Create: `packages/core/src/use-cases/task-service.test.ts`
- Create: `tests/integration/application-workflows.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing event-sequence tests**

Assert accepted is sequence 1, phase transitions follow `events.ts`, progress totals do not decrease, cancellation is rejected during atomic writes, replay gaps yield cursor reset plus snapshot, terminal events are final, and unresolved compensation sets `systemRecoveryLock` and blocks later writes.

- [ ] **Step 2: Implement task service**

Implement `TaskService.start(kind, operation)`, `cancel(taskId, reason)`, `subscribe(taskId, afterSequence, listener)`, and `assertWritesAllowed(paths)`. Persist snapshots through `TaskRepository` and keep a bounded in-memory event ring for active/recent tasks.

- [ ] **Step 3: Run full workflow tests and commit**

Run: `pnpm test && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build`

Expected: full repository gate exits 0 and integration tests cover scan → preview → deployment → local snapshot → history → rollback.

Commit:

```bash
git add packages/core tests/integration
git commit -m "feat(core): orchestrate observable application workflows"
```
