import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createTaskEventCursor,
  type CommandRequest,
  type CommandResponse,
  type TaskEvent,
} from "@ai-config-hub/api";
import type { Asset, DeploymentRecord, EffectiveConfig } from "@ai-config-hub/core";
import { NodeDeploymentFilePort } from "@ai-config-hub/deployer";
import { WatchService, type WatchBatch } from "@ai-config-hub/scanner";
import { AbsolutePathSchema, ContentHashSchema } from "@ai-config-hub/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertEffectiveResponseArrayBound,
  createDesktopCommandServices,
  DesktopTaskEvents,
  resetLocalHistory,
} from "./composition.js";

const temporaryDirectories: string[] = [];
type DesktopRuntimeFixture = Awaited<ReturnType<typeof createDesktopCommandServices>>;

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForTask(
  runtime: DesktopRuntimeFixture,
  taskId: string,
): Promise<readonly TaskEvent[]> {
  return new Promise((resolve, reject) => {
    const events: TaskEvent[] = [];
    const subscription: { unsubscribe?: () => void } = {};
    let settled = false;
    const timer = setTimeout(() => {
      subscription.unsubscribe?.();
      reject(new Error(`Timed out waiting for task ${taskId}`));
    }, 10_000);
    const listener = (event: TaskEvent) => {
      events.push(event);
      if (event.type !== "completed" || settled) return;
      settled = true;
      clearTimeout(timer);
      subscription.unsubscribe?.();
      resolve(events);
    };
    subscription.unsubscribe = runtime.taskEvents.subscribe(taskId, 0, listener);
    if (settled) subscription.unsubscribe();
  });
}

async function startScanAndWait(
  runtime: DesktopRuntimeFixture,
  request: CommandRequest<"scan.start">,
): Promise<CommandResponse<"scan.start">> {
  const accepted = await runtime.services["scan.start"](request);
  await waitForTask(runtime, accepted.taskId);
  return accepted;
}

async function executeDeploymentAndWait(
  runtime: DesktopRuntimeFixture,
  request: CommandRequest<"deployment.execute">,
): Promise<CommandResponse<"deployment.execute">> {
  const accepted = await runtime.services["deployment.execute"](request);
  const events = await waitForTask(runtime, accepted.taskId);
  throwForFailedTask(accepted.taskId, events);
  return accepted;
}

async function executeRollbackAndWait(
  runtime: DesktopRuntimeFixture,
  request: CommandRequest<"deployment.rollback">,
): Promise<CommandResponse<"deployment.rollback">> {
  const accepted = await runtime.services["deployment.rollback"](request);
  const events = await waitForTask(runtime, accepted.taskId);
  throwForFailedTask(accepted.taskId, events);
  return accepted;
}

function throwForFailedTask(taskId: string, events: readonly TaskEvent[]): void {
  const completed = events.find((event) => event.type === "completed");
  if (completed?.type !== "completed" || completed.payload.status === "succeeded") return;
  const failure = events.find((event) => event.type === "item.failed");
  const error = Object.assign(new Error(`Task ${taskId} failed`), {
    code: failure?.type === "item.failed" ? failure.payload.errorCode : "INTERNAL_ERROR",
    taskId,
  });
  throw error;
}

class RecordingWatchService extends WatchService {
  readonly suppressed: string[][] = [];
  readonly cleared: string[][] = [];

  override suppressDeploymentPaths(paths: Parameters<WatchService["suppressDeploymentPaths"]>[0]) {
    this.suppressed.push([...paths]);
    super.suppressDeploymentPaths(paths);
  }

  override clearDeploymentSuppression(
    paths: Parameters<WatchService["clearDeploymentSuppression"]>[0],
  ) {
    this.cleared.push([...paths]);
    super.clearDeploymentSuppression(paths);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function writeCodexUserConfigFixtures(home: string): Promise<void> {
  await mkdir(join(home, ".codex", "agents"), { recursive: true });
  await mkdir(join(home, ".agents", "skills", "release"), { recursive: true });
  await writeFile(join(home, "AGENTS.md"), "# User Codex guidance\nUse tests.\n", "utf8");
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
}

describe("desktop command service composition", () => {
  it("persists public theme and language settings through desktop services", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-settings-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project);
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      const initial = await runtime.services["settings.get"]({ keys: ["theme", "language"] });
      const updated = await runtime.services["settings.update"]({
        expectedRevision: initial.revision,
        patch: { theme: "dark", language: "zh-CN" },
      });
      const reloaded = await runtime.services["settings.get"]({ keys: ["language"] });

      expect(initial.values).toEqual({ theme: "system", language: "system" });
      expect(updated.values).toMatchObject({ theme: "dark", language: "zh-CN" });
      expect(updated.revision).toBe(initial.revision + 1);
      expect(reloaded.values).toEqual({ language: "zh-CN" });
    } finally {
      runtime.close();
    }
  });

  it("clears selected local data and recreates local Git history privately", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-clear-local-data-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    const historyRoot = join(userData, "history", "local-git");
    const deploymentBackups = join(userData, "backups", "deployments");
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-07-04T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await writeFile(join(historyRoot, "stale-history.txt"), "remove me\n", "utf8");
      await writeFile(join(deploymentBackups, "retained.backup"), "keep me\n", "utf8");
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
      const initial = await runtime.services["settings.get"]({});
      await runtime.services["settings.update"]({
        expectedRevision: initial.revision,
        patch: { theme: "dark", language: "zh-CN" },
      });
      expect((await runtime.services["assets.list"]({ limit: 50 })).items).not.toHaveLength(0);

      const result = await runtime.services["settings.clearLocalData"]({
        categories: ["scan_cache", "settings", "deployment_history"],
        confirmation: "clear-local-data",
      });

      expect(result).toMatchObject({
        clearedAt: "2026-07-04T08:00:00.000Z",
        categories: ["scan_cache", "settings", "deployment_history"],
        retained: {
          databaseBackups: true,
          deploymentBackups: true,
          disabledAssets: true,
        },
        requiresRestart: false,
      });
      expect(result.counts.assets).toBeGreaterThan(0);
      expect(result.counts.settings).toBe(1);
      expect(result.counts.localHistoryDirectories).toBe(1);
      expect((await runtime.services["assets.list"]({ limit: 50 })).items).toHaveLength(0);
      expect((await runtime.services["settings.get"]({})).values).toMatchObject({
        theme: "system",
        language: "system",
      });
      await expect(readFile(join(project, "AGENTS.md"), "utf8")).resolves.toBe(
        "Use local TypeScript conventions.\n",
      );
      await expect(readFile(join(deploymentBackups, "retained.backup"), "utf8")).resolves.toBe(
        "keep me\n",
      );
      await expect(access(join(historyRoot, "stale-history.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readdir(historyRoot)).resolves.toEqual([]);
      if (platform() !== "win32") expect((await stat(historyRoot)).mode & 0o777).toBe(0o700);
    } finally {
      runtime.close();
    }
  });

  it("reports zero local history directories when deployment history is already empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-empty-history-clear-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    const historyRoot = join(userData, "history", "local-git");
    await mkdir(project);
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-07-04T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      const result = await runtime.services["settings.clearLocalData"]({
        categories: ["deployment_history"],
        confirmation: "clear-local-data",
      });

      expect(result.counts.localHistoryDirectories).toBe(0);
      await expect(readdir(historyRoot)).resolves.toEqual([]);
      if (platform() !== "win32") expect((await stat(historyRoot)).mode & 0o777).toBe(0o700);
    } finally {
      runtime.close();
    }
  });

  it("rejects local history reset when the target is outside the controlled app data path", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-history-guard-"));
    temporaryDirectories.push(root);
    const appData = join(root, "user-data");
    const outside = join(root, "outside", "history", "local-git");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "sentinel.txt"), "keep\n", "utf8");

    await expect(
      resetLocalHistory({
        appDataRoot: AbsolutePathSchema.parse(appData),
        historyRoot: AbsolutePathSchema.parse(outside),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(readFile(join(outside, "sentinel.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("opens asset source files through the injected opener", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-open-source-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project);
    const sourcePath = join(project, "AGENTS.md");
    await writeFile(sourcePath, "Use local TypeScript conventions.\n", "utf8");
    const openedPaths: string[] = [];
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      sourceFileOpener: {
        openPath(path) {
          openedPaths.push(path);
          return Promise.resolve();
        },
      },
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.logicalKey.includes("AGENTS"),
      );
      if (source === undefined) throw new Error("Expected scanned Codex AGENTS asset");
      expect(source.sourceSummary).toMatchObject({
        kind: "file",
        fileName: "AGENTS.md",
        isText: true,
      });

      await expect(runtime.services["assets.openSource"]({ assetId: source.id })).resolves.toEqual({
        assetId: source.id,
        opened: true,
      });
      expect(openedPaths).toEqual([await realpath(sourcePath)]);
    } finally {
      runtime.close();
    }
  });

  it("returns sorted source files for multi-file skill assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-source-files-"));
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

    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.resourceType === "skill",
      );
      if (source === undefined) throw new Error("Expected scanned Codex skill asset");
      expect(source.sourceSummary).toEqual({
        kind: "package",
        rootName: "release",
        fileCount: 2,
        folderCount: 1,
        textCount: 2,
        binaryCount: 0,
        roleCounts: {
          primary: 1,
          metadata: 0,
          support: 1,
        },
      });

      const detail = await runtime.services["assets.get"]({ assetId: source.id });

      expect(detail.source.sourceSummary).toEqual(source.sourceSummary);
      expect(detail.source.files.map((file) => [file.role, file.relativePath])).toEqual([
        ["primary", "SKILL.md"],
        ["support", "assets/notes.md"],
      ]);
    } finally {
      runtime.close();
    }
  });

  it("executes source copy operations from source package roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-copy-preview-"));
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

    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: sourceProject,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [sourceProject] });
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
      expect(preview.changeGroups).toEqual([
        expect.objectContaining({
          sourceAssetId: source.id,
          resourceType: "skill",
          targetRootRelativePath: ".cursor/skills/release",
          operation: "create",
          operationCount: 2,
          changedTargetCount: 2,
          packageOutputCount: 2,
          visibleDetailCount: 2,
          detailsTruncated: false,
        }),
      ]);
      expect(preview.differenceSummary).toMatchObject({
        addedToTarget: 2,
        overwrittenInTarget: 0,
        changedGroupCount: 1,
        changedFileCount: 2,
      });
      expect(preview.changesTruncated).toBe(false);
      expect(preview.changeDetailLimit).toBe(50);
      const copyChange = preview.changes.find((change) => change.deploymentType === "copy");

      expect(copyChange).toMatchObject({
        groupId: preview.changeGroups[0]?.groupId,
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

      const deployment = await executeDeploymentAndWait(runtime, {
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

  it.each(["modified", "deleted"] as const)(
    "rejects an old deployment plan when its single-file source is %s on disk",
    async (mutation) => {
      const root = await mkdtemp(join(tmpdir(), `ai-config-hub-desktop-source-${mutation}-`));
      temporaryDirectories.push(root);
      const sourceProject = join(root, "source");
      const targetProject = join(root, "target");
      const userData = join(root, "user-data");
      const sourcePath = join(sourceProject, "AGENTS.md");
      await mkdir(sourceProject);
      await mkdir(targetProject);
      await writeFile(sourcePath, "Use local TypeScript conventions.\n", "utf8");

      const runtime = await createDesktopCommandServices({
        appVersion: "0.2.0-test",
        cwd: sourceProject,
        now: () => "2026-06-28T08:00:00.000Z",
        userDataPath: userData,
        fileWatcherFactory: () => ({ start: () => Promise.resolve(), close() {} }),
      });

      try {
        await startScanAndWait(runtime, { mode: "full", roots: [sourceProject] });
        const assets = await runtime.services["assets.list"]({ limit: 50 });
        const source = assets.items.find(
          (asset) =>
            asset.toolKey === "codex" &&
            asset.resourceType === "rule" &&
            asset.logicalKey.includes("AGENTS"),
        );
        if (source === undefined) throw new Error("Expected scanned Codex AGENTS asset");
        const preview = await runtime.services["migration.preview"]({
          sourceAssetIds: [source.id],
          targetToolKey: "cursor",
          targetScopeId: targetProject,
          conflictPolicy: "replace",
        });

        if (mutation === "modified") {
          await writeFile(sourcePath, "Use the externally edited conventions.\n", "utf8");
        } else {
          await rm(sourcePath);
        }

        await expectSourceDrift(
          executeDeploymentAndWait(runtime, {
            planId: preview.planId,
            confirmedPlanHash: preview.planHash,
            confirmations: preview.requiredConfirmations,
          }),
        );
        await expect(
          access(join(targetProject, ".cursor", "rules", "agents.mdc")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        runtime.close();
      }
    },
  );

  it.each(["modified", "deleted", "added"] as const)(
    "rejects an old Skill deployment plan when a package file is %s on disk",
    async (mutation) => {
      const root = await mkdtemp(join(tmpdir(), `ai-config-hub-desktop-skill-${mutation}-`));
      temporaryDirectories.push(root);
      const sourceProject = join(root, "source");
      const targetProject = join(root, "target");
      const userData = join(root, "user-data");
      const skillRoot = join(sourceProject, ".agents", "skills", "release");
      const supportPath = join(skillRoot, "assets", "notes.md");
      await mkdir(join(skillRoot, "assets"), { recursive: true });
      await mkdir(targetProject);
      await writeFile(
        join(skillRoot, "SKILL.md"),
        "---\nname: release\ndescription: Release safely\n---\nRun the checklist.\n",
        "utf8",
      );
      await writeFile(supportPath, "Release notes template\n", "utf8");
      await writeFile(join(sourceProject, "AGENTS.md"), "Use local conventions.\n", "utf8");

      const runtime = await createDesktopCommandServices({
        appVersion: "0.2.0-test",
        cwd: sourceProject,
        now: () => "2026-06-28T08:00:00.000Z",
        userDataPath: userData,
        fileWatcherFactory: () => ({ start: () => Promise.resolve(), close() {} }),
      });

      try {
        await startScanAndWait(runtime, { mode: "full", roots: [sourceProject] });
        const assets = await runtime.services["assets.list"]({ limit: 50 });
        const source = assets.items.find(
          (asset) => asset.toolKey === "codex" && asset.resourceType === "skill",
        );
        if (source === undefined) throw new Error("Expected scanned Codex skill asset");
        const preview = await runtime.services["migration.preview"]({
          sourceAssetIds: [source.id],
          targetToolKey: "cursor",
          targetScopeId: targetProject,
          conflictPolicy: "replace",
        });

        if (mutation === "modified") {
          await writeFile(supportPath, "Externally edited release notes\n", "utf8");
        } else if (mutation === "deleted") {
          await rm(supportPath);
        } else {
          await writeFile(join(skillRoot, "assets", "new.md"), "New package file\n", "utf8");
        }

        await expectSourceDrift(
          executeDeploymentAndWait(runtime, {
            planId: preview.planId,
            confirmedPlanHash: preview.planHash,
            confirmations: preview.requiredConfirmations,
          }),
        );
        await expect(
          access(join(targetProject, ".cursor", "skills", "release", "SKILL.md")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        runtime.close();
      }
    },
  );

  it("returns bounded grouped previews for large Skill packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-large-skill-preview-"));
    temporaryDirectories.push(root);
    const sourceProject = join(root, "source");
    const targetProject = join(root, "target");
    const userData = join(root, "user-data");
    await writeLargeSkillPackage(sourceProject, 205);
    await mkdir(targetProject);

    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: sourceProject,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      fileWatcherFactory: () => ({ start: () => Promise.resolve(), close() {} }),
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [sourceProject] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.resourceType === "skill",
      );
      if (source === undefined) throw new Error("Expected scanned Codex skill asset");

      const preview = await runtime.services["migration.preview"]({
        sourceAssetIds: [source.id],
        targetToolKey: "cursor",
        targetScopeId: targetProject,
        conflictPolicy: "replace",
      });
      const group = preview.changeGroups[0];

      expect(preview.changes).toHaveLength(50);
      expect(preview.changesTruncated).toBe(true);
      expect(preview.changeDetailLimit).toBe(50);
      expect(group).toMatchObject({
        sourceAssetId: source.id,
        resourceType: "skill",
        targetRootRelativePath: ".cursor/skills/release",
        operationCount: 206,
        changedTargetCount: 206,
        packageOutputCount: 206,
        visibleDetailCount: 50,
        detailsTruncated: true,
      });
      expect(group?.targetPathSample).toHaveLength(10);
      expect(group?.packagePathSample).toHaveLength(10);
      expect(preview.differenceSummary).toMatchObject({
        addedToTarget: 206,
        changedGroupCount: 1,
        changedFileCount: 206,
      });
      expect(new Set(preview.changes.map((change) => change.groupId))).toEqual(
        new Set([group?.groupId]),
      );

      const history = await runtime.services["history.list"]({ kinds: ["deployment"], limit: 10 });
      const planned = history.items.find((entry) => entry.status === "planned");
      if (planned === undefined) throw new Error("Expected planned deployment history entry");
      const historyDetail = await runtime.services["history.get"]({ id: planned.id });

      expect(historyDetail.changes).toHaveLength(50);
      expect(historyDetail.changesTruncated).toBe(true);
      expect(historyDetail.changeGroups[0]).toMatchObject({
        changedTargetCount: 206,
        visibleDetailCount: 50,
        detailsTruncated: true,
      });
      expect(historyDetail.differenceSummary).toMatchObject({
        changedGroupCount: 1,
        changedFileCount: 206,
      });
    } finally {
      runtime.close();
    }
  }, 20_000);

  it("filters asset lists by indexed project id for independent migration projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-project-filter-"));
    temporaryDirectories.push(root);
    const sourceProject = join(root, "source");
    const targetProject = join(root, "target");
    const userData = join(root, "user-data");
    await mkdir(sourceProject);
    await mkdir(targetProject);
    await writeFile(join(sourceProject, "AGENTS.md"), "Use source conventions.\n", "utf8");
    await writeFile(join(targetProject, "AGENTS.md"), "Use target conventions.\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: sourceProject,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [sourceProject, targetProject] });
      const canonicalSourceProject = await realpath(sourceProject);
      const canonicalTargetProject = await realpath(targetProject);
      const database = new DatabaseSync(join(userData, "ai-config-hub.sqlite"));
      const projectIdForRoot = (root: string) =>
        projectIdForIndexedRoot(database, root) ?? expect.fail(`Expected indexed project: ${root}`);
      const sourceProjectId = projectIdForRoot(canonicalSourceProject);
      const targetProjectId = projectIdForRoot(canonicalTargetProject);
      database.close();

      const sourceAssets = await runtime.services["assets.list"]({
        projectId: sourceProjectId,
        limit: 50,
      });
      const targetAssets = await runtime.services["assets.list"]({
        projectId: targetProjectId,
        limit: 50,
      });

      const sourceAssetIds = new Set(sourceAssets.items.map((asset) => asset.id));
      const targetAssetIds = new Set(targetAssets.items.map((asset) => asset.id));

      expect(sourceAssets.items.map((asset) => asset.logicalKey)).toContain("rule:AGENTS");
      expect(targetAssets.items.map((asset) => asset.logicalKey)).toContain("rule:AGENTS");
      expect([...sourceAssetIds].filter((assetId) => targetAssetIds.has(assetId))).toEqual([]);
    } finally {
      runtime.close();
    }
  });

  it("preserves migration source assets when scanning a target project independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-migration-scope-"));
    temporaryDirectories.push(root);
    const sourceProject = join(root, "source");
    const targetProject = join(root, "target");
    const userData = join(root, "user-data");
    await mkdir(sourceProject);
    await mkdir(targetProject);
    await writeFile(join(sourceProject, "AGENTS.md"), "Use source conventions.\n", "utf8");
    await writeFile(join(targetProject, "AGENTS.md"), "Use target conventions.\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: sourceProject,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [sourceProject] });
      const canonicalSourceProject = await realpath(sourceProject);
      const databaseAfterSource = new DatabaseSync(join(userData, "ai-config-hub.sqlite"));
      const sourceProjectId =
        projectIdForIndexedRoot(databaseAfterSource, canonicalSourceProject) ??
        expect.fail(`Expected indexed project: ${canonicalSourceProject}`);
      databaseAfterSource.close();

      const sourceAssetsBeforeTargetScan = await runtime.services["assets.list"]({
        projectId: sourceProjectId,
        limit: 50,
      });
      expect(sourceAssetsBeforeTargetScan.items.map((asset) => asset.logicalKey)).toContain(
        "rule:AGENTS",
      );

      const requestedTargetProjectId = deterministicProjectId(await realpath(targetProject));
      await startScanAndWait(runtime, {
        mode: "full",
        roots: [targetProject],
        projectId: requestedTargetProjectId,
      });
      const canonicalTargetProject = await realpath(targetProject);
      const databaseAfterTarget = new DatabaseSync(join(userData, "ai-config-hub.sqlite"));
      const targetProjectId =
        projectIdForIndexedRoot(databaseAfterTarget, canonicalTargetProject) ??
        expect.fail(`Expected indexed project: ${canonicalTargetProject}`);
      databaseAfterTarget.close();

      const sourceAssetsAfterTargetScan = await runtime.services["assets.list"]({
        projectId: sourceProjectId,
        limit: 50,
      });
      const targetAssets = await runtime.services["assets.list"]({
        projectId: targetProjectId,
        limit: 50,
      });

      expect(sourceAssetsAfterTargetScan.items.map((asset) => asset.logicalKey)).toContain(
        "rule:AGENTS",
      );
      expect(targetAssets.items.map((asset) => asset.logicalKey)).toContain("rule:AGENTS");
    } finally {
      runtime.close();
    }
  });

  it("preserves covered asset load states when a later scan updates another installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-asset-load-state-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const nested = join(project, "src");
    const home = join(root, "home");
    const otherProject = join(root, "other-project");
    const userData = join(root, "user-data");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await Promise.all([mkdir(home), mkdir(otherProject)]);
    await writeFile(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { command: "root-docs" } } }),
      "utf8",
    );
    await writeFile(
      join(nested, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { command: "nested-docs" } } }),
      "utf8",
    );
    await writeFile(
      join(otherProject, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-docs" } } }),
      "utf8",
    );
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: nested,
      homeDirectory: home,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full" });
      const canonicalProject = await realpath(project);
      const canonicalNested = await realpath(nested);
      const initialAssets = await runtime.services["assets.list"]({
        toolKeys: ["claude-code"],
        resourceTypes: ["mcp"],
        limit: 50,
      });
      const initialRootAsset = initialAssets.items.find(
        (asset) => asset.sourceDirectory === canonicalProject,
      );
      const initialNestedAsset = initialAssets.items.find(
        (asset) => asset.sourceDirectory === canonicalNested,
      );
      if (initialRootAsset === undefined || initialNestedAsset === undefined) {
        throw new Error("Expected root and nested MCP assets");
      }
      seedCoveredEffectiveConfig(userData, initialRootAsset.id, initialNestedAsset.id);

      await startScanAndWait(runtime, {
        mode: "full",
        roots: [otherProject],
        projectId: "project:other-load-state",
      });
      const assets = await runtime.services["assets.list"]({
        toolKeys: ["claude-code"],
        resourceTypes: ["mcp"],
        limit: 50,
      });
      const rootAsset = assets.items.find((asset) => asset.sourceDirectory === canonicalProject);
      const nestedAsset = assets.items.find((asset) => asset.sourceDirectory === canonicalNested);

      expect(rootAsset).toMatchObject({
        logicalKey: "mcp:docs",
        loadState: "covered",
        coveredByAssetId: nestedAsset?.id,
        coveredByLogicalKey: "mcp:docs",
      });
      expect(nestedAsset).toMatchObject({
        logicalKey: "mcp:docs",
        loadState: "loaded",
      });
    } finally {
      runtime.close();
    }
  });

  it("uses only the latest effective config for each installation and target", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-latest-effective-config-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const nested = join(project, "src");
    const home = join(root, "home");
    const userData = join(root, "user-data");
    await mkdir(join(project, ".git"), { recursive: true });
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(home)]);
    await writeFile(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { command: "root-docs" } } }),
      "utf8",
    );
    await writeFile(
      join(nested, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { command: "nested-docs" } } }),
      "utf8",
    );
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: nested,
      homeDirectory: home,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full" });
      const canonicalProject = await realpath(project);
      const canonicalNested = await realpath(nested);
      const initialAssets = await runtime.services["assets.list"]({
        toolKeys: ["claude-code"],
        resourceTypes: ["mcp"],
        limit: 50,
      });
      const rootAsset = initialAssets.items.find(
        (asset) => asset.sourceDirectory === canonicalProject,
      );
      const nestedAsset = initialAssets.items.find(
        (asset) => asset.sourceDirectory === canonicalNested,
      );
      if (rootAsset === undefined || nestedAsset === undefined) {
        throw new Error("Expected root and nested MCP assets");
      }
      seedEffectiveConfigHistory(
        userData,
        rootAsset.id,
        nestedAsset.id,
        join(root, "other-target"),
      );

      const assets = await runtime.services["assets.list"]({
        toolKeys: ["claude-code"],
        resourceTypes: ["mcp"],
        limit: 50,
      });
      expect(assets.items.find(({ id }) => id === rootAsset.id)).toMatchObject({
        loadState: "loaded",
      });
      expect(assets.items.find(({ id }) => id === nestedAsset.id)).toMatchObject({
        loadState: "covered",
        coveredByAssetId: rootAsset.id,
        coveredByLogicalKey: "mcp:docs",
      });
    } finally {
      runtime.close();
    }
  });

  it("pages diagnostic post-filters past ten thousand non-matching rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-diagnostic-paging-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "Use diagnostic paging.\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
      seedDiagnostics(userData, [
        { prefix: "a-nonmatch", count: 10_000, code: "OTHER_DIAGNOSTIC" },
        { prefix: "z-match", count: 51, code: "MATCHED_DIAGNOSTIC" },
      ]);

      const firstPage = await runtime.services["diagnostics.list"]({
        codes: ["MATCHED_DIAGNOSTIC"],
        limit: 25,
      });
      if (firstPage.nextCursor === null) throw new Error("Expected a second diagnostic page");
      const secondPage = await runtime.services["diagnostics.list"]({
        codes: ["MATCHED_DIAGNOSTIC"],
        cursor: firstPage.nextCursor,
        limit: 25,
      });
      if (secondPage.nextCursor === null) throw new Error("Expected a final diagnostic page");
      const finalPage = await runtime.services["diagnostics.list"]({
        codes: ["MATCHED_DIAGNOSTIC"],
        cursor: secondPage.nextCursor,
        limit: 25,
      });

      const items = [...firstPage.items, ...secondPage.items, ...finalPage.items];
      expect(items).toHaveLength(51);
      expect(new Set(items.map(({ id }) => id)).size).toBe(51);
      expect(items.every(({ code }) => code === "MATCHED_DIAGNOSTIC")).toBe(true);
      expect(firstPage.countsBySeverity).toEqual({ info: 0, warning: 0, error: 25 });
      expect(secondPage.countsBySeverity).toEqual({ info: 0, warning: 0, error: 25 });
      expect(finalPage.countsBySeverity).toEqual({ info: 0, warning: 0, error: 1 });
      expect(finalPage.nextCursor).toBeNull();
      expect(secondPage.snapshotRevision).toBe(firstPage.snapshotRevision);
      expect(finalPage.snapshotRevision).toBe(firstPage.snapshotRevision);
    } finally {
      runtime.close();
    }
  }, 15_000);

  it("filters rejected-only diagnostics by evidenced project and tool ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-diagnostic-ownership-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await Promise.all([
      mkdir(join(project, ".codex", "agents"), { recursive: true }),
      mkdir(join(project, ".cursor", "rules"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(project, ".codex", "agents", "broken.toml"), "not = [valid\n", "utf8"),
      writeFile(
        join(project, ".cursor", "rules", "project.mdc"),
        "Use the valid Cursor rule.\n",
        "utf8",
      ),
    ]);
    const canonicalProject = await realpath(project);
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: canonicalProject,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      fileWatcherFactory: () => ({ start: () => Promise.resolve(), close() {} }),
    });

    try {
      const projectId = deterministicProjectId(canonicalProject);
      await startScanAndWait(runtime, {
        mode: "full",
        roots: [canonicalProject],
        projectId,
      });

      const codexDiagnostics = await runtime.services["diagnostics.list"]({
        projectId,
        toolKeys: ["codex"],
        limit: 50,
      });
      const rejected = codexDiagnostics.items.find(({ code }) => code === "ADAPTER_PARSE_INVALID");
      expect(rejected).toBeDefined();

      const cursorDiagnostics = await runtime.services["diagnostics.list"]({
        projectId,
        toolKeys: ["cursor"],
        limit: 50,
      });
      expect(cursorDiagnostics.items.map(({ id }) => id)).not.toContain(rejected?.id);
    } finally {
      runtime.close();
    }
  });

  it("rejects diagnostic exports that exceed item or response byte bounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-diagnostic-export-bounds-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "Use bounded exports.\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
      seedDiagnostics(userData, [{ prefix: "too-many", count: 10_001, code: "EXPORT_LIMIT" }]);
      await expect(
        runtime.services["diagnostics.export"]({ format: "json" }),
      ).rejects.toMatchObject({
        code: "PREVIEW_TOO_LARGE",
        message: "Diagnostic export matches more than 10000 items",
      });

      seedDiagnostics(userData, [
        {
          prefix: "too-large",
          count: 1_200,
          code: "EXPORT_BYTES",
          message: "x".repeat(1_000),
        },
      ]);
      await expect(
        runtime.services["diagnostics.export"]({ format: "json" }),
      ).rejects.toMatchObject({
        code: "PREVIEW_TOO_LARGE",
        message: "Diagnostic export exceeds the 1000000 byte response limit",
      });
    } finally {
      runtime.close();
    }
  }, 15_000);

  it("rejects effective response arrays beyond the API bound", () => {
    expect(() => assertEffectiveResponseArrayBound("contributors", 10_001)).toThrowError(
      expect.objectContaining({
        code: "PREVIEW_TOO_LARGE",
        message: "Effective configuration has more than 10000 contributors",
        retryable: false,
      }),
    );
  });

  it("disables and re-enables existing assets through desktop command services", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-asset-status-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.logicalKey.includes("AGENTS"),
      );
      if (source === undefined) throw new Error("Expected scanned Codex AGENTS asset");

      expect(
        await runtime.services["assets.disable"]({ assetId: source.id, method: "hub_ignore" }),
      ).toEqual({
        assetId: source.id,
        status: "disabled",
      });
      await expect(readFile(join(project, "AGENTS.md"), "utf8")).resolves.toBe(
        "Use local TypeScript conventions.\n",
      );
      expect(await runtime.services["assets.enable"]({ assetId: source.id })).toEqual({
        assetId: source.id,
        status: "enabled",
      });
      expect((await runtime.services["assets.get"]({ assetId: source.id })).asset.status).toBe(
        "enabled",
      );

      expect(
        await runtime.services["assets.disable"]({ assetId: source.id, method: "move_file" }),
      ).toEqual({
        assetId: source.id,
        status: "disabled",
      });
      await expect(access(join(project, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await runtime.services["assets.get"]({ assetId: source.id })).asset.status).toBe(
        "disabled",
      );
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
      const rescanned = await runtime.services["assets.list"]({ limit: 50 });
      expect(rescanned.items.find((asset) => asset.id === source.id)).toMatchObject({
        id: source.id,
        status: "disabled",
        loadState: "disabled",
      });
      expect(
        (await runtime.services["assets.get"]({ assetId: source.id })).asset.disablementOptions.map(
          ({ method, recommended }) => ({ method, recommended }),
        ),
      ).toEqual([
        { method: "hub_ignore", recommended: true },
        { method: "move_file", recommended: false },
      ]);
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
      await expect(readFile(join(project, "AGENTS.md"), "utf8")).resolves.toBe(
        "Use local TypeScript conventions.\n",
      );
    } finally {
      runtime.close();
    }
  });

  it("keeps disabled assets from another project out of effective resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-effective-project-scope-"));
    temporaryDirectories.push(root);
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    const userData = join(root, "user-data");
    await mkdir(projectA);
    await mkdir(projectB);
    await writeFile(join(projectA, "AGENTS.md"), "Project A instructions.\n", "utf8");
    await writeFile(join(projectB, "AGENTS.md"), "Project B instructions.\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: projectA,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, {
        mode: "full",
        roots: [projectA],
        projectId: "project:a",
      });
      await startScanAndWait(runtime, {
        mode: "full",
        roots: [projectB],
        projectId: "project:b",
      });
      const canonicalProjectA = await realpath(projectA);
      const canonicalProjectB = await realpath(projectB);
      const assets = await runtime.services["assets.list"]({ limit: 200 });
      const assetA = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.sourceDirectory === canonicalProjectA,
      );
      const assetB = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.sourceDirectory === canonicalProjectB,
      );
      if (assetA === undefined || assetB === undefined) {
        throw new Error("Expected indexed Codex assets for both projects");
      }
      await runtime.services["assets.disable"]({ assetId: assetB.id, method: "hub_ignore" });

      const effective = await runtime.services["effective.resolve"]({
        toolKey: "codex",
        projectId: "project:a",
        targetScopeId: canonicalProjectA,
        resourceTypes: ["rule"],
      });

      expect(effective.contributors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ assetId: assetA.id, reasonCode: "TARGET_SCOPE_APPLIES" }),
        ]),
      );
      expect(effective.ignored).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ assetId: assetB.id })]),
      );
    } finally {
      runtime.close();
    }
  });

  it("retires a removed project tool installation before effective lookup", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-effective-removed-tool-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const cursorRoot = join(project, ".cursor");
    const userData = join(root, "user-data");
    await mkdir(join(cursorRoot, "rules"), { recursive: true });
    await writeFile(
      join(cursorRoot, "rules", "project.mdc"),
      "Use the project Cursor conventions.\n",
      "utf8",
    );
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      fileWatcherFactory: () => ({ start: () => Promise.resolve(), close() {} }),
    });

    try {
      await startScanAndWait(runtime, {
        mode: "full",
        roots: [project],
        projectId: "project:removed-tool",
      });
      const canonicalProject = await realpath(project);
      await expect(
        runtime.services["effective.resolve"]({
          toolKey: "cursor",
          projectId: "project:removed-tool",
          targetScopeId: canonicalProject,
          resourceTypes: ["rule"],
        }),
      ).resolves.toMatchObject({
        contributors: [expect.objectContaining({ reasonCode: "TARGET_SCOPE_APPLIES" })],
      });

      await rm(cursorRoot, { recursive: true, force: true });
      await startScanAndWait(runtime, {
        mode: "full",
        roots: [project],
        projectId: "project:removed-tool",
      });

      await expect(
        runtime.services["effective.resolve"]({
          toolKey: "cursor",
          projectId: "project:removed-tool",
          targetScopeId: canonicalProject,
          resourceTypes: ["rule"],
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      runtime.close();
    }
  });

  it("enables OpenCode native-disabled assets that were discovered during scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-native-enable-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project);
    const configPath = join(project, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          agent: {
            reviewer: {
              description: "Reviews code",
              prompt: "Review carefully.",
              disable: false,
            },
          },
          mcp: { docs: { command: ["node", "server.js"], enabled: false } },
        },
        null,
        2,
      ),
      "utf8",
    );
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, {
        mode: "full",
        roots: [project],
        toolKeys: ["opencode"],
      });
      const assets = await runtime.services["assets.list"]({ toolKeys: ["opencode"], limit: 50 });
      const source = assets.items.find((asset) => asset.logicalKey === "mcp:docs");
      const agent = assets.items.find((asset) => asset.logicalKey === "agent:reviewer");
      if (source === undefined) throw new Error("Expected scanned OpenCode MCP asset");
      if (agent === undefined) throw new Error("Expected scanned OpenCode Agent asset");
      expect(source.status).toBe("disabled");
      expect(
        (await runtime.services["assets.get"]({ assetId: agent.id })).asset.disablementOptions,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "native",
            label: "Set OpenCode Agent disable to true",
            description: "Write disable=true for this Agent in the OpenCode configuration.",
          }),
        ]),
      );

      expect(await runtime.services["assets.enable"]({ assetId: source.id })).toEqual({
        assetId: source.id,
        status: "enabled",
      });
      expect((await runtime.services["assets.get"]({ assetId: source.id })).asset.status).toBe(
        "enabled",
      );
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        readonly mcp: { readonly docs: { readonly enabled: boolean } };
      };
      expect(config.mcp.docs.enabled).toBe(true);

      await startScanAndWait(runtime, {
        mode: "full",
        roots: [project],
        toolKeys: ["opencode"],
      });
      expect((await runtime.services["assets.get"]({ assetId: source.id })).asset.status).toBe(
        "enabled",
      );
    } finally {
      runtime.close();
    }
  });

  it("surfaces opener failures as retryable API errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-open-source-error-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      sourceFileOpener: {
        openPath() {
          return Promise.reject(new Error("No registered editor"));
        },
      },
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.logicalKey.includes("AGENTS"),
      );
      if (source === undefined) throw new Error("Expected scanned Codex AGENTS asset");

      await expect(
        runtime.services["assets.openSource"]({ assetId: source.id }),
      ).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
        message: "The source file could not be opened in the external editor",
        retryable: true,
      });
    } finally {
      runtime.close();
    }
  });

  it("defaults scans to standard user-level configuration roots and surfaces user scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-home-scan-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const home = join(root, "home");
    const userData = join(root, "user-data");
    await mkdir(project);
    await mkdir(home);
    await writeCodexUserConfigFixtures(home);

    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      homeDirectory: home,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full" });
      const assets = await runtime.services["assets.list"]({ toolKeys: ["codex"], limit: 50 });

      expect(new Set(assets.items.map(({ resourceType }) => resourceType))).toEqual(
        new Set(["rule", "agent", "skill", "mcp"]),
      );
      expect(new Set(assets.items.map(({ scopeKind }) => scopeKind))).toEqual(new Set(["user"]));
    } finally {
      runtime.close();
    }
  });

  it("defaults scans from a subdirectory to tool configuration roots up to the Git root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-ancestor-scan-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const nested = join(project, "src", "app");
    const home = join(root, "home");
    const userData = join(root, "user-data");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await mkdir(home);
    await writeFile(join(project, "AGENTS.md"), "Use project TypeScript conventions.\n", "utf8");

    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: nested,
      homeDirectory: home,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full" });
      const assets = await runtime.services["assets.list"]({ toolKeys: ["codex"], limit: 50 });

      expect(assets.items).toHaveLength(1);
      expect(assets.items[0]).toEqual(
        expect.objectContaining({
          resourceType: "rule",
          logicalKey: "rule:AGENTS",
        }),
      );
      expect(["directory", "project"]).toContain(assets.items[0]?.scopeKind);
    } finally {
      runtime.close();
    }
  });

  it("replays cursor reset and task snapshot when retained events no longer cover the cursor", () => {
    const taskEvents = new DesktopTaskEvents();
    const taskId = "task:deployment:replay";
    taskEvents.record({
      taskId,
      emittedAt: "2026-06-28T08:00:00.000Z",
      type: "accepted",
      payload: {
        taskKind: "deployment",
        phase: "queued",
        acceptedAt: "2026-06-28T08:00:00.000Z",
      },
    });
    taskEvents.record({
      taskId,
      emittedAt: "2026-06-28T08:00:00.500Z",
      type: "cancel.requested",
      payload: { reason: "user", effectiveAfterPhase: "preflight" },
    });
    for (let index = 1; index <= 205; index += 1) {
      taskEvents.record({
        taskId,
        emittedAt: "2026-06-28T08:00:01.000Z",
        type: "progress",
        payload: { phase: "preflight", completed: index, total: 205, unit: "operations" },
      });
    }

    const replayed: TaskEvent[] = [];
    taskEvents.subscribe(taskId, 1, (event) => replayed.push(event));

    expect(replayed.map((event) => event.type)).toEqual(["cursor.reset", "snapshot"]);
    expect(replayed[0]).toMatchObject({
      sequence: null,
      payload: {
        requestedAfterSequence: 1,
        earliestAvailableSequence: 8,
        latestSequence: 207,
      },
    });
    expect(replayed[1]).toMatchObject({
      sequence: null,
      payload: {
        taskKind: "deployment",
        phase: "preflight",
        status: "running",
        progress: { phase: "preflight", completed: 205, total: 205, unit: "operations" },
        lastSequence: 207,
        cancellable: false,
        systemRecoveryLock: false,
      },
    });

    taskEvents.record({
      taskId,
      emittedAt: "2026-06-28T08:00:02.000Z",
      type: "completed",
      payload: {
        status: "failed",
        succeededCount: 0,
        failedCount: 1,
        skippedCount: 0,
        resultRef: "deployment:failed",
        systemRecoveryLock: true,
      },
    });
    const terminalReplay: TaskEvent[] = [];
    taskEvents.subscribe(taskId, 1, (event) => terminalReplay.push(event));
    expect(terminalReplay.at(-1)).toMatchObject({
      type: "snapshot",
      payload: {
        status: "failed",
        systemRecoveryLock: true,
        cancellable: false,
        resultRef: "deployment:failed",
      },
    });
  });

  it("bounds terminal task replay state while retaining the newest tasks", () => {
    const taskEvents = new DesktopTaskEvents();
    const firstTaskId = "task:scan:lru-0";
    for (let index = 0; index <= DesktopTaskEvents.TERMINAL_TASK_LIMIT; index += 1) {
      const taskId = `task:scan:lru-${index}`;
      taskEvents.record({
        taskId,
        emittedAt: "2026-06-28T08:00:00.000Z",
        type: "accepted",
        payload: {
          taskKind: "scan",
          phase: "queued",
          acceptedAt: "2026-06-28T08:00:00.000Z",
        },
      });
      taskEvents.record({
        taskId,
        emittedAt: "2026-06-28T08:00:01.000Z",
        type: "completed",
        payload: {
          status: "succeeded",
          succeededCount: 1,
          failedCount: 0,
          skippedCount: 0,
          resultRef: `scan:${index}`,
          systemRecoveryLock: false,
        },
      });
    }

    const evictedReplay: TaskEvent[] = [];
    const newestReplay: TaskEvent[] = [];
    taskEvents.subscribe(firstTaskId, 0, (event) => evictedReplay.push(event));
    taskEvents.subscribe(`task:scan:lru-${DesktopTaskEvents.TERMINAL_TASK_LIMIT}`, 0, (event) =>
      newestReplay.push(event),
    );
    expect(evictedReplay).toEqual([]);
    expect(newestReplay.map(({ type }) => type)).toEqual(["accepted", "completed"]);
  });

  it("isolates task event listener failures from retained state and other subscribers", () => {
    const taskEvents = new DesktopTaskEvents();
    const taskId = "task:deployment:listener-isolation";
    taskEvents.subscribe(taskId, 0, () => {
      throw new Error("renderer delivery failed");
    });
    const observed: TaskEvent[] = [];
    taskEvents.subscribe(taskId, 0, (event) => observed.push(event));

    expect(() =>
      taskEvents.record({
        taskId,
        emittedAt: "2026-06-28T08:00:00.000Z",
        type: "accepted",
        payload: {
          taskKind: "deployment",
          phase: "queued",
          acceptedAt: "2026-06-28T08:00:00.000Z",
        },
      }),
    ).not.toThrow();
    expect(() =>
      taskEvents.record({
        taskId,
        emittedAt: "2026-06-28T08:00:01.000Z",
        type: "completed",
        payload: {
          status: "succeeded",
          succeededCount: 1,
          failedCount: 0,
          skippedCount: 0,
          resultRef: "deployment-record:listener-isolation",
          systemRecoveryLock: false,
        },
      }),
    ).not.toThrow();

    expect(observed.map(({ type }) => type)).toEqual(["accepted", "completed"]);
    const replayed: TaskEvent[] = [];
    taskEvents.subscribe(taskId, 0, (event) => replayed.push(event));
    expect(replayed.map(({ type }) => type)).toEqual(["accepted", "completed"]);
  });

  it("records scan item failures before partial scan completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-scan-failures-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(join(project, ".codex", "agents"), { recursive: true });
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");
    await writeFile(join(project, ".codex", "agents", "broken.toml"), "not = [valid\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      const scan = await startScanAndWait(runtime, { mode: "full", roots: [project] });
      const events: TaskEvent[] = [];
      runtime.taskEvents.subscribe(String(scan.taskId), 0, (event) => events.push(event));

      const itemFailures = events.filter((event) => event.type === "item.failed");
      expect(itemFailures).toHaveLength(1);
      expect(itemFailures[0]).toMatchObject({
        payload: {
          itemRef: await realpath(join(project, ".codex", "agents", "broken.toml")),
          errorCode: "ADAPTER_PARSE_INVALID",
        },
      });
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        payload: { status: "partially_succeeded", succeededCount: 3, failedCount: 1 },
      });
    } finally {
      runtime.close();
    }
  });

  it("records scan cancellation requests in the task event stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-scan-cancel-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      const scan = await runtime.services["scan.start"]({ mode: "full", roots: [project] });
      const completion = waitForTask(runtime, scan.taskId);
      await runtime.services["scan.cancel"]({ taskId: scan.taskId });
      await expect(runtime.services["scan.status"]({ taskId: scan.taskId })).resolves.toMatchObject(
        {
          cancellable: false,
        },
      );
      await expect(runtime.services["scan.cancel"]({ taskId: scan.taskId })).rejects.toMatchObject({
        code: "TASK_NOT_CANCELLABLE",
      });
      const events = await completion;

      expect(events.map((event) => event.type)).toContain("cancel.requested");
      expect(events.find((event) => event.type === "cancel.requested")).toMatchObject({
        payload: { reason: "user" },
      });
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        payload: { status: "cancelled" },
      });
    } finally {
      runtime.close();
    }
  });

  it("accepts scans before deferred work, streams live events, blocks cleanup, and purges replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-async-scan-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    const watcherStarted = deferred();
    const releaseWatcher = deferred();
    let onWatchBatch: ((batch: WatchBatch) => void | Promise<void>) | undefined;
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      fileWatcherFactory: (watcherOptions) => ({
        async start() {
          onWatchBatch = watcherOptions.onBatch;
          watcherStarted.resolve();
          await releaseWatcher.promise;
        },
        close() {},
      }),
    });

    try {
      const canonicalProject = await realpath(project);
      const accepted = await runtime.services["scan.start"]({
        mode: "full",
        roots: [project],
        clientContext: "migration-source",
      });
      const liveEvents: TaskEvent[] = [];
      let activeTasksSeenAtCompletion:
        | ReturnType<typeof runtime.runtimeState>["activeTasks"]
        | undefined;
      const unsubscribe = runtime.taskEvents.subscribe(accepted.taskId, 0, (event) => {
        liveEvents.push(event);
        if (event.type === "completed") {
          activeTasksSeenAtCompletion = runtime.runtimeState().activeTasks;
        }
      });
      const completion = waitForTask(runtime, accepted.taskId);

      expect(accepted).toMatchObject({ status: "queued" });
      expect(runtime.runtimeState().activeTasks).toEqual([
        {
          taskId: accepted.taskId,
          taskKind: "scan",
          clientContext: "migration-source",
          selectedRoots: [project],
          canonicalRoots: [canonicalProject],
        },
      ]);
      expect(liveEvents.map(({ type }) => type)).toEqual(["accepted"]);
      await watcherStarted.promise;
      expect(liveEvents.some(({ type }) => type === "phase.changed")).toBe(false);
      expect(liveEvents.some(({ type }) => type === "completed")).toBe(false);
      await expect(
        runtime.services["scan.start"]({ mode: "full", roots: [project] }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        runtime.services["settings.clearLocalData"]({
          categories: ["scan_cache"],
          confirmation: "clear-local-data",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      if (onWatchBatch === undefined) throw new Error("Expected an active file watcher");
      let watcherBatchSettled = false;
      const watcherBatch = Promise.resolve(
        onWatchBatch({
          kind: "changes",
          changedPaths: [AbsolutePathSchema.parse(await realpath(join(project, "AGENTS.md")))],
        }),
      ).then(() => {
        watcherBatchSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(watcherBatchSettled).toBe(false);
      expect(runtime.runtimeState().activeTasks).toEqual([
        {
          taskId: accepted.taskId,
          taskKind: "scan",
          clientContext: "migration-source",
          selectedRoots: [project],
          canonicalRoots: [canonicalProject],
        },
      ]);

      releaseWatcher.resolve();
      const completedEvents = await completion;
      await watcherBatch;
      expect(completedEvents.at(-1)).toMatchObject({
        type: "completed",
        payload: { status: "succeeded" },
      });
      expect(liveEvents.at(-1)).toMatchObject({ type: "completed" });
      expect(activeTasksSeenAtCompletion).toEqual([]);
      expect(runtime.runtimeState().activeTasks).toEqual([]);
      unsubscribe();

      await runtime.services["settings.clearLocalData"]({
        categories: ["scan_cache"],
        confirmation: "clear-local-data",
      });
      const replayAfterPurge: TaskEvent[] = [];
      const unsubscribePurged = runtime.taskEvents.subscribe(accepted.taskId, 0, (event) =>
        replayAfterPurge.push(event),
      );
      expect(replayAfterPurge).toEqual([]);
      unsubscribePurged();
    } finally {
      releaseWatcher.resolve();
      runtime.close();
    }
  });

  it("passes changed paths through to incremental scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-incremental-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(join(project, ".codex", "agents"), { recursive: true });
    const changedPath = join(project, "AGENTS.md");
    await writeFile(changedPath, "Use local TypeScript conventions.\n", "utf8");
    await writeFile(join(project, ".codex", "agents", "broken.toml"), "not = [valid\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
      const incremental = await startScanAndWait(runtime, {
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

  it("records local Git snapshots for successful deployments and rollbacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-history-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");

    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
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

      const deployment = await executeDeploymentAndWait(runtime, {
        planId: preview.planId,
        confirmedPlanHash: preview.planHash,
        confirmations: preview.requiredConfirmations,
      });
      const rollback = await executeRollbackAndWait(runtime, {
        deploymentId: deployment.deploymentId,
      });

      const history = await runtime.services["history.list"]({ limit: 10 });
      const deploymentEntry = history.items.find((entry) => entry.id === deployment.deploymentId);
      expect(deploymentEntry).toMatchObject({
        snapshot: {
          status: "recorded",
          message: `record deployment ${deployment.deploymentId}`,
        },
      });
      expect(deploymentEntry?.snapshot?.status).toBe("recorded");
      if (deploymentEntry?.snapshot?.status !== "recorded") {
        throw new Error("Expected a recorded deployment snapshot");
      }
      expect(deploymentEntry.snapshot.commitId.length).toBeGreaterThan(0);
      expect(deploymentEntry.snapshot.authoredAt.length).toBeGreaterThan(0);
      const rollbackEntry = history.items.find((entry) => entry.id === rollback.rollbackId);
      expect(rollbackEntry).toMatchObject({
        kind: "rollback",
        snapshot: {
          status: "recorded",
          message: `record deployment ${rollback.rollbackId}`,
        },
      });
      expect(rollbackEntry?.snapshot?.status).toBe("recorded");
      if (rollbackEntry?.snapshot?.status !== "recorded") {
        throw new Error("Expected a recorded rollback snapshot");
      }
      expect(rollbackEntry.snapshot.commitId.length).toBeGreaterThan(0);
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

  it("accepts deployments and rollbacks before work and reports their live completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-async-operations-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    const targetPath = join(project, ".cursor", "rules", "agents.mdc");
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
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
      const deploymentEvents: TaskEvent[] = [];
      const unsubscribeDeployment = runtime.taskEvents.subscribe(deployment.taskId, 0, (event) =>
        deploymentEvents.push(event),
      );
      expect(deployment.snapshot).toBeUndefined();
      expect(deploymentEvents.map(({ type }) => type)).toEqual(["accepted"]);
      await expect(
        runtime.services["deployment.execute"]({
          planId: preview.planId,
          confirmedPlanHash: preview.planHash,
          confirmations: preview.requiredConfirmations,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        runtime.services["settings.clearLocalData"]({
          categories: ["deployment_history"],
          confirmation: "clear-local-data",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await waitForTask(runtime, deployment.taskId);
      expect(deploymentEvents.at(-1)).toMatchObject({
        type: "completed",
        payload: { status: "succeeded", resultRef: deployment.deploymentId },
      });
      expect(deploymentEvents.filter(({ type }) => type === "completed")).toHaveLength(1);
      unsubscribeDeployment();
      await expect(readFile(targetPath, "utf8")).resolves.toContain(
        "Use local TypeScript conventions.",
      );
      for (const activeTask of runtime.runtimeState().activeTasks) {
        await waitForTask(runtime, activeTask.taskId);
      }
      expect(runtime.runtimeState().activeTasks).toEqual([]);

      const rollback = await runtime.services["deployment.rollback"]({
        deploymentId: deployment.deploymentId,
      });
      const rollbackEvents: TaskEvent[] = [];
      const unsubscribeRollback = runtime.taskEvents.subscribe(rollback.taskId, 0, (event) =>
        rollbackEvents.push(event),
      );
      expect(rollback.snapshot).toBeUndefined();
      expect(rollbackEvents.map(({ type }) => type)).toEqual(["accepted"]);
      await expect(
        runtime.services["deployment.rollback"]({ deploymentId: deployment.deploymentId }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await waitForTask(runtime, rollback.taskId);
      expect(rollbackEvents.at(-1)).toMatchObject({
        type: "completed",
        payload: { status: "succeeded", resultRef: rollback.rollbackId },
      });
      unsubscribeRollback();
      await expect(access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      const history = await runtime.services["history.get"]({ id: rollback.rollbackId });
      expect(history.entry).toMatchObject({
        id: rollback.rollbackId,
        kind: "rollback",
        taskId: rollback.taskId,
      });
      const projectId = history.entry.projectId;
      if (projectId === undefined) throw new Error("Expected persisted history project identity");
      const filteredHistory = await runtime.services["history.list"]({
        taskId: deployment.taskId,
        projectId,
        limit: 10,
      });
      expect(filteredHistory.items).toHaveLength(1);
      expect(filteredHistory.items[0]).toMatchObject({
        id: deployment.deploymentId,
        taskId: deployment.taskId,
        projectId,
      });
      expect(filteredHistory.snapshotRevision).toMatch(/^\d+$/);
      await expect(
        runtime.services["history.list"]({
          taskId: rollback.taskId,
          projectId: "project:unrelated",
          limit: 10,
        }),
      ).resolves.toMatchObject({ items: [] });

      const firstHistoryPage = await runtime.services["history.list"]({ limit: 1 });
      if (firstHistoryPage.nextCursor === null) {
        throw new Error("Expected a second history page");
      }
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
      await expect(
        runtime.services["history.list"]({
          cursor: firstHistoryPage.nextCursor,
          snapshotRevision: firstHistoryPage.snapshotRevision,
          limit: 1,
        }),
      ).rejects.toMatchObject({ code: "STALE_INDEX" });
    } finally {
      runtime.close();
    }
  }, 15_000);

  it("holds a recovery lock across scans and failed recovery until the target rollback succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-recovery-lock-"));
    temporaryDirectories.push(root);
    const sourceProject = join(root, "source");
    const targetProject = join(root, "target");
    const userData = join(root, "user-data");
    const skillRoot = join(sourceProject, ".agents", "skills", "release");
    const skillPath = join(skillRoot, "SKILL.md");
    await mkdir(join(skillRoot, "assets"), { recursive: true });
    await mkdir(targetProject);
    await writeFile(
      skillPath,
      "---\nname: release\ndescription: Release safely\n---\nRun the checklist.\n",
      "utf8",
    );
    await writeFile(join(skillRoot, "assets", "notes.md"), "Release notes\n", "utf8");
    await writeFile(join(sourceProject, "AGENTS.md"), "Use local conventions.\n", "utf8");
    let sabotageWrites = true;
    let writeCount = 0;
    const deploymentFileFactory: NonNullable<
      Parameters<typeof createDesktopCommandServices>[0]["deploymentFileFactory"]
    > = (options) => {
      const delegate = new NodeDeploymentFilePort(options);
      const beforeWrite = () => {
        writeCount += 1;
        if (sabotageWrites && writeCount === 2) {
          throw new Error("Injected second-write failure");
        }
      };
      return {
        createBackup: (input) => delegate.createBackup(input),
        async atomicReplace(input) {
          beforeWrite();
          return delegate.atomicReplace(input);
        },
        async copy(input) {
          beforeWrite();
          return delegate.copy(input);
        },
        async createSymlink(input) {
          beforeWrite();
          return delegate.createSymlink(input);
        },
        async remove(input) {
          if (sabotageWrites) throw new Error("Injected compensation failure");
          await delegate.remove(input);
        },
      };
    };
    const runtimeOptions = {
      appVersion: "0.2.0-test",
      cwd: sourceProject,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      deploymentFileFactory,
    };
    let runtime = await createDesktopCommandServices(runtimeOptions);

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [sourceProject] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.resourceType === "skill",
      );
      if (source === undefined) throw new Error("Expected scanned Codex skill asset");
      const preview = await runtime.services["migration.preview"]({
        sourceAssetIds: [source.id],
        targetToolKey: "cursor",
        targetScopeId: targetProject,
        conflictPolicy: "replace",
      });
      expect(preview.changes.length).toBeGreaterThan(1);

      const failedDeployment = await runtime.services["deployment.execute"]({
        planId: preview.planId,
        confirmedPlanHash: preview.planHash,
        confirmations: preview.requiredConfirmations,
      });
      const failedDeploymentEvents = await waitForTask(runtime, failedDeployment.taskId);
      expect(failedDeploymentEvents.at(-1)).toMatchObject({
        type: "completed",
        payload: {
          status: "failed",
          resultRef: failedDeployment.deploymentId,
          systemRecoveryLock: true,
        },
      });

      runtime.close();
      runtime = await createDesktopCommandServices(runtimeOptions);
      expect(runtime.runtimeState().recoveryDeploymentIds).toEqual([failedDeployment.deploymentId]);
      await expect(
        runtime.services["deployment.rollback"]({
          deploymentId: "deployment-record:unrelated",
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        safeContext: { recoveryDeploymentId: failedDeployment.deploymentId },
      });
      await startScanAndWait(runtime, { mode: "full", roots: [sourceProject] });
      await expect(
        runtime.services["deployment.execute"]({
          planId: preview.planId,
          confirmedPlanHash: preview.planHash,
          confirmations: preview.requiredConfirmations,
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        safeContext: { recoveryDeploymentId: failedDeployment.deploymentId },
      });
      await expect(
        runtime.services["settings.clearLocalData"]({
          categories: ["deployment_history"],
          confirmation: "clear-local-data",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const failedRecovery = await runtime.services["deployment.rollback"]({
        deploymentId: failedDeployment.deploymentId,
      });
      const failedRecoveryEvents = await waitForTask(runtime, failedRecovery.taskId);
      expect(failedRecoveryEvents.at(-1)).toMatchObject({
        type: "completed",
        payload: {
          status: "failed",
          resultRef: failedDeployment.deploymentId,
          systemRecoveryLock: true,
        },
      });
      await expect(
        runtime.services["deployment.execute"]({
          planId: preview.planId,
          confirmedPlanHash: preview.planHash,
          confirmations: preview.requiredConfirmations,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      sabotageWrites = false;
      const recovery = await runtime.services["deployment.rollback"]({
        deploymentId: failedDeployment.deploymentId,
      });
      const recoveryEvents = await waitForTask(runtime, recovery.taskId);
      expect(recoveryEvents.at(-1)).toMatchObject({
        type: "completed",
        payload: {
          status: "succeeded",
          resultRef: recovery.rollbackId,
          systemRecoveryLock: false,
        },
      });

      runtime.close();
      runtime = await createDesktopCommandServices(runtimeOptions);
      expect(runtime.runtimeState().recoveryDeploymentIds).toEqual([]);
      await writeFile(
        skillPath,
        "---\nname: release\ndescription: Release safely\n---\nRun the updated checklist.\n",
        "utf8",
      );
      await startScanAndWait(runtime, { mode: "full", roots: [sourceProject] });
      const refreshedAssets = await runtime.services["assets.list"]({ limit: 50 });
      const refreshedSource = refreshedAssets.items.find(
        (asset) => asset.toolKey === "codex" && asset.resourceType === "skill",
      );
      if (refreshedSource === undefined) throw new Error("Expected refreshed Codex skill asset");
      const freshPreview = await runtime.services["migration.preview"]({
        sourceAssetIds: [refreshedSource.id],
        targetToolKey: "cursor",
        targetScopeId: targetProject,
        conflictPolicy: "replace",
      });
      await executeDeploymentAndWait(runtime, {
        planId: freshPreview.planId,
        confirmedPlanHash: freshPreview.planHash,
        confirmations: freshPreview.requiredConfirmations,
      });
    } finally {
      sabotageWrites = false;
      runtime.close();
    }
  }, 15_000);

  it("keeps a newer interrupted rollback recoverable after an older resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-recovery-order-"));
    temporaryDirectories.push(root);
    const sourceProject = join(root, "source");
    const targetProject = join(root, "target");
    const userData = join(root, "user-data");
    const removalApplied = deferred();
    const releaseInterruptedRollback = deferred();
    let blockRemoval = false;
    await Promise.all([mkdir(sourceProject), mkdir(targetProject)]);
    await writeFile(join(sourceProject, "AGENTS.md"), "Use chronological recovery.\n", "utf8");
    const runtimeOptions = {
      appVersion: "0.2.0-test",
      cwd: sourceProject,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      deploymentFileFactory: (options: ConstructorParameters<typeof NodeDeploymentFilePort>[0]) => {
        const delegate = new NodeDeploymentFilePort(options);
        return {
          createBackup: (input: Parameters<typeof delegate.createBackup>[0]) =>
            delegate.createBackup(input),
          atomicReplace: (input: Parameters<typeof delegate.atomicReplace>[0]) =>
            delegate.atomicReplace(input),
          copy: (input: Parameters<typeof delegate.copy>[0]) => delegate.copy(input),
          createSymlink: (input: Parameters<typeof delegate.createSymlink>[0]) =>
            delegate.createSymlink(input),
          async remove(input: Parameters<typeof delegate.remove>[0]) {
            await delegate.remove(input);
            if (!blockRemoval) return;
            blockRemoval = false;
            removalApplied.resolve();
            await releaseInterruptedRollback.promise;
          },
        };
      },
    };
    let runtime = await createDesktopCommandServices(runtimeOptions);

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [sourceProject] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.logicalKey.includes("AGENTS"),
      );
      if (source === undefined) throw new Error("Expected scanned Codex AGENTS asset");
      const preview = await runtime.services["migration.preview"]({
        sourceAssetIds: [source.id],
        targetToolKey: "cursor",
        targetScopeId: targetProject,
        conflictPolicy: "replace",
      });
      const deployment = await executeDeploymentAndWait(runtime, {
        planId: preview.planId,
        confirmedPlanHash: preview.planHash,
        confirmations: preview.requiredConfirmations,
      });
      const targetPath = preview.changes[0]?.pathDisplay;
      if (targetPath === undefined) throw new Error("Expected a deployment target");
      const deployedText = await readFile(targetPath, "utf8");
      await executeRollbackAndWait(runtime, { deploymentId: deployment.deploymentId });

      runtime.close();
      const database = new DatabaseSync(join(userData, "ai-config-hub.sqlite"));
      const deploymentRow = database
        .prepare("SELECT id FROM deployments WHERE domain_id = ?")
        .get(deployment.deploymentId) as { readonly id: string } | undefined;
      if (deploymentRow === undefined) throw new Error("Expected persisted deployment record");
      const resolvedThroughStorageOrder = (
        database.prepare("SELECT MAX(rowid) AS storage_order FROM deployments").get() as {
          readonly storage_order: number;
        }
      ).storage_order;
      database
        .prepare(
          `INSERT INTO recovery_locks(
             canonical_target_key, deployment_id, reason, created_at, resolved_at,
             resolution_evidence_json, recovery_fence_token
           ) VALUES(?, ?, 'failed_deployment', 1, 1, ?, 1)`,
        )
        .run(
          targetPath,
          deploymentRow.id,
          JSON.stringify({
            resolution: "successful_rollback",
            deploymentRecordId: deployment.deploymentId,
            resolvedThroughStorageOrder,
          }),
        );
      database.close();

      runtime = await createDesktopCommandServices(runtimeOptions);
      expect(runtime.runtimeState().recoveryDeploymentIds).toEqual([]);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, deployedText, "utf8");
      blockRemoval = true;
      const interruptedRollback = await runtime.services["deployment.rollback"]({
        deploymentId: deployment.deploymentId,
      });
      const interruptedCompletion = waitForTask(runtime, interruptedRollback.taskId);
      await removalApplied.promise;
      await expect(access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });

      runtime.close();
      runtime = await createDesktopCommandServices(runtimeOptions);
      expect(runtime.runtimeState().recoveryDeploymentIds).toEqual([deployment.deploymentId]);

      await executeRollbackAndWait(runtime, { deploymentId: deployment.deploymentId });
      expect(runtime.runtimeState().recoveryDeploymentIds).toEqual([]);
      await expect(access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });

      releaseInterruptedRollback.resolve();
      await interruptedCompletion;
    } finally {
      releaseInterruptedRollback.resolve();
      runtime.close();
    }
  }, 15_000);

  it("reconstructs and resolves recovery for a deployment interrupted while writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-interrupted-deploy-"));
    temporaryDirectories.push(root);
    const sourceProject = join(root, "source");
    const targetProject = join(root, "target");
    const userData = join(root, "user-data");
    await Promise.all([mkdir(sourceProject), mkdir(targetProject)]);
    await writeFile(join(sourceProject, "AGENTS.md"), "Use safe recovery.\n", "utf8");
    const runtimeOptions = {
      appVersion: "0.2.0-test",
      cwd: sourceProject,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    };
    let runtime = await createDesktopCommandServices(runtimeOptions);

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [sourceProject] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.logicalKey.includes("AGENTS"),
      );
      if (source === undefined) throw new Error("Expected a scanned Codex AGENTS asset");
      const preview = await runtime.services["migration.preview"]({
        sourceAssetIds: [source.id],
        targetToolKey: "cursor",
        targetScopeId: targetProject,
        conflictPolicy: "replace",
      });
      runtime.close();

      const database = new DatabaseSync(join(userData, "ai-config-hub.sqlite"));
      const row = database
        .prepare("SELECT domain_id, verification_json FROM deployments WHERE plan_id = ?")
        .get(preview.planId) as
        | { readonly domain_id: string; readonly verification_json: string }
        | undefined;
      if (row === undefined) throw new Error("Expected a persisted deployment preview record");
      const record = JSON.parse(row.verification_json) as DeploymentRecord;
      const operation = record.operations[0];
      if (
        operation === undefined ||
        operation.kind !== "create" ||
        operation.nextText === undefined
      ) {
        throw new Error("Expected one generated create operation for the empty target project");
      }
      await mkdir(dirname(operation.targetPath), { recursive: true });
      await writeFile(operation.targetPath, operation.nextText, "utf8");
      const resultingHash = ContentHashSchema.parse(
        `sha256:${createHash("sha256").update(operation.nextText).digest("hex")}`,
      );
      const interruptedRecord: DeploymentRecord = {
        ...record,
        status: "writing",
        confirmedPlanHash: preview.planHash,
        confirmedAt: "2026-06-28T08:00:00.000Z",
        startedAt: "2026-06-28T08:00:00.000Z",
        backupLocations: { [operation.targetPath]: "previously-absent" },
        resultingHashes: { [operation.targetPath]: resultingHash },
        operationJournal: [
          {
            targetPath: operation.targetPath,
            operationKind: operation.kind,
            phase: "completed",
            expectedTargetHash: operation.expectedTargetHash,
            resultingHash,
            recordedAt: "2026-06-28T08:00:00.000Z",
          },
        ],
      };
      database
        .prepare(
          "UPDATE deployments SET status = 'writing', rollback_state = 'writing', confirmed_at = ?, verification_json = ? WHERE domain_id = ?",
        )
        .run(
          Date.parse("2026-06-28T08:00:00.000Z"),
          JSON.stringify(interruptedRecord),
          row.domain_id,
        );
      database.close();

      runtime = await createDesktopCommandServices(runtimeOptions);
      expect(runtime.runtimeState().recoveryDeploymentIds).toEqual([row.domain_id]);
      await expect(
        runtime.services["deployment.execute"]({
          planId: preview.planId,
          confirmedPlanHash: preview.planHash,
          confirmations: preview.requiredConfirmations,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const recovery = await runtime.services["deployment.rollback"]({
        deploymentId: row.domain_id,
      });
      const recoveryEvents = await waitForTask(runtime, recovery.taskId);
      expect(recoveryEvents.at(-1)).toMatchObject({
        type: "completed",
        payload: { status: "succeeded", systemRecoveryLock: false },
      });
      await expect(access(operation.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(runtime.runtimeState().recoveryDeploymentIds).toEqual([]);

      runtime.close();
      runtime = await createDesktopCommandServices(runtimeOptions);
      expect(runtime.runtimeState().recoveryDeploymentIds).toEqual([]);
    } finally {
      runtime.close();
    }
  }, 15_000);

  it("reconstructs an interrupted rollback and clears an already-restored recovery lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-interrupted-rollback-"));
    temporaryDirectories.push(root);
    const sourceProject = join(root, "source");
    const targetProject = join(root, "target");
    const userData = join(root, "user-data");
    const removalApplied = deferred();
    const releaseInterruptedRollback = deferred();
    let blockRollbackRemoval = false;
    await Promise.all([mkdir(sourceProject), mkdir(targetProject)]);
    await writeFile(join(sourceProject, "AGENTS.md"), "Use safe rollback recovery.\n", "utf8");
    const runtimeOptions = {
      appVersion: "0.2.0-test",
      cwd: sourceProject,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      deploymentFileFactory: (options: ConstructorParameters<typeof NodeDeploymentFilePort>[0]) => {
        const delegate = new NodeDeploymentFilePort(options);
        return {
          createBackup: (input: Parameters<typeof delegate.createBackup>[0]) =>
            delegate.createBackup(input),
          atomicReplace: (input: Parameters<typeof delegate.atomicReplace>[0]) =>
            delegate.atomicReplace(input),
          copy: (input: Parameters<typeof delegate.copy>[0]) => delegate.copy(input),
          createSymlink: (input: Parameters<typeof delegate.createSymlink>[0]) =>
            delegate.createSymlink(input),
          async remove(input: Parameters<typeof delegate.remove>[0]) {
            await delegate.remove(input);
            if (!blockRollbackRemoval) return;
            blockRollbackRemoval = false;
            removalApplied.resolve();
            await releaseInterruptedRollback.promise;
          },
        };
      },
    };
    let runtime = await createDesktopCommandServices(runtimeOptions);
    let interruptedRuntime: DesktopRuntimeFixture | undefined;

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [sourceProject] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.logicalKey.includes("AGENTS"),
      );
      if (source === undefined) throw new Error("Expected a scanned Codex AGENTS asset");
      const preview = await runtime.services["migration.preview"]({
        sourceAssetIds: [source.id],
        targetToolKey: "cursor",
        targetScopeId: targetProject,
        conflictPolicy: "replace",
      });
      const deployment = await executeDeploymentAndWait(runtime, {
        planId: preview.planId,
        confirmedPlanHash: preview.planHash,
        confirmations: preview.requiredConfirmations,
      });
      const targetPath = preview.changes[0]?.pathDisplay;
      if (targetPath === undefined) throw new Error("Expected a deployment target");

      blockRollbackRemoval = true;
      const interrupted = await runtime.services["deployment.rollback"]({
        deploymentId: deployment.deploymentId,
      });
      const interruptedCompletion = waitForTask(runtime, interrupted.taskId);
      await removalApplied.promise;
      await expect(access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });

      interruptedRuntime = runtime;
      interruptedRuntime.close();
      runtime = await createDesktopCommandServices(runtimeOptions);
      expect(runtime.runtimeState().recoveryDeploymentIds).toEqual([deployment.deploymentId]);

      const recovery = await runtime.services["deployment.rollback"]({
        deploymentId: deployment.deploymentId,
      });
      const recoveryEvents = await waitForTask(runtime, recovery.taskId);
      expect(recoveryEvents.at(-1)).toMatchObject({
        type: "completed",
        payload: {
          status: "succeeded",
          succeededCount: 0,
          resultRef: recovery.rollbackId,
          systemRecoveryLock: false,
        },
      });
      expect(runtime.runtimeState().recoveryDeploymentIds).toEqual([]);

      releaseInterruptedRollback.resolve();
      await interruptedCompletion;

      runtime.close();
      runtime = await createDesktopCommandServices(runtimeOptions);
      expect(runtime.runtimeState().recoveryDeploymentIds).toEqual([]);
    } finally {
      releaseInterruptedRollback.resolve();
      runtime.close();
    }
  }, 15_000);

  it("uses real scanner and storage services instead of demo assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-services-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project);
    await writeFile(
      join(project, "AGENTS.md"),
      "# Project instructions\nUse real scans.\n",
      "utf8",
    );

    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      const scan = await startScanAndWait(runtime, {
        mode: "full",
        roots: [project],
      });
      const assets = await runtime.services["assets.list"]({
        limit: 50,
      });

      expect(JSON.stringify(assets)).not.toContain("asset-demo");
      expect(
        assets.items.some(
          (asset) =>
            asset.toolKey === "codex" &&
            asset.resourceType === "rule" &&
            asset.logicalKey.includes("AGENTS"),
        ),
      ).toBe(true);
      expect(assets.snapshotRevision).not.toBe("desktop-demo");
      const events: TaskEvent[] = [];
      runtime.taskEvents.subscribe(String(scan.taskId), 0, (event) => events.push(event));
      expect(
        events.some(
          (event) =>
            event.type === "accepted" && event.taskId === scan.taskId && event.sequence === 1,
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "completed" &&
            event.taskId === scan.taskId &&
            event.payload.status === "succeeded",
        ),
      ).toBe(true);
    } finally {
      runtime.close();
    }
  });

  it("honors migration conflict policies before saving a deployment plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-migration-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    const cursorRules = join(project, ".cursor", "rules");
    await mkdir(cursorRules, { recursive: true });
    const canonicalProject = await realpath(project);
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");
    await writeFile(join(project, ".cursor", "rules", "agents.mdc"), "Existing Cursor Rule.\n", {
      encoding: "utf8",
      flag: "wx",
    });

    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      fileWatcherFactory: () => ({ start: () => Promise.resolve(), close() {} }),
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.logicalKey.includes("AGENTS"),
      );
      if (source === undefined) throw new Error("Expected scanned Codex AGENTS asset");

      await expect(
        runtime.services["migration.preview"]({
          sourceAssetIds: [source.id],
          targetToolKey: "cursor",
          targetScopeId: project,
          conflictPolicy: "fail",
        }),
      ).rejects.toMatchObject({ code: "TARGET_CONFLICT" });

      await expect(
        runtime.services["migration.preview"]({
          sourceAssetIds: [source.id],
          targetToolKey: "cursor",
          targetScopeId: project,
          conflictPolicy: "merge",
        }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_CONVERSION" });

      const preview = await runtime.services["migration.preview"]({
        sourceAssetIds: [source.id],
        targetToolKey: "cursor",
        targetScopeId: project,
        conflictPolicy: "replace",
      });
      expect(preview.changes).toEqual([
        expect.objectContaining({
          operation: "replace",
          pathDisplay: join(canonicalProject, ".cursor", "rules", "agents.mdc"),
        }),
      ]);
      await expect(
        executeDeploymentAndWait(runtime, {
          planId: preview.planId,
          confirmedPlanHash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
          confirmations: preview.requiredConfirmations,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(readFile(join(project, ".cursor", "rules", "agents.mdc"), "utf8")).resolves.toBe(
        "Existing Cursor Rule.\n",
      );

      const deployment = await executeDeploymentAndWait(runtime, {
        planId: preview.planId,
        confirmedPlanHash: preview.planHash,
        confirmations: preview.requiredConfirmations,
      });
      const deploymentEvents: TaskEvent[] = [];
      runtime.taskEvents.subscribe(String(deployment.taskId), 0, (event) =>
        deploymentEvents.push(event),
      );
      expect(deploymentEvents.map((event) => event.type)).toEqual([
        "accepted",
        "phase.changed",
        "progress",
        "phase.changed",
        "progress",
        "phase.changed",
        "progress",
        "phase.changed",
        "progress",
        "phase.changed",
        "completed",
      ]);
      expect(
        deploymentEvents
          .filter((event) => event.type === "phase.changed")
          .map((event) => event.payload.to),
      ).toEqual(["preflight", "backing_up", "writing", "verifying", "completed"]);
      expect(
        deploymentEvents.filter((event) => event.type === "progress").map((event) => event.payload),
      ).toEqual([
        { phase: "preflight", completed: 0, total: 1, unit: "operations" },
        { phase: "backing_up", completed: 1, total: 1, unit: "operations" },
        { phase: "writing", completed: 1, total: 1, unit: "operations" },
        { phase: "verifying", completed: 1, total: 1, unit: "operations" },
      ]);
      expect(deploymentEvents.at(-1)).toMatchObject({
        type: "completed",
        payload: {
          status: "succeeded",
          succeededCount: 1,
          failedCount: 0,
          systemRecoveryLock: false,
        },
      });
      await expect(
        readFile(join(project, ".cursor", "rules", "agents.mdc"), "utf8"),
      ).resolves.toContain("Use local TypeScript conventions.");
      await expect(
        readFile(join(project, ".cursor", "rules", "agents.mdc"), "utf8"),
      ).resolves.not.toContain("Existing Cursor Rule.");

      await writeFile(
        join(project, ".cursor", "rules", "agents.mdc"),
        "External post-deployment edit.\n",
        "utf8",
      );
      await expect(
        executeRollbackAndWait(runtime, { deploymentId: deployment.deploymentId }),
      ).rejects.toMatchObject({ code: "STALE_INDEX" });
    } finally {
      runtime.close();
    }
  });

  it("suppresses deployment target paths while desktop file watching is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-watch-suppression-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    const watchService = new RecordingWatchService();
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      watchService,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
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

      await executeDeploymentAndWait(runtime, {
        planId: preview.planId,
        confirmedPlanHash: preview.planHash,
        confirmations: preview.requiredConfirmations,
      });

      const targetPaths = preview.changes.map((change) => change.pathDisplay);
      expect(watchService.suppressed).toContainEqual(targetPaths);
      expect(watchService.cleared).toContainEqual(targetPaths);
    } finally {
      runtime.close();
    }
  });

  it("keeps distinct scan-root watchers alive without duplicating an existing root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-watch-roots-"));
    temporaryDirectories.push(root);
    const reviewRoot = join(root, "review");
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    const userData = join(root, "user-data");
    await Promise.all([mkdir(reviewRoot), mkdir(sourceRoot), mkdir(targetRoot)]);
    const watchers: {
      readonly roots: readonly string[];
      starts: number;
      closes: number;
    }[] = [];
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: reviewRoot,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      fileWatcherFactory: (options) => {
        const watcher = { roots: [...options.roots], starts: 0, closes: 0 };
        watchers.push(watcher);
        return {
          start() {
            watcher.starts += 1;
            return Promise.resolve();
          },
          close() {
            watcher.closes += 1;
          },
        };
      },
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [reviewRoot] });
      await startScanAndWait(runtime, { mode: "full", roots: [sourceRoot] });
      await startScanAndWait(runtime, { mode: "full", roots: [targetRoot] });
      await startScanAndWait(runtime, { mode: "full", roots: [sourceRoot] });

      expect(watchers.map((watcher) => watcher.roots)).toEqual(
        await Promise.all(
          [reviewRoot, sourceRoot, targetRoot].map(async (path) => [await realpath(path)]),
        ),
      );
      expect(watchers.map((watcher) => watcher.starts)).toEqual([1, 1, 1]);
      expect(watchers.map((watcher) => watcher.closes)).toEqual([0, 0, 0]);
    } finally {
      runtime.close();
    }

    expect(watchers.map((watcher) => watcher.closes)).toEqual([1, 1, 1]);
  });

  it("attaches the watcher before scanning so attachment-time changes are indexed", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-watch-attachment-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    const sourceFile = join(project, "AGENTS.md");
    await mkdir(project);
    await writeFile(sourceFile, "Initial instructions.\n", "utf8");
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      fileWatcherFactory: () => ({
        async start() {
          await writeFile(sourceFile, "Changed while attaching.\n", "utf8");
        },
        close() {},
      }),
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      expect(assets.items.find((asset) => asset.logicalKey.includes("AGENTS"))?.contentHash).toBe(
        `sha256:${createHash("sha256").update("Changed while attaching.\n").digest("hex")}`,
      );
    } finally {
      runtime.close();
    }
  });

  it("limits a watcher fallback batch to the native watcher that emitted it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-watch-owner-"));
    temporaryDirectories.push(root);
    const firstProject = join(root, "first");
    const secondProject = join(root, "second");
    const userData = join(root, "user-data");
    await Promise.all([mkdir(firstProject), mkdir(secondProject)]);
    const callbacks: ((batch: WatchBatch) => void | Promise<void>)[] = [];
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: firstProject,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      fileWatcherFactory: (options) => {
        callbacks.push(options.onBatch);
        return { start: () => Promise.resolve(), close() {} };
      },
    });
    const events: { readonly roots: readonly string[] }[] = [];
    const unsubscribe = runtime.indexChanges.subscribe((event) => events.push(event));

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [firstProject] });
      await startScanAndWait(runtime, { mode: "full", roots: [secondProject] });
      expect(callbacks).toHaveLength(2);

      await callbacks[0]?.({
        kind: "refresh_required",
        reason: "unstable",
        suggestedAction: "Run a full scan or manual refresh",
      });

      expect(events).toEqual([{ roots: [firstProject] }]);
    } finally {
      unsubscribe();
      runtime.close();
    }
  });

  it("keeps other project assets when a watcher fallback performs a full scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-watch-full-scope-"));
    temporaryDirectories.push(root);
    const firstProject = join(root, "first");
    const secondProject = join(root, "second");
    const userData = join(root, "user-data");
    await Promise.all([mkdir(firstProject), mkdir(secondProject)]);
    await Promise.all([
      writeFile(join(firstProject, "AGENTS.md"), "First project instructions.\n", "utf8"),
      writeFile(join(secondProject, "AGENTS.md"), "Second project instructions.\n", "utf8"),
    ]);
    const callbacks: ((batch: WatchBatch) => void | Promise<void>)[] = [];
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: firstProject,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      fileWatcherFactory: (options) => {
        callbacks.push(options.onBatch);
        return { start: () => Promise.resolve(), close() {} };
      },
    });

    try {
      await startScanAndWait(runtime, {
        mode: "full",
        roots: [firstProject],
        projectId: deterministicProjectId(firstProject),
      });
      await startScanAndWait(runtime, {
        mode: "full",
        roots: [secondProject],
        projectId: deterministicProjectId(secondProject),
      });
      expect(callbacks).toHaveLength(2);

      await callbacks[0]?.({
        kind: "refresh_required",
        reason: "unstable",
        suggestedAction: "Run a full scan or manual refresh",
      });

      const sourceDirectories = new Set(
        (await runtime.services["assets.list"]({ toolKeys: ["codex"], limit: 200 })).items.map(
          ({ sourceDirectory }) => sourceDirectory,
        ),
      );
      expect(sourceDirectories).toEqual(
        new Set([await realpath(firstProject), await realpath(secondProject)]),
      );
    } finally {
      runtime.close();
    }
  });

  it("preserves a symlink selection identity when publishing watcher changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-index-changes-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const selectedProject = join(root, "selected-project");
    const userData = join(root, "user-data");
    const sourceFile = join(project, "AGENTS.md");
    await mkdir(project);
    await symlink(project, selectedProject, platform() === "win32" ? "junction" : "dir");
    await writeFile(sourceFile, "Source instructions.\n", "utf8");
    const onBatches: ((batch: WatchBatch) => void | Promise<void>)[] = [];
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: selectedProject,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      fileWatcherFactory: (options) => {
        onBatches.push(options.onBatch);
        return { start: () => Promise.resolve(), close() {} };
      },
    });
    const events: { readonly roots: readonly string[] }[] = [];
    const unsubscribe = runtime.indexChanges.subscribe((event) => events.push(event));

    try {
      await startScanAndWait(runtime, {
        mode: "full",
        roots: [selectedProject],
        projectId: "project:renderer-selection",
      });
      expect(onBatches).toHaveLength(1);
      expect(events).toEqual([]);
      const projectId = deterministicProjectId(selectedProject);
      const beforeAssets = await runtime.services["assets.list"]({ projectId, limit: 50 });
      const beforeHash = beforeAssets.items.find((asset) =>
        asset.logicalKey.includes("AGENTS"),
      )?.contentHash;
      expect(beforeHash).toBeDefined();

      await writeFile(sourceFile, "Updated source instructions.\n", "utf8");
      await onBatches[0]?.({
        kind: "changes",
        changedPaths: [AbsolutePathSchema.parse(await realpath(sourceFile))],
      });

      expect(events).toEqual([{ roots: [selectedProject] }]);
      const updatedAssets = await runtime.services["assets.list"]({ projectId, limit: 50 });
      const updatedHash = updatedAssets.items.find((asset) =>
        asset.logicalKey.includes("AGENTS"),
      )?.contentHash;
      expect(updatedHash).not.toBe(beforeHash);
    } finally {
      unsubscribe();
      runtime.close();
    }
  });

  it("runs watcher scans for every lexical root sharing one canonical directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-watch-lexical-roots-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const firstSelection = join(root, "first-selection");
    const secondSelection = join(root, "second-selection");
    const userData = join(root, "user-data");
    const sourceFile = join(project, "AGENTS.md");
    await mkdir(project);
    await Promise.all([
      symlink(project, firstSelection, platform() === "win32" ? "junction" : "dir"),
      symlink(project, secondSelection, platform() === "win32" ? "junction" : "dir"),
    ]);
    await writeFile(sourceFile, "Source instructions.\n", "utf8");
    const onBatches: ((batch: WatchBatch) => void | Promise<void>)[] = [];
    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: firstSelection,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
      fileWatcherFactory: (options) => {
        onBatches.push(options.onBatch);
        return { start: () => Promise.resolve(), close() {} };
      },
    });
    const events: { readonly roots: readonly string[] }[] = [];
    const unsubscribe = runtime.indexChanges.subscribe((event) => events.push(event));

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [firstSelection] });
      await startScanAndWait(runtime, { mode: "full", roots: [secondSelection] });
      expect(onBatches).toHaveLength(1);

      await writeFile(sourceFile, "Updated source instructions.\n", "utf8");
      await onBatches[0]?.({
        kind: "changes",
        changedPaths: [AbsolutePathSchema.parse(await realpath(sourceFile))],
      });

      expect(events).toEqual([{ roots: [firstSelection, secondSelection].sort() }]);
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const updated = assets.items.find((asset) => asset.logicalKey.includes("AGENTS"));
      expect(updated?.contentHash).toBe(
        `sha256:${createHash("sha256").update("Updated source instructions.\n").digest("hex")}`,
      );
    } finally {
      unsubscribe();
      runtime.close();
    }
  });

  it("emits deployment preflight failures without an unnecessary recovery lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-deploy-failure-events-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project);
    await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");

    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
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
      const history = await runtime.services["history.list"]({ kinds: ["deployment"], limit: 10 });
      const planned = history.items.find((entry) => entry.status === "planned");
      if (planned === undefined) throw new Error("Expected planned deployment history entry");
      let taskId: string | undefined;

      try {
        await executeDeploymentAndWait(runtime, {
          planId: preview.planId,
          confirmedPlanHash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
          confirmations: preview.requiredConfirmations,
        });
        throw new Error("Expected deployment execution to fail");
      } catch (error) {
        expect(error).toMatchObject({ code: "VALIDATION_FAILED" });
        taskId = error instanceof Error && "taskId" in error ? String(error.taskId) : undefined;
        expect(taskId).toMatch(/^task:deployment:/);
      }
      if (taskId === undefined) throw new Error("Expected deployment failure task id");
      const events: TaskEvent[] = [];
      runtime.taskEvents.subscribe(taskId, 0, (event) => events.push(event));

      expect(events.map((event) => event.type)).toEqual([
        "accepted",
        "phase.changed",
        "progress",
        "item.failed",
        "phase.changed",
        "completed",
      ]);
      expect(events.find((event) => event.type === "item.failed")).toMatchObject({
        payload: {
          itemRef: planned.id,
          errorCode: "VALIDATION_FAILED",
          message: "Confirmed plan hash does not match deployment plan",
          retryable: false,
        },
      });
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        payload: {
          status: "failed",
          failedCount: 1,
          resultRef: planned.id,
          systemRecoveryLock: false,
        },
      });
      const acceptedByCursor: TaskEvent[] = [];
      const cursor = createTaskEventCursor(taskId, 0, (event) => acceptedByCursor.push(event));
      for (const event of events) {
        expect(cursor.push(event).kind, `${event.sequence}:${event.type}`).toBe("accepted");
      }
      expect(acceptedByCursor).toHaveLength(events.length);
    } finally {
      runtime.close();
    }
  });

  it("emits rollback preflight failure events without creating a recovery dead end", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-rollback-preflight-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await mkdir(project);

    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      let taskId: string | undefined;
      try {
        await executeRollbackAndWait(runtime, {
          deploymentId: "deployment-record-missing",
        });
        throw new Error("Expected rollback preflight to fail");
      } catch (error) {
        expect(error).toMatchObject({ code: "NOT_FOUND" });
        taskId = error instanceof Error && "taskId" in error ? String(error.taskId) : undefined;
        expect(taskId).toMatch(/^task:rollback:/);
      }
      if (taskId === undefined) throw new Error("Expected rollback failure task id");

      const events: TaskEvent[] = [];
      runtime.taskEvents.subscribe(taskId, 0, (event) => events.push(event));
      expect(events.map((event) => event.type)).toEqual([
        "accepted",
        "phase.changed",
        "progress",
        "item.failed",
        "phase.changed",
        "completed",
      ]);
      expect(events.find((event) => event.type === "item.failed")).toMatchObject({
        payload: {
          itemRef: "deployment-record-missing",
          errorCode: "NOT_FOUND",
          message: "Deployment record not found",
          retryable: false,
        },
      });
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        payload: {
          status: "failed",
          failedCount: 1,
          resultRef: "deployment-record-missing",
          systemRecoveryLock: false,
        },
      });
      const acceptedByCursor: TaskEvent[] = [];
      const cursor = createTaskEventCursor(taskId, 0, (event) => acceptedByCursor.push(event));
      for (const event of events) {
        expect(cursor.push(event).kind, `${event.sequence}:${event.type}`).toBe("accepted");
      }
      expect(acceptedByCursor).toHaveLength(events.length);
    } finally {
      runtime.close();
    }
  });

  it("rejects migration previews that mix source resource types", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-desktop-mixed-migration-"));
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

    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await startScanAndWait(runtime, { mode: "full", roots: [project] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const rule = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.resourceType === "rule",
      );
      const skill = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.resourceType === "skill",
      );
      if (rule === undefined) throw new Error("Expected scanned Codex rule asset");
      if (skill === undefined) throw new Error("Expected scanned Codex skill asset");
      expect(
        (await runtime.services["assets.get"]({ assetId: skill.id })).asset.disablementOptions,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "move_file",
            description:
              "Move the Skill package directory into the AI Config Hub disabled-assets area.",
          }),
        ]),
      );

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
});

async function expectSourceDrift(result: Promise<unknown>): Promise<void> {
  try {
    await result;
    throw new Error("Expected deployment execution to reject source drift");
  } catch (error) {
    expect(error).toMatchObject({ code: "STALE_INDEX" });
  }
}

async function writeLargeSkillPackage(project: string, supportFileCount: number): Promise<void> {
  await mkdir(join(project, ".agents", "skills", "release", "assets"), { recursive: true });
  await writeFile(join(project, "AGENTS.md"), "Use local TypeScript conventions.\n", "utf8");
  await writeFile(
    join(project, ".agents", "skills", "release", "SKILL.md"),
    "---\nname: release\ndescription: Release safely\n---\nRun the checklist.\n",
    "utf8",
  );
  for (let index = 1; index <= supportFileCount; index += 1) {
    await writeFile(
      join(
        project,
        ".agents",
        "skills",
        "release",
        "assets",
        `note-${String(index).padStart(3, "0")}.md`,
      ),
      `Release note ${index}\n`,
      "utf8",
    );
  }
}

function seedDiagnostics(
  userDataPath: string,
  groups: readonly {
    readonly prefix: string;
    readonly count: number;
    readonly code: string;
    readonly message?: string;
  }[],
): void {
  const database = new DatabaseSync(join(userDataPath, "ai-config-hub.sqlite"));
  const scanRun = database.prepare("SELECT id FROM scan_runs ORDER BY rowid DESC LIMIT 1").get() as
    | { readonly id: string }
    | undefined;
  if (scanRun === undefined) {
    database.close();
    throw new Error("Expected a scan run before seeding diagnostics");
  }
  const insert = database.prepare(
    `INSERT INTO diagnostics(
       id, asset_id, scan_run_id, code, severity, message_key, location_json,
       evidence_json, suggested_action, fingerprint, created_at
     ) VALUES(?, NULL, ?, ?, 'error', ?, '{}', ?, 'Review the diagnostic', ?, ?)`,
  );
  database.exec("BEGIN IMMEDIATE; DELETE FROM diagnostics");
  try {
    for (const group of groups) {
      for (let index = 0; index < group.count; index += 1) {
        const diagnosticId = `diagnostic:${group.prefix}:${String(index).padStart(5, "0")}`;
        const message = group.message ?? `Seeded diagnostic ${index}`;
        const diagnostic = {
          diagnosticId,
          code: group.code,
          severity: "error",
          category: "internal",
          message,
          subject: { kind: "scan", id: "scan:seeded-diagnostics" },
          impact: "Exercises bounded diagnostic reads",
          evidence: { seededIndex: index },
          suggestedActions: ["Review the diagnostic"],
          blocking: true,
          createdAt: "2026-06-28T08:00:00.000Z",
        };
        insert.run(
          diagnosticId,
          scanRun.id,
          group.code,
          message,
          JSON.stringify(diagnostic),
          diagnosticId,
          Date.parse("2026-06-28T08:00:00.000Z"),
        );
      }
    }
    const revision = (
      database.prepare("PRAGMA user_version").get() as { readonly user_version: number }
    ).user_version;
    database.exec(`PRAGMA user_version = ${String(revision + 1)}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function seedCoveredEffectiveConfig(
  userDataPath: string,
  coveredAssetId: string,
  coveringAssetId: string,
): EffectiveConfig {
  const database = new DatabaseSync(join(userDataPath, "ai-config-hub.sqlite"));
  try {
    const assetRows = database
      .prepare("SELECT domain_id, normalized_json FROM assets WHERE domain_id IN (?, ?)")
      .all(coveredAssetId, coveringAssetId) as {
      readonly domain_id: string;
      readonly normalized_json: string;
    }[];
    const assets = new Map(
      assetRows.map((row) => [row.domain_id, JSON.parse(row.normalized_json) as Asset]),
    );
    const covered = assets.get(coveredAssetId);
    const covering = assets.get(coveringAssetId);
    if (covered === undefined || covering === undefined) {
      throw new Error("Expected covered-state assets in storage");
    }
    const scanRun = database
      .prepare(
        "SELECT id, effective_configs_json FROM scan_runs ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get() as { readonly id: string; readonly effective_configs_json: string } | undefined;
    if (scanRun === undefined) throw new Error("Expected an effective configuration scan run");
    const configs = JSON.parse(scanRun.effective_configs_json) as EffectiveConfig[];
    const baseIndex = configs.findIndex(
      (config) =>
        config.adapterId === "builtin-claude-code" &&
        config.steps.some((step) => step.assetId === coveringAssetId),
    );
    const base = configs[baseIndex];
    if (base === undefined) throw new Error("Expected a Claude effective configuration");
    const seeded: EffectiveConfig = {
      ...base,
      resourceKinds: ["mcp"],
      contributingAssetIds: [covering.assetId],
      ignoredAssetIds: [covered.assetId],
      steps: [
        {
          action: "ignore",
          assetId: covered.assetId,
          coveredByAssetId: covering.assetId,
          reason: `A more specific scope overrides this resource (${covering.assetId})`,
        },
        {
          action: "override",
          assetId: covering.assetId,
          reason: "The asset applies to the selected target scope",
        },
      ],
      resolvedResources: [covering.resource],
    };
    const updated = [...configs];
    updated[baseIndex] = seeded;
    database
      .prepare("UPDATE scan_runs SET effective_configs_json = ? WHERE id = ?")
      .run(JSON.stringify(updated), scanRun.id);
    return seeded;
  } finally {
    database.close();
  }
}

function seedEffectiveConfigHistory(
  userDataPath: string,
  staleCoveredAssetId: string,
  coveringAssetId: string,
  alternateTargetPath: string,
): void {
  const stale = seedCoveredEffectiveConfig(userDataPath, staleCoveredAssetId, coveringAssetId);
  const database = new DatabaseSync(join(userDataPath, "ai-config-hub.sqlite"));
  try {
    const assetRows = database
      .prepare("SELECT domain_id, normalized_json FROM assets WHERE domain_id IN (?, ?)")
      .all(staleCoveredAssetId, coveringAssetId) as {
      readonly domain_id: string;
      readonly normalized_json: string;
    }[];
    const assets = new Map(
      assetRows.map((row) => [row.domain_id, JSON.parse(row.normalized_json) as Asset]),
    );
    const staleCovered = assets.get(staleCoveredAssetId);
    const covering = assets.get(coveringAssetId);
    if (staleCovered === undefined || covering === undefined) {
      throw new Error("Expected effective-history assets in storage");
    }
    const latestSameTarget: EffectiveConfig = {
      ...stale,
      contributingAssetIds: [staleCovered.assetId],
      ignoredAssetIds: [],
      steps: [
        {
          action: "override",
          assetId: staleCovered.assetId,
          reason: "The asset applies to the selected target scope",
        },
      ],
      resolvedResources: [staleCovered.resource],
    };
    const retainedOtherTarget: EffectiveConfig = {
      ...stale,
      canonicalTargetPath: AbsolutePathSchema.parse(alternateTargetPath),
      contributingAssetIds: [staleCovered.assetId],
      ignoredAssetIds: [covering.assetId],
      steps: [
        {
          action: "ignore",
          assetId: covering.assetId,
          coveredByAssetId: staleCovered.assetId,
          reason: `A more specific scope overrides this resource (${staleCovered.assetId})`,
        },
        {
          action: "override",
          assetId: staleCovered.assetId,
          reason: "The asset applies to the selected target scope",
        },
      ],
      resolvedResources: [staleCovered.resource],
    };
    const previous = database
      .prepare("SELECT id, started_at FROM scan_runs ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get() as { readonly id: string; readonly started_at: number } | undefined;
    if (previous === undefined) throw new Error("Expected an effective-history scan run");
    database
      .prepare("UPDATE scan_runs SET effective_configs_json = ? WHERE id = ?")
      .run(JSON.stringify([stale]), previous.id);
    const insert = database.prepare(
      `INSERT INTO scan_runs(
         id, domain_id, scan_kind, status, phase, requested_roots_json, started_at,
         effective_configs_json
       ) VALUES(?, ?, 'full', 'succeeded', 'succeeded', '[]', ?, ?)`,
    );
    insert.run(
      "seed-effective-other-target",
      "scan:seed-effective-other-target",
      previous.started_at + 1,
      JSON.stringify([retainedOtherTarget]),
    );
    insert.run(
      "seed-effective-latest-target",
      "scan:seed-effective-latest-target",
      previous.started_at + 2,
      JSON.stringify([latestSameTarget]),
    );
  } finally {
    database.close();
  }
}

function projectIdForIndexedRoot(database: DatabaseSync, root: string): string | undefined {
  const row = database
    .prepare("SELECT domain_id FROM projects WHERE root_path_normalized = ?")
    .get(root) as { readonly domain_id: string } | undefined;
  return row?.domain_id;
}

function deterministicProjectId(root: string): `project:${string}` {
  const hash = createHash("sha256")
    .update("ai-config-hub:identity:v1\0")
    .update("project")
    .update("\0")
    .update(String(Buffer.byteLength(root)))
    .update(":")
    .update(root)
    .digest("hex");
  return `project:${hash}`;
}
