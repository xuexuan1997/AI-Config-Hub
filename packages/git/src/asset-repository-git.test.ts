import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AbsolutePath, IsoDateTime } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import {
  SystemAssetRepositoryGitPort,
  type AssetRepositoryRunGit,
} from "./asset-repository-git.js";

const execFileAsync = promisify(execFile);
const authoredAt: IsoDateTime = "2026-06-22T10:00:00Z";

describe("SystemAssetRepositoryGitPort", () => {
  it("constructs hardened remote workflow commands without shell exposure", async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), "aich-asset-parent-"));
    const root = join(parentRoot, "repo");
    const calls: Array<{ readonly args: readonly string[]; readonly cwd: AbsolutePath }> = [];
    const runGit: AssetRepositoryRunGit = (args, cwd) => {
      calls.push({ args: [...args], cwd });
      expect(args).toContain("--no-optional-locks");
      expect(args).toContain("credential.helper=");
      expect(args).toContain("core.hooksPath=/dev/null");
      expect(args).not.toContain("--recurse-submodules");
      if (args.includes("status")) {
        return Promise.resolve({ stdout: "## main...origin/main [ahead 1]\0", stderr: "" });
      }
      if (args.includes("log")) {
        return Promise.resolve({ stdout: `abc123\0${authoredAt}\0asset update\0\n`, stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const git = new SystemAssetRepositoryGitPort(runGit);
    await git.clone({ remoteUrl: "https://example.test/assets.git", parentRoot, targetRoot: root });
    await mkdir(root);
    await git.pull({ root, remote: "origin", branch: "main" });
    await git.status({ root });
    await git.diff({ root, from: "HEAD~1", to: "HEAD" });
    await git.commit({ root, paths: ["assets/example.json"], message: "asset update", authoredAt });
    await git.push({ root, remote: "origin", branch: "main" });
    await git.tag({ root, name: "asset/v1", message: "asset v1" });
    await git.restore({ root, paths: ["assets/example.json"] });
    await git.history({ root, limit: 5 });

    expect(calls.map((call) => call.args.filter((arg) => !arg.startsWith("-c")))).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(["clone", "--no-recurse-submodules", "--"]),
        expect.arrayContaining(["pull", "--ff-only", "--recurse-submodules=no", "origin", "main"]),
        expect.arrayContaining(["status", "--porcelain=v1", "--branch", "-z"]),
        expect.arrayContaining(["diff", "--no-ext-diff", "HEAD~1..HEAD"]),
        expect.arrayContaining(["add", "--", "assets/example.json"]),
        expect.arrayContaining([
          "commit",
          "--no-verify",
          "--date",
          authoredAt,
          "-m",
          "asset update",
        ]),
        expect.arrayContaining(["push", "origin", "HEAD:main"]),
        expect.arrayContaining(["tag", "-a", "asset/v1", "-m", "asset v1"]),
        expect.arrayContaining(["restore", "--", "assets/example.json"]),
        expect.arrayContaining(["log", "--max-count=5", "--format=%H%x00%aI%x00%s%x00"]),
      ]),
    );
    expect(calls.find((call) => call.args.includes("clone"))?.cwd).toBe(await realpath(parentRoot));
  });

  it("classifies conflicted, ahead, behind, and diverged status with recovery guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "aich-asset-status-"));
    const runGit: AssetRepositoryRunGit = (args) => {
      if (args.includes("status")) {
        return Promise.resolve({
          stdout: "## main...origin/main [ahead 1, behind 2]\0UU assets/a.json\0 M assets/b.json\0",
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    const status = await new SystemAssetRepositoryGitPort(runGit).status({ root });

    expect(status).toMatchObject({
      state: "conflicted",
      ahead: 1,
      behind: 2,
      hasUncommittedChanges: true,
      conflictedPaths: ["assets/a.json"],
    });
    expect(status.recoveryGuidance.join("\n")).toContain("Resolve merge conflicts");
    expect(status.recoveryGuidance.join("\n")).toContain("assets/a.json");
  });

  it("rejects unsafe clone URLs and target roots escaping the requested parent", async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), "aich-asset-parent-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "aich-asset-outside-"));
    const git = new SystemAssetRepositoryGitPort(() => Promise.resolve({ stdout: "", stderr: "" }));

    await expect(
      git.clone({
        remoteUrl: "http://example.test/assets.git",
        parentRoot,
        targetRoot: join(parentRoot, "repo"),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      git.clone({
        remoteUrl: "ssh://example.test/assets.git",
        parentRoot,
        targetRoot: join(parentRoot, "repo"),
      }),
    ).resolves.toBeUndefined();
    await expect(
      git.clone({
        remoteUrl: "git@example.test:org/assets.git",
        parentRoot,
        targetRoot: join(parentRoot, "repo-2"),
      }),
    ).resolves.toBeUndefined();
    await expect(
      git.clone({
        remoteUrl: `file://${parentRoot}/remote.git`,
        parentRoot,
        targetRoot: join(outsideRoot, "repo"),
      }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
  });

  it("requires explicit safe commit paths and rejects symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aich-asset-commit-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "aich-asset-outside-"));
    await symlink(outsideRoot, join(root, "outside-link"));
    const git = new SystemAssetRepositoryGitPort(() =>
      Promise.resolve({ stdout: `abc123\0${authoredAt}\0asset update\0\n`, stderr: "" }),
    );

    await expect(git.commit({ root, paths: [], message: "bad", authoredAt })).rejects.toMatchObject(
      { code: "VALIDATION_FAILED" },
    );
    await expect(
      git.commit({ root, paths: ["../escape"], message: "bad", authoredAt }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    await expect(
      git.commit({ root, paths: [".git/config"], message: "bad", authoredAt }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOT" });
    await expect(
      git.commit({ root, paths: ["outside-link/file.json"], message: "bad", authoredAt }),
    ).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
  });

  it("rejects option-like revision arguments before running diff or history", async () => {
    const root = await mkdtemp(join(tmpdir(), "aich-asset-revisions-"));
    let calls = 0;
    const git = new SystemAssetRepositoryGitPort(() => {
      calls += 1;
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    await expect(git.diff({ root, from: "--output=/tmp/leak" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(git.history({ root, limit: 10, cursor: "../main" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(calls).toBe(0);
  });

  it("clones, commits, and pushes to a local bare repository with real git", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "aich-asset-real-"));
    const remote = join(tmp, "remote.git");
    const seed = join(tmp, "seed");
    const work = join(tmp, "work");
    const verify = join(tmp, "verify");

    await git(["init", "--bare", remote], tmp);
    await git(["init", "--initial-branch=main", seed], tmp);
    await git(["config", "user.name", "Test User"], seed);
    await git(["config", "user.email", "test@example.test"], seed);
    await writeFile(join(seed, "README.md"), "# assets\n");
    await git(["add", "README.md"], seed);
    await git(["commit", "-m", "seed"], seed);
    await git(["remote", "add", "origin", remote], seed);
    await git(["push", "-u", "origin", "main"], seed);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], remote);

    const assetGit = new SystemAssetRepositoryGitPort();
    await assetGit.clone({ remoteUrl: `file://${remote}`, parentRoot: tmp, targetRoot: work });
    await writeFile(join(work, "asset.json"), '{"id":"asset-1"}\n');
    const summary = await assetGit.commit({
      root: work,
      paths: ["asset.json"],
      message: "add asset",
      authoredAt,
    });
    await assetGit.push({ root: work, remote: "origin", branch: "main" });
    await git(["clone", remote, verify], tmp);

    expect(summary.subject).toBe("add asset");
    expect((await lstat(join(verify, "asset.json"))).isFile()).toBe(true);
  });
});

async function git(args: readonly string[], cwd: string): Promise<void> {
  await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}
