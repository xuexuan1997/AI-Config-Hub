import {
  AdapterIdSchema,
  AssetIdSchema,
  ContentHashSchema,
  ConversionResultIdSchema,
  JsonPointerSchema,
  ResourceKindSchema,
  SemVerSchema,
  ToolIdSchema,
} from "@ai-config-hub/shared";
import { z } from "zod";

import { DiagnosticSchema } from "./diagnostic.js";

const RelativeOutputPathSchema = z
  .string()
  .min(1)
  .refine((path) => {
    if (/^(?:[A-Za-z]:|[\\/])/.test(path)) return false;
    return !path
      .split(/[\\/]/)
      .some((segment) => segment === "" || segment === "." || segment === "..");
  }, "Expected a traversal-safe relative path");

export const ConvertedOutputSchema = z
  .object({
    relativePath: RelativeOutputPathSchema,
    mediaType: z.string().trim().min(1),
    text: z.string(),
    contentHash: ContentHashSchema,
  })
  .strict()
  .readonly();
export type ConvertedOutput = z.infer<typeof ConvertedOutputSchema>;

export const FieldTransformationSchema = z
  .object({
    sourceField: JsonPointerSchema,
    targetField: JsonPointerSchema,
    reason: z.string().trim().min(1),
  })
  .strict()
  .readonly();

const conversionBaseShape = {
  conversionResultId: ConversionResultIdSchema,
  sourceAssetId: AssetIdSchema,
  sourceContentHash: ContentHashSchema,
  targetToolId: ToolIdSchema,
  targetResourceKind: ResourceKindSchema,
  targetSchemaVersion: SemVerSchema,
  adapterId: AdapterIdSchema,
  adapterVersion: SemVerSchema,
  diagnostics: z.array(DiagnosticSchema).readonly(),
};

const FullConversionResultSchema = z
  .object({
    ...conversionBaseShape,
    level: z.literal("full"),
    outputs: z.array(ConvertedOutputSchema).min(1).readonly(),
  })
  .strict()
  .readonly();

const PartialConversionResultSchema = z
  .object({
    ...conversionBaseShape,
    level: z.literal("partial"),
    outputs: z.array(ConvertedOutputSchema).min(1).readonly(),
    retainedFields: z.array(JsonPointerSchema).readonly(),
    droppedFields: z.array(JsonPointerSchema).readonly(),
    transformedFields: z.array(FieldTransformationSchema).readonly(),
    warnings: z.array(z.string().trim().min(1)).min(1).readonly(),
  })
  .strict()
  .readonly();

const UnsupportedConversionResultSchema = z
  .object({
    ...conversionBaseShape,
    level: z.literal("unsupported"),
    reasons: z.array(z.string().trim().min(1)).min(1).readonly(),
  })
  .strict()
  .readonly();

export const ConversionResultSchema = z.discriminatedUnion("level", [
  FullConversionResultSchema,
  PartialConversionResultSchema,
  UnsupportedConversionResultSchema,
]);
export type ConversionResult = z.infer<typeof ConversionResultSchema>;

export const DeployableConversionResultSchema = z.discriminatedUnion("level", [
  FullConversionResultSchema,
  PartialConversionResultSchema,
]);
export type DeployableConversionResult = z.infer<typeof DeployableConversionResultSchema>;
