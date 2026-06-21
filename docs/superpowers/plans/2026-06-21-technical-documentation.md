# AI Config Hub Technical Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a complete, internally consistent technical documentation set under `docs/` for implementing, testing, securing, packaging, and operating the AI Config Hub MVP.

**Architecture:** The documentation describes a TypeScript pnpm Monorepo with an Electron/React desktop application, a standalone Node.js CLI, shared domain packages, compile-time tool adapters, SQLite indexing, and guarded deployment workflows. Each document owns one concern and links back to the confirmed design and PRD.

**Tech Stack:** TypeScript strict mode, Node.js LTS, Electron, React, Vite, pnpm workspace, SQLite, Drizzle ORM, Zod, Commander.js, Pino, Chokidar, Vitest, Playwright, electron-builder.

---

## Planned Documentation Structure

```text
docs/
  README.md
  PRD.md
  architecture/
    overview.md
    domain-model.md
    adapter-system.md
    data-storage.md
    api-and-ipc.md
    security.md
  development/
    repository-and-tooling.md
    testing-strategy.md
  operations/
    build-release-and-compatibility.md
    observability-and-recovery.md
  adr/
    0001-modular-monolith.md
    0002-electron-security-boundary.md
    0003-files-as-source-of-truth.md
  superpowers/
    specs/2026-06-21-technical-solution-design.md
    plans/2026-06-21-technical-documentation.md
```

## Documentation Conventions

- Use Simplified Chinese for explanatory text and English for code identifiers.
- Begin each document with purpose, audience, status, and links to related documents.
- Use Mermaid only when it makes component, sequence, or trust relationships clearer.
- Define each important term once in `domain-model.md`; other documents link to it.
- Mark MVP scope explicitly and place future evolution in a final, separate section.
- Never include real tokens, home-directory usernames, or private repository addresses.
- Keep commands runnable from the repository root.

### Task 1: Create the documentation index and navigation contract

**Files:**
- Create: `docs/README.md`
- Reference: `docs/PRD.md`
- Reference: `docs/superpowers/specs/2026-06-21-technical-solution-design.md`

- [ ] **Step 1: Write the index metadata and audience guidance**

Create `docs/README.md` with these exact top-level sections:

```markdown
# AI Config Hub 技术文档

## 阅读指南
## 文档地图
## 核心技术约束
## 文档状态
## 维护规则
```

State that the primary readers are application engineers, adapter authors, test engineers, release engineers, and security reviewers.

- [ ] **Step 2: Add the document map**

Add one table row for every planned document. Columns must be `文档`, `主要问题`, `目标读者`, and `状态`. Use relative Markdown links from `docs/README.md`.

- [ ] **Step 3: Record the invariant constraints**

List TypeScript-only implementation, Electron desktop, standalone CLI, three operating systems, glibc 2.28, read-first behavior, no third-party configuration execution, files as the source of truth, and shared core behavior.

- [ ] **Step 4: Validate links and headings**

Run:

```bash
rg -n '^#|\]\(' docs/README.md
```

Expected: six declared headings and links to every planned document.

- [ ] **Step 5: Commit the documentation index**

```bash
git add docs/README.md
git commit -m "docs: add technical documentation index"
```

### Task 2: Document the system architecture and runtime topology

**Files:**
- Create: `docs/architecture/overview.md`
- Modify: `docs/README.md`
- Reference: `docs/superpowers/specs/2026-06-21-technical-solution-design.md`

- [ ] **Step 1: Define architecture goals and context**

Create the document with sections `架构目标`, `系统上下文`, `模块化单体`, `运行时拓扑`, `包依赖规则`, `关键数据流`, `扩展边界`, and `架构验收检查表`.

- [ ] **Step 2: Add the system context diagram**

Include a Mermaid flowchart showing the user, Electron desktop, CLI, core use cases, four tool adapters, local configuration files, SQLite, Git repositories, and the operating system. Show that desktop and CLI converge on the same core use cases.

- [ ] **Step 3: Add the runtime topology diagram**

Show the Electron renderer, preload boundary, main process, core packages, SQLite, file system, and Git. Label IPC as validated business commands and prohibit a renderer-to-file-system edge.

- [ ] **Step 4: Define package dependency direction**

Document allowed dependencies: apps depend on API/use cases; use cases depend on domain interfaces; infrastructure implements interfaces; adapters depend on shared contracts; `shared` must not depend on application packages. Add a rule forbidding cross-package internal imports.

- [ ] **Step 5: Verify architecture vocabulary and commit**

Run:

```bash
rg -n 'Electron|CLI|glibc 2\.28|contextIsolation|nodeIntegration|模块化单体' docs/architecture/overview.md
git diff --check
```

Expected: every required constraint appears and `git diff --check` exits with status 0.

```bash
git add docs/architecture/overview.md docs/README.md
git commit -m "docs: describe system architecture"
```

### Task 3: Define the domain model and lifecycle states

**Files:**
- Create: `docs/architecture/domain-model.md`
- Modify: `docs/README.md`
- Reference: `docs/PRD.md`

- [ ] **Step 1: Define the ubiquitous language**

Create sections for `Tool`, `Resource`, `Scope`, `Asset`, `EffectiveConfig`, `Diagnostic`, `ConversionResult`, `DeploymentPlan`, and `DeploymentRecord`. For each term, document responsibility, identity, required attributes, invariants, and relationships.

- [ ] **Step 2: Define compatibility semantics**

Specify three conversion levels: `full`, `partial`, and `unsupported`. Define that `partial` must list retained fields, dropped fields, transformed fields, and user-visible warnings.

- [ ] **Step 3: Define lifecycle state machines**

Add Mermaid state diagrams for scan tasks and deployment tasks. Deployment states must include `planned`, `confirmed`, `backed_up`, `writing`, `verifying`, `succeeded`, `failed`, `rolling_back`, and `rolled_back`.

- [ ] **Step 4: Define hashing, identity, and versioning**

Document stable asset identity, source path normalization, content hashing, normalized Schema version, adapter version, and why file hashes are used for optimistic concurrency rather than as permanent asset IDs.

- [ ] **Step 5: Verify term coverage and commit**

Run:

```bash
for term in Tool Resource Scope Asset EffectiveConfig Diagnostic ConversionResult DeploymentPlan DeploymentRecord; do rg -q "$term" docs/architecture/domain-model.md || exit 1; done
git diff --check
```

Expected: exit status 0.

```bash
git add docs/architecture/domain-model.md docs/README.md
git commit -m "docs: define the core domain model"
```

### Task 4: Specify the tool adapter system

**Files:**
- Create: `docs/architecture/adapter-system.md`
- Modify: `docs/README.md`
- Reference: `docs/architecture/domain-model.md`

- [ ] **Step 1: Document adapter responsibilities and exclusions**

Define detection, discovery, parsing, effective configuration resolution, diagnosis, conversion, deployment planning, and verification. State that adapters do not own UI, persistence transactions, Git credentials, or arbitrary script execution.

- [ ] **Step 2: Publish the TypeScript contract**

Include complete signatures for `ToolAdapter`, all method context/result types referenced by it, `AdapterCapabilities`, and `AdapterRegistration`. Use discriminated unions for resource types and conversion levels.

- [ ] **Step 3: Define compile-time registration and version negotiation**

Document a static adapter registry keyed by tool ID. Explain tool-version detection, supported-version ranges, adapter Schema versions, and the diagnostic returned for an unknown newer tool version.

- [ ] **Step 4: Add the adapter execution sequence**

Add a Mermaid sequence diagram from scan request through registry selection, discovery, parsing, core normalization, diagnosis, persistence, and result publication.

- [ ] **Step 5: Define adapter conformance and commit**

List required fixture suites for Claude Code, Cursor, Codex, and OpenCode, including valid, malformed, nested-scope, unknown-field, sensitive-value, and version-boundary cases.

```bash
rg -n 'interface ToolAdapter|Claude Code|Cursor|Codex|OpenCode|unsupported' docs/architecture/adapter-system.md
git diff --check
git add docs/architecture/adapter-system.md docs/README.md
git commit -m "docs: specify the adapter system"
```

### Task 5: Specify storage, scanning, and change detection

**Files:**
- Create: `docs/architecture/data-storage.md`
- Modify: `docs/README.md`
- Reference: `docs/architecture/domain-model.md`

- [ ] **Step 1: Define ownership of data**

State that configuration files are authoritative and SQLite stores indexes, normalized data, diagnostics, tasks, deployment history, and backup metadata. Define when source text may be cached and how sensitive fields are removed.

- [ ] **Step 2: Define the logical SQLite Schema**

Document tables and key relations for `tools`, `projects`, `scopes`, `assets`, `asset_references`, `diagnostics`, `scan_runs`, `deployments`, `deployment_operations`, `backups`, and `schema_migrations`. Include primary keys, important unique constraints, foreign-key deletion behavior, and indexes used by list and resolution queries.

- [ ] **Step 3: Define transaction boundaries**

Describe WAL mode, scan-run staging, atomic index replacement, migration startup behavior, read-only recovery after migration failure, and the separation between database transactions and file-system compensation logs.

- [ ] **Step 4: Define file watching and drift detection**

Describe Chokidar event debouncing, event coalescing, normalized paths, deployment-originated event suppression, incremental rescans, content hash comparison, and overflow recovery through a full rescan.

- [ ] **Step 5: Verify storage invariants and commit**

```bash
rg -n '事实来源|WAL|外键|哈希|Chokidar|只读恢复' docs/architecture/data-storage.md
git diff --check
git add docs/architecture/data-storage.md docs/README.md
git commit -m "docs: specify storage and scanning"
```

### Task 6: Define API, IPC, CLI, and long-running task semantics

**Files:**
- Create: `docs/architecture/api-and-ipc.md`
- Modify: `docs/README.md`
- Reference: `docs/architecture/overview.md`

- [ ] **Step 1: Define API design rules**

Document business-level commands, Zod validation at both IPC edges, stable error envelopes, command versioning, and the prohibition on generic file-system and shell-execution endpoints.

- [ ] **Step 2: Define the command catalog**

For every command below, document purpose, request fields, response fields, failure codes, authorization boundary, and emitted events:

```text
scan.start
scan.status
scan.cancel
assets.list
assets.get
effective.resolve
diagnostics.list
migration.preview
deployment.execute
deployment.rollback
history.list
settings.get
settings.update
```

- [ ] **Step 3: Define long-running task behavior**

Specify task IDs, progress counters, phase names, event ordering, reconnect behavior, cancellation points, partial success, and why deployment cannot be cancelled after atomic writing starts.

- [ ] **Step 4: Map CLI commands to use cases**

Define `ai-config-hub scan`, `assets`, `effective`, `diagnose`, `migrate --dry-run`, `deploy`, `rollback`, and `history`. For each, provide a human-readable output example and a stable `--json` response shape.

- [ ] **Step 5: Validate command coverage and commit**

```bash
for command in scan.start scan.status scan.cancel assets.list assets.get effective.resolve diagnostics.list migration.preview deployment.execute deployment.rollback history.list settings.get settings.update; do rg -q "$command" docs/architecture/api-and-ipc.md || exit 1; done
git diff --check
git add docs/architecture/api-and-ipc.md docs/README.md
git commit -m "docs: define API IPC and CLI contracts"
```

### Task 7: Produce the security and threat-model document

**Files:**
- Create: `docs/architecture/security.md`
- Modify: `docs/README.md`
- Reference: `docs/architecture/api-and-ipc.md`

- [ ] **Step 1: Define assets, actors, and trust boundaries**

Identify local configuration, secrets, Git credentials, backups, logs, database records, and deployment targets. Add a Mermaid trust-boundary diagram covering renderer, preload, main process, core, local files, Git, and external URLs.

- [ ] **Step 2: Create the threat table**

Include path traversal, symbolic-link escape, renderer compromise, malicious configuration text, command injection, secret leakage, stale-preview overwrite, backup exposure, dependency compromise, and untrusted Git content. Columns must be `威胁`, `入口`, `影响`, `预防`, `检测`, and `恢复`.

- [ ] **Step 3: Define Electron hardening**

Require `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer where compatible, navigation denial, window-open interception, protocol allowlisting, strict preload exports, content security policy, and no remote module.

- [ ] **Step 4: Define file and secret handling**

Specify canonical-path checks, allowed roots, symbolic-link handling, least-privilege permissions, log allowlists, case-insensitive secret-key detection, backup permissions, and the rule that third-party configurations are never executed during scanning.

- [ ] **Step 5: Validate controls and commit**

```bash
rg -n 'contextIsolation|nodeIntegration|符号链接|目录逃逸|命令注入|密钥|CSP|不执行' docs/architecture/security.md
git diff --check
git add docs/architecture/security.md docs/README.md
git commit -m "docs: add security architecture and threat model"
```

### Task 8: Document repository conventions and developer workflows

**Files:**
- Create: `docs/development/repository-and-tooling.md`
- Modify: `docs/README.md`
- Reference: `docs/architecture/overview.md`

- [ ] **Step 1: Define repository layout and package ownership**

Describe every `apps/*` and `packages/*` directory, public entrypoints, dependency direction, naming conventions, and locations for unit, integration, fixture, and end-to-end tests.

- [ ] **Step 2: Define baseline scripts**

Specify the intended root commands and their responsibilities:

```text
pnpm install
pnpm dev
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm package
```

State that these commands become enforceable once project scaffolding is implemented.

- [ ] **Step 3: Define TypeScript and dependency rules**

Require strict mode, explicit package exports, no implicit `any`, no deep cross-package imports, shared Schema-derived types, pinned package-manager version, lockfile review, and a review requirement for native dependencies.

- [ ] **Step 4: Define contribution workflow**

Document branch naming, conventional commit categories, required checks, adapter fixture updates, database migration review, and security review triggers.

- [ ] **Step 5: Verify commands and commit**

```bash
for command in dev build typecheck lint test test:integration test:e2e package; do rg -q "pnpm $command" docs/development/repository-and-tooling.md || exit 1; done
git diff --check
git add docs/development/repository-and-tooling.md docs/README.md
git commit -m "docs: define repository and tooling conventions"
```

### Task 9: Document testing and quality gates

**Files:**
- Create: `docs/development/testing-strategy.md`
- Modify: `docs/README.md`
- Reference: `docs/architecture/adapter-system.md`
- Reference: `docs/architecture/security.md`

- [ ] **Step 1: Define the test pyramid and ownership**

Document unit, adapter contract, integration, IPC contract, end-to-end, packaging, and compatibility tests. State which package owns each test type and which failures block merging or release.

- [ ] **Step 2: Define fixture and golden-file policy**

Require synthetic or irreversibly anonymized fixtures, readable fixture intent, expected normalized outputs, explicit golden-file review, and cases for malformed and malicious input.

- [ ] **Step 3: Define critical behavior matrices**

Add matrices for the four tools by four resource types, Windows/macOS/Linux, scan outcomes, conversion levels, and deployment/rollback failure injection points.

- [ ] **Step 4: Define release quality gates**

Require typecheck, lint, unit, adapter contract, integration, IPC contract, Electron end-to-end, package installation, glibc 2.28 startup, migration upgrade, rollback, and secret-redaction checks.

- [ ] **Step 5: Validate matrix coverage and commit**

```bash
rg -n 'Claude Code|Cursor|Codex|OpenCode|Windows|macOS|Linux|glibc 2\.28|回滚|脱敏' docs/development/testing-strategy.md
git diff --check
git add docs/development/testing-strategy.md docs/README.md
git commit -m "docs: define testing strategy and quality gates"
```

### Task 10: Document build, release, and compatibility engineering

**Files:**
- Create: `docs/operations/build-release-and-compatibility.md`
- Modify: `docs/README.md`
- Reference: `docs/development/testing-strategy.md`

- [ ] **Step 1: Define release artifacts**

Document Windows installer, macOS installer, Linux AppImage, Linux archive, standalone CLI, checksums, release notes, and version manifest.

- [ ] **Step 2: Define the CI release pipeline**

Describe source validation, dependency installation, static checks, test stages, three-platform builds, signing/notarization hooks, package installation tests, checksum generation, and publication approval.

- [ ] **Step 3: Define glibc 2.28 controls**

Specify the baseline build image, forbidden higher-baseline native binaries, native dependency audit, runtime symbol inspection, Linux Electron startup test, CLI smoke test, and retention of compatibility evidence per release.

- [ ] **Step 4: Define versioning and migration policy**

Document SemVer, database migration compatibility, asset Schema versions, adapter versions, rollback compatibility, supported upgrade paths, and how incompatible downgrades are blocked with a clear error.

- [ ] **Step 5: Validate release coverage and commit**

```bash
rg -n 'AppImage|校验和|签名|notar|glibc 2\.28|SemVer|迁移|降级' docs/operations/build-release-and-compatibility.md
git diff --check
git add docs/operations/build-release-and-compatibility.md docs/README.md
git commit -m "docs: define build release and compatibility"
```

### Task 11: Document observability, backup, and operational recovery

**Files:**
- Create: `docs/operations/observability-and-recovery.md`
- Modify: `docs/README.md`
- Reference: `docs/architecture/data-storage.md`
- Reference: `docs/architecture/security.md`

- [ ] **Step 1: Define local observability**

Document Pino log levels, structured fields, correlation IDs, rolling-file retention, path shortening, sensitive-field allowlists, diagnostic export, and the default no-telemetry policy.

- [ ] **Step 2: Define backup and retention behavior**

Specify backup directory layout, manifest contents, file permissions, retention count and age policy, cleanup rules, backup verification, and how a deployment record links to backup artifacts.

- [ ] **Step 3: Define recovery runbooks**

Provide ordered runbooks for failed database migration, interrupted scan, failed deployment before replacement, failed deployment after partial replacement, failed verification, corrupted index, missing backup, and Git synchronization conflict.

- [ ] **Step 4: Define support bundles**

Specify that support bundles are generated only on user request, contain version metadata and redacted diagnostics, exclude configuration content and credentials by default, and show an exact preview before export.

- [ ] **Step 5: Verify recovery coverage and commit**

```bash
rg -n 'correlation|滚动|遥测|备份|迁移失败|部分写入|支持包|脱敏' docs/operations/observability-and-recovery.md
git diff --check
git add docs/operations/observability-and-recovery.md docs/README.md
git commit -m "docs: add observability and recovery runbooks"
```

### Task 12: Record the foundational architecture decisions

**Files:**
- Create: `docs/adr/0001-modular-monolith.md`
- Create: `docs/adr/0002-electron-security-boundary.md`
- Create: `docs/adr/0003-files-as-source-of-truth.md`
- Modify: `docs/README.md`

- [ ] **Step 1: Write ADR 0001**

Use sections `状态`, `背景`, `决策`, `备选方案`, `后果`, and `复审条件`. Record the choice of a TypeScript pnpm modular Monorepo over a dynamic plugin microkernel and multiple local services.

- [ ] **Step 2: Write ADR 0002**

Record that the Electron main process owns privileged operations, the renderer uses validated business IPC through preload, and generic file-system or shell APIs are prohibited.

- [ ] **Step 3: Write ADR 0003**

Record that configuration files remain authoritative while SQLite is a rebuildable index and history store. Explain the consequences for scanning, drift detection, recovery, and deletion behavior.

- [ ] **Step 4: Link ADRs from the documentation index and related architecture pages**

Add reciprocal relative links so each ADR points to the affected architecture document and the architecture document points back to the ADR.

- [ ] **Step 5: Validate ADR structure and commit**

```bash
for file in docs/adr/0001-modular-monolith.md docs/adr/0002-electron-security-boundary.md docs/adr/0003-files-as-source-of-truth.md; do
  for heading in 状态 背景 决策 备选方案 后果 复审条件; do
    rg -q "^## $heading$" "$file" || exit 1
  done
done
git diff --check
git add docs/adr docs/README.md docs/architecture
git commit -m "docs: record foundational architecture decisions"
```

### Task 13: Perform whole-set consistency and completeness review

**Files:**
- Modify: any technical document created in Tasks 1–12 when a concrete inconsistency is found
- Reference: `docs/PRD.md`
- Reference: `docs/superpowers/specs/2026-06-21-technical-solution-design.md`

- [ ] **Step 1: Check required files**

Run:

```bash
for file in \
  docs/README.md \
  docs/architecture/overview.md \
  docs/architecture/domain-model.md \
  docs/architecture/adapter-system.md \
  docs/architecture/data-storage.md \
  docs/architecture/api-and-ipc.md \
  docs/architecture/security.md \
  docs/development/repository-and-tooling.md \
  docs/development/testing-strategy.md \
  docs/operations/build-release-and-compatibility.md \
  docs/operations/observability-and-recovery.md \
  docs/adr/0001-modular-monolith.md \
  docs/adr/0002-electron-security-boundary.md \
  docs/adr/0003-files-as-source-of-truth.md; do
  test -s "$file" || exit 1
done
```

Expected: exit status 0.

- [ ] **Step 2: Check scope and terminology consistency**

Confirm all documents consistently state TypeScript, Electron, standalone CLI, four tools, four MVP resource types, three platforms, glibc 2.28, files as source of truth, compile-time adapters, and SQLite as a local index.

- [ ] **Step 3: Check internal links**

Run a local Markdown link checker if already available. If no checker is installed, extract relative links and verify every referenced local path from the linking document's directory without adding a new dependency.

- [ ] **Step 4: Check formatting and unsafe examples**

Run:

```bash
git diff --check
rg -n 'BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}' docs && exit 1 || true
```

Expected: no whitespace errors and no credential-like examples.

- [ ] **Step 5: Review the final diff and commit corrections**

```bash
git status --short
git diff --stat
git diff -- docs
git add docs/README.md docs/architecture docs/development docs/operations docs/adr
git commit -m "docs: complete technical documentation set"
```

Expected: the diff contains only intended documentation changes; the pre-existing PRD remains unchanged unless a confirmed factual correction is required.
