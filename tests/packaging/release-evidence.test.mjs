import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("release evidence scripts", () => {
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
    await execFileAsync("node", [
      "scripts/release/generate-manifest.mjs",
      windows,
      "windows",
      "x64",
    ]);
    await execFileAsync("node", [
      "scripts/release/generate-manifest.mjs",
      macosArm,
      "macos",
      "arm64",
    ]);
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
    const windowsManifest = JSON.parse(
      await readFile(join(windows, "version-manifest.json"), "utf8"),
    );
    assert.match(windowsSums, /AI-Config-Hub-0\.2\.0-windows-x64\.exe/);
    assert.doesNotMatch(windowsSums, /elf-compatibility\.json/);
    assert.equal(windowsManifest.platform, "windows");
    assert.equal(windowsManifest.architecture, "x64");
    assert.equal("glibcBaseline" in windowsManifest, false);

    const macosSums = await readFile(join(macosArm, "SHA256SUMS"), "utf8");
    const macosManifest = JSON.parse(
      await readFile(join(macosArm, "version-manifest.json"), "utf8"),
    );
    assert.match(macosSums, /AI-Config-Hub-0\.2\.0-macos-arm64\.dmg/);
    assert.doesNotMatch(macosSums, /builder-debug\.yml/);
    assert.equal(macosManifest.platform, "macos");
    assert.equal(macosManifest.architecture, "arm64");
    assert.equal("glibcBaseline" in macosManifest, false);
  });

  it("keeps AppImage smoke bounded and headless", async () => {
    const smokeScript = await readFile("scripts/release/smoke-appimage.sh", "utf8");

    assert.match(smokeScript, /pwd -P/);
    assert.match(smokeScript, /timeout 120 "\$artifact" --appimage-extract/);
    assert.match(smokeScript, /squashfs-root\/AppRun/);
    assert.match(smokeScript, /squashfs-root\/ai-config-hub/);
    assert.match(smokeScript, /resources\/app\.asar/);
    assert.doesNotMatch(smokeScript, /--appimage-extract-and-run/);
  });

  it("uses bounded release workflows without network-only SBOM generation", async () => {
    const packageWorkflow = await readFile(".github/workflows/linux-package.yml", "utf8");
    const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");

    assert.match(packageWorkflow, /timeout-minutes: 30/);
    assert.match(packageWorkflow, /pnpm release:sbom release\/linux-x64\/sbom\.cdx\.json/);
    assert.match(
      packageWorkflow,
      /pnpm release:sbom \$\{\{ matrix\.release_dir \}\}\/sbom\.cdx\.json/,
    );
    assert.doesNotMatch(packageWorkflow, /pnpm dlx @cyclonedx\/cyclonedx-npm/);
    assert.match(releaseWorkflow, /timeout-minutes: 15/);
    assert.match(releaseWorkflow, /linux-x64-release-candidate/);
    assert.match(releaseWorkflow, /windows-x64-release-candidate/);
    assert.match(releaseWorkflow, /macos-x64-release-candidate/);
    assert.match(releaseWorkflow, /macos-arm64-release-candidate/);
    assert.match(releaseWorkflow, /gh release upload "\$GITHUB_REF_NAME"/);
    assert.match(releaseWorkflow, /--clobber/);
  });
});
