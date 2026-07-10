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
export const ADAPTER_DISCOVERY_ENTRY_LIMIT = 10_000;

export class AdapterDiscoveryLimitError extends Error {
  readonly code = "ADAPTER_DISCOVERY_LIMIT_EXCEEDED";

  constructor(
    readonly root: AbsolutePath,
    readonly limit: number,
    readonly observedAtLeast: number,
  ) {
    super(`Adapter discovery exceeds the ${String(limit)} entry limit at ${root}`);
    this.name = "AdapterDiscoveryLimitError";
  }
}

export interface AdapterDiscoveryBudget {
  readonly root: AbsolutePath;
  readonly visitedDirectories: Set<AbsolutePath>;
  visitedEntries: number;
}

export function createAdapterDiscoveryBudget(root: AbsolutePath): AdapterDiscoveryBudget {
  return { root, visitedDirectories: new Set(), visitedEntries: 0 };
}

function consumeDiscoveryEntry(budget: AdapterDiscoveryBudget): void {
  budget.visitedEntries += 1;
  if (budget.visitedEntries > ADAPTER_DISCOVERY_ENTRY_LIMIT) {
    throw new AdapterDiscoveryLimitError(
      budget.root,
      ADAPTER_DISCOVERY_ENTRY_LIMIT,
      budget.visitedEntries,
    );
  }
}

export async function walkFiles(
  read: AdapterReadApi,
  root: AbsolutePath,
  signal: CancellationSignal,
  sharedBudget?: AdapterDiscoveryBudget,
): Promise<readonly AbsolutePath[]> {
  return walkFilesWithBudget(read, root, signal, sharedBudget);
}

async function walkFilesWithBudget(
  read: AdapterReadApi,
  root: AbsolutePath,
  signal: CancellationSignal,
  sharedBudget?: AdapterDiscoveryBudget,
): Promise<readonly AbsolutePath[]> {
  const rootStat = await read.stat(root);
  if (rootStat.kind === "missing") return [];
  const canonicalRoot = await read.realpath(root);
  if (rootStat.kind === "file") return [canonicalRoot];

  const budget = sharedBudget ?? createAdapterDiscoveryBudget(canonicalRoot);
  const files = new Set<AbsolutePath>();
  const queue: AbsolutePath[] = [canonicalRoot];
  while (queue.length > 0) {
    signal.throwIfAborted();
    const directory = queue.shift();
    if (directory === undefined) break;
    const canonicalDirectory = await read.realpath(directory);
    if (budget.visitedDirectories.has(canonicalDirectory)) continue;
    budget.visitedDirectories.add(canonicalDirectory);
    for (const child of await read.list(canonicalDirectory)) {
      consumeDiscoveryEntry(budget);
      const metadata = await read.stat(child);
      if (metadata.kind === "file") files.add(await read.realpath(child));
      if (metadata.kind === "directory" && !ignoredDirectories.has(basename(child)))
        queue.push(child);
    }
  }
  return [...files].sort();
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
  sharedBudget?: AdapterDiscoveryBudget,
): Promise<readonly AbsolutePath[]> {
  const files = [];
  const canonicalRoot = await read.realpath(root);
  const budget = sharedBudget ?? createAdapterDiscoveryBudget(canonicalRoot);
  for (const relativeDirectory of [...relativeDirectories].sort()) {
    const directory = markerPath(root, ...pathSegments(relativeDirectory));
    if ((await read.stat(directory)).kind === "directory") {
      files.push(
        ...(await walkFilesWithBudget(read, await read.realpath(directory), signal, budget)),
      );
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
  readonly budget?: AdapterDiscoveryBudget;
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
      input.budget,
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
  const joined = join(root, ...segments);
  return AbsolutePathSchema.parse(root.startsWith("/") ? joined.replaceAll("\\", "/") : joined);
}

export function scopeKindFromEvidence(
  evidence: Readonly<Record<string, unknown>>,
): ScopeKind | undefined {
  return evidence["scope"] === "user" ? "user" : undefined;
}
