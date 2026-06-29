import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { DeploymentFilePort } from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AppError,
  ContentHashSchema,
  type AbsolutePath,
  type ContentHash,
} from "@ai-config-hub/shared";

export interface NodeDeploymentFilePortOptions {
  readonly allowedRoots: readonly AbsolutePath[];
  readonly backupRoot: AbsolutePath;
}

interface DeploymentFilePortTestHooks {
  readonly beforeParentSync?: () => Promise<void>;
}

const testHooks = new WeakMap<NodeDeploymentFilePort, DeploymentFilePortTestHooks>();

export class CommittedButDurabilityUncertainError extends AppError {
  readonly committed = true;
  readonly durabilityUncertain = true;

  constructor(operation: "backup" | "replace" | "remove", cause: unknown) {
    super({
      code: "INTERNAL_ERROR",
      message: "Filesystem mutation committed, but parent directory durability is uncertain",
      retryable: false,
      suggestedActions: ["Verify the target state before retrying or compensating"],
      safeContext: { committed: true, durabilityUncertain: true, operation },
      cause,
    });
    this.name = "CommittedButDurabilityUncertainError";
  }
}

export class MutationOutcomeUncertainError extends AppError {
  readonly mutationOutcomeUncertain = true;
  readonly requiresRescan = true;

  constructor(operation: "backup" | "replace" | "remove", signal: string | null) {
    super({
      code: "INTERNAL_ERROR",
      message: "Deployment helper terminated before reporting the mutation outcome",
      retryable: false,
      suggestedActions: ["Rescan the target and backup state before retrying or compensating"],
      safeContext: {
        mutationOutcomeUncertain: true,
        requiresRescan: true,
        operation,
        signal: signal ?? "unknown",
      },
    });
    this.name = "MutationOutcomeUncertainError";
  }
}

function contentHash(bytes: Uint8Array | string): ContentHash {
  return ContentHashSchema.parse(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}

function contains(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}

function pathError(code: "PATH_OUTSIDE_ALLOWED_ROOT" | "SYMLINK_ESCAPE"): AppError {
  return new AppError({
    code,
    message:
      code === "SYMLINK_ESCAPE"
        ? "Path resolves outside its allowed root through a symbolic link"
        : "Path is outside the allowed deployment roots",
    retryable: false,
    suggestedActions: ["Choose a path inside an allowed deployment root"],
  });
}

function staleTargetError(): AppError {
  return new AppError({
    code: "STALE_TARGET",
    message: "File contents no longer match the expected hash",
    retryable: true,
    suggestedActions: ["Refresh the deployment preview and try again"],
  });
}

function nativeHelperError(message: string, cause?: unknown): AppError {
  return new AppError({
    code: "INTERNAL_ERROR",
    message,
    retryable: false,
    suggestedActions: ["Repair or reinstall the Linux deployment helper before retrying"],
    cause,
  });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function canonicalCandidate(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let current = path;

  for (;;) {
    try {
      return join(await realpath(current), ...missingSegments.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missingSegments.push(current.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
      current = parent;
    }
  }
}

async function confine(path: AbsolutePath, roots: readonly AbsolutePath[]): Promise<AbsolutePath> {
  const lexicalPath = resolve(path);
  const lexicalRoots = roots.map((root) => resolve(root));
  if (!lexicalRoots.some((root) => contains(root, lexicalPath))) {
    throw pathError("PATH_OUTSIDE_ALLOWED_ROOT");
  }

  const [canonicalPath, ...canonicalRoots] = await Promise.all([
    canonicalCandidate(lexicalPath),
    ...lexicalRoots.map((root) => canonicalCandidate(root)),
  ]);
  if (!canonicalRoots.some((root) => contains(root, canonicalPath))) {
    throw pathError("SYMLINK_ESCAPE");
  }
  return AbsolutePathSchema.parse(lexicalPath);
}

interface NativeLocation {
  readonly root: string;
  readonly relativePath: string;
}

async function nativeLocation(
  path: AbsolutePath,
  roots: readonly AbsolutePath[],
): Promise<NativeLocation> {
  const lexicalPath = resolve(path);
  const lexicalRoot = roots
    .map((root) => resolve(root))
    .filter((root) => contains(root, lexicalPath))
    .sort((left, right) => right.length - left.length)[0];
  if (lexicalRoot === undefined) throw pathError("PATH_OUTSIDE_ALLOWED_ROOT");
  return {
    root: await canonicalCandidate(lexicalRoot),
    relativePath: relative(lexicalRoot, lexicalPath),
  };
}

async function runNativeHelper(
  operation: "backup" | "replace" | "remove",
  args: readonly string[],
  input?: string,
): Promise<string> {
  const executable =
    process.env["AI_CONFIG_HUB_DEPLOYMENT_HELPER"] ??
    fileURLToPath(new URL("./native/deployment-file-helper", import.meta.url));

  // Security contract: the caller must durably journal intent before starting the helper.
  // A signal can terminate the helper after commit but before its protocol response.
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(executable, [operation, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (cause) => {
      reject(nativeHelperError("Linux deployment helper could not be started", cause));
    });
    child.once("close", (code, signal) => {
      if (code === null) {
        reject(new MutationOutcomeUncertainError(operation, signal));
      } else if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString("utf8").trim());
      } else if (code === 20) {
        reject(staleTargetError());
      } else if (code === 21) {
        reject(pathError("SYMLINK_ESCAPE"));
      } else if (code === 22) {
        reject(
          new CommittedButDurabilityUncertainError(
            operation,
            new Error(Buffer.concat(stderr).toString("utf8") || "parent fsync failed"),
          ),
        );
      } else if (code === 24) {
        reject(new MutationOutcomeUncertainError(operation, signal));
      } else {
        reject(
          nativeHelperError(
            `Linux deployment helper failed with exit code ${String(code)}`,
            new Error(Buffer.concat(stderr).toString("utf8")),
          ),
        );
      }
    });
    child.stdin.end(input);
  });
}

async function currentHash(path: AbsolutePath): Promise<ContentHash | "absent"> {
  try {
    return contentHash(await readFile(path));
  } catch (error) {
    if (isMissing(error)) return "absent";
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export function shouldIgnoreDirectorySyncError(
  cause: unknown,
  currentPlatform: NodeJS.Platform = process.platform,
): boolean {
  if (currentPlatform !== "win32") return false;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return false;
  return cause.code === "EPERM" || cause.code === "ENOTSUP" || cause.code === "EINVAL";
}

async function syncDirectoryWhenSupported(path: string): Promise<void> {
  try {
    await syncDirectory(path);
  } catch (cause) {
    if (!shouldIgnoreDirectorySyncError(cause)) throw cause;
  }
}

async function writeAtomically(input: {
  readonly destination: AbsolutePath;
  readonly bytes: Uint8Array | string;
  readonly mode: number;
  readonly operation: "backup" | "replace";
  readonly beforeParentSync?: () => Promise<void>;
}): Promise<void> {
  const directory = dirname(input.destination);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(input.bytes);
    if (input.mode !== 0o600) await handle.chmod(input.mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, input.destination);
    try {
      await input.beforeParentSync?.();
      await syncDirectoryWhenSupported(directory);
    } catch (cause) {
      throw new CommittedButDurabilityUncertainError(input.operation, cause);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

async function createSymlinkAtomically(input: {
  readonly source: AbsolutePath;
  readonly destination: AbsolutePath;
  readonly operation: "replace";
  readonly beforeParentSync?: () => Promise<void>;
}): Promise<void> {
  const directory = dirname(input.destination);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  try {
    await symlink(input.source, temporaryPath);
    await rename(temporaryPath, input.destination);
    try {
      await input.beforeParentSync?.();
      await syncDirectoryWhenSupported(directory);
    } catch (cause) {
      throw new CommittedButDurabilityUncertainError(input.operation, cause);
    }
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

export class NodeDeploymentFilePort implements DeploymentFilePort {
  constructor(private readonly options: NodeDeploymentFilePortOptions) {}

  async createBackup(input: {
    readonly source: AbsolutePath;
    readonly destination: AbsolutePath;
    readonly expectedHash: ContentHash;
  }): Promise<{ readonly backupPath: AbsolutePath; readonly backupHash: ContentHash }> {
    const source = await confine(input.source, this.options.allowedRoots);
    const destination = await confine(input.destination, [this.options.backupRoot]);
    if (process.platform === "linux") {
      const sourceLocation = await nativeLocation(source, this.options.allowedRoots);
      const destinationLocation = await nativeLocation(destination, [this.options.backupRoot]);
      const backupHash = ContentHashSchema.parse(
        await runNativeHelper("backup", [
          sourceLocation.root,
          sourceLocation.relativePath,
          destinationLocation.root,
          destinationLocation.relativePath,
          input.expectedHash,
        ]),
      );
      return { backupPath: destination, backupHash };
    }
    // Development-only fallback: Linux releases fail closed through the fd-relative native helper.
    // Other platforms retain the preflight-confined implementation for local development and tests.
    const bytes = await readFile(source);
    const backupHash = contentHash(bytes);
    if (backupHash !== input.expectedHash) throw staleTargetError();
    const sourceMode = (await stat(source)).mode & 0o777;
    const beforeParentSync = testHooks.get(this)?.beforeParentSync;

    await writeAtomically({
      destination,
      bytes,
      mode: sourceMode,
      operation: "backup",
      ...(beforeParentSync === undefined ? {} : { beforeParentSync }),
    });
    return { backupPath: destination, backupHash };
  }

  async atomicReplace(input: {
    readonly target: AbsolutePath;
    readonly text: string;
    readonly expectedHash: ContentHash | "absent";
  }): Promise<{ readonly resultingHash: ContentHash }> {
    const target = await confine(input.target, this.options.allowedRoots);
    if (process.platform === "linux") {
      const location = await nativeLocation(target, this.options.allowedRoots);
      return {
        resultingHash: ContentHashSchema.parse(
          await runNativeHelper(
            "replace",
            [location.root, location.relativePath, input.expectedHash],
            input.text,
          ),
        ),
      };
    }
    if ((await currentHash(target)) !== input.expectedHash) throw staleTargetError();
    const resultingHash = contentHash(input.text);
    const beforeParentSync = testHooks.get(this)?.beforeParentSync;

    await writeAtomically({
      destination: target,
      bytes: input.text,
      mode: 0o600,
      operation: "replace",
      ...(beforeParentSync === undefined ? {} : { beforeParentSync }),
    });
    return { resultingHash };
  }

  async copy(input: {
    readonly source: AbsolutePath;
    readonly target: AbsolutePath;
    readonly expectedSourceHash: ContentHash;
    readonly expectedHash: ContentHash | "absent";
  }): Promise<{ readonly resultingHash: ContentHash }> {
    const source = await confine(input.source, this.options.allowedRoots);
    const target = await confine(input.target, this.options.allowedRoots);
    const bytes = await readFile(source);
    const sourceHash = contentHash(bytes);
    if (sourceHash !== input.expectedSourceHash) throw staleTargetError();
    if ((await currentHash(target)) !== input.expectedHash) throw staleTargetError();
    const sourceMode = (await stat(source)).mode & 0o777;
    const beforeParentSync = testHooks.get(this)?.beforeParentSync;

    await writeAtomically({
      destination: target,
      bytes,
      mode: sourceMode,
      operation: "replace",
      ...(beforeParentSync === undefined ? {} : { beforeParentSync }),
    });
    return { resultingHash: sourceHash };
  }

  async createSymlink(input: {
    readonly source: AbsolutePath;
    readonly target: AbsolutePath;
    readonly expectedSourceHash: ContentHash;
    readonly expectedHash: ContentHash | "absent";
  }): Promise<{ readonly resultingHash: ContentHash }> {
    const source = await confine(input.source, this.options.allowedRoots);
    const target = await confine(input.target, this.options.allowedRoots);
    const sourceHash = contentHash(await readFile(source));
    if (sourceHash !== input.expectedSourceHash) throw staleTargetError();
    if ((await currentHash(target)) !== input.expectedHash) throw staleTargetError();
    const beforeParentSync = testHooks.get(this)?.beforeParentSync;

    await createSymlinkAtomically({
      source,
      destination: target,
      operation: "replace",
      ...(beforeParentSync === undefined ? {} : { beforeParentSync }),
    });
    return { resultingHash: sourceHash };
  }

  async remove(input: {
    readonly target: AbsolutePath;
    readonly expectedHash: ContentHash;
  }): Promise<void> {
    const target = await confine(input.target, this.options.allowedRoots);
    if (process.platform === "linux") {
      const location = await nativeLocation(target, this.options.allowedRoots);
      await runNativeHelper("remove", [location.root, location.relativePath, input.expectedHash]);
      return;
    }
    if ((await currentHash(target)) !== input.expectedHash) throw staleTargetError();
    await lstat(target);
    await unlink(target);
    try {
      await testHooks.get(this)?.beforeParentSync?.();
      await syncDirectoryWhenSupported(dirname(target));
    } catch (cause) {
      throw new CommittedButDurabilityUncertainError("remove", cause);
    }
  }
}

/** Internal test factory; intentionally not exported from the package entry point. */
export function createNodeDeploymentFilePortForTest(
  options: NodeDeploymentFilePortOptions,
  hooks: DeploymentFilePortTestHooks,
): NodeDeploymentFilePort {
  const port = new NodeDeploymentFilePort(options);
  testHooks.set(port, hooks);
  return port;
}
