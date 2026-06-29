# Phase 5 implementation evidence: central assets and Git

Recorded on 2026-06-29 for the local `main` branch.

## PRD scope

PRD Phase 5 covers a personal central asset library, Git asset library, clone/pull/commit/push, Git conflict prompts, version history, and Preset.

## Current status

Complete for the currently tracked P3 scope in `docs/TODO.md`.

Implemented evidence now covers the personal central asset library, Preset base workflows, a separate remote-capable Git asset repository port, Git asset workflow primitives, conflict recovery guidance, and declarative custom tool scanning. Existing local Git-backed deployment history snapshots remain in place and keep their local-only safety boundary.

## Test evidence

| Evidence | Coverage |
| --- | --- |
| `packages/asset-library/src/asset-library.test.ts` | Personal central library initialization, asset import/list/get with source tracking, Preset definition/preview/apply, rollback/source tracking, path-safety rejection |
| `packages/core/src/ports/contracts.test.ts` | Separation between local history Git port and remote-capable asset repository Git port |
| `packages/git/src/asset-repository-git.test.ts` | Clone, pull, status, diff, commit, push, tag, restore, history, safe URL/ref/path handling, conflict guidance, local bare-repo push round trip |
| `packages/git/src/local-git.test.ts` | Local Git initialization, snapshot, diff and history primitives |
| `packages/git/src/snapshot-service.test.ts` | Deployment asset snapshot behavior |
| `packages/shared/src/primitives.test.ts` | Built-in plus safe custom tool ID validation |
| `packages/storage/src/database.test.ts` | Forward migration allowing custom declarative tool keys |
| `packages/adapters/src/declarative-tool.test.ts` | Declarative tool definition validation, custom registry registration, scan/discover/parse for Rules, Agents, Skills and MCP without script execution |
| `apps/cli/src/app-services.test.ts` | CLI deployment and rollback snapshot metadata in history |
| `apps/desktop/src/main/composition.test.ts` | Desktop deployment and rollback snapshot metadata in history |

## Scope notes

Team identity, repository permissions, approval flows, hosted collaboration services, and online sharing markets remain intentionally outside the MVP boundary; Git providers continue to own authentication and authorization.

## Verification command

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
