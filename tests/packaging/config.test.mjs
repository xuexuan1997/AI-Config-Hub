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
    assert.match(config, /directories:\r?\n\s+output: \.\.\/\.\.\/release\/linux-x64/);
    assert.match(config, /linux:[\s\S]*target: AppImage/);
    assert.match(config, /linux:[\s\S]*arch:\r?\n\s+- x64/);
    assert.match(config, /artifactName: AI-Config-Hub-\$\{version\}-x86_64\.\$\{ext\}/);
    assert.match(config, /category: Development/);
    assert.match(config, /win:[\s\S]*target: nsis/);
    assert.match(config, /win:[\s\S]*arch:\r?\n\s+- x64/);
    assert.match(config, /artifactName: AI-Config-Hub-\$\{version\}-windows-x64\.\$\{ext\}/);
    assert.match(config, /nsis:[\s\S]*allowToChangeInstallationDirectory: true/);
    assert.match(config, /mac:[\s\S]*target: dmg/);
    assert.match(config, /mac:[\s\S]*arch:\r?\n\s+- x64\r?\n\s+- arm64/);
    assert.match(config, /artifactName: AI-Config-Hub-\$\{version\}-macos-\$\{arch\}\.\$\{ext\}/);
    assert.match(config, /dist\/main\/\*\*\/\*/);
    assert.match(config, /dist\/renderer\/\*\*\/\*/);
    assert.match(config, /!\*\*\/\*\.test\.\*/);
    assert.match(config, /!\*\*\/fixtures\/\*\*/);
  });

  it("builds every desktop main workspace dependency before packaging", async () => {
    const manifest = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
    const buildMain = manifest.scripts["build:main"];

    for (const workspacePackage of [
      "@ai-config-hub/shared",
      "@ai-config-hub/core",
      "@ai-config-hub/adapters",
      "@ai-config-hub/api",
      "@ai-config-hub/deployer",
      "@ai-config-hub/git",
      "@ai-config-hub/scanner",
      "@ai-config-hub/storage",
    ]) {
      assert.match(buildMain, new RegExp(`pnpm --filter ${workspacePackage} build`));
    }
    assert.match(buildMain, /&& tsc -p tsconfig\.build\.json$/);
  });

  it("uses cross-platform workspace build scripts for native installer runners", async () => {
    const storage = JSON.parse(await readFile("packages/storage/package.json", "utf8"));

    assert.doesNotMatch(storage.scripts.build, /\brm\b/);
    assert.doesNotMatch(storage.scripts.build, /\bcp\b/);
    assert.match(storage.scripts.build, /node scripts\/copy-migrations\.mjs/);
  });
});
