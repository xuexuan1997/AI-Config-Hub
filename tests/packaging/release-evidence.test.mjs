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
});
