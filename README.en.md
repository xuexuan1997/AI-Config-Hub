# AI Config Hub

Language: [简体中文](./README.md) | English

AI Config Hub is a local-first configuration workbench for AI coding tools. It uses one domain model to scan, diagnose, explain, and migrate Rules, Agents, Skills, and MCP configuration across Claude Code, Cursor, Codex, and OpenCode. The current product experience is centered on the Electron desktop app: choose a project and review assets, choose source and target projects for migration, preview writes, then explicitly confirm before verified configuration files are written.

### Problems It Solves

Choosing an AI coding tool is rarely a one-time decision. A Claude Code account being banned, OpenCode introducing a cheaper Go plan, Cursor plans feeling expensive, or even a single top-down company decision can force teams to jump back and forth between IDEs and AI coding tools. Many users also run multiple IDEs at the same time to compare models, agents, rules, MCP integrations, and workflows. When they need to carry previous configuration, prompt assets, and project knowledge into another tool, each product's directory layout, file format, inheritance rules, and disable mechanism make manual migration complex and error-prone.

Another common problem is figuring out why an AI IDE unexpectedly invokes a tool in a specific directory. The cause is often not random model behavior, but a tool-specific configuration loading mechanism: for example, Claude Code may load asset configuration from multiple directory levels, while Cursor, Codex, and OpenCode each have their own scopes, precedence, and ignore rules. Without deep knowledge of the IDE, it is hard to locate which asset was loaded and from which path; after locating it, safely disabling it and confirming the final effective configuration becomes another debugging task.

### Solution Overview

AI Config Hub scans Rules, Agents, Skills, and MCP configuration scattered across different IDEs and directory levels into one reviewable asset model. It explains each asset's source path, scope, load state, contributor relationships, and diagnostics. During migration, it first produces a cross-tool conversion preview that shows which fields will be preserved, transformed, or dropped, then uses hash checks, drift detection, backups, verification, and rollback to help users safely migrate and govern configuration across Claude Code, Cursor, Codex, and OpenCode.

It is not a simple file sync tool. Before writing, AI Config Hub surfaces target impact, field loss, hash snapshots, drift risk, and required confirmations, then reduces migration risk through backups, verification, history records, and rollback APIs.

### Current Experience

The desktop app is the most complete UX entry point today. Its sidebar has three workspaces:

- **Asset Review**: select a current project and scan automatically; filter Rules, Agents, Skills, and MCP assets by tool and resource type; review logical keys, source directories, load state, diagnostic counts, and asset detail.
- **Asset Migration**: choose source and target projects independently, select source assets, target tool, and conflict policy, create a write preview, then confirm hashes, field loss, overwrite/delete risks, and execute the migration.
- **Settings**: configure theme and language, including system, light, dark, English, and Simplified Chinese.

The asset detail dialog can open the source file, enable or disable an asset, load effective configuration, and show normalized content, references, contributors, ignored assets, and effective diagnostics. The migration page shows difference summaries, target file changes, retained/dropped/transformed fields, source drift, source/target hash snapshots, and task execution status.

### Visual Overview

#### Feature Flow

![AI Config Hub feature flow](./docs/readme/assets/feature-flow.svg)

#### Current Desktop Workflow

The screenshots come from the desktop review and migration flow and are cropped so the local path bar is not shown.

| Asset review                                                                                 | Migration preview                                                                                            | Settings                                                                                   |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| <img src="./docs/readme/assets/desktop-assets.png" alt="Asset review interface" width="300"> | <img src="./docs/readme/assets/desktop-migration-preview.png" alt="Migration preview interface" width="300"> | <img src="./docs/readme/assets/desktop-settings.png" alt="Settings interface" width="300"> |

#### Architecture Overview

![AI Config Hub architecture overview](./docs/readme/assets/architecture.svg)

### Implemented Capabilities

- Multi-tool scanning for Claude Code, Cursor, Codex, and OpenCode Rules, Agents, Skills, and MCP assets.
- Unified asset model that normalizes tool-specific files into `rule`, `agent`, `skill`, and `mcp` resources while preserving source, scope, hash, and diagnostic evidence.
- Asset review by tool, resource type, scope, and diagnostics, with source opening, enable/disable controls, and diagnostic location.
- Effective configuration explanation for contributors, inheritance, merge, override, ignored assets, and effective diagnostics.
- Diagnostics and reports for parsing, compatibility, permissions, conflicts, literal secret risk, drift, deployment, and verification; the CLI can export diagnostics.
- Migration previews with plans, diffs, compatibility results, field loss, source/target hashes, and target impact.
- Controlled deployment from a fresh preview plan hash, with required confirmations for overwrite, partial conversion, and delete risks.
- Recovery evidence through CLI and API support for deployment/rollback history, rollback execution, task events, and local Git snapshot evidence.
- Settings and localization for desktop theme, language, settings revisions, English, and Simplified Chinese.
- Multiple entry points: the desktop app for the main interactive workflow, the CLI for automation and audit, and the local Web UI for Local API connection, scanning, asset listing, and task events.

See [docs/implementation/phase-status.md](./docs/implementation/phase-status.md) for the current implementation status. Diagnostics, conversion, deployment, the central asset library, Git asset repository primitives, Local API, local Web UI, and three-platform packaging are covered for the current tracked scope; team identity, approval flows, hosted collaboration services, and online sharing markets remain outside the MVP boundary.

### CLI

The CLI exposes the same core use cases as the desktop app and is useful for scripting, CI checks, and audit:

```bash
ai-config-hub scan <roots...>
ai-config-hub assets list --tool claude-code
ai-config-hub assets get <asset-id> --include normalized --include diagnostics
ai-config-hub effective --tool claude-code --project <project-id> --scope <scope-id>
ai-config-hub diagnose --severity error
ai-config-hub diagnose export --format markdown
ai-config-hub migrate --dry-run --asset <asset-id> --to cursor --scope <target-scope>
ai-config-hub deploy <plan-id> --plan-hash <hash> --yes
ai-config-hub history --kind deployment
ai-config-hub rollback <deployment-id> --yes
```

All major CLI commands support `--json`. `migrate` only creates a preview plan; actual writes must be explicitly confirmed through `deploy`.

### Local API And Web UI

`packages/local-api` provides a local HTTP/SSE API with authentication and origin restrictions. `apps/web` is a lightweight Local API client for entering a local API URL and token, starting scans, refreshing assets, and viewing task events. The complete review and migration workflow lives in the desktop app.

### Design Principles

- Local configuration files remain the source of truth; SQLite stores only rebuildable indexes, normalized results, diagnostics, and operation records.
- Scans are read-only by default and do not execute Skills, Hooks, MCP commands, or third-party scripts referenced by configuration.
- Writes must go through conversion, diff preview, user confirmation, drift checks, backups, atomic writes, rescan verification, and rollback on failure.
- Tool-specific behavior is isolated inside adapters, while the CLI, desktop app, and Local API share the same core use cases and error semantics.
- The Electron renderer cannot access the filesystem, SQLite, Git, or shell directly; it only calls business-level APIs through an allowlisted preload IPC bridge.

### Development Setup

This project requires Node.js `>=24 <25` and declares `pnpm@11.5.3` as its package manager. Use `fnm` to pin the local Node version:

```bash
fnm install 24
fnm use 24
node --version
```

Enable Corepack and install dependencies:

```bash
corepack enable
corepack prepare pnpm@11.5.3 --activate
pnpm install --frozen-lockfile
```

If Vitest, Vite, Rolldown, or other tooling fails with missing modern `node:*` exports, first confirm the active shell is using Node 24:

```bash
node --version
pnpm --version
```

### Common Commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Additional scripts:

```bash
pnpm dev
pnpm test:integration
pnpm test:e2e
pnpm package
pnpm package:macos:arm64
pnpm package:windows:x64
pnpm package:linux:x64
```

### Repository Structure

- `packages/shared`: cross-layer primitives such as stable IDs, paths, hashes, and redacted errors.
- `packages/core`: contracts for normalized assets, scopes, effective configuration, diagnostics, conversion, deployment, and tasks.
- `packages/api`: versioned commands, IPC envelopes, event protocols, and browser-safe clients.
- `packages/adapters`: tool adapters for Claude Code, Cursor, Codex, and OpenCode.
- `packages/scanner`: safe reads, hashing, scan orchestration, and incremental change detection.
- `packages/deployer`: diffs, drift checks, backups, atomic writes, verification, and rollback.
- `packages/storage`: SQLite repositories, migrations, and transaction boundaries.
- `packages/git`: local Git snapshots, history, and recovery evidence.
- `packages/asset-library`: personal central asset library, Presets, and asset source tracking.
- `packages/local-api`: local HTTP/SSE API, authentication, and origin restrictions.
- `apps/cli`: Node.js CLI over the shared core use cases.
- `apps/desktop`: Electron + React desktop application.
- `apps/web`: local Web UI that reaches core capabilities through the Local API.

### Documentation

- [Architecture overview](./docs/architecture/overview.md)
- [Domain model](./docs/architecture/domain-model.md)
- [Adapter system](./docs/architecture/adapter-system.md)
- [API and IPC](./docs/architecture/api-and-ipc.md)
- [Security design](./docs/architecture/security.md)
- [Implementation status](./docs/implementation/phase-status.md)
