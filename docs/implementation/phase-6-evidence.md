# Phase 6 implementation evidence: product UI and distribution

Recorded on 2026-06-29 for the local `main` branch.

## PRD scope

PRD Phase 6 covers Local API, Web UI, external editor integration, desktop shell, Linux/Windows/macOS installers, and glibc 2.28 compatibility verification.

## Current status

Complete for the currently tracked P4 scope in `docs/TODO.md`.

Implemented evidence covers Local API, Local Web UI, the secure Electron desktop shell, IPC/preload command boundary, renderer state for the MVP workflows, external editor open/rescan flow, and three-platform packaging evidence. Linux packaging retains the Rocky Linux 8.10 / glibc 2.28 AppImage baseline, ELF audit, smoke test, SBOM, checksum, and manifest verification. Windows x64 NSIS and macOS x64/arm64 DMG targets are configured and included in release evidence.

## Test evidence

| Evidence | Coverage |
| --- | --- |
| `packages/local-api/src/server.test.ts` | Local-only bind validation, Bearer authentication, Origin allowlist, shared command handler reuse, no-store headers, SSE task events, graceful shutdown |
| `apps/web/src/local-transport.test.ts` | Browser fetch/SSE transport over the shared API envelope with Bearer auth |
| `apps/web/src/import-boundary.test.ts` and `dependency-cruiser.mjs` | Web runtime avoids privileged filesystem/storage/git/core implementation imports |
| `packages/api/src/browser.ts` | Browser-safe API entry that excludes Node-only diagnostic report/server handler exports |
| `apps/desktop/src/main/ipc.test.ts` and `apps/desktop/src/preload/api.test.ts` | IPC/preload validation and safe renderer boundary |
| `apps/desktop/src/main/composition.test.ts` | Desktop command service wiring, external editor open/rescan, task events, deployment/rollback history |
| `apps/desktop/src/renderer/model.test.ts` | Renderer state for assets, effective config, diagnostics, migration, deployment, recovery lock handling, history |
| `tests/e2e/desktop.spec.ts` | Desktop E2E workflow evidence |
| `tests/packaging/config.test.mjs` | Windows, macOS, and Linux packaging configuration |
| `tests/packaging/release-evidence.test.mjs` | Release manifest, SBOM, checksum, AppImage smoke, and workflow evidence |
| `.github/workflows/linux-package.yml` and `.github/workflows/release.yml` | Packaging matrix and tag-triggered release evidence |

## Verification command

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```
