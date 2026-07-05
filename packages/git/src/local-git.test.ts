import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IsoDateTime } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { SystemLocalGitPort, type RunGit } from "./local-git.js";

const authoredAt: IsoDateTime = "2026-06-22T10:00:00Z";

describe("SystemLocalGitPort", () => {
  it("uses local-only git commands with hardened flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "aich-git-"));
    await writeFile(join(root, "snapshot.json"), "{}\n");
    const calls: string[][] = [];
    const runGit: RunGit = (args) => {
      calls.push([...args]);
      const command = args.join(" ");
      expect(command).not.toMatch(/\b(?:clone|fetch|pull|push)\b/);
      expect(args).toContain("--no-optional-locks");
      expect(args).toContain("credential.helper=");
      expect(args).toContain("core.hooksPath=/dev/null");
      if (args.includes("status")) {
        return Promise.resolve({ stdout: "?? snapshot.json\0", stderr: "" });
      }
      if (args.includes("log")) {
        return Promise.resolve({ stdout: `abc123\0${authoredAt}\0snapshot\0\n`, stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const git = new SystemLocalGitPort(runGit);
    await git.initialize(root);
    await git.snapshot({ root, paths: ["snapshot.json"], message: "snapshot", authoredAt });

    expect(calls.some((args) => args.includes("--initial-branch=main"))).toBe(true);
    expect(calls.some((args) => args.includes("add") && args.includes("snapshot.json"))).toBe(true);
    expect(calls.some((args) => args.includes("commit") && args.includes(authoredAt))).toBe(true);
  });

  it("creates deterministic local commits and reads history with real git", async () => {
    const root = await mkdtemp(join(tmpdir(), "aich-git-real-"));
    const git = new SystemLocalGitPort();
    await git.initialize(root);
    await writeFile(join(root, "assets.json"), '{"id":"asset-1"}\n');

    const first = await git.snapshot({
      root,
      paths: ["assets.json"],
      message: "record deployment",
      authoredAt,
    });
    await writeFile(join(root, "assets.json"), '{"id":"asset-2"}\n');
    const summary = await git.snapshot({
      root,
      paths: ["assets.json"],
      message: "record deployment update",
      authoredAt,
    });

    expect(summary.subject).toBe("record deployment update");
    expect(summary.authoredAt).toBe(authoredAt);
    const history = await git.history({ root, limit: 10 });
    expect(history).toEqual([summary, first]);
    expect(await git.diff({ root, from: first.commitId, to: summary.commitId })).toContain(
      '+{"id":"asset-2"}',
    );
  });

  it("rejects unsafe, symlink, and unlisted paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "aich-git-reject-"));
    const outside = await mkdtemp(join(tmpdir(), "aich-outside-"));
    const git = new SystemLocalGitPort();
    await git.initialize(root);
    await writeFile(join(root, "allowed.json"), "{}\n");
    await writeFile(join(root, "unlisted.json"), "{}\n");

    await expect(
      git.snapshot({ root, paths: ["../escape"], message: "bad", authoredAt }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    await expect(
      git.snapshot({ root, paths: [join(root, "allowed.json")], message: "bad", authoredAt }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    await expect(
      git.snapshot({ root, paths: [".git/config"], message: "bad", authoredAt }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });

    await mkdir(join(root, "links"));
    await symlink(outside, join(root, "links", "outside"), directoryLinkType());
    await expect(
      git.snapshot({ root, paths: ["links/outside"], message: "bad", authoredAt }),
    ).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });

    await expect(
      git.snapshot({ root, paths: ["allowed.json"], message: "bad", authoredAt }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

function directoryLinkType(): "dir" | "junction" {
  return process.platform === "win32" ? "junction" : "dir";
}
