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
  it("generates deterministic checksums and verifies them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aich-release-"));
    await mkdir(directory, { recursive: true });
    await mkdir(join(directory, "linux-unpacked"), { recursive: true });
    await writeFile(join(directory, "AI-Config-Hub-0.2.0-x86_64.AppImage"), "demo");
    await writeFile(join(directory, "builder-debug.yml"), "internal: true\n");
    await writeFile(join(directory, "elf-compatibility.json"), "{}\n");
    await writeFile(join(directory, "sbom.cdx.json"), "{}\n");

    await execFileAsync("node", ["scripts/release/generate-manifest.mjs", directory]);
    await execFileAsync("node", ["scripts/release/verify-artifacts.mjs", directory]);

    const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
    const manifest = await readFile(join(directory, "version-manifest.json"), "utf8");
    assert.match(sums, /AI-Config-Hub-0\.2\.0-x86_64\.AppImage/);
    assert.match(sums, /elf-compatibility\.json/);
    assert.doesNotMatch(sums, /builder-debug\.yml/);
    assert.doesNotMatch(sums, /linux-unpacked/);
    assert.match(manifest, /"architecture": "x86_64"/);
    assert.match(manifest, /"glibcBaseline": "2.28"/);
  });

  it("keeps AppImage smoke bounded and headless", async () => {
    const smokeScript = await readFile("scripts/release/smoke-appimage.sh", "utf8");

    assert.match(smokeScript, /timeout 60/);
    assert.match(smokeScript, /ELECTRON_RUN_AS_NODE=1/);
    assert.match(smokeScript, /process\.versions\.electron/);
  });

  it("uses bounded release workflows without network-only SBOM generation", async () => {
    const packageWorkflow = await readFile(".github/workflows/linux-package.yml", "utf8");
    const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");

    assert.match(packageWorkflow, /timeout-minutes: 30/);
    assert.match(packageWorkflow, /pnpm release:sbom/);
    assert.doesNotMatch(packageWorkflow, /pnpm dlx @cyclonedx\/cyclonedx-npm/);
    assert.match(releaseWorkflow, /timeout-minutes: 15/);
    assert.match(releaseWorkflow, /gh release upload "\$GITHUB_REF_NAME"/);
    assert.match(releaseWorkflow, /--clobber/);
  });
});
