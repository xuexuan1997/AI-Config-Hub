import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const runtimeCompositionFiles = [
  "apps/cli/src/app-services.ts",
  "apps/desktop/src/main/composition.ts",
] as const;

describe("deployment lock lifetime", () => {
  it.each(runtimeCompositionFiles)("%s uses a runtime-scoped PathLockManager", async (file) => {
    const source = await readFile(file, "utf8");

    expect(source).toContain("readonly pathLocks: PathLockManager");
    expect(source).toContain("pathLocks: new PathLockManager()");
    expect(source).not.toMatch(/locks:\s*new PathLockManager\(\)/);
  });
});
