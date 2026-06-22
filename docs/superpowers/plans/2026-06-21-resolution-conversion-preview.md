# Effective Resolution, Conversion, and Preview Plan

> Execute task-by-task with TDD and a verification checkpoint after every commit.

**Goal:** Compute explainable effective configuration, convert all four normalized resource kinds across the four built-in tools with honest compatibility semantics, and create immutable drift-bound deployment previews without writing source or target files.

**Architecture:** Adapters continue to own tool precedence, rendering and target paths. Core use cases add stable metadata and enforce domain schemas. The deployer consumes only deployable conversion results, reads target snapshots through constrained ports, creates deterministic operations/diffs/hashes, and persists an immutable plan plus a `planned` record. Redacted non-deployable values block conversion.

## Task 1: Make effective resolution precedence-aware and persist it during scans

- Add adapter contract tests for root-to-target filtering, directory precedence, same-scope override, deterministic steps and resource-kind filtering.
- Implement shared resolution helpers used by all four adapters without branching on tool names in core.
- Add a core `EffectiveConfigService` that derives stable IDs, invokes adapter resolution/diagnostics and validates the complete `EffectiveConfig`.
- Extend `ScanService` to resolve detected installations after parsing and include effective configs in the same atomic replacement.

## Task 2: Render normalized resources into official target formats

- Add pure, deterministic renderers for rule, agent, skill and MCP resources for Claude Code, Cursor, Codex and OpenCode.
- Reject path traversal, absolute relative paths, duplicate outputs and any redacted non-deployable secret.
- Preserve symbolic environment references and never expand environment variables.
- Add golden tests for all 16 target cells and stable content hashes.

## Task 3: Implement honest conversion results

- Declare the conversion matrix in every adapter capability.
- Return `full` when normalized semantics are expressible, `partial` with complete retained/dropped/transformed/warning evidence when target syntax loses extensions, and `unsupported` for non-deployable secrets or unrepresentable transports.
- Derive stable `ConversionResultId` from source hash, target, schema and adapter version.
- Ensure unsupported results contain no outputs and can never cross the deployable type boundary.

## Task 4: Build immutable migration previews

- Add a preview service in `packages/deployer` that loads source assets, invokes target conversion/planning, validates target paths against allowed roots, reads current snapshots, creates create/replace operations and bounded unified diffs, and derives plan/record IDs plus plan hash.
- Persist plan and initial `planned` deployment record in one repository call.
- Detect stale source indexes, target conflicts, duplicate target paths and oversized previews before persistence.

## Task 5: Prove end-to-end preview behavior

- Scan a mixed-tool project, resolve nested effective config, convert representative assets to every target tool and preview create/replace operations.
- Assert preview performs zero file writes, partial conversions require confirmation, redacted MCP values block preview, source/target hashes bind the plan, and reopen returns the identical plan/record.
- Run frozen install, typecheck, lint, unit tests, integration tests, build and diff checks; record Phase 3 evidence.
