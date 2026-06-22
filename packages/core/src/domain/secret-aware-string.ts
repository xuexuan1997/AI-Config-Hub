import { ContentHashSchema } from "@ai-config-hub/shared";
import { z } from "zod";

const LiteralSecretAwareStringSchema = z
  .object({
    kind: z.literal("literal"),
    value: z.string(),
    deployable: z.literal(true),
  })
  .strict()
  .readonly();

const ReferenceSecretAwareStringSchema = z
  .object({
    kind: z.literal("reference"),
    expression: z.string().trim().min(1),
    deployable: z.literal(true),
  })
  .strict()
  .readonly();

const RedactedSecretAwareStringSchema = z
  .object({
    kind: z.literal("redacted"),
    digest: ContentHashSchema,
    deployable: z.literal(false),
  })
  .strict()
  .readonly();

export const SecretAwareStringSchema = z.discriminatedUnion("kind", [
  LiteralSecretAwareStringSchema,
  ReferenceSecretAwareStringSchema,
  RedactedSecretAwareStringSchema,
]);
export type SecretAwareString = z.infer<typeof SecretAwareStringSchema>;
