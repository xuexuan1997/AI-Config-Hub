# Linux AppImage full manager design

## Goal

Deliver AI Config Hub `v0.2.0` as a functional Linux x86_64 AppImage that strictly supports glibc 2.28. The desktop application must discover, explain, convert, deploy, verify, version, and roll back Claude Code, Cursor, Codex, and OpenCode Rules, Agents, Skills, and MCP configurations.

The release must be an actual usable manager rather than an installable shell. Existing `v0.1.0` and `v0.1.1` tags and release bytes remain immutable.

## Product scope

The desktop application has five workspaces:

1. **Overview** detects supported tools, selects authorized projects, starts and monitors scans, and summarizes health.
2. **Assets** lists Rules, Agents, Skills, and MCP resources with tool, scope, source, normalized content, references, and diagnostics.
3. **Migration** selects source assets and a target tool, then displays compatibility level, dropped fields, target paths, and structured/text differences.
4. **Deployment** requires explicit confirmation, creates backups, performs atomic writes, rescans, verifies results, and compensates failed operations.
5. **History** lists deployment records, exposes verified rollback actions, and shows local Git snapshot history and diffs.

Settings manage authorized roots, database/backup locations, retention, theme, and local Git snapshot behavior. The MVP does not push or pull remote Git repositories.

## Architecture

The existing pnpm modular monolith remains the system boundary:

- `packages/core` owns domain rules, use-case contracts, plan freshness, and state transitions.
- `packages/adapters` owns tool discovery, parsing, resolution, diagnosis, conversion, deployment drafts, and verification.
- `packages/scanner` owns root-confined reads, scan orchestration, change detection, and index refresh.
- `packages/deployer` owns previews, locks, backup manifests, atomic file operations, verification, compensation, and rollback.
- `packages/git` owns a local snapshot repository, scoped staging, commits, log, and diff. It never performs remote network operations in `v0.2.0`.
- `packages/storage` persists indexes, immutable plans/records, task state, backups, settings, and migrations while files remain the source of truth.
- `packages/api` defines Zod-validated commands, responses, errors, events, preload methods, and a browser-safe client.
- `apps/desktop` contains the Electron main process, constrained preload, React renderer, and electron-builder configuration.

Electron main is the only process with filesystem, SQLite, Git, and controlled subprocess privileges. The renderer has `contextIsolation: true`, sandbox enabled, `nodeIntegration: false`, denied navigation/new-window defaults, and no generic filesystem, shell, SQLite, or IPC surface.

## Core data flows

### Scan and explain

```text
User authorizes project/root
→ adapters discover candidates
→ scanner performs confined stable reads
→ adapters parse and diagnose
→ storage atomically updates indexes
→ effective configuration is resolved with provenance
→ renderer receives validated summaries and detail views
```

A malformed or inaccessible file produces a localized diagnostic and partial scan result rather than terminating unrelated work.

### Convert, preview, and deploy

```text
Select assets and target tool
→ convert normalized resources
→ load current target snapshots
→ create bounded structured/text diff
→ persist immutable plan and source/target hashes
→ user confirms warnings and operations
→ acquire path locks and recheck hashes
→ create permission-restricted backups
→ atomically write operations
→ rescan and verify
→ persist deployment result and local Git snapshot
```

Changed source or target hashes invalidate the plan. The application must not silently regenerate and execute a different plan.

### Rollback

Rollback loads a completed or partially failed deployment record, validates backup hashes and current target state, previews inverse operations, obtains confirmation, restores atomically, rescans, verifies, and records a linked rollback deployment. A restore that cannot be proven safe remains blocked with an exact backup path and recovery instructions.

## Deployment engine

Deployment operations are limited to create, replace, and delete within adapter-approved roots. Each plan records source assets, target snapshots, operations, warnings, required confirmations, plan hash, expiry, and adapter versions.

The executor provides:

- canonical path and symlink confinement;
- per-target locking;
- optimistic source/target hash checks;
- backup-before-mutation with file mode preservation;
- temporary-file write, flush, and atomic rename;
- append-only operation journal;
- reverse-order compensation after a failed batch;
- adapter verification and scan reconciliation;
- redacted logs and stable error codes.

MCP redacted secret values are never materialized into output. Deployments requiring unavailable literal secrets are blocked rather than emitting incomplete configuration.

## Local Git history

AI Config Hub maintains a dedicated local repository under application data. It stores sanitized canonical asset snapshots, deployment manifests, and non-secret metadata. It does not stage arbitrary user project files and does not modify an existing project repository.

Each verified deployment or rollback can create one deterministic commit containing the deployment ID, tool, resource count, and content hashes. Git failures do not undo an already verified file deployment; they produce a visible retryable history error. No remote URL, fetch, pull, or push capability is exposed in `v0.2.0`.

## Desktop application

The main process composes storage, adapters, scanner, deployment, and local Git services. It registers versioned business handlers from `packages/api`, owns application paths, enforces single-instance behavior, and shuts down tasks and databases cleanly.

The preload exposes named methods for scan, asset/effective queries, diagnostics, migration preview, deployment, rollback, history, settings, and task-event subscription. Every payload is validated at the IPC boundary. Event subscriptions return explicit unsubscribe functions and cannot request arbitrary channels.

The React renderer uses a left navigation shell, project/tool filters, task progress surface, sortable asset/diagnostic tables, provenance panels, diff preview, confirmation dialogs, deployment timeline, rollback preview, and local history view. Destructive actions are unavailable until a fresh plan and required acknowledgements exist. Empty, loading, partial, permission-denied, and recovery states are first-class views.

## Error and recovery behavior

Errors include stable code, user-facing message, redacted context, retryability, suggested action, and task/deployment correlation. The UI never exposes raw stack traces or secret-bearing configuration values.

Database migration failure starts a diagnostic read-only recovery mode. Index data may be rebuilt from source files, but deployment history, settings, and backup links are preserved. Incompatible downgrade is rejected before any write.

If deployment compensation is incomplete, new writes to affected paths remain blocked until the user successfully rolls back or explicitly resolves the recorded recovery state. Backup retention never deletes artifacts referenced by unresolved deployments.

## Linux packaging and compatibility

The only desktop artifact for `v0.2.0` is Linux x86_64 AppImage. electron-builder creates the artifact from a pinned Electron/Node toolchain. The build and runtime validation environment has glibc 2.28 and is referenced by immutable image digest in the release workflow.

The packaging pipeline produces:

- `AI-Config-Hub-0.2.0-x86_64.AppImage`;
- `SHA256SUMS`;
- a version manifest containing product, database, asset schema, adapter, Electron, Node, architecture, baseline image, and artifact hashes;
- an SBOM and native dependency inventory;
- ELF interpreter, NEEDED library, RPATH/RUNPATH, and GLIBC/GLIBCXX/CXXABI symbol evidence.

The release blocks any GLIBC requirement above 2.28, unexpected ELF/native addon, absolute build RPATH, missing checksum, or architecture mismatch. A glibc 2.28 x86_64 runtime must launch the AppImage, open the main window, perform a synthetic scan, execute and roll back a temporary deployment, exercise SQLite/native paths, and exit cleanly. FUSE and extract-and-run behavior are recorded.

The tag-triggered release workflow builds and validates the AppImage before creating the GitHub Release. It uploads the exact validated bytes and evidence; it never rebuilds after approval. Existing source-only Release automation is extended rather than creating a second publisher.

## Testing

- Unit tests cover plans, freshness, locks, journals, backup manifests, atomic operations, compensation, rollback, local Git scoping, IPC Schemas, and renderer state transitions.
- Adapter contract tests cover all four tools and four resource kinds for discovery, parsing, resolution, diagnosis, conversion, planning, and verification.
- Integration tests use temporary roots, SQLite databases, backups, and Git repositories for scan-to-deploy-to-rollback flows and injected failures.
- IPC tests prove only named business methods are exposed and malformed messages are rejected.
- Playwright Electron E2E covers first scan, asset inspection, effective provenance, conversion preview, deployment confirmation, verified deployment, history, and rollback.
- Packaging tests inspect AppImage contents, permissions, checksums, version manifest, SBOM, and native binaries.
- Compatibility smoke tests run the final bytes on glibc 2.28 x86_64 and retain logs and evidence with the Release.

## Delivery decomposition

This scope is implemented as four independently reviewable subprojects, in order:

1. **Deployment and rollback:** preview, freshness, backups, atomic execution, verification, compensation, persistence, and integration tests.
2. **Local Git history and application services:** sanitized snapshots, commits/diffs, use-case composition, command handlers, and event/task integration.
3. **Secure Electron desktop:** main/preload boundaries, React workspaces, IPC contracts, and Electron E2E tests.
4. **glibc 2.28 AppImage release:** pinned packaging, compatibility evidence, release assets, checksums, and post-upload verification.

Each subproject must pass its focused tests and the repository-wide gate before the next begins. The final release occurs only after all four are complete; partial milestones are not published as functional desktop releases.

## Acceptance criteria

- A user on glibc 2.28 Linux x86_64 can download, verify, and launch the AppImage without installing Node.js.
- The UI scans and explains configurations for the four supported tools and resource kinds.
- The UI previews compatibility, target files, and bounded diffs before any write.
- Confirmed deployments are backup-first, atomic, drift-protected, verified, and recorded.
- Rollback is previewed, confirmed, verified, and linked to its original deployment.
- Local Git history works without network access and contains no deployable secrets.
- Renderer compromise does not expose generic local privileges.
- CI retains passing unit, integration, IPC, E2E, package, and glibc 2.28 evidence.
- GitHub Release `v0.2.0` includes the AppImage, checksum, manifest, SBOM, compatibility evidence, and release notes.

