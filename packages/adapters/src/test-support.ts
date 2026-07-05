import { dirname, posix } from "node:path";
import { createHash } from "node:crypto";

import type {
  AdapterFileSnapshot,
  AdapterReadApi,
  CancellationSignal,
  FileSnapshot,
  FileStat,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  ContentHashSchema,
  IsoDateTimeSchema,
  type AbsolutePath,
} from "@ai-config-hub/shared";

export const neverCancelled: CancellationSignal = Object.freeze({
  aborted: false,
  throwIfAborted() {},
});

export function memoryReadApi(
  files: Readonly<Record<string, string | Uint8Array>>,
): AdapterReadApi {
  const normalized = new Map(
    Object.entries(files).map(([path, content]) => [normalizeFixturePath(path), content]),
  );
  const directories = new Set<AbsolutePath>([AbsolutePathSchema.parse("/")]);
  for (const path of normalized.keys()) {
    let parent = AbsolutePathSchema.parse(dirname(path));
    for (;;) {
      directories.add(parent);
      if (parent === "/") break;
      parent = AbsolutePathSchema.parse(dirname(parent));
    }
  }
  function snapshotFile(path: AbsolutePath): Promise<AdapterFileSnapshot | undefined> {
    const normalizedPath = normalizeFixturePath(path);
    const content = normalized.get(normalizedPath);
    if (content === undefined) return Promise.resolve(undefined);
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    if (typeof content !== "string") {
      return Promise.resolve({
        canonicalPath: normalizedPath,
        contentHash: contentHash(bytes),
        modifiedAt: IsoDateTimeSchema.parse("2026-06-21T08:00:00.000Z"),
        size: bytes.byteLength,
        isText: false,
      });
    }
    return Promise.resolve({
      canonicalPath: normalizedPath,
      contentHash: contentHash(bytes),
      modifiedAt: IsoDateTimeSchema.parse("2026-06-21T08:00:00.000Z"),
      size: bytes.byteLength,
      isText: true,
      text: content,
    });
  }
  return Object.freeze({
    realpath(path: AbsolutePath) {
      return Promise.resolve(normalizeFixturePath(path));
    },
    stat(path: AbsolutePath): Promise<FileStat> {
      const normalizedPath = normalizeFixturePath(path);
      const content = normalized.get(normalizedPath);
      return Promise.resolve({
        kind:
          content === undefined
            ? directories.has(normalizedPath)
              ? "directory"
              : "missing"
            : "file",
        size: contentSize(content),
        modifiedAt: IsoDateTimeSchema.parse("2026-06-21T08:00:00.000Z"),
      });
    },
    list(path: AbsolutePath) {
      const normalizedPath = normalizeFixturePath(path);
      const children = new Set<AbsolutePath>();
      for (const candidate of [...directories, ...normalized.keys()]) {
        if (candidate !== normalizedPath && dirname(candidate) === normalizedPath) {
          children.add(candidate);
        }
      }
      return Promise.resolve([...children].sort());
    },
    async readText(path: AbsolutePath) {
      const snapshot = await snapshotFile(path);
      if (snapshot?.text === undefined) throw new Error(`Missing fixture: ${path}`);
      return snapshot.text;
    },
    snapshotFile,
  });
}

export function failOnListedDirectory(
  read: AdapterReadApi,
  directory: AbsolutePath,
): AdapterReadApi {
  return Object.freeze({
    ...read,
    list(path: AbsolutePath) {
      if (normalizeFixturePath(path) === normalizeFixturePath(directory)) {
        throw new Error(`Unexpected directory traversal: ${directory}`);
      }
      return read.list(path);
    },
  });
}

export async function fixtureSnapshot(
  read: AdapterReadApi,
  path: AbsolutePath,
): Promise<FileSnapshot> {
  const text = await read.readText(path);
  return {
    canonicalPath: path,
    text,
    contentHash: ContentHashSchema.parse(`sha256:${"a".repeat(64)}`),
    modifiedAt: IsoDateTimeSchema.parse("2026-06-21T08:00:00.000Z"),
    size: text.length,
  };
}

function contentHash(content: string | Buffer) {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return ContentHashSchema.parse(`sha256:${hashBytes(bytes)}`);
}

function normalizeFixturePath(path: string): AbsolutePath {
  return AbsolutePathSchema.parse(posix.normalize(path.replace(/\\/g, "/")));
}

function contentSize(content: string | Uint8Array | undefined): number {
  if (content === undefined) return 0;
  return typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
