import {
  AbsolutePathSchema,
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

const GeneratedConvertedOutputSchema = z
  .object({
    deploymentType: z.literal("generated_file"),
    relativePath: RelativeOutputPathSchema,
    mediaType: z.string().trim().min(1),
    text: z.string(),
    contentHash: ContentHashSchema,
  })
  .strict()
  .readonly();

const sourceOutputShape = {
  relativePath: RelativeOutputPathSchema,
  mediaType: z.string().trim().min(1),
  sourcePath: AbsolutePathSchema,
  sourceHash: ContentHashSchema,
  contentHash: ContentHashSchema,
} as const;

const CopyConvertedOutputSchema = z
  .object({
    deploymentType: z.literal("copy"),
    ...sourceOutputShape,
  })
  .strict()
  .superRefine((output, context) => {
    if (output.contentHash !== output.sourceHash) {
      context.addIssue({
        code: "custom",
        message: "Source output contentHash must match sourceHash",
        path: ["contentHash"],
      });
    }
  })
  .readonly();

const SymlinkConvertedOutputSchema = z
  .object({
    deploymentType: z.literal("symlink"),
    ...sourceOutputShape,
  })
  .strict()
  .superRefine((output, context) => {
    if (output.contentHash !== output.sourceHash) {
      context.addIssue({
        code: "custom",
        message: "Source output contentHash must match sourceHash",
        path: ["contentHash"],
      });
    }
  })
  .readonly();

export const ConvertedOutputSchema = z.discriminatedUnion("deploymentType", [
  GeneratedConvertedOutputSchema,
  CopyConvertedOutputSchema,
  SymlinkConvertedOutputSchema,
]);
export type ConvertedOutput = z.infer<typeof ConvertedOutputSchema>;

export const FieldTransformationSchema = z
  .object({
    sourceField: JsonPointerSchema,
    targetField: JsonPointerSchema,
    reason: z.string().trim().min(1),
  })
  .strict()
  .readonly();
export type FieldTransformation = z.infer<typeof FieldTransformationSchema>;

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
