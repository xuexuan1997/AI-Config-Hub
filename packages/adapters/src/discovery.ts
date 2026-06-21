import { basename, dirname, join, relative, sep } from "node:path";

import type { AdapterReadApi, CancellationSignal, DiscoveredResource } from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  type AbsolutePath,
  type ResourceKind,
  type ToolId,
} from "@ai-config-hub/shared";

const ignoredDirectories = new Set([".git", "node_modules", "dist", "target"]);

export async function walkFiles(
  read: AdapterReadApi,
  root: AbsolutePath,
  signal: CancellationSignal,
): Promise<readonly AbsolutePath[]> {
  const files: AbsolutePath[] = [];
  const queue: AbsolutePath[] = [root];
  let visited = 0;
  while (queue.length > 0) {
    signal.throwIfAborted();
    const directory = queue.shift();
    if (directory === undefined) break;
    for (const child of await read.list(directory)) {
      visited += 1;
      if (visited > 10_000) throw new Error("Adapter discovery exceeds 10,000 entries");
      const metadata = await read.stat(child);
      if (metadata.kind === "file") files.push(child);
      if (metadata.kind === "directory" && !ignoredDirectories.has(basename(child)))
        queue.push(child);
    }
  }
  return files.sort();
}

export function scopeFor(
  root: AbsolutePath,
  scopeRoot: AbsolutePath = root,
): DiscoveredResource["scope"] {
  const pathFromRoot = relative(root, scopeRoot);
  const depth = pathFromRoot === "" ? 0 : pathFromRoot.split(sep).length;
  return {
    kind: depth === 0 ? "project" : "directory",
    canonicalRootPath: scopeRoot,
    projectRoot: root,
    ...(depth === 0 ? {} : { parentRoot: AbsolutePathSchema.parse(dirname(scopeRoot)) }),
    depth,
    precedence: 100 + depth,
  };
}

export function candidate(input: {
  readonly toolId: ToolId;
  readonly root: AbsolutePath;
  readonly sourcePath: AbsolutePath;
  readonly sourceFormat: string;
  readonly resourceKind: ResourceKind;
  readonly scopeRoot?: AbsolutePath;
}): DiscoveredResource {
  return {
    toolId: input.toolId,
    sourcePath: input.sourcePath,
    sourceFormat: input.sourceFormat,
    resourceKindHint: input.resourceKind,
    scope: scopeFor(input.root, input.scopeRoot),
  };
}

export function markerPath(root: AbsolutePath, ...segments: string[]): AbsolutePath {
  return AbsolutePathSchema.parse(join(root, ...segments));
}
