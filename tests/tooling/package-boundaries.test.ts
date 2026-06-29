import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const packageNames = [
  "shared",
  "core",
  "api",
  "asset-library",
  "adapters",
  "scanner",
  "storage",
  "deployer",
  "git",
  "local-api",
] as const;

describe("package boundaries", () => {
  it.each(packageNames)("%s exposes only its public entry", async (name) => {
    const root = `packages/${name}`;
    await expect(access(`${root}/src/index.ts`)).resolves.toBeUndefined();
    const manifest = JSON.parse(await readFile(`${root}/package.json`, "utf8")) as {
      name: string;
      exports: Record<string, unknown>;
    };

    expect(manifest.name).toBe(`@ai-config-hub/${name}`);
    expect(Object.keys(manifest.exports)).toEqual(name === "api" ? [".", "./browser"] : ["."]);
  });
});
