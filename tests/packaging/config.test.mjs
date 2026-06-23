import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("desktop AppImage packaging config", () => {
  it("pins deterministic Linux x86_64 AppImage settings", async () => {
    const config = await readFile("apps/desktop/electron-builder.yml", "utf8");
    const manifest = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));

    assert.equal(manifest.main, "dist/main/main/main.js");
    assert.match(config, /^appId: io\.aiconfighub\.desktop$/m);
    assert.match(config, /^productName: AI Config Hub$/m);
    assert.match(config, /^executableName: ai-config-hub$/m);
    assert.match(config, /^asar: true$/m);
    assert.match(config, /^npmRebuild: false$/m);
    assert.match(config, /^buildDependenciesFromSource: false$/m);
    assert.match(config, /target: AppImage/);
    assert.match(config, /arch:\n\s+- x64/);
    assert.match(config, /artifactName: AI-Config-Hub-\$\{version\}-x86_64\.\$\{ext\}/);
    assert.match(config, /category: Development/);
    assert.match(config, /dist\/main\/\*\*\/\*/);
    assert.match(config, /dist\/renderer\/\*\*\/\*/);
    assert.match(config, /!\*\*\/\*\.test\.\*/);
    assert.match(config, /!\*\*\/fixtures\/\*\*/);
  });
});
