import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { describe, it } from "node:test";

describe("desktop installer packaging config", () => {
  it("pins deterministic Linux, Windows, and macOS installer settings", async () => {
    const config = await readFile("apps/desktop/electron-builder.yml", "utf8");
    const manifest = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));

    assert.equal(manifest.main, "dist/main/main/main.js");
    assert.match(config, /^appId: io\.aiconfighub\.desktop$/m);
    assert.match(config, /^productName: AI Config Hub$/m);
    assert.match(config, /^executableName: ai-config-hub$/m);
    assert.match(config, /^icon: resources\/icon\.png$/m);
    assert.match(config, /^asar: true$/m);
    assert.match(config, /^npmRebuild: false$/m);
    assert.match(config, /^buildDependenciesFromSource: false$/m);
    assert.match(config, /^electronUpdaterCompatibility: ">= 2\.16"$/m);
    assert.match(config, /directories:\r?\n\s+output: \.\.\/\.\.\/release\/linux-x64/);
    assert.match(config, /linux:[\s\S]*target: AppImage/);
    assert.match(config, /linux:[\s\S]*icon: resources\/icon\.png/);
    assert.match(config, /linux:[\s\S]*arch:\r?\n\s+- x64/);
    assert.match(config, /artifactName: AI-Config-Hub-\$\{version\}-x86_64\.\$\{ext\}/);
    assert.match(config, /category: Development/);
    assert.match(
      config,
      /linux:[\s\S]*publish:\r?\n\s+provider: github\r?\n\s+owner: xuexuan1997\r?\n\s+repo: AI-Config-Hub/,
    );
    assert.match(config, /win:[\s\S]*target: nsis/);
    assert.match(config, /win:[\s\S]*icon: resources\/icon\.ico/);
    assert.match(config, /win:[\s\S]*arch:\r?\n\s+- x64/);
    assert.match(config, /artifactName: AI-Config-Hub-\$\{version\}-windows-x64\.\$\{ext\}/);
    assert.match(
      config,
      /win:[\s\S]*publish:\r?\n\s+provider: github\r?\n\s+owner: xuexuan1997\r?\n\s+repo: AI-Config-Hub/,
    );
    assert.match(config, /nsis:[\s\S]*allowToChangeInstallationDirectory: true/);
    assert.match(config, /mac:[\s\S]*target: dmg/);
    assert.match(config, /mac:[\s\S]*icon: resources\/icon\.icns/);
    assert.match(config, /mac:[\s\S]*arch:\r?\n\s+- x64\r?\n\s+- arm64/);
    assert.match(config, /artifactName: AI-Config-Hub-\$\{version\}-macos-\$\{arch\}\.\$\{ext\}/);
    assert.match(config, /dist\/main\/\*\*\/\*/);
    assert.match(config, /dist\/renderer\/\*\*\/\*/);
    assert.match(config, /!\*\*\/\*\.test\.\*/);
    assert.match(config, /!\*\*\/fixtures\/\*\*/);

    for (const iconPath of [
      "apps/desktop/resources/icon.svg",
      "apps/desktop/resources/icon.png",
      "apps/desktop/resources/icon.ico",
      "apps/desktop/resources/icon.icns",
    ]) {
      assert.ok((await stat(iconPath)).size > 0, `${iconPath} should be present`);
    }
  });

  it("builds every desktop main workspace dependency before packaging", async () => {
    const manifest = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
    const buildMain = manifest.scripts["build:main"];

    assert.match(manifest.scripts["package:linux:x64"], /--publish never/);
    assert.match(manifest.scripts["package:windows:x64"], /--publish never/);

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

  it("loads electron-updater through a CommonJS bridge", async () => {
    const updatesSource = await readFile("apps/desktop/src/main/updates.ts", "utf8");

    assert.match(updatesSource, /^import \{ createRequire \} from "node:module";$/m);
    assert.match(updatesSource, /createRequire\(import\.meta\.url\)/);
    assert.doesNotMatch(
      updatesSource,
      /import\s+\{\s*autoUpdater\s*\}\s+from\s+"electron-updater"/,
    );
    assert.doesNotMatch(
      updatesSource,
      /^const\s+\{\s*autoUpdater\s*\}\s*=\s*require\("electron-updater"\)/m,
    );
  });

  it("uses cross-platform workspace build scripts for native installer runners", async () => {
    const storage = JSON.parse(await readFile("packages/storage/package.json", "utf8"));

    assert.doesNotMatch(storage.scripts.build, /\brm\b/);
    assert.doesNotMatch(storage.scripts.build, /\bcp\b/);
    assert.match(storage.scripts.build, /node scripts\/copy-migrations\.mjs/);
  });
});
