import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCliCommandServices } from "./app-services.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function writeUserConfigFixtures(home: string): Promise<void> {
  await mkdir(join(home, ".claude", "agents"), { recursive: true });
  await mkdir(join(home, ".claude", "skills", "release"), { recursive: true });
  await mkdir(join(home, ".cursor", "rules"), { recursive: true });
  await mkdir(join(home, ".cursor", "agents"), { recursive: true });
  await mkdir(join(home, ".cursor", "skills", "release"), { recursive: true });
  await mkdir(join(home, ".codex", "agents"), { recursive: true });
  await mkdir(join(home, ".agents", "skills", "release"), { recursive: true });
  await mkdir(join(home, ".opencode", "agents"), { recursive: true });
  await mkdir(join(home, ".opencode", "skills", "release"), { recursive: true });

  await writeFile(join(home, "CLAUDE.md"), "# User Claude guidance\nUse tests.\n", "utf8");
  await writeFile(join(home, "AGENTS.md"), "# User agent guidance\nUse tests.\n", "utf8");
  await writeFile(
    join(home, ".claude", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reviews code\n---\nReview carefully.\n",
    "utf8",
  );
  await writeFile(
    join(home, ".claude", "skills", "release", "SKILL.md"),
    "---\nname: release\ndescription: Release safely\n---\nRun checks.\n",
    "utf8",
  );
  await writeFile(
    join(home, ".mcp.json"),
    JSON.stringify({ mcpServers: { docs: { command: "npx", args: ["docs"] } } }),
    "utf8",
  );
  await writeFile(
    join(home, ".cursor", "rules", "user.mdc"),
    "---\ndescription: User Cursor rule\n---\nUse strict TypeScript.\n",
    "utf8",
  );
  await writeFile(
    join(home, ".cursor", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Review code\n---\nReview only.\n",
    "utf8",
  );
  await writeFile(
    join(home, ".cursor", "skills", "release", "SKILL.md"),
    "---\nname: release\ndescription: Release safely\n---\nRun checks.\n",
    "utf8",
  );
  await writeFile(
    join(home, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { docs: { url: "https://example.test/mcp" } } }),
    "utf8",
  );
  await writeFile(
    join(home, ".codex", "agents", "reviewer.toml"),
    'name = "reviewer"\ndescription = "Reviews code"\ndeveloper_instructions = "Review carefully."\n',
    "utf8",
  );
  await writeFile(
    join(home, ".agents", "skills", "release", "SKILL.md"),
    "---\nname: release\ndescription: Release safely\n---\nRun checks.\n",
    "utf8",
  );
  await writeFile(
    join(home, ".codex", "config.toml"),
    '[mcp_servers.docs]\ncommand = "npx"\nargs = ["docs"]\n',
    "utf8",
  );
  await writeFile(
    join(home, ".opencode", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Review code\n---\nReview only.\n",
    "utf8",
  );
  await writeFile(
    join(home, ".opencode", "skills", "release", "SKILL.md"),
    "---\nname: release\ndescription: Release safely\n---\nRun checks.\n",
    "utf8",
  );
  await writeFile(
    join(home, "opencode.jsonc"),
    '{"mcp":{"docs":{"type":"remote","url":"https://example.test/mcp"}}}',
    "utf8",
  );
}

describe("CLI command service composition", () => {
  it("clears local Git history through the settings clear command", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-clear-local-data-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    const historyRoot = join(userData, "history", "local-git");
    await mkdir(project);
    const runtime = await createCliCommandServices({
      cwd: project,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
      now: () => "2026-07-04T08:00:00.000Z",
    });

    try {
      const empty = await runtime.services["settings.clearLocalData"]({
        categories: ["deployment_history"],
        confirmation: "clear-local-data",
      });
      expect(empty.counts.localHistoryDirectories).toBe(0);

      await writeFile(join(historyRoot, "stale-history.txt"), "remove me\n", "utf8");
      const cleared = await runtime.services["settings.clearLocalData"]({
        categories: ["deployment_history"],
        confirmation: "clear-local-data",
      });

      expect(cleared.counts.localHistoryDirectories).toBe(1);
      await expect(readdir(historyRoot)).resolves.toEqual([]);
      if (platform() !== "win32") expect((await stat(historyRoot)).mode & 0o777).toBe(0o700);
    } finally {
      runtime.close();
    }
  });

  it("defaults scans to project plus standard user-level tool configuration roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-home-scan-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const home = join(root, "home");
    const userData = join(root, "user-data");
    await mkdir(project);
    await mkdir(home);
    await writeUserConfigFixtures(home);

    const runtime = await createCliCommandServices({
      cwd: project,
      homeDirectory: home,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
      now: () => "2026-06-28T08:00:00.000Z",
    });

    try {
      await runtime.services["scan.start"]({ mode: "full" });
      const assets = await runtime.services["assets.list"]({ limit: 200 });

      expect(new Set(assets.items.map(({ toolKey }) => toolKey))).toEqual(
        new Set(["claude-code", "codex", "cursor", "opencode"]),
      );
      expect(new Set(assets.items.map(({ resourceType }) => resourceType))).toEqual(
        new Set(["rule", "agent", "skill", "mcp"]),
      );
      expect(new Set(assets.items.map(({ scopeKind }) => scopeKind))).toEqual(new Set(["user"]));
    } finally {
      runtime.close();
    }
  });

  it("defaults scans from a subdirectory to tool configuration roots up to the Git root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-ancestor-scan-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const nested = join(project, "src", "app");
    const home = join(root, "home");
    const userData = join(root, "user-data");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await mkdir(home);
    await writeFile(join(project, "AGENTS.md"), "Use project TypeScript conventions.\n", "utf8");

    const runtime = await createCliCommandServices({
      cwd: nested,
      homeDirectory: home,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
      now: () => "2026-06-28T08:00:00.000Z",
    });

    try {
      await runtime.services["scan.start"]({ mode: "full" });
      const assets = await runtime.services["assets.list"]({ toolKeys: ["codex"], limit: 50 });

      expect(assets.items).toEqual([
        expect.objectContaining({
          resourceType: "rule",
          scopeKind: "project",
          logicalKey: "rule:AGENTS",
        }),
      ]);
    } finally {
      runtime.close();
    }
  });

  it("filters listed assets by scope kind and diagnostic severity", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-asset-filters-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const home = join(root, "home");
    const userData = join(root, "user-data");
    await mkdir(join(project, ".agents", "skills", "release"), { recursive: true });
    await mkdir(home);
    await writeUserConfigFixtures(home);
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");
    await writeFile(
      join(project, ".agents", "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: Release safely\nwhen_to_use: Project releases\n---\nRun checks.\n",
      "utf8",
    );

    const runtime = await createCliCommandServices({
      cwd: project,
      homeDirectory: home,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
      now: () => "2026-06-28T08:00:00.000Z",
    });

    try {
      await runtime.services["scan.start"]({ mode: "full" });

      const projectAssets = await runtime.services["assets.list"]({
        scopeKinds: ["project"],
        limit: 50,
      });
      expect(projectAssets.items.length).toBeGreaterThan(0);
      expect(new Set(projectAssets.items.map(({ scopeKind }) => scopeKind))).toEqual(
        new Set(["project"]),
      );

      const userAssets = await runtime.services["assets.list"]({
        scopeKinds: ["user"],
        limit: 50,
      });
      expect(userAssets.items.length).toBeGreaterThan(0);
      expect(new Set(userAssets.items.map(({ scopeKind }) => scopeKind))).toEqual(
        new Set(["user"]),
      );

      const warningAssets = await runtime.services["assets.list"]({
        diagnosticSeverity: "warning",
        limit: 50,
      });
      expect(warningAssets.items.length).toBeGreaterThan(0);
      expect(
        warningAssets.items.every(({ diagnosticCounts }) => diagnosticCounts.warning > 0),
      ).toBe(true);
      const releaseProjectAsset = warningAssets.items.find(
        ({ logicalKey, scopeKind }) => logicalKey.includes("release") && scopeKind === "project",
      );
      expect(releaseProjectAsset).toBeDefined();
    } finally {
      runtime.close();
    }
  });

  it("disables and re-enables existing assets without removing them from the project index", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-asset-status-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");

    const runtime = await createCliCommandServices({
      cwd: project,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
      now: () => "2026-06-28T08:00:00.000Z",
    });

    try {
      await runtime.services["scan.start"]({ mode: "full", roots: [project] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.logicalKey.includes("AGENTS"),
      );
      if (source === undefined) throw new Error("Expected scanned Codex AGENTS asset");
      expect(source.status).toBe("enabled");
      expect(
        (await runtime.services["assets.get"]({ assetId: source.id })).asset.disablementOptions,
      ).toEqual([
        {
          method: "hub_ignore",
          label: "Ignore inside AI Config Hub only",
          description: "Keep the tool configuration unchanged and ignore the asset in Hub.",
          recommended: true,
        },
        {
          method: "move_file",
          label: "Move file out of the tool load path",
          description: "Move the source file into the AI Config Hub disabled-assets area.",
          recommended: false,
        },
      ]);

      await expect(
        runtime.services["assets.disable"]({ assetId: "missing-asset", method: "hub_ignore" }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
      });

      expect(
        await runtime.services["assets.disable"]({ assetId: source.id, method: "hub_ignore" }),
      ).toEqual({
        assetId: source.id,
        status: "disabled",
      });
      expect((await runtime.services["assets.get"]({ assetId: source.id })).asset.status).toBe(
        "disabled",
      );
      const disabledAssets = await runtime.services["assets.list"]({ limit: 50 });
      expect(disabledAssets.items.find((asset) => asset.id === source.id)).toMatchObject({
        status: "disabled",
      });
      const disabledEffective = await runtime.services["effective.resolve"]({
        toolKey: "codex",
        projectId: project,
        targetScopeId: project,
        resourceTypes: ["rule"],
      });
      expect(disabledEffective.effective).toEqual([]);
      expect(disabledEffective.contributors).toEqual([]);
      expect(disabledEffective.ignored).toContainEqual({
        assetId: source.id,
        reasonCode: "ASSET_DISABLED",
      });

      await expect(
        runtime.services["migration.preview"]({
          sourceAssetIds: [source.id],
          targetToolKey: "cursor",
          targetScopeId: project,
          conflictPolicy: "replace",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

      expect(await runtime.services["assets.enable"]({ assetId: source.id })).toEqual({
        assetId: source.id,
        status: "enabled",
      });
      expect((await runtime.services["assets.get"]({ assetId: source.id })).asset.status).toBe(
        "enabled",
      );
    } finally {
      runtime.close();
    }
  });

  it("passes changed paths through to incremental scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-incremental-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(join(project, ".codex", "agents"), { recursive: true });
    const changedPath = join(project, "AGENTS.md");
    await writeFile(changedPath, "Use local TypeScript conventions.\n", "utf8");
    await writeFile(join(project, ".codex", "agents", "broken.toml"), "not = [valid\n", "utf8");

    const runtime = await createCliCommandServices({
      cwd: project,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
      now: () => "2026-06-28T08:00:00.000Z",
    });

    try {
      await runtime.services["scan.start"]({ mode: "full", roots: [project] });
      const incremental = await runtime.services["scan.start"]({
        mode: "incremental",
        roots: [project],
        changedPaths: [changedPath],
      });
      const status = await runtime.services["scan.status"]({ taskId: incremental.taskId });

      expect(status).toMatchObject({
        status: "succeeded",
        resultSummary: { failedCount: 0 },
      });
      expect(status.resultSummary?.succeededCount).toBeGreaterThan(0);
    } finally {
      runtime.close();
    }
  });

  it("returns sorted source files for multi-file skill assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-source-files-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(join(project, ".agents", "skills", "release", "assets"), { recursive: true });
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");
    await writeFile(
      join(project, ".agents", "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: Release safely\n---\nRun the checklist.\n",
      "utf8",
    );
    await writeFile(
      join(project, ".agents", "skills", "release", "assets", "notes.md"),
      "Release notes template\n",
      "utf8",
    );

    const runtime = await createCliCommandServices({
      cwd: project,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
      now: () => "2026-06-28T08:00:00.000Z",
    });

    try {
      await runtime.services["scan.start"]({ mode: "full", roots: [project] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.resourceType === "skill",
      );
      if (source === undefined) throw new Error("Expected scanned Codex skill asset");

      const detail = await runtime.services["assets.get"]({ assetId: source.id });

      expect(detail.source.files.map((file) => [file.role, file.relativePath])).toEqual([
        ["primary", "SKILL.md"],
        ["support", "assets/notes.md"],
      ]);
      expect(detail.source.files[0]?.pathDisplay).toContain("SKILL.md");
    } finally {
      runtime.close();
    }
  });

  it("executes source copy operations from source package roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-source-copy-preview-"));
    temporaryDirectories.push(root);
    const sourceProject = join(root, "source");
    const targetProject = join(root, "target");
    const userData = join(root, "user-data");
    await mkdir(join(sourceProject, ".agents", "skills", "release", "assets"), {
      recursive: true,
    });
    await mkdir(targetProject);
    await writeFile(
      join(sourceProject, "AGENTS.md"),
      "Use local TypeScript conventions.\n",
      "utf8",
    );
    await writeFile(
      join(sourceProject, ".agents", "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: Release safely\n---\nRun the checklist.\n",
      "utf8",
    );
    await writeFile(
      join(sourceProject, ".agents", "skills", "release", "assets", "notes.md"),
      "Release notes template\n",
      "utf8",
    );

    const runtime = await createCliCommandServices({
      cwd: sourceProject,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
      now: () => "2026-06-28T08:00:00.000Z",
    });

    try {
      await runtime.services["scan.start"]({ mode: "full", roots: [sourceProject] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.resourceType === "skill",
      );
      if (source === undefined) throw new Error("Expected scanned Codex skill asset");
      const detail = await runtime.services["assets.get"]({ assetId: source.id });
      const supportFile = detail.source.files.find(
        (file) => file.relativePath === "assets/notes.md",
      );
      if (supportFile === undefined) throw new Error("Expected scanned skill support file");

      const preview = await runtime.services["migration.preview"]({
        sourceAssetIds: [source.id],
        targetToolKey: "cursor",
        targetScopeId: targetProject,
        conflictPolicy: "replace",
      });
      const copyChange = preview.changes.find((change) => change.deploymentType === "copy");

      expect(copyChange).toMatchObject({
        operation: "create",
        sourcePathDisplay: supportFile.pathDisplay,
        afterHash: supportFile.contentHash,
      });
      const history = await runtime.services["history.list"]({ kinds: ["deployment"], limit: 10 });
      const planned = history.items.find((entry) => entry.status === "planned");
      if (planned === undefined) throw new Error("Expected planned deployment history entry");
      const historyDetail = await runtime.services["history.get"]({ id: planned.id });
      expect(
        historyDetail.changes.find((change) => change.deploymentType === "copy"),
      ).toMatchObject({
        sourcePathDisplay: supportFile.pathDisplay,
        afterHash: supportFile.contentHash,
      });

      const deployment = await runtime.services["deployment.execute"]({
        planId: preview.planId,
        confirmedPlanHash: preview.planHash,
        confirmations: [],
      });

      expect(deployment.deploymentId).toBe(planned.id);
      await expect(
        readFile(join(targetProject, ".cursor", "skills", "release", "assets", "notes.md"), "utf8"),
      ).resolves.toBe("Release notes template\n");
    } finally {
      runtime.close();
    }
  });

  it("records local Git snapshots for successful deployments and rollbacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-history-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");

    const runtime = await createCliCommandServices({
      cwd: project,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
      now: () => "2026-06-28T08:00:00.000Z",
    });

    try {
      await runtime.services["scan.start"]({ mode: "full", roots: [project] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.logicalKey.includes("AGENTS"),
      );
      if (source === undefined) throw new Error("Expected scanned Codex AGENTS asset");

      const preview = await runtime.services["migration.preview"]({
        sourceAssetIds: [source.id],
        targetToolKey: "cursor",
        targetScopeId: project,
        conflictPolicy: "replace",
      });
      const deployment = await runtime.services["deployment.execute"]({
        planId: preview.planId,
        confirmedPlanHash: preview.planHash,
        confirmations: preview.requiredConfirmations,
      });
      expect(deployment.snapshot).toMatchObject({
        status: "recorded",
        message: `record deployment ${deployment.deploymentId}`,
      });

      const rollback = await runtime.services["deployment.rollback"]({
        deploymentId: deployment.deploymentId,
      });
      expect(rollback.snapshot).toMatchObject({
        status: "recorded",
        message: `record deployment ${rollback.rollbackId}`,
      });

      const history = await runtime.services["history.list"]({ limit: 10 });
      expect(history.items.find((entry) => entry.id === deployment.deploymentId)).toMatchObject({
        snapshot: {
          status: "recorded",
          commitId: deployment.snapshot?.status === "recorded" ? deployment.snapshot.commitId : "",
          authoredAt:
            deployment.snapshot?.status === "recorded" ? deployment.snapshot.authoredAt : "",
          message: `record deployment ${deployment.deploymentId}`,
        },
      });
      expect(history.items.find((entry) => entry.id === rollback.rollbackId)).toMatchObject({
        kind: "rollback",
        snapshot: {
          status: "recorded",
          commitId: rollback.snapshot?.status === "recorded" ? rollback.snapshot.commitId : "",
          message: `record deployment ${rollback.rollbackId}`,
        },
      });
      const detail = await runtime.services["history.get"]({ id: deployment.deploymentId });
      expect(detail).toMatchObject({
        entry: { id: deployment.deploymentId, kind: "deployment", status: "succeeded" },
        plan: {
          planId: preview.planId,
          planHash: preview.planHash,
          requiredConfirmations: preview.requiredConfirmations,
        },
      });
      expect(detail.changes).toEqual(preview.changes);

      const historyRoot = join(userData, "history", "local-git");
      if (platform() !== "win32") expect((await stat(historyRoot)).mode & 0o777).toBe(0o700);
      expect(await readdir(join(historyRoot, "assets"))).toHaveLength(1);
    } finally {
      runtime.close();
    }
  }, 15_000);

  it("does not fail a successful deployment when the local Git snapshot fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-history-failure-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    const historyRoot = join(userData, "history", "local-git");
    await mkdir(project);
    await mkdir(historyRoot, { recursive: true });
    await writeFile(join(historyRoot, "stray.txt"), "not managed by snapshots\n", "utf8");
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");

    const runtime = await createCliCommandServices({
      cwd: project,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
      now: () => "2026-06-28T08:00:00.000Z",
    });

    try {
      await runtime.services["scan.start"]({ mode: "full", roots: [project] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.logicalKey.includes("AGENTS"),
      );
      if (source === undefined) throw new Error("Expected scanned Codex AGENTS asset");
      const preview = await runtime.services["migration.preview"]({
        sourceAssetIds: [source.id],
        targetToolKey: "cursor",
        targetScopeId: project,
        conflictPolicy: "replace",
      });

      const deployment = await runtime.services["deployment.execute"]({
        planId: preview.planId,
        confirmedPlanHash: preview.planHash,
        confirmations: preview.requiredConfirmations,
      });

      expect(deployment.deploymentId).toMatch(/^deployment-record:/);
      expect(deployment.snapshot).toMatchObject({
        status: "failed",
        error: { code: "CONFLICT" },
      });
      const history = await runtime.services["history.list"]({ kinds: ["deployment"], limit: 10 });
      const historyItem = history.items.find((item) => item.id === deployment.deploymentId);
      expect(historyItem).toMatchObject({ id: deployment.deploymentId, status: "succeeded" });
      expect(historyItem?.snapshot).toMatchObject({ status: "unavailable" });
    } finally {
      runtime.close();
    }
  });

  it("maps partial conversion details into migration preview field losses", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-field-loss-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(join(project, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(project, ".claude", "agents", "reviewer.md"),
      "---\nname: reviewer\nmodel: sonnet\ntools: Read, Grep\n---\nReview carefully.\n",
      "utf8",
    );

    const runtime = await createCliCommandServices({
      cwd: project,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
      now: () => "2026-06-28T08:00:00.000Z",
    });

    try {
      await runtime.services["scan.start"]({ mode: "full", roots: [project] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "claude-code" && asset.resourceType === "agent",
      );
      if (source === undefined) throw new Error("Expected scanned Claude agent asset");

      const preview = await runtime.services["migration.preview"]({
        sourceAssetIds: [source.id],
        targetToolKey: "codex",
        targetScopeId: project,
        conflictPolicy: "replace",
      });

      expect(preview.compatibility).toBe("partial");
      expect(preview.requiredConfirmations).toContain("partial_conversion");
      expect(preview.fieldLosses).toEqual([
        {
          assetId: source.id,
          droppedFields: ["/data/allowedTools", "/data/description"],
          retainedFields: ["/data/name", "/data/instructions", "/data/model"],
          transformedFields: [],
          warnings: expect.arrayContaining([
            expect.stringContaining("/data/allowedTools"),
            expect.stringContaining("/data/description"),
          ]) as unknown,
        },
      ]);
    } finally {
      runtime.close();
    }
  });

  it("persists all public settings exposed by the API", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-settings-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project, { recursive: true });

    const runtime = await createCliCommandServices({
      cwd: project,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
      now: () => "2026-06-28T08:00:00.000Z",
    });

    try {
      const initial = await runtime.services["settings.get"]({});
      expect(initial.values).toMatchObject({
        theme: "system",
        language: "system",
        pathDisplay: "abbreviated",
        scanHints: true,
        fileWatching: true,
      });

      const updated = await runtime.services["settings.update"]({
        expectedRevision: initial.revision,
        patch: {
          theme: "dark",
          language: "zh-CN",
          pathDisplay: "full",
          scanHints: false,
          fileWatching: false,
        },
      });
      expect(updated.values).toEqual({
        theme: "dark",
        language: "zh-CN",
        pathDisplay: "full",
        scanHints: false,
        fileWatching: false,
      });

      const selected = await runtime.services["settings.get"]({
        keys: ["theme", "scanHints"],
      });
      expect(selected.values).toEqual({ theme: "dark", scanHints: false });
    } finally {
      runtime.close();
    }
  });

  it("rejects migration previews that mix source resource types", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-mixed-migration-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(join(project, ".agents", "skills", "release"), { recursive: true });
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");
    await writeFile(
      join(project, ".agents", "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: Release safely\n---\nRun the checklist.\n",
      "utf8",
    );

    const runtime = await createCliCommandServices({
      cwd: project,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
      now: () => "2026-06-28T08:00:00.000Z",
    });

    try {
      await runtime.services["scan.start"]({ mode: "full", roots: [project] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const rule = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.resourceType === "rule",
      );
      const skill = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.resourceType === "skill",
      );
      if (rule === undefined) throw new Error("Expected scanned Codex rule asset");
      if (skill === undefined) throw new Error("Expected scanned Codex skill asset");

      await runtime.services["migration.preview"]({
        sourceAssetIds: [rule.id, skill.id],
        targetToolKey: "cursor",
        targetScopeId: project,
        conflictPolicy: "replace",
      }).then(
        () => {
          throw new Error("Expected mixed resource migration preview to fail");
        },
        (error: unknown) => {
          expect(error).toMatchObject({ code: "VALIDATION_FAILED" });
          if (!(error instanceof Error)) throw error;
          expect(error.message).toContain("same resource type");
        },
      );
    } finally {
      runtime.close();
    }
  });

  it("exports filtered diagnostics with shortened and redacted paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-diagnostic-export-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const project = join(home, "sk-live-secret", "project");
    const userData = join(root, "user-data");
    await mkdir(join(project, ".agents", "skills", "release"), { recursive: true });
    await writeFile(join(project, "AGENTS.md"), "Use local conventions.\n", "utf8");
    await writeFile(
      join(project, ".agents", "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: Release safely\nwhen_to_use: Project releases\n---\nRun checks.\n",
      "utf8",
    );

    const runtime = await createCliCommandServices({
      cwd: project,
      homeDirectory: home,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
      now: () => "2026-06-28T08:00:00.000Z",
    });

    try {
      const scan = await runtime.services["scan.start"]({
        mode: "full",
        roots: [project],
        toolKeys: ["codex"],
      });
      const report = await runtime.services["diagnostics.export"]({
        format: "markdown",
        taskId: scan.taskId,
        toolKeys: ["codex"],
        severities: ["warning"],
      });

      expect(report.summary).toEqual({ total: 1, info: 0, warning: 1, error: 0 });
      expect(report.content).toContain("# Diagnostic report");
      expect(report.content).toContain("<project>/.agents/skills/release/SKILL.md");
      expect(report.content).not.toContain(home);
      expect(report.content).not.toContain("sk-live-secret");
      expect(report.redactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ pointer: "/items/0/location/pathDisplay", reason: "path" }),
        ]),
      );

      const offsetWindow = await runtime.services["diagnostics.export"]({
        format: "markdown",
        from: "2026-06-28T16:00:00+08:00",
        to: "2026-06-30T08:00:00.000Z",
        toolKeys: ["codex"],
        severities: ["warning"],
      });
      expect(offsetWindow.summary.total).toBe(1);

      const listed = await runtime.services["diagnostics.list"]({
        limit: 50,
        toolKeys: ["codex"],
        codes: ["SKILL_UNSUPPORTED_NATIVE_FIELD"],
      });
      expect(listed.items).toHaveLength(1);

      const wrongCode = await runtime.services["diagnostics.list"]({
        limit: 50,
        toolKeys: ["codex"],
        codes: ["MISSING_REFERENCE"],
      });
      expect(wrongCode.items).toHaveLength(0);

      const empty = await runtime.services["diagnostics.export"]({
        format: "markdown",
        toolKeys: ["cursor"],
        severities: ["warning"],
      });
      expect(empty.summary.total).toBe(0);
    } finally {
      runtime.close();
    }
  });

  it("exports parse diagnostics by tool even when no asset was indexed", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-cli-diagnostic-parse-export-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(join(project, ".codex", "agents"), { recursive: true });
    await writeFile(join(project, ".codex", "agents", "broken.toml"), "name = [\n", "utf8");

    const runtime = await createCliCommandServices({
      cwd: project,
      env: { AI_CONFIG_HUB_USER_DATA: userData },
    });

    try {
      await runtime.services["scan.start"]({
        mode: "full",
        roots: [project],
        toolKeys: ["codex"],
      });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      expect(assets.items).toHaveLength(0);

      const report = await runtime.services["diagnostics.export"]({
        format: "markdown",
        projectId: project,
        toolKeys: ["codex"],
        severities: ["error"],
      });

      expect(report.summary).toEqual({ total: 1, info: 0, warning: 0, error: 1 });
      expect(report.items[0]).toMatchObject({ code: "ADAPTER_PARSE_INVALID", severity: "error" });
      expect(report.content).toContain("<project>/.codex/agents/broken.toml");
      expect(report.content).not.toContain(project);
    } finally {
      runtime.close();
    }
  });
});
