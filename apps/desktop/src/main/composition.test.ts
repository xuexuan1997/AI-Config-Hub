import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTaskEventCursor, type TaskEvent } from "@ai-config-hub/api";
import { ContentHashSchema } from "@ai-config-hub/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createDesktopCommandServices, DesktopTaskEvents } from "./composition.js";

const temporaryDirectories: string[] = [];

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
    'name = "reviewer"\ndeveloper_instructions = "Review carefully."\n',
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
      await runtime.services["scan.start"]({ mode: "full", roots: [project] });
      const assets = await runtime.services["assets.list"]({ limit: 50 });
      const source = assets.items.find(
        (asset) => asset.toolKey === "codex" && asset.logicalKey.includes("AGENTS"),
      );
      if (source === undefined) throw new Error("Expected scanned Codex AGENTS asset");

      await expect(runtime.services["assets.openSource"]({ assetId: source.id })).resolves.toEqual({
        assetId: source.id,
        opened: true,
      });
      expect(openedPaths).toEqual([await realpath(sourcePath)]);
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
      await runtime.services["scan.start"]({ mode: "full", roots: [project] });
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
      await runtime.services["scan.start"]({ mode: "full" });
      const assets = await runtime.services["assets.list"]({ toolKeys: ["codex"], limit: 50 });

      expect(new Set(assets.items.map(({ resourceType }) => resourceType))).toEqual(
        new Set(["rule", "agent", "skill", "mcp"]),
      );
      expect(new Set(assets.items.map(({ scopeKind }) => scopeKind))).toEqual(new Set(["user"]));
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
        earliestAvailableSequence: 7,
        latestSequence: 206,
      },
    });
    expect(replayed[1]).toMatchObject({
      sequence: null,
      payload: {
        taskKind: "deployment",
        phase: "preflight",
        status: "running",
        progress: { phase: "preflight", completed: 205, total: 205, unit: "operations" },
        lastSequence: 206,
        cancellable: true,
      },
    });
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
      await runtime.services["scan.cancel"]({ taskId: scan.taskId });
      const events: TaskEvent[] = [];
      runtime.taskEvents.subscribe(String(scan.taskId), 0, (event) => events.push(event));

      expect(events.map((event) => event.type)).toContain("cancel.requested");
      expect(events.find((event) => event.type === "cancel.requested")).toMatchObject({
        payload: { reason: "user", effectiveAfterPhase: "completed" },
      });
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
      const rollback = await runtime.services["deployment.rollback"]({
        deploymentId: deployment.deploymentId,
      });

      expect(deployment.snapshot).toMatchObject({
        status: "recorded",
        message: `record deployment ${deployment.deploymentId}`,
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
      expect((await stat(historyRoot)).mode & 0o777).toBe(0o700);
      expect(await readdir(join(historyRoot, "assets"))).toHaveLength(1);
    } finally {
      runtime.close();
    }
  });

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
      const scan = await runtime.services["scan.start"]({
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
    await writeFile(join(project, ".cursor", "rules", "agents.mdc"), "Existing Cursor rule.\n", {
      encoding: "utf8",
      flag: "wx",
    });

    const runtime = await createDesktopCommandServices({
      appVersion: "0.2.0-test",
      cwd: project,
      now: () => "2026-06-28T08:00:00.000Z",
      userDataPath: userData,
    });

    try {
      await runtime.services["scan.start"]({ mode: "full", roots: [project] });
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
        runtime.services["deployment.execute"]({
          planId: preview.planId,
          confirmedPlanHash: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
          confirmations: preview.requiredConfirmations,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(readFile(join(project, ".cursor", "rules", "agents.mdc"), "utf8")).resolves.toBe(
        "Existing Cursor rule.\n",
      );

      const deployment = await runtime.services["deployment.execute"]({
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
      ).resolves.not.toContain("Existing Cursor rule.");

      await chmod(cursorRules, 0o500);
      await expect(
        runtime.services["deployment.rollback"]({ deploymentId: deployment.deploymentId }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    } finally {
      await chmod(cursorRules, 0o700).catch(() => undefined);
      runtime.close();
    }
  });

  it("emits deployment failure events with a recovery lock and task id", async () => {
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
      const history = await runtime.services["history.list"]({ kinds: ["deployment"], limit: 10 });
      const planned = history.items.find((entry) => entry.status === "planned");
      if (planned === undefined) throw new Error("Expected planned deployment history entry");
      let taskId: string | undefined;

      try {
        await runtime.services["deployment.execute"]({
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
          retryable: false,
        },
      });
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        payload: {
          status: "failed",
          failedCount: 1,
          resultRef: planned.id,
          systemRecoveryLock: true,
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

  it("emits rollback preflight failure events with a recovery lock and task id", async () => {
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
        await runtime.services["deployment.rollback"]({
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
          retryable: false,
        },
      });
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        payload: {
          status: "failed",
          failedCount: 1,
          resultRef: "deployment-record-missing",
          systemRecoveryLock: true,
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
});
