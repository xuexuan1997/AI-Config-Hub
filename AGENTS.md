# Agent Notes

## Local Node Environment

This project requires Node `>=24 <25` as declared in `package.json`.

Use `fnm` to manage the local Node version when running project commands:

```sh
fnm install 24
fnm use 24
node --version
```

If Vitest, Vite, Rolldown, or other tooling fails with missing modern `node:*` exports, first verify that the active shell is using Node 24 through `fnm`.

## Release Procedure and Failure Recovery

Release failures in this repository have repeatedly come from version drift, timing-sensitive tests on Windows, and tagging before the final commit has passed every packaging workflow. Follow this checklist for every release.

### Before Tagging

1. Update the version consistently in every workspace `package.json`, both READMEs, and any E2E assertion that displays the current version. Use searches such as:

   ```sh
   rg -n '"version":' --glob package.json
   rg -n '0\.2\.[0-9]+' README.md README.en.md tests/e2e/desktop.spec.ts
   ```

2. Run the release gates under Node 24:

   ```sh
   pnpm test
   pnpm test:integration
   pnpm typecheck
   pnpm lint
   pnpm build
   pnpm --filter @ai-config-hub/desktop test
   pnpm --filter @ai-config-hub/desktop test:e2e
   ```

3. Commit and push the release preparation to `main`. Do not create or push the tag until the exact commit intended for release has both the `CI` and `Desktop Packages` workflows green.

### Test Stability Rules

- Do not assume invocation order when a test starts concurrent asynchronous refreshes. If work such as hashing occurs before the mocked API call, add an explicit handshake proving that the first operation has reached the intended point before starting the second operation.
- Desktop composition tests use real file-system, SQLite, and Git operations. Windows runners can exceed Vitest's default five-second timeout even when behavior is correct. Keep the bounded 15-second timeout on that integration-style suite instead of weakening timeouts globally.
- When a workflow fails, inspect the exact failed job and log before rerunning it. A rerun may hide a timing problem without fixing it.

### Tagging and Monitoring

Create an annotated tag only after the final `main` commit is green:

```sh
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin refs/tags/vX.Y.Z
```

Useful monitoring commands:

```sh
gh run list --limit 10
gh run watch RUN_ID --exit-status --interval 15
gh run view RUN_ID --json jobs,status,conclusion,url
gh run view RUN_ID --job JOB_ID --log-failed
```

A tag push starts the standalone `Desktop Packages` workflow and the packaging matrix called by `Release`. This duplicate packaging is expected; it is not by itself a release error.

### Recovering a Failed Release

If a tag workflow fails before a GitHub Release has been published:

1. Inspect the failed job and fix the underlying issue on `main`.
2. Run the local gates, push the fix, and wait for both `CI` and `Desktop Packages` on the new commit to pass.
3. Confirm that no GitHub Release exists:

   ```sh
   gh release view vX.Y.Z
   ```

4. Cancel obsolete runs if they are still active, then move the annotated tag to the verified commit:

   ```sh
   git tag -fa vX.Y.Z -m "vX.Y.Z"
   git push --force origin refs/tags/vX.Y.Z
   ```

Force-moving a release tag is allowed only while no GitHub Release exists. Never rewrite a published release tag; prepare the next patch version instead.

### Release Completion Criteria

A release is complete only after all of the following are verified:

- The GitHub Release is published, non-draft, and non-prerelease.
- The remote annotated tag peels to the intended verified commit.
- All four platform installers are present: Linux, Windows, macOS x64, and macOS arm64.
- The expected checksums, update metadata, version manifests, SBOMs, blockmaps, and compatibility evidence are present. The current release workflow produces 20 assets in total.
- `git status` is clean and `main` matches the released commit.

Verify with:

```sh
gh release view vX.Y.Z --json tagName,name,isDraft,isPrerelease,publishedAt,url,targetCommitish,assets
git ls-remote --tags origin refs/tags/vX.Y.Z 'refs/tags/vX.Y.Z^{}'
git status --short --branch
```

GitHub Actions warnings about runner-image migrations or action runtime deprecations are not necessarily release blockers, but track and resolve them separately instead of ignoring them indefinitely.
