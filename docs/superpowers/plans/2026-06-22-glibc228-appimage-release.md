# glibc 2.28 AppImage Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, prove, and publish a Linux x86_64 AppImage that runs on glibc 2.28 and contains the complete desktop manager.

**Architecture:** electron-builder packages pinned Electron bytes; a Rocky Linux 8.10 digest-pinned job audits every ELF and runs AppImage smoke tests. The existing tag workflow becomes a build-validate-publish pipeline that uploads only verified artifacts and evidence.

**Tech Stack:** Electron 42.4.1, electron-builder 26.15.3, Rocky Linux 8.10, GitHub Actions, CycloneDX, readelf/objdump, SHA-256

---

### Task 1: Configure deterministic AppImage packaging

**Files:**
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/resources/icon.svg`
- Create: `apps/desktop/resources/ai-config-hub.desktop`
- Modify: `apps/desktop/package.json`
- Modify: `.gitignore`
- Create: `tests/packaging/config.test.mjs`

- [ ] **Step 1: Write failing packaging configuration test**

Assert product name, app ID, x64-only AppImage target, artifact name `AI-Config-Hub-${version}-x86_64.AppImage`, ASAR enabled, main entry, included dist/workspace production files, no source maps/tests/fixtures, no dependency rebuild downloads, and category `Development`.

Run: `node --test tests/packaging/config.test.mjs`

Expected: FAIL because builder configuration is missing.

- [ ] **Step 2: Add exact builder configuration**

Set `appId: io.aiconfighub.desktop`, `productName: AI Config Hub`, `asar: true`, `npmRebuild: false`, `buildDependenciesFromSource: false`, Linux target `AppImage` arch `x64`, artifact name above, and files restricted to built desktop files plus production workspace package distributions and migrations.

- [ ] **Step 3: Verify local unpacked package and commit**

Run: `pnpm --filter @ai-config-hub/desktop build && pnpm --filter @ai-config-hub/desktop exec electron-builder --linux dir --x64`

Expected: unpacked Linux x64 application contains main, preload, renderer, migrations, Electron runtime, and no source/test files.

Commit:

```bash
git add apps/desktop tests/packaging .gitignore
git commit -m "build(desktop): configure deterministic Linux AppImage"
```

### Task 2: Generate manifest, checksums, SBOM, and ELF evidence

**Files:**
- Create: `scripts/release/generate-manifest.mjs`
- Create: `scripts/release/audit-linux-elf.sh`
- Create: `scripts/release/verify-artifacts.mjs`
- Create: `tests/packaging/release-evidence.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing evidence tests**

Given a temporary artifact, assert `SHA256SUMS` exact format, manifest Schema/version/architecture/baseline digest/artifact hash, CycloneDX file presence, deterministic sorted ELF records, rejection of GLIBC_2.29+, absolute RPATH, unknown ELF, wrong architecture, or checksum mismatch.

Run: `node --test tests/packaging/release-evidence.test.mjs`

Expected: FAIL because release scripts are absent.

- [ ] **Step 2: Implement evidence scripts**

`generate-manifest.mjs` reads package versions and `process.versions`, hashes artifacts, and writes stable sorted JSON. `audit-linux-elf.sh` extracts the AppImage, enumerates ELF files with `file`, records interpreter/NEEDED/RPATH plus sorted version symbols from `readelf --version-info` and `objdump -T`, and exits nonzero for GLIBC above 2.28. `verify-artifacts.mjs` rehashes every manifest entry and validates required files.

- [ ] **Step 3: Add release scripts and commit**

Add root scripts `package:linux`, `release:evidence`, and `release:verify` using fixed paths under `release/linux-x64`.

Run: `node --test tests/packaging && pnpm lint`

Expected: evidence tests pass.

Commit:

```bash
git add scripts/release tests/packaging package.json
git commit -m "build(release): generate Linux compatibility evidence"
```

### Task 3: Add glibc 2.28 build and runtime smoke

**Files:**
- Create: `.github/workflows/linux-package.yml`
- Create: `scripts/release/smoke-appimage.sh`
- Create: `tests/e2e/release-smoke.spec.ts`
- Modify: `tests/tooling/workspace.test.mjs`

- [ ] **Step 1: Write failing workflow contract**

Assert workflow uses x86_64 only, pins `rockylinux/rockylinux:8.10@sha256:e8a49c5403b687db05d4d67333fa45808fbe74f36e683cec7abb1f7d0f2338c6`, runs frozen install/full gates/package/audit/smoke/verify, and uploads one artifact named `linux-x64-release-candidate`.

- [ ] **Step 2: Implement package workflow**

Use a self-contained container job with Node 24/pnpm 11.5.3 and required X11/FUSE/binutils packages installed from pinned Rocky repositories. Build the AppImage, generate a CycloneDX SBOM from `pnpm-lock.yaml`, audit symbols, run Electron under Xvfb, and upload the complete `release/linux-x64` directory.

- [ ] **Step 3: Implement smoke behavior**

`smoke-appimage.sh` verifies host glibc reports 2.28, runs AppImage `--appimage-extract-and-run` with isolated fixture/user-data directories, waits for the E2E ready file, executes scan/deploy/rollback through the Playwright release smoke, verifies restored bytes and SQLite creation, then terminates cleanly. Also record FUSE availability and extracted-run result.

- [ ] **Step 4: Verify workflow contract and commit**

Run: `node --test tests/tooling/workspace.test.mjs tests/packaging/*.test.mjs && pnpm lint`

Expected: all workflow/package contracts pass.

Commit:

```bash
git add .github/workflows/linux-package.yml scripts/release/smoke-appimage.sh tests
git commit -m "ci: validate AppImage on glibc 2.28"
```

### Task 4: Publish verified `v0.2.0` assets

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `tests/tooling/workspace.test.mjs`
- Modify: all workspace `package.json` versions

- [ ] **Step 1: Write failing release workflow contract**

Assert `Release` waits for package/test jobs, downloads the exact candidate artifact, reruns `release:verify`, and calls `gh release create` with AppImage, `SHA256SUMS`, version manifest, SBOM, and compatibility evidence paths. Assert publication cannot run when package or smoke fails.

- [ ] **Step 2: Extend release workflow and bump versions**

Set every workspace version to `0.2.0`. Replace direct source-only publication with build/test/package jobs plus a final `publish` job using `contents: write`; earlier jobs retain `contents: read`. Upload exact verified files and generated notes for tag `v0.2.0`.

- [ ] **Step 3: Run the final local gate and commit**

Run locally: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm test:e2e && pnpm build`

Expected: every command exits 0.

Commit before creating a tag:

```bash
git add .github/workflows/release.yml tests/tooling/workspace.test.mjs package.json apps packages pnpm-lock.yaml
git commit -m "release: prepare AI Config Hub v0.2.0"
```

- [ ] **Step 4: Run remote gates and publish**

Push `main` and require CI plus Linux package workflow success. Create annotated tag `v0.2.0`, push it, and require Release workflow success.

- [ ] **Step 5: Verify published bytes**

Download every `v0.2.0` asset into a clean directory, run `release:verify`, compare the AppImage SHA-256 to `SHA256SUMS` and manifest, rerun glibc 2.28 smoke, and verify the GitHub Release is non-draft/non-prerelease at the tagged `main` commit.
