# Phase 3 implementation evidence: diagnostics

Recorded on 2026-06-29 for the local `main` branch.

## PRD scope

PRD Phase 3 covers file-format diagnostics, directory diagnostics, hierarchy diagnostics, reference diagnostics, MCP security diagnostics, content-drift diagnostics, and report export.

## Current status

Complete for the current MVP scope.

The implementation provides adapter-level diagnostics for malformed configuration files, configuration roots outside allowed directories, hierarchy/precedence issues, missing skill references, MCP secret risks, non-deployable MCP secrets, and ignored resources. Preview and execution paths block source or target hash drift before writes. Diagnostic list and export APIs support JSON and Markdown output with task/project/tool/severity/time filters and path/secret redaction.

## Test evidence

| Evidence | Coverage |
| --- | --- |
| `packages/adapters/src/verification.test.ts` | Adapter diagnosis and verification diagnostics, including generated target validation and drift cases |
| `packages/scanner/src/scan-service.test.ts` | Scanner diagnostic normalization, partial success behavior, cancellation before commit, incremental changed-path diagnostics |
| `packages/api/src/diagnostic-report.test.ts` | JSON and Markdown diagnostic report rendering, redaction, filters |
| `packages/api/src/commands.test.ts` | Diagnostic command schema and handler mapping |
| `apps/cli/src/cli.test.ts` and `apps/cli/src/app-services.test.ts` | CLI diagnostic list/export command behavior |
| `apps/desktop/src/main/composition.test.ts` | Desktop diagnostic command service wiring and task-scoped evidence |

## Not claimed

This document does not claim future custom-tool diagnostics or third-party adapter diagnostics beyond the built-in MVP adapters. Those must add new fixtures and evidence when implemented.

## Verification command

```sh
pnpm test
```
