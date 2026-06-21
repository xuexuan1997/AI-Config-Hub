import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  claudeCodeRegistration,
  codexRegistration,
  cursorRegistration,
  opencodeRegistration,
} from "@ai-config-hub/adapters";
import { createNodeFileAccess, ScanService } from "@ai-config-hub/scanner";
import { AbsolutePathSchema } from "@ai-config-hub/shared";
import { createStorageRepositories, openDatabase } from "@ai-config-hub/storage";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const files = {
  "CLAUDE.md": "# Claude rule\nUse tests.\n",
  ".claude/agents/reviewer.md": "---\nname: claude-reviewer\ntools: [Read]\n---\nReview.\n",
  ".claude/agents/broken.md": "---\nname: broken\n",
  ".claude/skills/release/SKILL.md": "---\nname: claude-release\n---\nRelease.\n",
  ".mcp.json": `{"mcpServers":{"claude-docs":{"command":"npx","args":["docs"],"env":{"TOKEN":"top-secret-canary"}}}}`,
  ".cursor/rules/project.mdc": "---\nglobs: [src/**/*.ts]\n---\nStrict TypeScript.\n",
  ".cursor/agents/reviewer.md": "---\nname: cursor-reviewer\n---\nReview.\n",
  ".cursor/skills/refactor/SKILL.md": "---\nname: cursor-refactor\n---\nRefactor.\n",
  ".cursor/mcp.json": `{"mcpServers":{"cursor-docs":{"url":"https://example.test/mcp","headers":{"Authorization":"Bearer top-secret-canary"}}}}`,
  "AGENTS.md": "# Shared Codex/OpenCode rule\nKeep changes small.\n",
  "src/AGENTS.override.md": "# Nested override\nUse modules.\n",
  ".codex/agents/reviewer.toml": `name="codex-reviewer"\ndescription="Review"\ndeveloper_instructions="Review carefully."\n`,
  ".agents/skills/codex/SKILL.md": "---\nname: codex-skill\n---\nUse Codex.\n",
  ".codex/config.toml": `[mcp_servers.codex_docs]\ncommand="npx"\nargs=["docs","--token=top-secret-canary"]\nenv_vars=["DOCS_TOKEN"]\n`,
  ".opencode/agents/planner.md": "---\nname: opencode-planner\n---\nPlan.\n",
  ".opencode/skills/ship/SKILL.md": "---\nname: opencode-ship\n---\nShip.\n",
  "docs/local.md": "# Local OpenCode instruction\nStay local.\n",
  "opencode.jsonc": `{
    "instructions":["docs/local.md","https://example.test/never-fetch.md"],
    "agent":{"config-agent":{"prompt":"Plan from config.","description":"Planner"}},
    "mcp":{"open-docs":{"type":"local","command":["npx","docs"],"environment":{"TOKEN":"top-secret-canary"}}}
  }`,
} as const;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ai-config-hub-integration-"));
  temporaryDirectories.push(directory);
  const project = join(directory, "project");
  const state = join(directory, "state");
  await mkdir(project);
  await mkdir(state);
  for (const [relativePath, text] of Object.entries(files)) {
    const target = join(project, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
  }
  return { project, databasePath: join(state, "index.sqlite") };
}

async function sourceHashes(project: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const relativePath of Object.keys(files)) {
    hashes[relativePath] = createHash("sha256")
      .update(await readFile(join(project, relativePath)))
      .digest("hex");
  }
  return hashes;
}

describe("real four-tool scan", () => {
  it("rebuilds stable secret-free indexes without mutating source files", async () => {
    const { project, databasePath } = await fixture();
    const projectRoot = AbsolutePathSchema.parse(project);
    const before = await sourceHashes(project);
    const firstOpen = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const firstRepositories = createStorageRepositories(firstOpen);
    const access = await createNodeFileAccess({ allowedRoots: [projectRoot] });
    const service = new ScanService({
      registrations: [
        claudeCodeRegistration,
        codexRegistration,
        cursorRegistration,
        opencodeRegistration,
      ],
      read: access.read,
      snapshots: access.snapshots,
      indexRepository: firstRepositories.index,
      now: () => "2026-06-21T08:00:00.000Z",
    });
    const result = await service.scan({
      scanRunId: "integration-scan-1",
      candidateRoots: [projectRoot],
      homeDirectory: projectRoot,
      platform:
        process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
      signal: { aborted: false, throwIfAborted() {} },
    });
    expect(result.summary.status).toBe("partially_succeeded");
    const firstAssets = (await firstRepositories.index.listAssets({ limit: 500 })).items;
    for (const toolId of ["claude-code", "codex", "cursor", "opencode"] as const) {
      expect(
        new Set(
          firstAssets
            .filter((asset) => asset.toolId === toolId)
            .map((asset) => asset.resource.kind),
        ),
      ).toEqual(new Set(["rule", "agent", "skill", "mcp"]));
    }
    const firstIds = firstAssets.map(({ assetId }) => assetId).sort();
    expect(await sourceHashes(project)).toEqual(before);
    firstOpen.database.close();
    expect((await readFile(databasePath)).includes(Buffer.from("top-secret-canary"))).toBe(false);

    await rm(databasePath, { force: true });
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    const secondOpen = await openDatabase({ path: databasePath, appVersion: "0.1.0" });
    const secondRepositories = createStorageRepositories(secondOpen);
    const secondService = new ScanService({
      registrations: [
        claudeCodeRegistration,
        codexRegistration,
        cursorRegistration,
        opencodeRegistration,
      ],
      read: access.read,
      snapshots: access.snapshots,
      indexRepository: secondRepositories.index,
      now: () => "2026-06-21T09:00:00.000Z",
    });
    await secondService.scan({
      scanRunId: "integration-scan-2",
      candidateRoots: [projectRoot],
      homeDirectory: projectRoot,
      platform:
        process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
      signal: { aborted: false, throwIfAborted() {} },
    });
    expect(
      (await secondRepositories.index.listAssets({ limit: 500 })).items
        .map(({ assetId }) => assetId)
        .sort(),
    ).toEqual(firstIds);
    expect(await sourceHashes(project)).toEqual(before);
    secondOpen.database.close();
  });
});
