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
  if (rootStat.kind === "missing") return [];
  const canonicalRoot = await read.realpath(root);
  if (rootStat.kind === "file") return [canonicalRoot];

  const files: AbsolutePath[] = [];
  const queue: AbsolutePath[] = [canonicalRoot];
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

export async function existingRelativeFiles(
  read: AdapterReadApi,
  root: AbsolutePath,
  relativePaths: readonly string[],
): Promise<readonly AbsolutePath[]> {
  const files = [];
  for (const relativePath of [...relativePaths].sort()) {
    const path = markerPath(root, ...pathSegments(relativePath));
    if ((await read.stat(path)).kind === "file") files.push(await read.realpath(path));
  }
  return files;
}

export async function walkRelativeDirectories(
  read: AdapterReadApi,
  root: AbsolutePath,
  relativeDirectories: readonly string[],
  signal: CancellationSignal,
): Promise<readonly AbsolutePath[]> {
  const files = [];
  for (const relativeDirectory of [...relativeDirectories].sort()) {
    const directory = markerPath(root, ...pathSegments(relativeDirectory));
    if ((await read.stat(directory)).kind === "directory") {
      files.push(...(await walkFiles(read, await read.realpath(directory), signal)));
    }
  }
  return uniquePaths(files);
}

export async function documentedFiles(input: {
  readonly read: AdapterReadApi;
  readonly root: AbsolutePath;
  readonly rootFileNames: readonly string[];
  readonly relativeFiles: readonly string[];
  readonly relativeDirectories: readonly string[];
  readonly signal: CancellationSignal;
}): Promise<readonly AbsolutePath[]> {
  const rootStat = await input.read.stat(input.root);
  if (rootStat.kind === "file") {
    return input.rootFileNames.includes(basename(input.root))
      ? [await input.read.realpath(input.root)]
      : [];
  }
  if (rootStat.kind !== "directory") return [];
  return uniquePaths([
    ...(await existingRelativeFiles(input.read, input.root, input.relativeFiles)),
    ...(await walkRelativeDirectories(
      input.read,
      input.root,
      input.relativeDirectories,
      input.signal,
    )),
  ]);
}

export function uniquePaths(paths: readonly AbsolutePath[]): readonly AbsolutePath[] {
  return Object.freeze([...new Set(paths)].sort());
}

function pathSegments(path: string): readonly string[] {
  return path.split(/[\\/]/).filter((segment) => segment.length > 0 && segment !== ".");
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
