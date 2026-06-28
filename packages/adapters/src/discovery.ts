import { basename, dirname, join, relative, sep } from "node:path";

import type { AdapterReadApi, CancellationSignal, DiscoveredResource } from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  type AbsolutePath,
  type ResourceKind,
  type ScopeKind,
  type ToolId,
} from "@ai-config-hub/shared";

const ignoredDirectories = new Set([".git", "node_modules", "dist", "target"]);

export async function walkFiles(
  read: AdapterReadApi,
  root: AbsolutePath,
  signal: CancellationSignal,
): Promise<readonly AbsolutePath[]> {
  const rootStat = await read.stat(root);
  if (rootStat.kind === "file") return [root];
  if (rootStat.kind === "missing") return [];

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
  scopeKind?: ScopeKind,
): DiscoveredResource["scope"] {
  if (scopeKind === "user") {
    return {
      kind: "user",
      canonicalRootPath: root,
      depth: 0,
      precedence: 0,
    };
  }

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
  readonly scopeKind?: ScopeKind | undefined;
}): DiscoveredResource {
  return {
    toolId: input.toolId,
    sourcePath: input.sourcePath,
    sourceFormat: input.sourceFormat,
    resourceKindHint: input.resourceKind,
    scope: scopeFor(input.root, input.scopeRoot, input.scopeKind),
  };
}

export function markerPath(root: AbsolutePath, ...segments: string[]): AbsolutePath {
  return AbsolutePathSchema.parse(join(root, ...segments));
}

export function scopeKindFromEvidence(
  evidence: Readonly<Record<string, unknown>>,
): ScopeKind | undefined {
  return evidence["scope"] === "user" ? "user" : undefined;
}
