# Phase 2 implementation evidence

Recorded on 2026-06-21 for branch `codex/implement-ai-config-hub`.

## Runtime and migration

- Node.js: `v24.14.0`
- pnpm: `11.5.3`
- SQLite migration version: `1` (`initial`)
- Migration checksum: `sha256:b0849bc5455b0d64b34f2ce77f8727e8cdcdc3039943a02da29d797179e5f210`
- SQLite mode: foreign keys enabled, WAL journal, FULL synchronous writes, 5000 ms busy timeout, extension loading permanently disabled, defensive mode enabled.
- Upgrade boundary: a non-empty database is backed up with the Node SQLite Online Backup API; the backup is permission-restricted, integrity-checked and hashed before migration. A failed or drifted migration reopens read-only.

The verified catalog contains exactly these 15 business tables:

`asset_references`, `assets`, `backups`, `database_backups`, `deployment_locks`, `deployment_operations`, `deployments`, `diagnostics`, `projects`, `recovery_locks`, `scan_runs`, `schema_migrations`, `scopes`, `settings`, `tools`.

## Adapter matrix

The real-tree integration fixture proves every read-path cell below. Discovery and parsing are read-only; no adapter receives shell, generic filesystem, environment expansion, network, dynamic module loading or MCP execution capabilities.

| Tool | Rule | Agent | Skill | MCP |
| --- | --- | --- | --- | --- |
| Claude Code | `CLAUDE.md` | `.claude/agents` | `.claude/skills` | `.mcp.json` |
| Cursor | `.cursor/rules`, `AGENTS.md` | `.cursor/agents` | `.cursor/skills`, `.agents/skills` | `.cursor/mcp.json` |
| Codex | `AGENTS.override.md` / `AGENTS.md` precedence | `.codex/agents/*.toml` | `.agents/skills` | `.codex/config.toml` |
| OpenCode | `AGENTS.md`, `CLAUDE.md`, configured local instructions | `.opencode/agents` and config agents | `.opencode/skills` plus compatible skill roots | `opencode.json(c)` |

The fixture also includes nested scope, unknown extension fields, one malformed frontmatter file, symbolic environment references and secret-bearing command arguments, environment values and request headers.

## Atomicity and recovery evidence

- Scan phases are deterministic: discovering, reading, parsing, validating, committing, completed.
- Snapshot and parse concurrency is bounded at 16.
- Stable domain IDs are product-domain SHA-256 values over length-delimited canonical identity parts; deleting SQLite and rescanning the same files yields identical asset IDs.
- A malformed file produces a stable diagnostic and `partially_succeeded`; unrelated assets remain available.
- Cancellation immediately before commit produces no repository mutation.
- Derived-index replacement uses one `BEGIN IMMEDIATE` transaction. Validation or constraint failure preserves the previous queryable snapshot.
- Public settings use revision-based compare-and-set. Task progress, deployment plans and deployment records survive reopen.
- Read-only recovery repositories permit queries and reject all mutations with `READ_ONLY_RECOVERY`.
- Source-file hashes are identical before and after a real four-tool scan and rebuild.
- The supplied `top-secret-canary` does not appear in serialized adapter results or the closed SQLite database bytes.

## Phase gate

All commands completed successfully with the bundled Node 24 runtime:

```text
pnpm install --frozen-lockfile  # lockfile unchanged
pnpm typecheck                 # root plus all workspace packages passed
pnpm lint                      # ESLint, Prettier, dependency graph passed
pnpm test                      # 27 files, 95 tests passed
pnpm test:integration          # 2 files, 2 tests passed
pnpm build                     # all 10 buildable workspace projects passed
git diff --check               # clean
```

Coverage from `pnpm test`: 83.46% statements, 70.45% branches, 79.79% functions and 85.89% lines. Dependency Cruiser reported no violations across 91 modules and 228 dependencies.
