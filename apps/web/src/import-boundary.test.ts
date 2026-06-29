import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const forbiddenImports = [
  "@ai-config-hub/adapters",
  "@ai-config-hub/core",
  "@ai-config-hub/deployer",
  "@ai-config-hub/git",
  "@ai-config-hub/scanner",
  "@ai-config-hub/storage",
  "node:fs",
  "node:child_process",
  "node:net",
  "node:http",
  "node:https",
];

describe("web app import boundary", () => {
  it("does not import privileged implementation packages", async () => {
    const sourceFiles = await listSourceFiles(new URL(".", import.meta.url).pathname);
    const violations: string[] = [];

    for (const file of sourceFiles) {
      if (file.endsWith(".test.ts")) continue;
      const source = await readFile(file, "utf8");
      for (const forbidden of forbiddenImports) {
        if (source.includes(`from "${forbidden}`) || source.includes(`from '${forbidden}`)) {
          violations.push(`${relative(process.cwd(), file)} imports ${forbidden}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listSourceFiles(path);
      if (/\.(?:ts|tsx)$/.test(entry.name)) return [path];
      return [];
    }),
  );
  return nested.flat();
}
