# PRD Phase 3-6 implementation status

Recorded on 2026-06-29 for the local `main` branch.

This index maps PRD section 24 phases to current implementation evidence. It is an implementation status view, not a replacement for the PRD requirements.

| PRD phase | Current status | Evidence document | Completed evidence | Remaining tracked work |
| --- | --- | --- | --- | --- |
| Phase 3: Diagnostics | Complete for MVP scope | [phase-3-evidence.md](phase-3-evidence.md) | Adapter diagnostics, scanner-owned diagnostics, drift blocking, diagnostic listing and export | Keep adapter golden cases current as tool formats change |
| Phase 4: Conversion and deployment | Complete for MVP scope | [phase-4-evidence.md](phase-4-evidence.md) | Conversion preview, compatibility/field-loss surfacing, diff, dry run, copy/symlink/generated file, backup, execution, rollback | Keep deployment evidence current as new target tools or operation kinds are added |
| Phase 5: Central assets and Git | Partial | [phase-5-evidence.md](phase-5-evidence.md) | Local Git snapshot/history evidence for successful deployment and rollback records | Personal central asset library, remote Git clone/pull/commit/push, Git conflict workflow, Preset |
| Phase 6: Product UI and distribution | Partial | [phase-6-evidence.md](phase-6-evidence.md) | Desktop shell, IPC/preload boundary, external editor integration, Windows/macOS/Linux packaging, Linux glibc 2.28 evidence | Local API and local Web UI |

Verification command for this status index:

```sh
pnpm test
```
