import {
  AbsolutePathSchema,
  AdapterIdSchema,
  AssetIdSchema,
  ContentHashSchema,
  EffectiveConfigIdSchema,
  IsoDateTimeSchema,
  ResourceKindSchema,
  SemVerSchema,
  ToolInstallationIdSchema,
} from "@ai-config-hub/shared";
import { z } from "zod";

import { DiagnosticSchema } from "./diagnostic.js";
import { NormalizedResourceSchema } from "./resource.js";

export const EffectiveConfigStepSchema = z
  .object({
    action: z.enum(["inherit", "merge", "override", "ignore"]),
    assetId: AssetIdSchema,
    reason: z.string().trim().min(1).max(1_000),
    coveredByAssetId: AssetIdSchema.optional(),
  })
  .strict()
  .readonly();
export type EffectiveConfigStep = z.infer<typeof EffectiveConfigStepSchema>;

export const EffectiveConfigSchema = z
  .object({
    effectiveConfigId: EffectiveConfigIdSchema,
    toolInstallationId: ToolInstallationIdSchema,
    canonicalTargetPath: AbsolutePathSchema,
    resourceKinds: z.array(ResourceKindSchema).readonly(),
    contributingAssetIds: z.array(AssetIdSchema).readonly(),
    ignoredAssetIds: z.array(AssetIdSchema).readonly(),
    steps: z.array(EffectiveConfigStepSchema).readonly(),
    resolvedResources: z.array(NormalizedResourceSchema).readonly(),
    resolutionInputHash: ContentHashSchema,
    adapterId: AdapterIdSchema,
    adapterVersion: SemVerSchema,
    diagnostics: z.array(DiagnosticSchema).readonly(),
    resolvedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((config, context) => {
    const contributing = new Set<string>(config.contributingAssetIds);
    const ignored = new Set<string>(config.ignoredAssetIds);

    for (const assetId of contributing) {
      if (!config.steps.some((step) => step.assetId === assetId && step.action !== "ignore")) {
        context.addIssue({
          code: "custom",
          message: "Every contributing asset requires an explicit resolution step",
          path: ["steps"],
        });
      }
    }

    for (const assetId of ignored) {
      if (contributing.has(assetId)) {
        context.addIssue({
          code: "custom",
          message: "An asset cannot be both contributing and ignored",
          path: ["ignoredAssetIds"],
        });
      }
      if (!config.steps.some((step) => step.assetId === assetId && step.action === "ignore")) {
        context.addIssue({
          code: "custom",
          message: "Every ignored asset requires an explicit ignore step",
          path: ["steps"],
        });
      }
    }
  })
  .readonly();
export type EffectiveConfig = z.infer<typeof EffectiveConfigSchema>;
