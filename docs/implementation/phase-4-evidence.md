# Phase 4 implementation evidence: conversion and deployment

Recorded on 2026-06-29 for the local `main` branch.

## PRD scope

PRD Phase 4 covers transformer, renderer, compatibility level, diff, dry run, copy, symlink, generated file, backup, and rollback.

## Current status

Complete for the current MVP scope.

The implementation supports migration preview with compatibility and field-loss evidence, preview diffs, required confirmations, plan freshness and source/target hash snapshots. Deployment plans support copy, symlink, and generated-file operations. Execution performs drift checks, backup-first writes, verification, compensation on failure, task events, and history records. Rollback validates current target state and backup integrity before restore.

## Test evidence

| Evidence | Coverage |
| --- | --- |
| `packages/core/src/domain/deployment.test.ts` | PRD deployment operation types and deployment domain invariants |
| `packages/deployer/src/preview-service.test.ts` | Conversion preview, diff, required confirmations, plan hashes, target conflict handling |
| `packages/deployer/src/execution-service.test.ts` | Backup-first execution, copy/symlink/generated file writes, drift rejection, verification failure and compensation |
| `packages/deployer/src/rollback-service.test.ts` | Rollback preview, drift rejection, backup validation, restore execution |
| `packages/deployer/src/file-port.test.ts` | Confined file operations and hash checks |
| `tests/integration/deployment-preview.test.ts` and `tests/integration/deployment-lifecycle.test.ts` | End-to-end preview, execution, history, and rollback lifecycle |
| `apps/desktop/src/main/composition.test.ts` and `apps/cli/src/app-services.test.ts` | Real desktop/CLI command-service wiring to deployer services |

## Not claimed

This document does not claim lossless conversion for every field across all tools. Compatibility and field loss remain explicit preview evidence, and unsupported conversions must keep failing closed.

## Verification command

```sh
pnpm test
pnpm test:integration
```
