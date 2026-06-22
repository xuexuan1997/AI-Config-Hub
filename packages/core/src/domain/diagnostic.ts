import {
  AbsolutePathSchema,
  DiagnosticIdSchema,
  DiagnosticSeveritySchema,
  IsoDateTimeSchema,
  JsonPointerSchema,
} from "@ai-config-hub/shared";
import { z } from "zod";

export const SourceLocationSchema = z
  .object({
    path: AbsolutePathSchema,
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    pointer: JsonPointerSchema.optional(),
  })
  .strict()
  .readonly();
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

export const DiagnosticCategorySchema = z.enum([
  "discovery",
  "parsing",
  "compatibility",
  "permission",
  "conflict",
  "deployment",
  "verification",
  "git",
  "security",
  "internal",
]);
export type DiagnosticCategory = z.infer<typeof DiagnosticCategorySchema>;

export const DiagnosticSubjectSchema = z
  .object({
    kind: z.enum([
      "tool",
      "scope",
      "asset",
      "effective_config",
      "conversion",
      "scan",
      "deployment",
      "git",
    ]),
    id: z.string().trim().min(1).max(200),
  })
  .strict()
  .readonly();

const DiagnosticEvidenceSchema = z
  .record(z.string().min(1).max(100), z.unknown())
  .refine((evidence) => Object.keys(evidence).length > 0, "Diagnostic evidence cannot be empty")
  .readonly();

export const DiagnosticSchema = z
  .object({
    diagnosticId: DiagnosticIdSchema,
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "Expected a stable uppercase diagnostic code"),
    severity: DiagnosticSeveritySchema,
    category: DiagnosticCategorySchema,
    message: z.string().trim().min(1).max(1_000),
    subject: DiagnosticSubjectSchema,
    location: SourceLocationSchema.optional(),
    impact: z.string().trim().min(1).max(1_000),
    evidence: DiagnosticEvidenceSchema,
    suggestedActions: z.array(z.string().trim().min(1).max(500)).min(1).readonly(),
    blocking: z.boolean(),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
