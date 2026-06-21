import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { AdapterReadApi, FileSnapshot, FileSnapshotPort, FileStat } from "@ai-config-hub/core";
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
}

export interface NodeFileAccess {
  readonly read: AdapterReadApi;
  readonly snapshots: FileSnapshotPort;
  readonly pathPolicy: NodePathPolicy;
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

  async function snapshot(
    path: AbsolutePath,
    allowedRoots: readonly AbsolutePath[] = options.allowedRoots,
  ): Promise<FileSnapshot> {
    const canonicalPath = await canonical(path, allowedRoots);
    let before;
    let bytes;
    try {
      before = await stat(canonicalPath, { bigint: true });
      bytes = await readFile(canonicalPath);
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

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new AppError({
        code: "VALIDATION_FAILED",
        message: "Configuration file is not valid UTF-8",
        retryable: false,
        suggestedActions: ["Save the configuration file as UTF-8 and scan again"],
        cause,
      });
    }
    return {
      canonicalPath,
      text,
      contentHash: ContentHashSchema.parse(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      ),
      modifiedAt: IsoDateTimeSchema.parse(new Date(Number(before.mtimeMs)).toISOString()),
      size: bytes.byteLength,
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
      const children = await readdir(directory);
      return Object.freeze(
        await Promise.all(
          children
            .sort()
            .map(async (child) => canonical(AbsolutePathSchema.parse(join(directory, child)))),
        ),
      );
    },
    async readText(path: AbsolutePath): Promise<string> {
      return (await snapshot(path)).text;
    },
  });

  const snapshots: FileSnapshotPort = Object.freeze({
    snapshot: async (input: {
      readonly path: AbsolutePath;
      readonly allowedRoots: readonly AbsolutePath[];
    }) => snapshot(input.path, input.allowedRoots),
  });
  return Object.freeze({ read, snapshots, pathPolicy });
}
