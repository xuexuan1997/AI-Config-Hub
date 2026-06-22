import { describe, expect, it } from "vitest";

import { EffectiveConfigSchema } from "./effective-config.js";

const resolvedRule = {
  kind: "rule",
  data: { instructions: "Use strict TypeScript", globs: ["**/*.ts"], extensions: {} },
} as const;

const validConfig = {
  effectiveConfigId: "effective-1",
  toolInstallationId: "installation-1",
  canonicalTargetPath: "/workspace/src",
  resourceKinds: ["rule"],
  contributingAssetIds: ["asset-winning"],
  ignoredAssetIds: ["asset-shadowed"],
  steps: [
    { action: "inherit", assetId: "asset-winning", reason: "Project scope applies" },
    { action: "ignore", assetId: "asset-shadowed", reason: "A deeper scope overrides it" },
  ],
  resolvedResources: [resolvedRule],
  resolutionInputHash: `sha256:${"a".repeat(64)}`,
  adapterId: "codex.builtin",
  adapterVersion: "1.0.0",
  diagnostics: [],
  resolvedAt: "2026-06-21T10:00:00Z",
} as const;

describe("EffectiveConfigSchema", () => {
  it("parses an explainable resolution", () => {
    expect(EffectiveConfigSchema.safeParse(validConfig).success).toBe(true);
  });

  it("requires every ignored asset to have an ignore step", () => {
    expect(
      EffectiveConfigSchema.safeParse({
        ...validConfig,
        steps: validConfig.steps.filter((step) => step.action !== "ignore"),
      }).success,
    ).toBe(false);
  });

  it("rejects assets that are both contributing and ignored", () => {
    expect(
      EffectiveConfigSchema.safeParse({ ...validConfig, ignoredAssetIds: ["asset-winning"] })
        .success,
    ).toBe(false);
  });

  it("requires every contributing asset to appear in a resolution step", () => {
    expect(
      EffectiveConfigSchema.safeParse({ ...validConfig, steps: [validConfig.steps[1]] }).success,
    ).toBe(false);
  });
});
