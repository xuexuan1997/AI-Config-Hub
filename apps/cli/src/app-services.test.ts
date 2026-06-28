import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

describe("CLI command service composition", () => {
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
        pathDisplay: "abbreviated",
        scanHints: true,
        fileWatching: true,
      });

      const updated = await runtime.services["settings.update"]({
        expectedRevision: initial.revision,
        patch: {
          theme: "dark",
          pathDisplay: "full",
          scanHints: false,
          fileWatching: false,
        },
      });
      expect(updated.values).toEqual({
        theme: "dark",
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
});
