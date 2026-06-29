# PRD Phase 3-6 implementation status

Recorded on 2026-06-29 for the local `main` branch.

This index maps PRD section 24 phases to current implementation evidence. It is an implementation status view, not a replacement for the PRD requirements.

| PRD phase | Current status | Evidence document | Completed evidence | Remaining tracked work |
| --- | --- | --- | --- | --- |
| Phase 3: Diagnostics | Complete for MVP scope | [phase-3-evidence.md](phase-3-evidence.md) | Adapter diagnostics, scanner-owned diagnostics, drift blocking, diagnostic listing and export | Keep adapter golden cases current as tool formats change |
| Phase 4: Conversion and deployment | Complete for MVP scope | [phase-4-evidence.md](phase-4-evidence.md) | Conversion preview, compatibility/field-loss surfacing, diff, dry run, copy/symlink/generated file, backup, execution, rollback | Keep deployment evidence current as new target tools or operation kinds are added |
| Phase 5: Central assets and Git | Complete for tracked P3 scope | [phase-5-evidence.md](phase-5-evidence.md) | Personal central asset library, Preset base workflows, remote-capable Git asset repository workflow, conflict guidance, custom declarative tool scanning, local Git snapshot/history evidence | Team identity, approval flows, hosted collaboration services, and sharing markets remain outside MVP |
| Phase 6: Product UI and distribution | Complete for tracked P4 scope | [phase-6-evidence.md](phase-6-evidence.md) | Local API, local Web UI, desktop shell, IPC/preload boundary, external editor integration, Windows/macOS/Linux packaging, Linux glibc 2.28 evidence | Keep Local API/Web UI hardening current as new commands are exposed |

Verification command for this status index:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
