# Multiplatform Release Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Windows x64, macOS x64, macOS arm64, and Linux x64 desktop release artifacts from the tag-triggered release pipeline.

**Architecture:** Keep electron-builder as the single desktop packaging backend and add platform-specific package scripts that write to isolated `release/<platform>-<arch>` directories. Generalize release evidence generation so every platform has checksums, SBOM, and a version manifest, while Linux keeps its extra glibc 2.28 ELF evidence. The reusable packaging workflow builds Linux in the existing Rocky Linux container and builds Windows/macOS on native GitHub-hosted runners; the publish workflow only downloads and uploads verified candidate directories.

**Tech Stack:** pnpm workspace, Electron 42.4.1, electron-builder 26.15.3, Node.js 24, node:test contract tests, GitHub Actions, Rocky Linux 8.10.

---

## File Structure

- `tests/packaging/config.test.mjs`: contract tests for electron-builder platform targets and artifact names.
- `tests/packaging/release-evidence.test.mjs`: contract tests for platform-aware manifest/checksum generation and workflow bounds.
- `tests/tooling/workspace.test.mjs`: contract tests for root/desktop scripts and release workflow asset coverage.
- `package.json`: root scripts for platform packaging, release evidence, and node:test contract execution.
- `apps/desktop/package.json`: desktop package scripts that call electron-builder for one target directory at a time.
- `apps/desktop/electron-builder.yml`: shared electron-builder metadata plus Linux AppImage, Windows NSIS, and macOS DMG targets.
- `scripts/release/generate-manifest.mjs`: platform-aware publishable artifact selection and manifest generation.
- `scripts/release/verify-artifacts.mjs`: checksum verification for one or more release directories.
- `.github/workflows/linux-package.yml`: reusable packaging workflow expanded from Linux-only to Linux plus native Windows/macOS jobs.
- `.github/workflows/release.yml`: tag publisher that downloads and publishes all four verified candidate directories.

## Task 1: Write Failing Multiplatform Release Contract Tests

**Files:**
- Modify: `tests/packaging/config.test.mjs`
- Modify: `tests/packaging/release-evidence.test.mjs`
- Modify: `tests/tooling/workspace.test.mjs`

- [ ] **Step 1: Replace the electron-builder config contract test**

Use this complete content for `tests/packaging/config.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("desktop installer packaging config", () => {
  it("pins deterministic Linux, Windows, and macOS installer settings", async () => {
    const config = await readFile("apps/desktop/electron-builder.yml", "utf8");
    const manifest = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));

    assert.equal(manifest.main, "dist/main/main/main.js");
    assert.match(config, /^appId: io\.aiconfighub\.desktop$/m);
    assert.match(config, /^productName: AI Config Hub$/m);
    assert.match(config, /^executableName: ai-config-hub$/m);
    assert.match(config, /^asar: true$/m);
    assert.match(config, /^npmRebuild: false$/m);
    assert.match(config, /^buildDependenciesFromSource: false$/m);
    assert.match(config, /directories:\n\s+output: \.\.\/\.\.\/release\/linux-x64/);
    assert.match(config, /linux:[\s\S]*target: AppImage/);
    assert.match(config, /linux:[\s\S]*arch:\n\s+- x64/);
    assert.match(config, /artifactName: AI-Config-Hub-\$\{version\}-x86_64\.\$\{ext\}/);
    assert.match(config, /category: Development/);
    assert.match(config, /win:[\s\S]*target: nsis/);
    assert.match(config, /win:[\s\S]*arch:\n\s+- x64/);
    assert.match(config, /artifactName: AI-Config-Hub-\$\{version\}-windows-x64\.\$\{ext\}/);
    assert.match(config, /nsis:[\s\S]*allowToChangeInstallationDirectory: true/);
    assert.match(config, /mac:[\s\S]*target: dmg/);
    assert.match(config, /mac:[\s\S]*arch:\n\s+- x64\n\s+- arm64/);
    assert.match(config, /artifactName: AI-Config-Hub-\$\{version\}-macos-\$\{arch\}\.\$\{ext\}/);
    assert.match(config, /dist\/main\/\*\*\/\*/);
    assert.match(config, /dist\/renderer\/\*\*\/\*/);
    assert.match(config, /!\*\*\/\*\.test\.\*/);
    assert.match(config, /!\*\*\/fixtures\/\*\*/);
  });
});
```

- [ ] **Step 2: Extend release evidence tests for all target types**

In `tests/packaging/release-evidence.test.mjs`, keep the existing imports and replace the first test with this code:

```js
  it("generates deterministic platform manifests and verifies them", async () => {
    const root = await mkdtemp(join(tmpdir(), "aich-release-"));
    const linux = join(root, "linux-x64");
    const windows = join(root, "windows-x64");
    const macosArm = join(root, "macos-arm64");

    await mkdir(join(linux, "linux-unpacked"), { recursive: true });
    await writeFile(join(linux, "AI-Config-Hub-0.2.0-x86_64.AppImage"), "linux-demo");
    await writeFile(join(linux, "builder-debug.yml"), "internal: true\n");
    await writeFile(join(linux, "elf-compatibility.json"), "{}\n");
    await writeFile(join(linux, "sbom.cdx.json"), "{}\n");

    await mkdir(windows, { recursive: true });
    await writeFile(join(windows, "AI-Config-Hub-0.2.0-windows-x64.exe"), "windows-demo");
    await writeFile(join(windows, "win-unpacked"), "not-a-file-entry");
    await writeFile(join(windows, "sbom.cdx.json"), "{}\n");

    await mkdir(macosArm, { recursive: true });
    await writeFile(join(macosArm, "AI-Config-Hub-0.2.0-macos-arm64.dmg"), "macos-demo");
    await writeFile(join(macosArm, "builder-debug.yml"), "internal: true\n");
    await writeFile(join(macosArm, "sbom.cdx.json"), "{}\n");

    await execFileAsync("node", ["scripts/release/generate-manifest.mjs", linux, "linux", "x64"]);
    await execFileAsync("node", ["scripts/release/generate-manifest.mjs", windows, "windows", "x64"]);
    await execFileAsync("node", ["scripts/release/generate-manifest.mjs", macosArm, "macos", "arm64"]);
    await execFileAsync("node", ["scripts/release/verify-artifacts.mjs", linux, windows, macosArm]);

    const linuxSums = await readFile(join(linux, "SHA256SUMS"), "utf8");
    const linuxManifest = JSON.parse(await readFile(join(linux, "version-manifest.json"), "utf8"));
    assert.match(linuxSums, /AI-Config-Hub-0\.2\.0-x86_64\.AppImage/);
    assert.match(linuxSums, /elf-compatibility\.json/);
    assert.doesNotMatch(linuxSums, /builder-debug\.yml/);
    assert.doesNotMatch(linuxSums, /linux-unpacked/);
    assert.equal(linuxManifest.platform, "linux");
    assert.equal(linuxManifest.architecture, "x64");
    assert.equal(linuxManifest.glibcBaseline, "2.28");

    const windowsSums = await readFile(join(windows, "SHA256SUMS"), "utf8");
    const windowsManifest = JSON.parse(await readFile(join(windows, "version-manifest.json"), "utf8"));
    assert.match(windowsSums, /AI-Config-Hub-0\.2\.0-windows-x64\.exe/);
    assert.doesNotMatch(windowsSums, /elf-compatibility\.json/);
    assert.equal(windowsManifest.platform, "windows");
    assert.equal(windowsManifest.architecture, "x64");
    assert.equal("glibcBaseline" in windowsManifest, false);

    const macosSums = await readFile(join(macosArm, "SHA256SUMS"), "utf8");
    const macosManifest = JSON.parse(await readFile(join(macosArm, "version-manifest.json"), "utf8"));
    assert.match(macosSums, /AI-Config-Hub-0\.2\.0-macos-arm64\.dmg/);
    assert.doesNotMatch(macosSums, /builder-debug\.yml/);
    assert.equal(macosManifest.platform, "macos");
    assert.equal(macosManifest.architecture, "arm64");
    assert.equal("glibcBaseline" in macosManifest, false);
  });
```

- [ ] **Step 3: Update workflow contract expectations**

In `tests/packaging/release-evidence.test.mjs`, replace the workflow test body with:

```js
  it("uses bounded release workflows without network-only SBOM generation", async () => {
    const packageWorkflow = await readFile(".github/workflows/linux-package.yml", "utf8");
    const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");

    assert.match(packageWorkflow, /timeout-minutes: 30/);
    assert.match(packageWorkflow, /pnpm release:sbom release\/linux-x64\/sbom\.cdx\.json/);
    assert.match(packageWorkflow, /pnpm release:sbom \$\{\{ matrix\.release_dir \}\}\/sbom\.cdx\.json/);
    assert.doesNotMatch(packageWorkflow, /pnpm dlx @cyclonedx\/cyclonedx-npm/);
    assert.match(releaseWorkflow, /timeout-minutes: 15/);
    assert.match(releaseWorkflow, /linux-x64-release-candidate/);
    assert.match(releaseWorkflow, /windows-x64-release-candidate/);
    assert.match(releaseWorkflow, /macos-x64-release-candidate/);
    assert.match(releaseWorkflow, /macos-arm64-release-candidate/);
    assert.match(releaseWorkflow, /gh release upload "\$GITHUB_REF_NAME"/);
    assert.match(releaseWorkflow, /--clobber/);
  });
```

- [ ] **Step 4: Update workspace script and release workflow tests**

In `tests/tooling/workspace.test.mjs`, add these required root scripts to the first test's script list:

```js
      "test:contracts",
      "package:linux",
      "package:linux:x64",
      "package:windows:x64",
      "package:macos:x64",
      "package:macos:arm64",
      "release:sbom",
      "release:evidence",
      "release:verify",
```

In the secure desktop toolchain test, replace the desktop script list with:

```js
    for (const script of [
      "dev",
      "build:main",
      "build:renderer",
      "build",
      "test",
      "test:e2e",
      "package:linux",
      "package:linux:x64",
      "package:windows:x64",
      "package:macos:x64",
      "package:macos:arm64",
    ]) {
      assert.ok(script in manifest.scripts, `missing desktop script: ${script}`);
    }
```

Replace the release workflow assertions in `publishes immutable tag-bound releases with narrow permissions` with:

```js
    assert.match(workflow, /^\s+tags:\s*\["v\*"\]$/m);
    assert.match(workflow, /^\s+contents:\s*read$/m);
    assert.match(workflow, /^\s+package:\s*$/m);
    assert.match(workflow, /uses: \.\/\.github\/workflows\/linux-package\.yml/);
    assert.match(workflow, /^\s+publish:\s*$/m);
    assert.match(workflow, /^\s+needs:\s*package$/m);
    assert.match(workflow, /^\s+contents:\s*write$/m);
    assert.match(workflow, /pnpm release:verify release\/linux-x64 release\/windows-x64 release\/macos-x64 release\/macos-arm64/);
    assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/);
    assert.match(workflow, /AI-Config-Hub-\*-x86_64\.AppImage/);
    assert.match(workflow, /AI-Config-Hub-\*-windows-x64\.exe/);
    assert.match(workflow, /AI-Config-Hub-\*-macos-x64\.dmg/);
    assert.match(workflow, /AI-Config-Hub-\*-macos-arm64\.dmg/);
    assert.match(workflow, /release\/linux-x64\/elf-compatibility\.json/);
    assert.match(workflow, /release\/windows-x64\/version-manifest\.json/);
    assert.match(workflow, /release\/macos-x64\/version-manifest\.json/);
    assert.match(workflow, /release\/macos-arm64\/version-manifest\.json/);
    assert.match(workflow, /--repo "\$GITHUB_REPOSITORY"/);
    assert.match(workflow, /--verify-tag/);
```

Replace the Linux package workflow assertions in `builds Linux AppImages with the pinned Node runtime and parseable ELF evidence` with:

```js
    assert.match(workflow, /rockylinux\/rockylinux:8\.10@sha256:/);
    assert.match(workflow, /uses: pnpm\/action-setup@v4/);
    assert.match(workflow, /uses: actions\/setup-node@v4/);
    assert.match(workflow, /node-version-file: \.node-version/);
    assert.doesNotMatch(workflow, /dnf install .*nodejs npm/);
    assert.match(workflow, /pnpm package:linux:x64/);
    assert.match(workflow, /windows-latest/);
    assert.match(workflow, /macos-latest/);
    assert.match(workflow, /package:windows:x64/);
    assert.match(workflow, /package:macos:x64/);
    assert.match(workflow, /package:macos:arm64/);
    assert.match(auditScript, /JSON\.stringify/);
    assert.doesNotMatch(auditScript, /%q/);
```

- [ ] **Step 5: Run contract tests and verify RED**

Run:

```bash
node --test tests/packaging/config.test.mjs tests/packaging/release-evidence.test.mjs tests/tooling/workspace.test.mjs
```

Expected: FAIL. The failure must mention missing Windows/macOS packaging config, missing platform packaging scripts, unsupported manifest arguments, or missing release workflow candidate paths.

## Task 2: Add Platform Packaging Configuration And Scripts

**Files:**
- Modify: `package.json`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/electron-builder.yml`
- Test: `tests/packaging/config.test.mjs`
- Test: `tests/tooling/workspace.test.mjs`

- [ ] **Step 1: Update root package scripts**

In `package.json`, update the `scripts` object to include these exact entries while preserving unrelated existing scripts:

```json
{
  "test": "vitest run --coverage && pnpm test:contracts",
  "test:contracts": "node --test tests/tooling/*.test.mjs tests/packaging/*.test.mjs",
  "package:linux": "pnpm package:linux:x64",
  "package:linux:x64": "pnpm --filter @ai-config-hub/desktop package:linux:x64",
  "package:windows:x64": "pnpm --filter @ai-config-hub/desktop package:windows:x64",
  "package:macos:x64": "pnpm --filter @ai-config-hub/desktop package:macos:x64",
  "package:macos:arm64": "pnpm --filter @ai-config-hub/desktop package:macos:arm64",
  "release:sbom": "node scripts/release/generate-sbom.mjs",
  "release:evidence": "node scripts/release/generate-manifest.mjs",
  "release:verify": "node scripts/release/verify-artifacts.mjs"
}
```

- [ ] **Step 2: Update desktop package scripts**

In `apps/desktop/package.json`, update the packaging script entries to:

```json
{
  "package": "pnpm run build",
  "package:linux": "pnpm run package:linux:x64",
  "package:linux:x64": "pnpm run build && electron-builder --linux AppImage --x64 --config.directories.output=../../release/linux-x64",
  "package:windows:x64": "pnpm run build && electron-builder --win nsis --x64 --config.directories.output=../../release/windows-x64",
  "package:macos:x64": "pnpm run build && electron-builder --mac dmg --x64 --config.directories.output=../../release/macos-x64",
  "package:macos:arm64": "pnpm run build && electron-builder --mac dmg --arm64 --config.directories.output=../../release/macos-arm64"
}
```

- [ ] **Step 3: Update electron-builder targets**

Edit `apps/desktop/electron-builder.yml` so the platform sections match this content:

```yaml
directories:
  output: ../../release/linux-x64
files:
  - package.json
  - dist/main/**/*
  - dist/renderer/**/*
  - resources/**/*
  - ../../packages/*/dist/**/*
  - ../../packages/*/package.json
  - "!**/*.map"
  - "!**/*.test.*"
  - "!**/fixtures/**"
linux:
  target:
    - target: AppImage
      arch:
        - x64
  category: Development
  artifactName: AI-Config-Hub-${version}-x86_64.${ext}
win:
  target:
    - target: nsis
      arch:
        - x64
  artifactName: AI-Config-Hub-${version}-windows-x64.${ext}
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
mac:
  target:
    - target: dmg
      arch:
        - x64
        - arm64
  category: public.app-category.developer-tools
  artifactName: AI-Config-Hub-${version}-macos-${arch}.${ext}
```

Keep the existing top-level metadata above `directories`.

- [ ] **Step 4: Run packaging config tests**

Run:

```bash
node --test tests/packaging/config.test.mjs tests/tooling/workspace.test.mjs
```

Expected: the config and script assertions pass. Workflow assertions may still fail until Task 4.

## Task 3: Generalize Release Evidence Scripts

**Files:**
- Modify: `scripts/release/generate-manifest.mjs`
- Modify: `scripts/release/verify-artifacts.mjs`
- Test: `tests/packaging/release-evidence.test.mjs`

- [ ] **Step 1: Replace manifest generation script**

Use this complete content for `scripts/release/generate-manifest.mjs`:

```js
/* global process */
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const directory = process.argv[2] ?? "release/linux-x64";
const target = resolveTarget(directory, process.argv[3], process.argv[4]);
const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
const expectedNames = expectedPublishableNames(rootPackage.version, target);
const directoryEntries = new Set(await readdir(directory));

for (const requiredName of expectedNames.required) {
  if (!directoryEntries.has(requiredName)) {
    throw new Error(
      `Missing release artifact for ${target.platform}-${target.architecture}: ${requiredName}`,
    );
  }
}

const publishableNames = expectedNames.all.filter((file) => directoryEntries.has(file)).sort();
const artifacts = [];
for (const file of publishableNames) {
  const path = join(directory, file);
  if (!(await stat(path)).isFile()) continue;
  const bytes = await readFile(path);
  artifacts.push({
    name: basename(file),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  });
}

await writeFile(
  join(directory, "SHA256SUMS"),
  artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n") + "\n",
);

const manifest = {
  schemaVersion: 1,
  packageName: rootPackage.name,
  version: rootPackage.version,
  platform: target.platform,
  architecture: target.architecture,
  ...(target.platform === "linux" ? { glibcBaseline: "2.28" } : {}),
  generatedAt: new Date(0).toISOString(),
  artifacts,
};

await writeFile(join(directory, "version-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

function resolveTarget(directoryName, platformArg, architectureArg) {
  const directoryTarget = /^(linux|windows|macos)-(x64|arm64)$/.exec(
    basename(directoryName.replace(/[\\/]+$/, "")),
  );
  const platform = platformArg ?? directoryTarget?.[1] ?? "linux";
  const architecture = architectureArg ?? directoryTarget?.[2] ?? "x64";

  if (!["linux", "windows", "macos"].includes(platform)) {
    throw new Error(`Unsupported release platform: ${platform}`);
  }
  if (!["x64", "arm64"].includes(architecture)) {
    throw new Error(`Unsupported release architecture: ${architecture}`);
  }
  if (platform === "windows" && architecture !== "x64") {
    throw new Error("Windows release packaging only supports x64");
  }
  if (platform === "linux" && architecture !== "x64") {
    throw new Error("Linux release packaging only supports x64");
  }

  return { platform, architecture };
}

function expectedPublishableNames(version, target) {
  const key = `${target.platform}-${target.architecture}`;
  const installerByTarget = {
    "linux-x64": `AI-Config-Hub-${version}-x86_64.AppImage`,
    "windows-x64": `AI-Config-Hub-${version}-windows-x64.exe`,
    "macos-x64": `AI-Config-Hub-${version}-macos-x64.dmg`,
    "macos-arm64": `AI-Config-Hub-${version}-macos-arm64.dmg`,
  };
  const installer = installerByTarget[key];
  if (!installer) throw new Error(`Unsupported release target: ${key}`);

  const required = [installer, "sbom.cdx.json"];
  const all = target.platform === "linux" ? [...required, "elf-compatibility.json"] : required;
  return { required, all };
}
```

- [ ] **Step 2: Replace artifact verification script**

Use this complete content for `scripts/release/verify-artifacts.mjs`:

```js
/* global process */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const directories = process.argv.slice(2);
if (directories.length === 0) directories.push("release/linux-x64");

for (const directory of directories) {
  await verifyDirectory(directory);
}

async function verifyDirectory(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "version-manifest.json"), "utf8"));
  const checksums = await readFile(join(directory, "SHA256SUMS"), "utf8");
  const checksumLines = new Set(checksums.trim().split(/\r?\n/).filter(Boolean));

  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(join(directory, artifact.name));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== artifact.sha256) {
      throw new Error(`Checksum mismatch in ${directory}: ${artifact.name}`);
    }
    if (!checksumLines.has(`${sha256}  ${artifact.name}`)) {
      throw new Error(`SHA256SUMS missing in ${directory}: ${artifact.name}`);
    }
  }
}
```

- [ ] **Step 3: Run release evidence tests**

Run:

```bash
node --test tests/packaging/release-evidence.test.mjs
```

Expected: release evidence tests pass except workflow assertions that depend on Task 4.

## Task 4: Expand GitHub Actions Packaging And Release Publishing

**Files:**
- Modify: `.github/workflows/linux-package.yml`
- Modify: `.github/workflows/release.yml`
- Test: `tests/packaging/release-evidence.test.mjs`
- Test: `tests/tooling/workspace.test.mjs`

- [ ] **Step 1: Replace reusable packaging workflow**

Use this complete content for `.github/workflows/linux-package.yml`:

```yaml
name: Desktop Packages

on:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:
  workflow_dispatch:
  workflow_call:

permissions:
  contents: read

jobs:
  linux-x64:
    timeout-minutes: 30
    runs-on: ubuntu-latest
    container:
      image: rockylinux/rockylinux:8.10@sha256:e8a49c5403b687db05d4d67333fa45808fbe74f36e683cec7abb1f7d0f2338c6
    steps:
      - uses: actions/checkout@v4
      - run: dnf install -y git gcc make binutils file fuse-libs gtk3 nss atk at-spi2-atk cups-libs libdrm libXcomposite libXdamage libXrandr mesa-libgbm alsa-lib xorg-x11-server-Xvfb
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: node --version && pnpm --version
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
      - run: pnpm test:integration
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm build
      - run: pnpm package:linux:x64
      - run: pnpm release:sbom release/linux-x64/sbom.cdx.json
      - run: scripts/release/audit-linux-elf.sh release/linux-x64/AI-Config-Hub-*-x86_64.AppImage release/linux-x64/elf-compatibility.json
      - run: scripts/release/smoke-appimage.sh release/linux-x64/AI-Config-Hub-*-x86_64.AppImage
      - run: pnpm release:evidence release/linux-x64 linux x64
      - run: pnpm release:verify release/linux-x64
      - uses: actions/upload-artifact@v4
        with:
          name: linux-x64-release-candidate
          path: release/linux-x64
          if-no-files-found: error

  native-installers:
    timeout-minutes: 30
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            artifact: windows-x64
            package_script: package:windows:x64
            platform: windows
            arch: x64
            release_dir: release/windows-x64
          - os: macos-latest
            artifact: macos-x64
            package_script: package:macos:x64
            platform: macos
            arch: x64
            release_dir: release/macos-x64
          - os: macos-latest
            artifact: macos-arm64
            package_script: package:macos:arm64
            platform: macos
            arch: arm64
            release_dir: release/macos-arm64
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: node --version && pnpm --version
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm --filter @ai-config-hub/desktop test
      - run: pnpm ${{ matrix.package_script }}
      - run: pnpm release:sbom ${{ matrix.release_dir }}/sbom.cdx.json
      - run: pnpm release:evidence ${{ matrix.release_dir }} ${{ matrix.platform }} ${{ matrix.arch }}
      - run: pnpm release:verify ${{ matrix.release_dir }}
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}-release-candidate
          path: ${{ matrix.release_dir }}
          if-no-files-found: error
```

- [ ] **Step 2: Replace tag release publisher workflow**

Use this complete content for `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: read

jobs:
  package:
    permissions:
      contents: read
    uses: ./.github/workflows/linux-package.yml

  publish:
    needs: package
    timeout-minutes: 15
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: linux-x64-release-candidate
          path: release/linux-x64
      - uses: actions/download-artifact@v4
        with:
          name: windows-x64-release-candidate
          path: release/windows-x64
      - uses: actions/download-artifact@v4
        with:
          name: macos-x64-release-candidate
          path: release/macos-x64
      - uses: actions/download-artifact@v4
        with:
          name: macos-arm64-release-candidate
          path: release/macos-arm64
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm release:verify release/linux-x64 release/windows-x64 release/macos-x64 release/macos-arm64
      - name: Publish GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          assets=(
            release/linux-x64/AI-Config-Hub-*-x86_64.AppImage
            release/linux-x64/SHA256SUMS
            release/linux-x64/version-manifest.json
            release/linux-x64/sbom.cdx.json
            release/linux-x64/elf-compatibility.json
            release/windows-x64/AI-Config-Hub-*-windows-x64.exe
            release/windows-x64/SHA256SUMS
            release/windows-x64/version-manifest.json
            release/windows-x64/sbom.cdx.json
            release/macos-x64/AI-Config-Hub-*-macos-x64.dmg
            release/macos-x64/SHA256SUMS
            release/macos-x64/version-manifest.json
            release/macos-x64/sbom.cdx.json
            release/macos-arm64/AI-Config-Hub-*-macos-arm64.dmg
            release/macos-arm64/SHA256SUMS
            release/macos-arm64/version-manifest.json
            release/macos-arm64/sbom.cdx.json
          )
          for asset in "${assets[@]}"; do
            test -f "$asset"
          done
          if gh release view "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
            gh release upload "$GITHUB_REF_NAME" "${assets[@]}" --repo "$GITHUB_REPOSITORY" --clobber
          else
            gh release create "$GITHUB_REF_NAME" "${assets[@]}" \
              --repo "$GITHUB_REPOSITORY" \
              --title "$GITHUB_REF_NAME" \
              --generate-notes \
              --verify-tag
          fi
```

- [ ] **Step 3: Run workflow contract tests**

Run:

```bash
node --test tests/packaging/release-evidence.test.mjs tests/tooling/workspace.test.mjs
```

Expected: PASS.

## Task 5: Verification And Cleanup

**Files:**
- Modify only if earlier tasks reveal formatting or contract-test drift.

- [ ] **Step 1: Run node contract tests through the package script**

Run:

```bash
pnpm test:contracts
```

Expected: PASS for `tests/tooling/*.test.mjs` and `tests/packaging/*.test.mjs`.

- [ ] **Step 2: Run the release evidence script against fixture directories**

Run:

```bash
node --test tests/packaging/release-evidence.test.mjs
```

Expected: PASS and no checksum mismatch errors.

- [ ] **Step 3: Run TypeScript validation**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Run the full local test entrypoint if dependencies are installed**

Run:

```bash
pnpm test
```

Expected: PASS. This now includes Vitest coverage plus `pnpm test:contracts`.

- [ ] **Step 5: Inspect changed files**

Run:

```bash
git diff -- package.json apps/desktop/package.json apps/desktop/electron-builder.yml scripts/release/generate-manifest.mjs scripts/release/verify-artifacts.mjs .github/workflows/linux-package.yml .github/workflows/release.yml tests/packaging/config.test.mjs tests/packaging/release-evidence.test.mjs tests/tooling/workspace.test.mjs
```

Expected: the diff is limited to multiplatform packaging, evidence generation, workflow publishing, and their tests. Existing unrelated user changes remain untouched.

- [ ] **Step 6: Note platform packaging limits in the final response**

Report that local verification covers scripts, manifests, type checking, and contract tests. State that actual Windows NSIS and macOS DMG production must be verified by GitHub Actions native runners or by running the new package scripts on those operating systems.
