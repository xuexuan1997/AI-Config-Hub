import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TaskEvent } from "@ai-config-hub/api";
import { ContentHashSchema } from "@ai-config-hub/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createDesktopCommandServices } from "./composition.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("desktop command service composition", () => {
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
