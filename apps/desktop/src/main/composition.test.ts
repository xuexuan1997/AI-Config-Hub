import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TaskEvent } from "@ai-config-hub/api";
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
});
