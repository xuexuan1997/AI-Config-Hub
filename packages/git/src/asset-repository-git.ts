import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type {
  AssetRepositoryGitPort,
  AssetRepositoryGitStatus,
  AssetRepositoryGitStatusState,
  GitCommitSummary,
} from "@ai-config-hub/core";
import { AppError, type AbsolutePath, type IsoDateTime } from "@ai-config-hub/shared";

const execFileAsync = promisify(execFile);

export interface AssetRepositoryGitRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type AssetRepositoryRunGit = (
  args: readonly string[],
  cwd: AbsolutePath,
) => Promise<AssetRepositoryGitRunResult>;

const BASE_GIT_ARGS = [
  "--no-optional-locks",
  "-c",
  "credential.helper=",
  "-c",
  "core.hooksPath=/dev/null",
] as const;

const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;

export class SystemAssetRepositoryGitPort implements AssetRepositoryGitPort {
  constructor(private readonly runGit: AssetRepositoryRunGit = defaultRunGit) {}

  async clone(input: {
    readonly remoteUrl: string;
    readonly parentRoot: AbsolutePath;
    readonly targetRoot: AbsolutePath;
  }): Promise<void> {
    validateRemoteUrl(input.remoteUrl);
    const requestedParentRoot = resolve(input.parentRoot);
    const parentRoot = await validatedRoot(input.parentRoot);
    const targetRoot = await validateCloneTarget(requestedParentRoot, parentRoot, input.targetRoot);
    await this.git(
      ["clone", "--no-recurse-submodules", "--", input.remoteUrl, targetRoot],
      parentRoot,
    );
  }

  async pull(input: {
    readonly root: AbsolutePath;
    readonly remote: string;
    readonly branch: string;
  }): Promise<void> {
    await this.git(
      [
        "pull",
        "--ff-only",
        "--recurse-submodules=no",
        validateGitRef(input.remote, "remote"),
        validateGitRef(input.branch, "branch"),
      ],
      await validatedRoot(input.root),
    );
  }

  async status(input: { readonly root: AbsolutePath }): Promise<AssetRepositoryGitStatus> {
    const result = await this.git(
      ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"],
      await validatedRoot(input.root),
    );
    return parseStatus(result.stdout);
  }

  async diff(input: {
    readonly root: AbsolutePath;
    readonly from?: string;
    readonly to?: string;
  }): Promise<string> {
    const from = input.from === undefined ? undefined : validateGitRevision(input.from);
    const to = input.to === undefined ? undefined : validateGitRevision(input.to);
    const range = from === undefined ? to : to === undefined ? from : `${from}..${to}`;
    const result = await this.git(
      range === undefined ? ["diff", "--no-ext-diff"] : ["diff", "--no-ext-diff", range],
      await validatedRoot(input.root),
    );
    return result.stdout;
  }

  async commit(input: {
    readonly root: AbsolutePath;
    readonly paths: readonly string[];
    readonly message: string;
    readonly authoredAt: IsoDateTime;
  }): Promise<GitCommitSummary> {
    const root = await validatedRoot(input.root);
    const paths = validateRelativePaths(input.paths, "Git asset repository commits");
    await assertPathsStayInsideRoot(root, paths);

    await this.git(["add", "--", ...paths], root);
    await this.git(
      [
        "-c",
        "user.name=AI Config Hub",
        "-c",
        "user.email=assets@ai-config-hub.local",
        "commit",
        "--no-verify",
        "--date",
        input.authoredAt,
        "-m",
        input.message,
      ],
      root,
    );

    const [summary] = await this.history({ root, limit: 1 });
    if (summary === undefined) {
      throw new AppError({
        code: "INTERNAL_ERROR",
        message: "Git commit succeeded but no commit could be read back",
        retryable: false,
        suggestedActions: ["Inspect the asset repository history"],
      });
    }
    return summary;
  }

  async push(input: {
    readonly root: AbsolutePath;
    readonly remote: string;
    readonly branch: string;
  }): Promise<void> {
    await this.git(
      [
        "push",
        validateGitRef(input.remote, "remote"),
        `HEAD:${validateGitRef(input.branch, "branch")}`,
      ],
      await validatedRoot(input.root),
    );
  }

  async tag(input: {
    readonly root: AbsolutePath;
    readonly name: string;
    readonly message: string;
  }): Promise<void> {
    await this.git(
      ["tag", "-a", validateGitRef(input.name, "tag"), "-m", input.message],
      await validatedRoot(input.root),
    );
  }

  async restore(input: {
    readonly root: AbsolutePath;
    readonly paths: readonly string[];
  }): Promise<void> {
    const root = await validatedRoot(input.root);
    const paths = validateRelativePaths(input.paths, "Git asset repository restores");
    await assertPathsStayInsideRoot(root, paths);
    await this.git(["restore", "--", ...paths], root);
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
        ...(input.cursor === undefined ? [] : [`${validateGitRevision(input.cursor)}..HEAD`]),
      ],
      await validatedRoot(input.root),
    );
    return parseHistory(result.stdout);
  }

  private async git(
    args: readonly string[],
    cwd: AbsolutePath,
  ): Promise<AssetRepositoryGitRunResult> {
    return this.runGit([...BASE_GIT_ARGS, ...args], cwd);
  }
}

async function defaultRunGit(
  args: readonly string[],
  cwd: AbsolutePath,
): Promise<AssetRepositoryGitRunResult> {
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
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  return { stdout, stderr };
}

async function validatedRoot(root: AbsolutePath): Promise<AbsolutePath> {
  if (!isAbsolute(root)) {
    throw new AppError({
      code: "PATH_OUTSIDE_ALLOWED_ROOT",
      message: "Git asset repository root must be an absolute path",
      retryable: false,
      suggestedActions: ["Use an absolute repository root path"],
      safeContext: { path: root },
    });
  }
  return await realpath(root);
}

async function validateCloneTarget(
  requestedParentRoot: AbsolutePath,
  parentRoot: AbsolutePath,
  targetRoot: AbsolutePath,
): Promise<AbsolutePath> {
  if (!isAbsolute(targetRoot)) {
    throw new AppError({
      code: "PATH_OUTSIDE_ALLOWED_ROOT",
      message: "Git clone target must be an absolute path inside the requested parent",
      retryable: false,
      suggestedActions: ["Choose a clone target inside the selected asset library parent"],
      safeContext: { path: targetRoot },
    });
  }

  const requestedTarget = resolve(targetRoot);
  const requestedRelativeTarget = relative(requestedParentRoot, requestedTarget);
  const realRelativeTarget = relative(parentRoot, requestedTarget);
  const relativeTarget = isPathInside(requestedRelativeTarget)
    ? requestedRelativeTarget
    : isPathInside(realRelativeTarget)
      ? realRelativeTarget
      : undefined;
  if (relativeTarget === undefined) {
    throw new AppError({
      code: "PATH_OUTSIDE_ALLOWED_ROOT",
      message: "Git clone target escapes the requested parent",
      retryable: false,
      suggestedActions: ["Choose a clone target inside the selected asset library parent"],
      safeContext: { path: targetRoot },
    });
  }
  const target = resolve(parentRoot, relativeTarget);
  const relativeRealTarget = relative(parentRoot, target);
  if (!isPathInside(relativeRealTarget)) {
    throw new AppError({
      code: "PATH_OUTSIDE_ALLOWED_ROOT",
      message: "Git clone target escapes the requested parent",
      retryable: false,
      suggestedActions: ["Choose a clone target inside the selected asset library parent"],
      safeContext: { path: targetRoot },
    });
  }

  await assertNoSymlinkInExistingPath(parentRoot, relativeTarget);
  return target;
}

function isPathInside(path: string): boolean {
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function validateRemoteUrl(remoteUrl: string): void {
  if (
    remoteUrl.trim() !== remoteUrl ||
    remoteUrl.length === 0 ||
    remoteUrl.startsWith("-") ||
    hasControlCharacters(remoteUrl)
  ) {
    throw invalidRemote(remoteUrl);
  }

  if (/^[A-Za-z0-9._-]+@[^:\s]+:[^\s]+$/u.test(remoteUrl)) return;

  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw invalidRemote(remoteUrl);
  }

  if (["https:", "ssh:", "file:"].includes(parsed.protocol)) return;
  throw invalidRemote(remoteUrl);
}

function invalidRemote(remoteUrl: string): AppError {
  return new AppError({
    code: "VALIDATION_FAILED",
    message: "Git asset repository remote URL uses an unsupported protocol",
    retryable: false,
    suggestedActions: ["Use an https://, ssh://, git@host:path, or file:// remote URL"],
    safeContext: { remoteUrl },
  });
}

function validateGitRef(value: string, label: string): string {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    value.startsWith("-") ||
    value.includes("..") ||
    hasControlCharacters(value) ||
    /[\s~^:?*[\]\\]/u.test(value)
  ) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: `Git ${label} name is not safe to pass as an argument`,
      retryable: false,
      suggestedActions: [`Use a normalized ${label} name without whitespace or traversal markers`],
      safeContext: { [label]: value },
    });
  }
  return value;
}

function validateGitRevision(value: string): string {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    value.startsWith("-") ||
    value.includes("..") ||
    hasControlCharacters(value) ||
    /[\s:?*[\]\\]/u.test(value)
  ) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "Git revision is not safe to pass as an argument",
      retryable: false,
      suggestedActions: ["Use a commit id, tag, or branch revision without option prefixes"],
      safeContext: { revision: value },
    });
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
  });
}

function validateRelativePaths(paths: readonly string[], action: string): readonly string[] {
  if (paths.length === 0) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: `${action} require at least one path`,
      retryable: false,
      suggestedActions: ["Provide explicit repository-relative paths"],
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
        message: "Git asset repository paths must be normalized repository-relative paths",
        retryable: false,
        suggestedActions: ["Use normalized relative paths inside the asset repository"],
        safeContext: { path },
      });
    }
    if (seen.has(path)) {
      throw new AppError({
        code: "VALIDATION_FAILED",
        message: "Git asset repository paths must be unique",
        retryable: false,
        suggestedActions: ["Remove duplicate paths before running Git"],
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
  for (const path of paths) {
    await assertNoSymlinkInExistingPath(root, path);
    const fullPath = resolve(root, path);
    try {
      const resolvedPath = await realpath(fullPath);
      const relativePath = relative(root, resolvedPath);
      if (
        relativePath === "" ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      ) {
        throw new AppError({
          code: "SYMLINK_ESCAPE",
          message: "Git asset repository path escapes the repository root",
          retryable: false,
          suggestedActions: ["Use only files stored inside the asset repository"],
          safeContext: { path },
        });
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (!isNodeNotFound(error)) throw error;
    }
  }
}

async function assertNoSymlinkInExistingPath(
  root: AbsolutePath,
  relativePath: string,
): Promise<void> {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new AppError({
          code: "SYMLINK_ESCAPE",
          message: "Git asset repository paths cannot traverse symbolic links",
          retryable: false,
          suggestedActions: ["Replace the symlink with a regular file or directory"],
          safeContext: { path: relativePath },
        });
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isNodeNotFound(error)) return;
      throw error;
    }
  }
}

function parseStatus(stdout: string): AssetRepositoryGitStatus {
  const tokens = stdout.split("\0").filter((token) => token.length > 0);
  const branch = tokens[0]?.startsWith("## ") ? tokens[0] : "";
  const entries = branch === "" ? tokens : tokens.slice(1);
  const ahead = parseBranchCount(branch, "ahead");
  const behind = parseBranchCount(branch, "behind");
  const conflictedPaths = entries
    .filter((entry) => isConflictedStatus(entry.slice(0, 2)))
    .map((entry) => entry.slice(3));
  const hasUncommittedChanges = entries.length > 0;
  const state = classifyStatus({ ahead, behind, hasUncommittedChanges, conflictedPaths });
  return {
    state,
    ahead,
    behind,
    hasUncommittedChanges,
    conflictedPaths,
    recoveryGuidance: recoveryGuidance(state, conflictedPaths),
  };
}

function parseBranchCount(branch: string, label: "ahead" | "behind"): number {
  const match = new RegExp(`${label} (\\d+)`, "u").exec(branch);
  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
}

function isConflictedStatus(status: string): boolean {
  return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status) || status.includes("U");
}

function classifyStatus(input: {
  readonly ahead: number;
  readonly behind: number;
  readonly hasUncommittedChanges: boolean;
  readonly conflictedPaths: readonly string[];
}): AssetRepositoryGitStatusState {
  if (input.conflictedPaths.length > 0) return "conflicted";
  if (input.hasUncommittedChanges) return "dirty";
  if (input.ahead > 0 && input.behind > 0) return "diverged";
  if (input.ahead > 0) return "ahead";
  if (input.behind > 0) return "behind";
  return "clean";
}

function recoveryGuidance(
  state: AssetRepositoryGitStatusState,
  conflictedPaths: readonly string[],
): readonly string[] {
  if (state === "conflicted") {
    const pathList =
      conflictedPaths.length === 0 ? "reported conflicted files" : conflictedPaths.join(", ");
    return [
      `Resolve merge conflicts in ${pathList}.`,
      "After resolving, commit the fixes or restore the conflicted paths before retrying the asset library operation.",
    ];
  }
  if (state === "dirty") {
    return [
      "Commit, restore, or stash local asset repository changes before pulling or switching history.",
    ];
  }
  if (state === "diverged") {
    return [
      "Reconcile local and remote commits before pushing; pull/rebase intentionally or ask for conflict recovery.",
    ];
  }
  if (state === "behind") {
    return [
      "Pull the remote branch with fast-forward before committing new asset library changes.",
    ];
  }
  if (state === "ahead") {
    return ["Push local asset library commits when ready."];
  }
  return ["No recovery is required."];
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
          message: "Git asset repository history output could not be parsed",
          retryable: true,
          suggestedActions: ["Inspect the asset repository"],
        });
      }
      return { commitId, authoredAt: normalizeUtc(authoredAt), subject };
    });
}

function normalizeUtc(value: IsoDateTime): IsoDateTime {
  return value.endsWith("+00:00") ? value.slice(0, -6) + "Z" : value;
}

function isNodeNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
