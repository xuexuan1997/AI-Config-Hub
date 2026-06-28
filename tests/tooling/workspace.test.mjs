import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("workspace contract", () => {
  it("pins pnpm and exposes every required root command", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));

    assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
    for (const script of [
      "build",
      "dev",
      "typecheck",
      "lint",
      "test",
      "test:contracts",
      "test:integration",
      "test:e2e",
      "package:linux",
      "package:linux:x64",
      "package:windows:x64",
      "package:macos:x64",
      "package:macos:arm64",
      "release:sbom",
      "release:evidence",
      "release:verify",
      "package",
    ]) {
      assert.ok(script in manifest.scripts, `missing script: ${script}`);
    }
  });

  it("ignores TypeScript incremental build state", async () => {
    const gitignore = await readFile(".gitignore", "utf8");

    assert.match(gitignore, /^\*\.tsbuildinfo$/m);
  });

  it("pins phase-two dependencies in the package that owns each capability", async () => {
    const [storage, adapters, scanner] = await Promise.all(
      ["storage", "adapters", "scanner"].map(async (name) =>
        JSON.parse(await readFile(`packages/${name}/package.json`, "utf8")),
      ),
    );

    assert.equal(storage.dependencies["drizzle-orm"], "0.45.2");
    assert.equal(adapters.dependencies.yaml, "2.9.0");
    assert.equal(adapters.dependencies["smol-toml"], "1.6.1");
    assert.equal(adapters.dependencies["jsonc-parser"], "3.3.1");
    for (const manifest of [storage, adapters, scanner]) {
      assert.equal(manifest.scripts.test, "vitest run src");
    }
  });

  it("pins the secure desktop Electron and React toolchain", async () => {
    const manifest = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));

    assert.equal(manifest.dependencies.react, "19.2.7");
    assert.equal(manifest.dependencies["react-dom"], "19.2.7");
    assert.equal(manifest.devDependencies.electron, "42.4.1");
    assert.equal(manifest.devDependencies["electron-builder"], "26.15.3");
    assert.equal(manifest.devDependencies.vite, "8.0.16");
    assert.equal(manifest.devDependencies["@vitejs/plugin-react"], "6.0.2");
    assert.equal(manifest.devDependencies["@types/react"], "19.2.17");
    assert.equal(manifest.devDependencies["@types/react-dom"], "19.2.3");

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
  });

  it("installs pnpm before setup-node initializes its pnpm cache", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    const jobsSection = workflow.split(/^jobs:\s*$/m)[1];
    assert.ok(jobsSection, "workflow must define jobs");
    const jobs = jobsSection.split(/^ {2}[a-z][a-z-]+:\s*$/m).slice(1);

    assert.equal(jobs.length, 4);
    for (const job of jobs) {
      const installPnpm = job.indexOf("uses: pnpm/action-setup@v4");
      const setupNode = job.indexOf("uses: actions/setup-node@v4");

      assert.ok(installPnpm >= 0, "job must install pnpm");
      assert.ok(installPnpm < setupNode, "pnpm must be installed before setup-node cache lookup");
    }
  });

  it("publishes immutable tag-bound releases with narrow permissions", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    assert.match(workflow, /^\s+tags:\s*\["v\*"\]$/m);
    assert.match(workflow, /^\s+contents:\s*read$/m);
    assert.match(workflow, /^\s+package:\s*$/m);
    assert.match(workflow, /uses: \.\/\.github\/workflows\/linux-package\.yml/);
    assert.match(workflow, /^\s+publish:\s*$/m);
    assert.match(workflow, /^\s+needs:\s*package$/m);
    assert.match(workflow, /^\s+contents:\s*write$/m);
    assert.match(
      workflow,
      /pnpm release:verify release\/linux-x64 release\/windows-x64 release\/macos-x64 release\/macos-arm64/,
    );
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
  });

  it("builds Linux AppImages with the pinned Node runtime and parseable ELF evidence", async () => {
    const [workflow, auditScript] = await Promise.all([
      readFile(".github/workflows/linux-package.yml", "utf8"),
      readFile("scripts/release/audit-linux-elf.sh", "utf8"),
    ]);

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
  });
});
