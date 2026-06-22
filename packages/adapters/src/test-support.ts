import { dirname, posix } from "node:path";

import type {
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

export function memoryReadApi(files: Readonly<Record<string, string>>): AdapterReadApi {
  const normalized = new Map(
    Object.entries(files).map(([path, text]) => [
      AbsolutePathSchema.parse(posix.normalize(path)),
      text,
    ]),
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
  return Object.freeze({
    realpath(path: AbsolutePath) {
      return Promise.resolve(AbsolutePathSchema.parse(posix.normalize(path)));
    },
    stat(path: AbsolutePath): Promise<FileStat> {
      const normalizedPath = AbsolutePathSchema.parse(posix.normalize(path));
      const text = normalized.get(normalizedPath);
      return Promise.resolve({
        kind:
          text === undefined ? (directories.has(normalizedPath) ? "directory" : "missing") : "file",
        size: text?.length ?? 0,
        modifiedAt: IsoDateTimeSchema.parse("2026-06-21T08:00:00.000Z"),
      });
    },
    list(path: AbsolutePath) {
      const normalizedPath = AbsolutePathSchema.parse(posix.normalize(path));
      const children = new Set<AbsolutePath>();
      for (const candidate of [...directories, ...normalized.keys()]) {
        if (candidate !== normalizedPath && dirname(candidate) === normalizedPath) {
          children.add(candidate);
        }
      }
      return Promise.resolve([...children].sort());
    },
    readText(path: AbsolutePath) {
      const text = normalized.get(AbsolutePathSchema.parse(posix.normalize(path)));
      return text === undefined
        ? Promise.reject(new Error(`Missing fixture: ${path}`))
        : Promise.resolve(text);
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
