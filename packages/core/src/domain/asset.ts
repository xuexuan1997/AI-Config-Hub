import {
  AbsolutePathSchema,
  AdapterIdSchema,
  AssetIdSchema,
  ContentHashSchema,
  IsoDateTimeSchema,
  ScopeIdSchema,
  SemVerSchema,
  ToolIdSchema,
} from "@ai-config-hub/shared";
import { z } from "zod";

import { NormalizedResourceSchema } from "./resource.js";

export const DiagnosticSummarySchema = z
  .object({
    info: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export const AssetStatusSchema = z.enum(["enabled", "disabled"]);
export type AssetStatus = z.infer<typeof AssetStatusSchema>;

export const AssetDisablementMethodSchema = z.enum([
  "native",
  "move_file",
  "remove_config_entry",
  "hub_ignore",
]);
export type AssetDisablementMethod = z.infer<typeof AssetDisablementMethodSchema>;

export const AssetSchema = z
  .object({
    assetId: AssetIdSchema,
    toolId: ToolIdSchema,
    resource: NormalizedResourceSchema,
    scopeId: ScopeIdSchema,
    canonicalSourcePath: AbsolutePathSchema,
    locator: z.string().min(1),
    sourceFormat: z.string().trim().min(1),
    contentHash: ContentHashSchema,
    normalizedSchemaVersion: SemVerSchema,
    adapterId: AdapterIdSchema,
    adapterVersion: SemVerSchema,
    discoveredAt: IsoDateTimeSchema,
    references: z.array(z.string().min(1)).readonly(),
    status: AssetStatusSchema.default("enabled"),
    diagnosticSummary: DiagnosticSummarySchema,
  })
  .strict()
  .readonly();
export type Asset = z.infer<typeof AssetSchema>;
