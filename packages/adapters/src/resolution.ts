import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";

import type { AdapterEffectiveConfigDraft, Asset, ResolutionContext } from "@ai-config-hub/core";
import { ContentHashSchema, type ResourceKind } from "@ai-config-hub/shared";

const kindOrder: Readonly<Record<ResourceKind, number>> = {
  rule: 0,
  agent: 1,
  skill: 2,
  mcp: 3,
};

function contains(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  );
}

function resourceName(asset: Asset): string {
  return asset.resource.data.name ?? asset.locator;
}

function resolutionHash(assets: readonly Asset[]) {
  const hash = createHash("sha256").update("ai-config-hub:resolution:v1\0");
  for (const asset of assets) {
    for (const value of [asset.assetId, asset.contentHash]) {
      hash
        .update(String(Buffer.byteLength(value)))
        .update(":")
        .update(value);
    }
  }
  return ContentHashSchema.parse(`sha256:${hash.digest("hex")}`);
}

export function resolveAssetsByScope(context: ResolutionContext): AdapterEffectiveConfigDraft {
  context.signal.throwIfAborted();
  const scopes = new Map(context.scopes.map((scope) => [scope.scopeId, scope]));
  const requestedKinds =
    context.resourceKinds === undefined ? undefined : new Set(context.resourceKinds);
  const applicable = context.assets
    .filter((asset) => {
      const scope = scopes.get(asset.scopeId);
      return (
        scope !== undefined &&
        scope.toolId === context.tool.toolId &&
        contains(scope.canonicalRootPath, context.targetPath) &&
        (requestedKinds === undefined || requestedKinds.has(asset.resource.kind))
      );
    })
    .sort((left, right) => {
      const leftScope = scopes.get(left.scopeId)!;
      const rightScope = scopes.get(right.scopeId)!;
      return (
        leftScope.precedence - rightScope.precedence ||
        leftScope.depth - rightScope.depth ||
        kindOrder[left.resource.kind] - kindOrder[right.resource.kind] ||
        left.canonicalSourcePath.localeCompare(right.canonicalSourcePath) ||
        left.locator.localeCompare(right.locator) ||
        left.assetId.localeCompare(right.assetId)
      );
    });

  const active = new Map<string, Asset>();
  const ignored = new Set<string>();
  const overriddenBy = new Map<string, string>();
  for (const asset of applicable) {
    const key =
      asset.resource.kind === "rule"
        ? `rule:${asset.assetId}`
        : `${asset.resource.kind}:${resourceName(asset)}`;
    const previous = active.get(key);
    if (previous !== undefined) {
      ignored.add(previous.assetId);
      overriddenBy.set(previous.assetId, asset.assetId);
    }
    active.set(key, asset);
  }
  const contributing = applicable.filter(
    (asset) => !ignored.has(asset.assetId) && [...active.values()].includes(asset),
  );
  const contributingIds = new Set(contributing.map(({ assetId }) => assetId));
  const steps = applicable.map((asset) => {
    if (ignored.has(asset.assetId)) {
      return {
        action: "ignore" as const,
        assetId: asset.assetId,
        reason: `A more specific scope overrides this resource (${overriddenBy.get(asset.assetId) ?? "unknown"})`,
      };
    }
    return {
      action:
        asset.resource.kind === "rule"
          ? ("inherit" as const)
          : applicable.some(
                (candidate) =>
                  candidate !== asset &&
                  candidate.resource.kind === asset.resource.kind &&
                  resourceName(candidate) === resourceName(asset),
              )
            ? ("override" as const)
            : ("merge" as const),
      assetId: asset.assetId,
      reason: "The asset applies to the selected target scope",
    };
  });
  return {
    canonicalTargetPath: context.targetPath,
    resourceKinds: [...new Set(contributing.map(({ resource }) => resource.kind))].sort(
      (left, right) => kindOrder[left] - kindOrder[right],
    ),
    resolvedResources: contributing.map(({ resource }) => resource),
    contributingAssetIds: applicable
      .filter(({ assetId }) => contributingIds.has(assetId))
      .map(({ assetId }) => assetId),
    ignoredAssetIds: applicable
      .filter(({ assetId }) => ignored.has(assetId))
      .map(({ assetId }) => assetId),
    steps,
    resolutionInputHash: resolutionHash(applicable),
  };
}
