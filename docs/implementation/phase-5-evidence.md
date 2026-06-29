# Phase 5 implementation evidence: central assets and Git

Recorded on 2026-06-29 for the local `main` branch.

## PRD scope

PRD Phase 5 covers a personal central asset library, Git asset library, clone/pull/commit/push, Git conflict prompts, version history, and Preset.

## Current status

Partial.

Implemented evidence is limited to local Git-backed deployment history snapshots. Successful deployment and rollback records can copy involved assets into the local history root, create a Git commit, expose commit metadata in history lists/details, and tolerate snapshot failure without failing the underlying deployment.

## Test evidence

| Evidence | Coverage |
| --- | --- |
| `packages/git/src/local-git.test.ts` | Local Git initialization, snapshot, diff and history primitives |
| `packages/git/src/snapshot-service.test.ts` | Deployment asset snapshot behavior |
| `apps/cli/src/app-services.test.ts` | CLI deployment and rollback snapshot metadata in history |
| `apps/desktop/src/main/composition.test.ts` | Desktop deployment and rollback snapshot metadata in history |

## Not claimed

The following PRD Phase 5 capabilities remain open and are tracked in `docs/TODO.md` P3:

- Personal central asset library.
- Remote Git clone, pull, commit, and push workflow.
- Git conflict prompts and recovery guidance.
- Preset definition, preview, application, source tracking, and rollback records.

## Verification command

```sh
pnpm test
```
