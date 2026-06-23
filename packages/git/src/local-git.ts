import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { GitCommitSummary, LocalGitPort } from "@ai-config-hub/core";
import { AppError, type AbsolutePath, type IsoDateTime } from "@ai-config-hub/shared";

const execFileAsync = promisify(execFile);

export interface GitRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type RunGit = (args: readonly string[], cwd: AbsolutePath) => Promise<GitRunResult>;

const BASE_GIT_ARGS = [
  "--no-optional-locks",
  "-c",
  "credential.helper=",
  "-c",
  "core.hooksPath=/dev/null",
] as const;

export class SystemLocalGitPort implements LocalGitPort {
  constructor(private readonly runGit: RunGit = defaultRunGit) {}

  async initialize(root: AbsolutePath): Promise<void> {
    await this.git(["init", "--initial-branch=main"], root);
    await this.git(["config", "user.name", "AI Config Hub"], root);
    await this.git(["config", "user.email", "history@ai-config-hub.local"], root);
  }

  async snapshot(input: {
    readonly root: AbsolutePath;
    readonly paths: readonly string[];
    readonly message: string;
    readonly authoredAt: IsoDateTime;
  }): Promise<GitCommitSummary> {
    const paths = validateRelativePaths(input.paths);
    await assertPathsStayInsideRoot(input.root, paths);
    await this.assertNoUnlistedChanges(input.root, paths);

    await this.git(["add", "--", ...paths], input.root);
    await this.git(
      [
        "-c",
        "user.name=AI Config Hub",
        "-c",
        "user.email=history@ai-config-hub.local",
        "commit",
        "--date",
        input.authoredAt,
        "-m",
        input.message,
      ],
      input.root,
    );

    const [summary] = await this.history({ root: input.root, limit: 1 });
    if (summary === undefined) {
      throw new AppError({
        code: "INTERNAL_ERROR",
        message: "Git commit succeeded but no commit could be read back",
        retryable: false,
        suggestedActions: ["Inspect the local history repository"],
      });
    }
    return summary;
  }

  async diff(input: {
    readonly root: AbsolutePath;
    readonly from?: string;
    readonly to?: string;
  }): Promise<string> {
    const range =
      input.from === undefined
        ? input.to
        : input.to === undefined
          ? input.from
          : `${input.from}..${input.to}`;
    const result = await this.git(
      range === undefined ? ["diff", "--no-ext-diff"] : ["diff", "--no-ext-diff", range],
      input.root,
    );
    return result.stdout;
  }

  async history(input: {
    readonly root: AbsolutePath;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<readonly GitCommitSummary[]> {
    const limit = Math.max(1, Math.min(input.limit, 200));
    const result = await this.git(
      [
        "log",
        `--max-count=${String(limit)}`,
        "--format=%H%x00%aI%x00%s%x00",
        ...(input.cursor === undefined ? [] : [`${input.cursor}..HEAD`]),
      ],
      input.root,
    );
    return parseHistory(result.stdout);
  }

  private async assertNoUnlistedChanges(
    root: AbsolutePath,
    allowlistedPaths: readonly string[],
  ): Promise<void> {
    const allowlist = new Set(allowlistedPaths);
    const status = await this.git(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      root,
    );
    const changed = parseStatusPaths(status.stdout);
    const unlisted = changed.filter((path) => !allowlist.has(path));
    if (unlisted.length > 0) {
      throw new AppError({
        code: "CONFLICT",
        message: "Local history snapshot contains unlisted working-tree changes",
        retryable: true,
        suggestedActions: ["Commit, discard, or include the listed paths before snapshotting"],
        safeContext: { path: unlisted[0] ?? "unknown" },
      });
    }
  }

  private async git(args: readonly string[], cwd: AbsolutePath): Promise<GitRunResult> {
    return this.runGit([...BASE_GIT_ARGS, ...args], cwd);
  }
}

async function defaultRunGit(args: readonly string[], cwd: AbsolutePath): Promise<GitRunResult> {
  const { stdout, stderr } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      HOME: "",
      LANG: "C",
      LC_ALL: "C",
      PATH: process.env["PATH"] ?? "",
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
}

function validateRelativePaths(paths: readonly string[]): readonly string[] {
  if (paths.length === 0) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "A Git snapshot requires at least one path",
      retryable: false,
      suggestedActions: ["Provide the relative paths to snapshot"],
    });
  }

  const seen = new Set<string>();
  return paths.map((path) => {
    const segments = path.split("/");
    if (
      path.length === 0 ||
      isAbsolute(path) ||
      path.includes("\\") ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
      segments.includes(".git")
    ) {
      throw new AppError({
        code: "PATH_OUTSIDE_ALLOWED_ROOT",
        message: "Git snapshot paths must be normalized repository-relative paths",
        retryable: false,
        suggestedActions: ["Use a normalized relative path inside the local history repository"],
        safeContext: { path },
      });
    }
    if (seen.has(path)) {
      throw new AppError({
        code: "VALIDATION_FAILED",
        message: "Git snapshot paths must be unique",
        retryable: false,
        suggestedActions: ["Remove duplicate paths before snapshotting"],
        safeContext: { path },
      });
    }
    seen.add(path);
    return path;
  });
}

async function assertPathsStayInsideRoot(
  root: AbsolutePath,
  paths: readonly string[],
): Promise<void> {
  const rootRealpath = await realpath(root);
  for (const path of paths) {
    const fullPath = resolve(rootRealpath, path);
    try {
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink()) {
        throw new AppError({
          code: "SYMLINK_ESCAPE",
          message: "Git snapshot paths cannot be symbolic links",
          retryable: false,
          suggestedActions: ["Replace the symlink with a regular file before snapshotting"],
          safeContext: { path },
        });
      }
      const resolvedPath = await realpath(fullPath);
      const relativePath = relative(rootRealpath, resolvedPath);
      if (
        relativePath === "" ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      ) {
        throw new AppError({
          code: "SYMLINK_ESCAPE",
          message: "Git snapshot path escapes the local history repository",
          retryable: false,
          suggestedActions: ["Snapshot only files stored inside the local history repository"],
          safeContext: { path },
        });
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (!isNodeNotFound(error)) throw error;
    }
  }
}

function parseStatusPaths(stdout: string): readonly string[] {
  const tokens = stdout.split("\0").filter((token) => token.length > 0);
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (entry === undefined) continue;
    const path = entry.slice(3);
    paths.push(path);
    const status = entry.slice(0, 2);
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return paths;
}

function parseHistory(stdout: string): readonly GitCommitSummary[] {
  return stdout
    .split("\0\n")
    .map((record) => record.replace(/\0$/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [commitId, authoredAt, subject] = record.split("\0");
      if (commitId === undefined || authoredAt === undefined || subject === undefined) {
        throw new AppError({
          code: "INTERNAL_ERROR",
          message: "Git history output could not be parsed",
          retryable: true,
          suggestedActions: ["Inspect the local history repository"],
        });
      }
      return { commitId, authoredAt, subject };
    });
}

function isNodeNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
