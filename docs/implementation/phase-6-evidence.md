# Phase 6 implementation evidence: product UI and distribution

Recorded on 2026-06-29 for the local `main` branch.

## PRD scope

PRD Phase 6 covers Local API, Web UI, external editor integration, desktop shell, Linux/Windows/macOS installers, and glibc 2.28 compatibility verification.

## Current status

Partial.

Implemented evidence covers the secure Electron desktop shell, IPC/preload command boundary, renderer state for the MVP workflows, external editor open/rescan flow, and three-platform packaging evidence. Linux packaging retains the Rocky Linux 8.10 / glibc 2.28 AppImage baseline, ELF audit, smoke test, SBOM, checksum, and manifest verification. Windows x64 NSIS and macOS x64/arm64 DMG targets are configured and included in release evidence.

## Test evidence

| Evidence | Coverage |
| --- | --- |
| `apps/desktop/src/main/ipc.test.ts` and `apps/desktop/src/preload/api.test.ts` | IPC/preload validation and safe renderer boundary |
| `apps/desktop/src/main/composition.test.ts` | Desktop command service wiring, external editor open/rescan, task events, deployment/rollback history |
| `apps/desktop/src/renderer/model.test.ts` | Renderer state for assets, effective config, diagnostics, migration, deployment, recovery lock handling, history |
| `tests/e2e/desktop.spec.ts` | Desktop E2E workflow evidence |
| `tests/packaging/config.test.mjs` | Windows, macOS, and Linux packaging configuration |
| `tests/packaging/release-evidence.test.mjs` | Release manifest, SBOM, checksum, AppImage smoke, and workflow evidence |
| `.github/workflows/linux-package.yml` and `.github/workflows/release.yml` | Packaging matrix and tag-triggered release evidence |

## Not claimed

The following PRD Phase 6 capabilities remain open and are tracked in `docs/TODO.md` P4:

- Local API that listens only on local addresses with explicit authentication, origin limits, and shutdown policy.
- Local Web UI sharing the same business API and core use cases as the desktop app.

## Verification command

```sh
pnpm test
pnpm test:e2e
```
