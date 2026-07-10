import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { AdapterDiscoveryLimitError } from "@ai-config-hub/adapters";
import type {
  AdapterFileSnapshot,
  AdapterReadApi,
  FileSnapshot,
  FileSnapshotPort,
  FileStat,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AppError,
  ContentHashSchema,
  IsoDateTimeSchema,
  type AbsolutePath,
} from "@ai-config-hub/shared";

import { NodePathPolicy } from "./path-policy.js";

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

export interface NodeFileAccessOptions {
  readonly allowedRoots: readonly AbsolutePath[];
  readonly platform?: NodeJS.Platform;
  readonly beforeFinalStat?: () => Promise<void>;
  readonly maxDirectoryEntries?: number;
  readonly maxSnapshotBytes?: number;
  readonly readFile?: (path: AbsolutePath) => Promise<Buffer>;
}

export interface NodeFileAccess {
  readonly read: AdapterReadApi;
  readonly snapshots: FileSnapshotPort;
  readonly pathPolicy: NodePathPolicy;
}

export const MAX_DIRECTORY_LIST_ENTRIES = 10_000;
export const MAX_SOURCE_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export class FileSnapshotLimitError extends Error {
  readonly code = "FILE_SNAPSHOT_TOO_LARGE";

  constructor(
    readonly path: AbsolutePath,
    readonly limit: number,
    readonly observed: number,
  ) {
    super(`File snapshot exceeds the ${String(limit)} byte limit: ${path}`);
    this.name = "FileSnapshotLimitError";
  }
}

function identity(value: BigIntStats): FileIdentity {
  return {
    dev: BigInt(value.dev),
    ino: BigInt(value.ino),
    size: BigInt(value.size),
    mtimeNs: value.mtimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function staleReadError(): AppError {
  return new AppError({
    code: "STALE_INDEX",
    message: "File changed while it was being read",
    retryable: true,
    suggestedActions: ["Retry the scan after the file becomes stable"],
  });
}

export async function createNodeFileAccess(
  options: NodeFileAccessOptions,
): Promise<NodeFileAccess> {
  const pathPolicy = await NodePathPolicy.create(options);
  const maxDirectoryEntries = Math.max(
    1,
    Math.min(MAX_DIRECTORY_LIST_ENTRIES, options.maxDirectoryEntries ?? MAX_DIRECTORY_LIST_ENTRIES),
  );
  const maxSnapshotBytes = Math.max(
    1,
    Math.min(MAX_SOURCE_SNAPSHOT_BYTES, options.maxSnapshotBytes ?? MAX_SOURCE_SNAPSHOT_BYTES),
  );
  const readBytes = options.readFile ?? ((path: AbsolutePath) => readFile(path));

  async function canonical(
    path: AbsolutePath,
    allowedRoots: readonly AbsolutePath[] = options.allowedRoots,
  ): Promise<AbsolutePath> {
    return (
      await pathPolicy.canonicalize({
        path,
        allowedRoots,
        intent: "read",
      })
    ).path;
  }

  async function snapshotFile(
    path: AbsolutePath,
    allowedRoots: readonly AbsolutePath[] = options.allowedRoots,
  ): Promise<AdapterFileSnapshot | undefined> {
    const canonicalPath = await canonical(path, allowedRoots);
    let before: BigIntStats;
    try {
      before = await stat(canonicalPath, { bigint: true });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
    if (before.isFile() && before.size > BigInt(maxSnapshotBytes)) {
      throw new FileSnapshotLimitError(canonicalPath, maxSnapshotBytes, Number(before.size));
    }

    let bytes: Buffer;
    try {
      bytes = await readBytes(canonicalPath);
      if (bytes.byteLength > maxSnapshotBytes) {
        throw new FileSnapshotLimitError(canonicalPath, maxSnapshotBytes, bytes.byteLength);
      }
      await options.beforeFinalStat?.();
      const after = await stat(canonicalPath, { bigint: true });
      if (!before.isFile() || !after.isFile() || !sameIdentity(identity(before), identity(after))) {
        throw staleReadError();
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw staleReadError();
      }
      throw error;
    }

    const base = {
      canonicalPath,
      contentHash: ContentHashSchema.parse(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      ),
      modifiedAt: IsoDateTimeSchema.parse(new Date(Number(before.mtimeMs)).toISOString()),
      size: bytes.byteLength,
    } as const;

    try {
      return {
        ...base,
        isText: true,
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } catch {
      return { ...base, isText: false };
    }
  }

  async function snapshot(
    path: AbsolutePath,
    allowedRoots: readonly AbsolutePath[] = options.allowedRoots,
  ): Promise<FileSnapshot | undefined> {
    const result = await snapshotFile(path, allowedRoots);
    if (result === undefined) return undefined;
    if (!result.isText || result.text === undefined) {
      throw new AppError({
        code: "VALIDATION_FAILED",
        message: "Configuration file is not valid UTF-8",
        retryable: false,
        suggestedActions: ["Save the configuration file as UTF-8 and scan again"],
      });
    }
    return {
      canonicalPath: result.canonicalPath,
      text: result.text,
      contentHash: result.contentHash,
      modifiedAt: result.modifiedAt,
      size: result.size,
    };
  }

  const read: AdapterReadApi = Object.freeze({
    realpath: canonical,
    async stat(path: AbsolutePath): Promise<FileStat> {
      const canonicalPath = await canonical(path);
      try {
        const metadata = await stat(canonicalPath);
        return {
          kind: metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : "missing",
          size: metadata.size,
          modifiedAt: IsoDateTimeSchema.parse(metadata.mtime.toISOString()),
        };
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return {
            kind: "missing",
            size: 0,
            modifiedAt: IsoDateTimeSchema.parse(new Date(0).toISOString()),
          };
        }
        throw error;
      }
    },
    async list(path: AbsolutePath): Promise<readonly AbsolutePath[]> {
      const directory = await canonical(path);
      const children: string[] = [];
      for await (const child of await opendir(directory)) {
        if (children.length === maxDirectoryEntries) {
          throw new AdapterDiscoveryLimitError(
            directory,
            maxDirectoryEntries,
            maxDirectoryEntries + 1,
          );
        }
        children.push(child.name);
      }
      const canonicalChildren: AbsolutePath[] = [];
      for (const child of children.sort()) {
        canonicalChildren.push(await canonical(AbsolutePathSchema.parse(join(directory, child))));
      }
      return Object.freeze(canonicalChildren);
    },
    async readText(path: AbsolutePath): Promise<string> {
      const result = await snapshotFile(path);
      if (result === undefined) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "Configuration file does not exist",
          retryable: true,
          suggestedActions: ["Refresh the configuration index and try again"],
        });
      }
      if (!result.isText || result.text === undefined) {
        throw new AppError({
          code: "VALIDATION_FAILED",
          message: "Configuration file is not valid UTF-8",
          retryable: false,
          suggestedActions: ["Save the configuration file as UTF-8 and scan again"],
        });
      }
      return result.text;
    },
    snapshotFile,
  });

  const snapshots: FileSnapshotPort = Object.freeze({
    snapshot: async (input: {
      readonly path: AbsolutePath;
      readonly allowedRoots: readonly AbsolutePath[];
    }) => snapshot(input.path, input.allowedRoots),
    snapshotFile: async (input: {
      readonly path: AbsolutePath;
      readonly allowedRoots: readonly AbsolutePath[];
    }) => snapshotFile(input.path, input.allowedRoots),
  });
  return Object.freeze({ read, snapshots, pathPolicy });
}
