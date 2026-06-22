import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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

function contentHash(bytes: Uint8Array | string): ContentHash {
  return ContentHashSchema.parse(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}

function contains(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
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
    ...lexicalRoots.map((root) => realpath(root)),
  ]);
  if (!canonicalRoots.some((root) => contains(root, canonicalPath))) {
    throw pathError("SYMLINK_ESCAPE");
  }
  return AbsolutePathSchema.parse(lexicalPath);
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

async function writeAtomically(input: {
  readonly destination: AbsolutePath;
  readonly bytes: Uint8Array | string;
  readonly mode: number;
}): Promise<void> {
  const directory = dirname(input.destination);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(input.bytes);
    if (input.mode !== 0o600) await chmod(temporaryPath, input.mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, input.destination);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
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
    const bytes = await readFile(source);
    const backupHash = contentHash(bytes);
    if (backupHash !== input.expectedHash) throw staleTargetError();
    const sourceMode = (await stat(source)).mode & 0o777;

    await writeAtomically({ destination, bytes, mode: sourceMode });
    return { backupPath: destination, backupHash };
  }

  async atomicReplace(input: {
    readonly target: AbsolutePath;
    readonly text: string;
    readonly expectedHash: ContentHash | "absent";
  }): Promise<{ readonly resultingHash: ContentHash }> {
    const target = await confine(input.target, this.options.allowedRoots);
    if ((await currentHash(target)) !== input.expectedHash) throw staleTargetError();
    const resultingHash = contentHash(input.text);

    await writeAtomically({ destination: target, bytes: input.text, mode: 0o600 });
    return { resultingHash };
  }

  async remove(input: {
    readonly target: AbsolutePath;
    readonly expectedHash: ContentHash;
  }): Promise<void> {
    const target = await confine(input.target, this.options.allowedRoots);
    if ((await currentHash(target)) !== input.expectedHash) throw staleTargetError();
    await lstat(target);
    await unlink(target);
    await syncDirectory(dirname(target));
  }
}
