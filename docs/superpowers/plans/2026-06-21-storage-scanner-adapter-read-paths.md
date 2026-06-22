# Storage, Scanner, and Adapter Read Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the durable SQLite foundation, capability-limited file reader, atomic scan pipeline, and read-only discovery/parse paths for Rules, Agents, Skills, and MCP across Claude Code, Cursor, Codex, and OpenCode.

**Architecture:** Configuration files remain authoritative. The scanner injects a root-confined read API into statically registered adapters, turns parsed resources into stable domain records, and replaces the affected SQLite index in one short transaction. SQLite uses Drizzle over Node 24's built-in `node:sqlite`; non-derived records and migrations are preserved separately from the replaceable scan index, and secret-bearing values are redacted before they can cross an adapter result or persistence boundary.

**Tech Stack:** TypeScript 6 strict mode, Node.js 24.14 `node:sqlite`, Drizzle ORM 0.45.2, Zod, YAML 2.9, smol-toml 1.6, jsonc-parser 3.3, Vitest, pnpm.

---

## File map

| Area | Files and responsibility |
| --- | --- |
| Storage bootstrap | `packages/storage/src/database.ts`, `migrations.ts`, `migrations/0001-initial.sql`: safe connection pragmas, schema application, backup-before-upgrade, read-only recovery |
| Storage schema | `packages/storage/src/schema.ts`: Drizzle declarations for all 15 architecture tables and scan staging tables |
| Storage repositories | `packages/storage/src/index-repository.ts`, `task-repository.ts`, `settings-repository.ts`, `deployment-repository.ts`, `serialization.ts`: core port implementations and secret-safe JSON |
| Safe file access | `packages/scanner/src/path-policy.ts`, `file-reader.ts`, `cancellation.ts`: canonical roots, symlink containment, stable snapshots and cancellation |
| Scan orchestration | `packages/scanner/src/scan-service.ts`, `identity.ts`, `diagnostics.ts`: detect/discover/read/parse/stage/commit and stable IDs |
| Adapter common code | `packages/adapters/src/registry.ts`, `frontmatter.ts`, `structured-config.ts`, `secrets.ts`, `base-adapter.ts`: static registration, parsers, normalized resources and redaction |
| Tool adapters | `packages/adapters/src/{claude-code,cursor,codex,opencode}.ts`: tool-owned paths, formats, scopes and parsing |
| Fixtures | `packages/adapters/test/fixtures/<tool>/**`: golden valid, malformed, unknown-field and secret-bearing files |
| Integration | `tests/integration/scan-pipeline.test.ts`, `storage-recovery.test.ts`: real temporary trees and SQLite files |

### Task 1: Pin phase-two dependencies and expose package test commands

**Files:**
- Modify: `packages/storage/package.json`
- Modify: `packages/adapters/package.json`
- Modify: `packages/scanner/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Test: `tests/tooling/workspace.test.mjs`

- [ ] **Step 1: Extend the failing workspace dependency test**

Assert exact versions and package ownership:

```js
assert.equal(storage.dependencies["drizzle-orm"], "0.45.2");
assert.equal(adapters.dependencies.yaml, "2.9.0");
assert.equal(adapters.dependencies["smol-toml"], "1.6.1");
assert.equal(adapters.dependencies["jsonc-parser"], "3.3.1");
for (const manifest of [storage, adapters, scanner]) {
  assert.equal(manifest.scripts.test, "vitest run src");
}
```

- [ ] **Step 2: Run the test and confirm the missing dependency failure**

Run: `node --test tests/tooling/workspace.test.mjs`

Expected: FAIL because phase-two dependencies and package test scripts are absent.

- [ ] **Step 3: Add exact dependencies**

Use these manifest entries; do not add `better-sqlite3`, a glob package, or a generic plugin loader:

```json
// packages/storage/package.json
"dependencies": {
  "@ai-config-hub/core": "workspace:*",
  "@ai-config-hub/shared": "workspace:*",
  "drizzle-orm": "0.45.2"
}

// packages/adapters/package.json
"dependencies": {
  "@ai-config-hub/core": "workspace:*",
  "@ai-config-hub/shared": "workspace:*",
  "jsonc-parser": "3.3.1",
  "smol-toml": "1.6.1",
  "yaml": "2.9.0"
}
```

Add `"test": "vitest run src"` to all three manifests and run `pnpm install`.

- [ ] **Step 4: Verify and commit**

Run: `node --test tests/tooling/workspace.test.mjs && pnpm install --frozen-lockfile`

Expected: PASS with no lockfile mutation on the frozen install.

```bash
git add package.json packages/*/package.json pnpm-lock.yaml tests/tooling/workspace.test.mjs
git commit -m "build: add storage and adapter dependencies"
```

### Task 2: Implement canonical, capability-limited file reads

**Files:**
- Create: `packages/scanner/src/path-policy.ts`
- Create: `packages/scanner/src/file-reader.ts`
- Create: `packages/scanner/src/cancellation.ts`
- Create: `packages/scanner/src/file-reader.test.ts`
- Modify: `packages/scanner/src/index.ts`

- [ ] **Step 1: Write hostile path and torn-read tests**

Use a temporary allowed root containing a regular file, an internal symlink and a symlink to an external directory. Assert:

```ts
await expect(read.readText(outsidePath)).rejects.toMatchObject({
  code: "PATH_OUTSIDE_ALLOWED_ROOT",
});
await expect(read.readText(escapingSymlink)).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
expect(await read.realpath(internalSymlink)).toBe(canonicalInternalTarget);
expect((await snapshots.snapshot({ path: file, allowedRoots: [root] })).contentHash)
  .toMatch(/^sha256:[0-9a-f]{64}$/);
expect(Object.keys(read).sort()).toEqual(["list", "readText", "realpath", "stat"]);
```

Inject a test hook between the first stat and final stat, mutate the file, and expect `STALE_INDEX` rather than a torn snapshot.

- [ ] **Step 2: Run the focused test and verify the missing reader failure**

Run: `pnpm exec vitest run packages/scanner/src/file-reader.test.ts`

Expected: FAIL because the path policy and reader do not exist.

- [ ] **Step 3: Implement containment and byte-stable snapshots**

`NodeFileReader` receives immutable allowed roots at construction. Resolve both root and target through `realpath`, compare using platform-aware path segments (not string prefixes), reject NUL bytes, and never expose write or execute methods. Snapshot raw bytes, compute `sha256:<hex>`, and compare identity, size and `mtimeMs` before and after reading:

```ts
export interface SnapshotIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

if (!sameIdentity(before, after)) {
  throw staleIndexError("File changed while being read", canonicalPath);
}
```

Map missing files to `FileStat.kind = "missing"`; return sorted canonical children from `list`. `createCancellationController()` must expose a signal whose `throwIfAborted()` raises `USER_CANCELLED` without using DOM types.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run packages/scanner/src/file-reader.test.ts && pnpm --filter @ai-config-hub/scanner typecheck`

Expected: PASS on regular paths, internal symlinks, escaping symlinks, traversal attempts and torn reads.

```bash
git add packages/scanner
git commit -m "feat(scanner): add root-confined stable file reads"
```

### Task 3: Add structured parsers, secret redaction, and a static adapter registry

**Files:**
- Create: `packages/adapters/src/frontmatter.ts`
- Create: `packages/adapters/src/structured-config.ts`
- Create: `packages/adapters/src/secrets.ts`
- Create: `packages/adapters/src/registry.ts`
- Create: `packages/adapters/src/common.test.ts`
- Modify: `packages/adapters/src/index.ts`

- [ ] **Step 1: Write parser, redaction and registry tests**

Cover YAML frontmatter line offsets, JSONC comments/trailing commas, TOML tables, cyclic/invalid values, and key/value secret detection. The golden secret test must search the entire serialized parse result:

```ts
const result = redactStructuredValue({
  authorization: "Bearer top-secret",
  endpoint: "https://user:pass@example.test/mcp?apiKey=top-secret",
  env: { SAFE: "ok", TOKEN: "top-secret" },
});
expect(JSON.stringify(result)).not.toContain("top-secret");
expect(JSON.stringify(result)).not.toContain("user:pass");
expect(Object.keys(createDefaultAdapterRegistry().registrations).sort()).toEqual([
  "claude-code", "codex", "cursor", "opencode",
]);
```

- [ ] **Step 2: Run the test and verify missing modules**

Run: `pnpm exec vitest run packages/adapters/src/common.test.ts`

Expected: FAIL with unresolved common parser/registry modules.

- [ ] **Step 3: Implement bounded parsers and product-domain redaction**

Parse frontmatter only when the file begins with `---`; reject an unclosed header with a line-1 diagnostic. Reject documents over 4 MiB and nesting deeper than 64. Redact keys matching this case-insensitive set:

```ts
const sensitiveKey = /(?:token|secret|password|passwd|private[_-]?key|api[_-]?key|authorization|cookie|credential)/i;
```

Represent `${NAME}` and `$NAME` as `SecretAwareString.kind = "reference"`. Redact sensitive literals with `sha256("ai-config-hub:secret:v1\0" + value)` and never return the input literal. Parse URLs structurally and redact userinfo plus sensitive query values.

The registry is a frozen map built only from four imported `AdapterRegistration` constants. Reject duplicate tool IDs, adapter IDs, unsupported contract versions and registrations whose runtime identity differs from metadata. It must not call dynamic `import()` or inspect the filesystem.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run packages/adapters/src/common.test.ts && pnpm --filter @ai-config-hub/adapters typecheck`

Expected: PASS; secret literals are absent from serialized results.

```bash
git add packages/adapters
git commit -m "feat(adapters): add safe parsers and static registry"
```

### Task 4: Implement Claude Code and Cursor read paths

**Files:**
- Create: `packages/adapters/src/claude-code.ts`
- Create: `packages/adapters/src/cursor.ts`
- Create: `packages/adapters/src/markdown-assets.ts`
- Create: `packages/adapters/src/claude-code.test.ts`
- Create: `packages/adapters/src/cursor.test.ts`
- Create: `packages/adapters/test/fixtures/claude-code/**`
- Create: `packages/adapters/test/fixtures/cursor/**`

- [ ] **Step 1: Write golden discovery and parse tests**

Build in-memory `AdapterReadApi` trees and golden fixtures for every cell:

| Tool | Rule | Agent | Skill | MCP |
| --- | --- | --- | --- | --- |
| Claude Code | `CLAUDE.md`, nested `CLAUDE.md` | `.claude/agents/**/*.md` | `.claude/skills/*/SKILL.md` | `.mcp.json` and config-root MCP JSON |
| Cursor | `.cursor/rules/**/*.mdc`, `AGENTS.md`, legacy `.cursorrules` with deprecation diagnostic | `.cursor/agents/**/*.md` | `.cursor/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md` | `.cursor/mcp.json` |

For each adapter assert deterministic candidate ordering, correct user/project/directory scope, normalized resource schema success, locator stability, references, unknown fields under `extensions`, and malformed-file `status = "rejected"` with a location.

- [ ] **Step 2: Confirm missing adapter failures**

Run: `pnpm exec vitest run packages/adapters/src/claude-code.test.ts packages/adapters/src/cursor.test.ts`

Expected: FAIL because adapter registrations are not implemented.

- [ ] **Step 3: Implement both adapters without direct Node imports**

Use only the injected `AdapterReadApi`. Markdown asset parsing maps frontmatter and body as follows:

```ts
// agent
{ kind: "agent", data: { name, instructions: body, model, allowedTools, extensions } }
// skill
{ kind: "skill", data: { name, description, instructions: body, references, extensions } }
// rule/MDC
{ kind: "rule", data: { name, instructions: body, globs, extensions } }
```

MCP JSON accepts `mcpServers` objects. Convert `command` plus `args` to stdio, and `url` plus headers to HTTP/SSE; run all args, env, URL userinfo/query and headers through secret-aware conversion. A single MCP file returns one asset per named server with locator `mcp:<name>`.

Capabilities must declare all four resource kinds, user/project/directory scopes, nested-scope support where the tool supports it, adapter version `0.1.0`, written normalized schema `1.0.0`, and explicit tested tool versions.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run packages/adapters/src/claude-code.test.ts packages/adapters/src/cursor.test.ts && pnpm lint`

Expected: PASS and no `node:fs`/`child_process` dependency from adapters.

```bash
git add packages/adapters
git commit -m "feat(adapters): read Claude Code and Cursor assets"
```

### Task 5: Implement Codex and OpenCode read paths

**Files:**
- Create: `packages/adapters/src/codex.ts`
- Create: `packages/adapters/src/opencode.ts`
- Create: `packages/adapters/src/codex.test.ts`
- Create: `packages/adapters/src/opencode.test.ts`
- Create: `packages/adapters/test/fixtures/codex/**`
- Create: `packages/adapters/test/fixtures/opencode/**`

- [ ] **Step 1: Write golden discovery and parse tests**

Cover the current official layouts:

| Tool | Rule | Agent | Skill | MCP |
| --- | --- | --- | --- | --- |
| Codex | global/project/nested `AGENTS.override.md` or `AGENTS.md` precedence | `.codex/agents/*.toml` | `.agents/skills/*/SKILL.md` along the root-to-CWD chain | global/project `.codex/config.toml` `[mcp_servers.<name>]` |
| OpenCode | `AGENTS.md`, compatible `CLAUDE.md`, configured local instruction paths only | `.opencode/agents/**/*.md` and config `agent` entries | `.opencode/skills`, `.agents/skills`, compatible `.claude/skills` | `opencode.json`/`opencode.jsonc` `mcp` entries |

Assert Codex only selects one instruction file per directory (`override` first), merges candidates root-to-target, and parses custom-agent TOML required fields `name`, `description`, `developer_instructions`. Assert OpenCode local/remote MCP shapes normalize without fetching remote URLs.

- [ ] **Step 2: Confirm missing adapter failures**

Run: `pnpm exec vitest run packages/adapters/src/codex.test.ts packages/adapters/src/opencode.test.ts`

Expected: FAIL because registrations do not exist.

- [ ] **Step 3: Implement official read-only formats**

Codex TOML mapping:

```ts
const resource = {
  kind: "agent",
  data: {
    name: requiredString(doc.name),
    instructions: requiredString(doc.developer_instructions),
    model: optionalString(doc.model),
    allowedTools: [],
    extensions: omitKnown(doc, ["name", "description", "developer_instructions", "model"]),
  },
};
```

For Codex MCP, accept stdio `command/args/env/env_vars` and streamable HTTP `url/bearer_token_env_var/http_headers/env_http_headers`; environment-variable names become references, not values. For OpenCode, map local `command: string[]` and remote `url/headers` forms. Never execute commands, expand environment variables, fetch instruction URLs, or connect to MCP servers.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run packages/adapters && pnpm --filter @ai-config-hub/adapters typecheck`

Expected: all four adapter suites pass with four resource kinds, malformed fixtures and secret scans.

```bash
git add packages/adapters
git commit -m "feat(adapters): read Codex and OpenCode assets"
```

### Task 6: Create the complete SQLite schema and safe database bootstrap

**Files:**
- Create: `packages/storage/src/schema.ts`
- Create: `packages/storage/src/database.ts`
- Create: `packages/storage/src/migrations.ts`
- Create: `packages/storage/src/migrations/0001-initial.sql`
- Create: `packages/storage/src/database.test.ts`
- Modify: `packages/storage/src/index.ts`

- [ ] **Step 1: Write schema and pragma tests**

Open a temporary database and assert the exact architecture table catalog:

```ts
expect(listTables(db)).toEqual([
  "asset_references", "assets", "backups", "database_backups",
  "deployment_locks", "deployment_operations", "deployments", "diagnostics",
  "projects", "recovery_locks", "scan_runs", "schema_migrations",
  "scopes", "settings", "tools",
]);
expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
```

Also test each documented unique/check/foreign-key delete behavior, disabled extension loading, a changed applied-migration checksum, and an upgrade attempt without a verified online backup.

- [ ] **Step 2: Run the database test and confirm missing schema/bootstrap**

Run: `pnpm exec vitest run packages/storage/src/database.test.ts`

Expected: FAIL because no database module or migration exists.

- [ ] **Step 3: Implement all 15 tables and scan staging**

Use Drizzle `sqliteTable` declarations for every table in `docs/architecture/data-storage.md`, preserving surrogate IDs, stable-domain unique keys, foreign keys, checks and indexes. The SQL migration creates the same schema in `STRICT` mode. Internal staging tables are temporary and keyed by `scan_run_id`; they mirror tools/projects/scopes/assets/references/diagnostics payloads without becoming query sources.

Open `DatabaseSync` with `allowExtension: false`, `defensive: true`, `enableForeignKeyConstraints: true`, and `timeout: 5000`, then execute and verify:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

For an empty database, apply migration 1 transactionally. For every non-empty upgrade, use `node:sqlite` `backup(source, destination)`, chmod the containing directory to `0700` and file to `0600` on POSIX, verify `PRAGMA integrity_check = 'ok'`, hash a manifest and database file, insert a `verified` database backup, then associate it with the `started` migration row. Any failure returns `{ mode: "read_only_recovery", reason, backupId? }` and prevents write repository construction.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run packages/storage/src/database.test.ts && pnpm --filter @ai-config-hub/storage typecheck`

Expected: PASS for new DB, validated upgrade backup, checksum drift and read-only recovery.

```bash
git add packages/storage
git commit -m "feat(storage): add durable SQLite schema and bootstrap"
```

### Task 7: Implement repositories and atomic derived-index replacement

**Files:**
- Create: `packages/storage/src/serialization.ts`
- Create: `packages/storage/src/index-repository.ts`
- Create: `packages/storage/src/task-repository.ts`
- Create: `packages/storage/src/settings-repository.ts`
- Create: `packages/storage/src/deployment-repository.ts`
- Create: `packages/storage/src/repositories.test.ts`
- Modify: `packages/storage/src/index.ts`

- [ ] **Step 1: Write repository atomicity and secret tests**

Seed revision A, stage revision B, inject a constraint failure midway and assert readers still see all of A and none of B. Then commit B and assert the opposite. Close/reopen the DB to prove settings and scan runs persist. Search the database bytes and every JSON column for supplied secret canaries.

```ts
await expect(repository.replaceDerivedIndex(invalidB)).rejects.toThrow();
expect(await repository.listAssets({ limit: 200 })).toEqual(revisionA);
expect(readFileSync(databasePath).includes(Buffer.from(secretCanary))).toBe(false);
```

- [ ] **Step 2: Confirm repository tests fail**

Run: `pnpm exec vitest run packages/storage/src/repositories.test.ts`

Expected: FAIL because the port implementations are missing.

- [ ] **Step 3: Implement transactional repositories**

`IndexRepository.replaceDerivedIndex` opens `BEGIN IMMEDIATE`, validates the entire replacement, deletes only the affected derived rows in FK-safe order, inserts tools/projects/scopes/assets/references/diagnostics, increments a committed snapshot revision, and commits. On any exception it rolls back. Queries never read staging.

`serialization.ts` must parse all DB JSON back through domain Zod schemas and call `assertSecretSafeJson` before every write. Reject objects whose keys match the sensitive-key regex with non-redacted string values. Settings updates use `WHERE revision = expectedRevision`; zero changed rows map to `CONFLICT`. Read-only recovery repository factories expose query methods but every mutation raises `READ_ONLY_RECOVERY`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run packages/storage && pnpm --filter @ai-config-hub/storage typecheck`

Expected: PASS including rollback, reopen, optimistic concurrency and canary scans.

```bash
git add packages/storage
git commit -m "feat(storage): persist atomic indexes and audit state"
```

### Task 8: Implement the cancellable scan orchestration pipeline

**Files:**
- Create: `packages/scanner/src/identity.ts`
- Create: `packages/scanner/src/diagnostics.ts`
- Create: `packages/scanner/src/scan-service.ts`
- Create: `packages/scanner/src/scan-service.test.ts`
- Modify: `packages/scanner/src/index.ts`

- [ ] **Step 1: Write pipeline state, partial success and cancellation tests**

Use fake adapters/repositories to assert the exact phase order, stable IDs across repeated scans, bounded parallel reads, deterministic commit ordering, one rejected file producing `partially_succeeded`, and cancellation before commit preserving the old snapshot. Ensure no repository mutation occurs during discovery/parse.

```ts
expect(events.map((event) => event.type === "phase.changed" && event.payload.to).filter(Boolean))
  .toEqual(["discovering", "reading", "parsing", "validating", "committing", "completed"]);
expect(repository.replaceCalls).toHaveLength(1);
expect(cancelledRepository.replaceCalls).toHaveLength(0);
expect(secondScan.assets.map(({ assetId }) => assetId)).toEqual(firstScanIds);
```

- [ ] **Step 2: Confirm the missing service failure**

Run: `pnpm exec vitest run packages/scanner/src/scan-service.test.ts`

Expected: FAIL because `ScanService` does not exist.

- [ ] **Step 3: Implement detect/discover/read/parse/validate/commit**

Generate stable IDs from length-delimited canonical identity components and product-domain SHA-256, not timestamps:

```ts
stableId("asset", [toolInstallationId, scopeId, canonicalSourcePath, locator]);
stableId("scope", [toolInstallationId, scopeKind, canonicalRootPath]);
```

Sort adapters, installations, candidates and parsed locators before ID generation and persistence. Limit concurrent snapshot/parse work to 16. Check cancellation between candidates, before reads, before parses and immediately before committing. Convert adapter diagnostics to domain diagnostics with stable fingerprints and sanitized evidence. A rejected file increments failed count but does not discard unrelated parsed assets. Validate every assembled record with its Zod schema before one `replaceDerivedIndex` call; only then publish terminal success/partial status.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run packages/scanner && pnpm --filter @ai-config-hub/scanner typecheck`

Expected: PASS for full success, partial success, cancellation, stable identity and deterministic ordering.

```bash
git add packages/scanner
git commit -m "feat(scanner): orchestrate atomic configuration scans"
```

### Task 9: Prove the real four-tool scan and recovery boundaries

**Files:**
- Create: `tests/integration/scan-pipeline.test.ts`
- Create: `tests/integration/storage-recovery.test.ts`
- Create: `docs/implementation/phase-2-evidence.md`
- Modify: `vitest.integration.config.ts`

- [ ] **Step 1: Write failing end-to-end integration tests**

Create a temporary home/project tree containing all 16 tool/resource cells plus malformed and secret-bearing files. Scan into a real SQLite file, close and reopen it, then assert assets/diagnostics counts, stable IDs, scope precedence inputs, no source-file mutation and no canary in DB bytes. Delete the SQLite file, rescan and assert the same derived IDs. Separately inject migration and scan-commit failures to prove read-only recovery and old-index preservation.

- [ ] **Step 2: Run integration tests and record failures**

Run: `pnpm test:integration`

Expected before final fixes: FAIL on any unimplemented matrix cell or persistence boundary.

- [ ] **Step 3: Fix only integration defects and add evidence**

Do not broaden formats during this step. Correct deterministic ordering, fixture mapping, transaction boundaries or sanitizer gaps found by the integration test. Record Node/pnpm versions, migration version/hash, table catalog, adapter matrix counts, test totals, dependency graph result and commands in `phase-2-evidence.md`.

- [ ] **Step 4: Run the complete phase gate**

Run:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm build
git diff --check
```

Expected: every command exits 0; a real fresh database can be deleted and rebuilt from files without modifying them, while non-derived state survives ordinary rescans.

- [ ] **Step 5: Commit phase-two evidence**

```bash
git add tests/integration docs/implementation/phase-2-evidence.md vitest.integration.config.ts
git commit -m "test: verify storage scanner and adapter read paths"
```

## Phase-two completion gate

- All 16 tool/resource read-path cells have valid, malformed, unknown-field, nested-scope and secret-bearing coverage.
- Adapters have no generic filesystem, shell, environment expansion, network fetch, dynamic module or MCP execution capability.
- Scanner cancellation cannot expose a half-built index; parse failures produce stable diagnostics and partial success without hiding successful files.
- A deleted SQLite index is fully reconstructable from source files with stable domain IDs and no file writes.
- Migration upgrades require a verified online backup; failures open read-only recovery and reject every write port.
- SQLite, adapter results, diagnostics, logs and test snapshots contain no supplied secret canary.
