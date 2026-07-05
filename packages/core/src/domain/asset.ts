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

export const AssetSourceFileRoleSchema = z.enum(["primary", "support", "metadata"]);
export type AssetSourceFileRole = z.infer<typeof AssetSourceFileRoleSchema>;

export const AssetSourceRelativePathSchema = z
  .string()
  .min(1)
  .refine((path) => {
    if (/^(?:[A-Za-z]:|[\\/])/.test(path)) return false;
    return !path
      .split(/[\\/]/)
      .some((segment) => segment === "" || segment === "." || segment === "..");
  }, "Expected a traversal-safe relative source path");

export const AssetSourceFileSchema = z
  .object({
    path: AbsolutePathSchema,
    relativePath: AssetSourceRelativePathSchema,
    role: AssetSourceFileRoleSchema,
    mediaType: z.string().trim().min(1),
    isText: z.boolean(),
    contentHash: ContentHashSchema,
  })
  .strict()
  .readonly();
export type AssetSourceFile = z.infer<typeof AssetSourceFileSchema>;

export const AssetNativeIdentitySchema = z
  .object({
    nativeId: z.string().trim().min(1),
    displayName: z.string().trim().min(1),
    directoryName: z.string().trim().min(1).optional(),
    invocationName: z.string().trim().min(1).optional(),
  })
  .strict()
  .readonly();
export type AssetNativeIdentity = z.infer<typeof AssetNativeIdentitySchema>;

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
    sourceFiles: z.array(AssetSourceFileSchema).min(1).readonly(),
    nativeIdentity: AssetNativeIdentitySchema,
    normalizedSchemaVersion: SemVerSchema,
    adapterId: AdapterIdSchema,
    adapterVersion: SemVerSchema,
    discoveredAt: IsoDateTimeSchema,
    references: z.array(z.string().min(1)).readonly(),
    status: AssetStatusSchema.default("enabled"),
    diagnosticSummary: DiagnosticSummarySchema,
  })
  .strict()
  .superRefine((asset, context) => {
    const primaryFiles = asset.sourceFiles.filter((sourceFile) => sourceFile.role === "primary");
    if (primaryFiles.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "Every asset must have exactly one primary source file",
        path: ["sourceFiles"],
      });
      return;
    }

    const [primary] = primaryFiles;
    if (primary !== undefined && primary.path !== asset.canonicalSourcePath) {
      context.addIssue({
        code: "custom",
        message: "canonicalSourcePath must match the primary source file path",
        path: ["canonicalSourcePath"],
      });
    }
  })
  .readonly();
export type Asset = z.infer<typeof AssetSchema>;
