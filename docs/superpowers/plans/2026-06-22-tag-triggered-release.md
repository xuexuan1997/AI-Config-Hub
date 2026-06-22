# Tag-triggered GitHub Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `v0.1.1` through a reusable, tag-triggered GitHub Actions workflow with narrowly scoped repository permissions.

**Architecture:** A repository contract test validates the release workflow's trigger, permission, and tag-bound command. The workflow uses the runner-provided `GITHUB_TOKEN` and preinstalled GitHub CLI to create a non-draft Release for the pushed tag, after which public GitHub APIs verify both the workflow and Release.

**Tech Stack:** GitHub Actions YAML, GitHub CLI, Node.js test runner, pnpm, GitHub REST API

---

### Task 1: Add the release workflow contract

**Files:**
- Modify: `tests/tooling/workspace.test.mjs`
- Test: `tests/tooling/workspace.test.mjs`

- [ ] **Step 1: Write the failing contract test**

Add this test inside the existing `workspace contract` suite:

```js
it("publishes immutable tag-bound releases with narrow permissions", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");

  assert.match(workflow, /^\s+tags:\s*\["v\*"\]$/m);
  assert.match(workflow, /^\s+contents:\s*write$/m);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /--repo "\$GITHUB_REPOSITORY"/);
  assert.match(workflow, /--verify-tag/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test tests/tooling/workspace.test.mjs
```

Expected: FAIL with `ENOENT` for `.github/workflows/release.yml`.

### Task 2: Implement tag-triggered release publishing

**Files:**
- Create: `.github/workflows/release.yml`
- Test: `tests/tooling/workspace.test.mjs`

- [ ] **Step 1: Add the minimal workflow**

Create `.github/workflows/release.yml` with:

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: Publish GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: >-
          gh release create "$GITHUB_REF_NAME"
          --repo "$GITHUB_REPOSITORY"
          --title "$GITHUB_REF_NAME"
          --generate-notes
          --verify-tag
```

- [ ] **Step 2: Run the focused test and verify GREEN**

Run:

```bash
node --test tests/tooling/workspace.test.mjs
```

Expected: all workspace contract tests pass.

- [ ] **Step 3: Run the full local quality gate**

Run:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm build
git diff --check
```

Expected: every command exits 0; 101 unit tests and 2 integration tests pass, plus the focused Node contract suite.

- [ ] **Step 4: Commit the workflow**

```bash
git add .github/workflows/release.yml tests/tooling/workspace.test.mjs
git commit -m "ci: publish releases from version tags"
```

### Task 3: Verify remotely and publish `v0.1.1`

**Files:**
- No file changes

- [ ] **Step 1: Push `main` and require green CI**

```bash
git push origin main
```

Poll the GitHub Actions API for the new HEAD SHA. Expected: workflow `CI` completes with conclusion `success`.

- [ ] **Step 2: Create and push the immutable release tag**

```bash
git tag -a v0.1.1 -m "AI Config Hub v0.1.1"
git push origin v0.1.1
```

Expected: the remote accepts a new tag without force or replacement.

- [ ] **Step 3: Verify the release workflow**

Poll the GitHub Actions API for the `Release` workflow at tag `v0.1.1`. Expected: conclusion `success`.

- [ ] **Step 4: Verify the published Release**

```bash
curl -fsSL https://api.github.com/repos/xuexuan1997/AI-Config-Hub/releases/tags/v0.1.1
```

Expected: `draft` and `prerelease` are false, `tag_name` is `v0.1.1`, and `target_commitish` resolves to the tagged commit.

