# Tag-triggered GitHub Release design

## Goal

Publish an immutable GitHub Release for each pushed `v*` tag without depending on a developer workstation, browser session, or long-lived personal token.

## Architecture

Add `.github/workflows/release.yml`. The workflow runs only for pushed tags matching `v*`, grants `contents: write` to its single release job, and uses the runner-provided `GITHUB_TOKEN` to create a non-draft GitHub Release for the exact tag.

The release command will use the preinstalled GitHub CLI and generated release notes. It will verify that the tag exists and scope every API call to `github.repository`, preventing accidental publication to another repository.

## Data flow

1. A verified commit on `main` is tagged with an immutable semantic version such as `v0.1.1`.
2. The tag is pushed to `origin`.
3. GitHub Actions starts the release workflow from the tagged commit.
4. The job creates a published GitHub Release using that tag and generated notes.
5. The release is verified through GitHub's public Releases API.

## Safety and failure handling

- The workflow has no branch trigger, so ordinary pushes cannot publish releases.
- Repository write permission is limited to `contents` for the release job.
- The workflow does not rewrite or delete existing tags or releases.
- A duplicate tag/release causes the command to fail rather than overwrite published state.
- `v0.1.0` remains unchanged; the CI-corrected release is `v0.1.1`.

## Verification

- Add a repository contract test that checks the tag trigger, `contents: write`, and tag-bound release command.
- Run the focused contract test and the full local quality gate.
- Push the workflow commit and require the `main` CI run to pass.
- Push `v0.1.1`, wait for the release workflow to pass, and verify the published release URL and target commit through the GitHub API.

