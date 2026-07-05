import { z } from "zod";

import { SecretAwareStringSchema } from "./secret-aware-string.js";

export const ExtensionsSchema = z.record(z.string().min(1), z.unknown()).readonly();

export const RuleResourceDataSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    instructions: z.string().min(1),
    globs: z.array(z.string().min(1)).readonly(),
    extensions: ExtensionsSchema,
  })
  .strict()
  .readonly();

export const AgentResourceDataSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().min(1).optional(),
    instructions: z.string().min(1),
    model: z.string().trim().min(1).optional(),
    allowedTools: z.array(z.string().trim().min(1)).readonly(),
    extensions: ExtensionsSchema,
  })
  .strict()
  .readonly();

export const SkillResourceDataSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().min(1).optional(),
    instructions: z.string().min(1),
    references: z.array(z.string().min(1)).readonly(),
    extensions: ExtensionsSchema,
  })
  .strict()
  .readonly();

export const McpStdioTransportSchema = z
  .object({
    kind: z.literal("stdio"),
    command: z.string().trim().min(1),
    args: z.array(SecretAwareStringSchema).readonly(),
    env: z.record(z.string().min(1), SecretAwareStringSchema).readonly(),
  })
  .strict()
  .readonly();

const McpRemoteEndpointSchema = z
  .object({
    baseUrl: SecretAwareStringSchema,
    query: z.record(z.string(), z.array(SecretAwareStringSchema).readonly()).readonly(),
    userInfo: z
      .object({
        username: SecretAwareStringSchema,
        password: SecretAwareStringSchema.optional(),
      })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();

export const McpRemoteTransportSchema = z
  .object({
    kind: z.enum(["http", "sse"]),
    endpoint: McpRemoteEndpointSchema,
    headers: z.record(z.string().min(1), SecretAwareStringSchema).readonly(),
  })
  .strict()
  .readonly();

export const McpTransportSchema = z.discriminatedUnion("kind", [
  McpStdioTransportSchema,
  McpRemoteTransportSchema,
]);

const RuleResourceSchema = z
  .object({ kind: z.literal("rule"), data: RuleResourceDataSchema })
  .strict()
  .readonly();
const AgentResourceSchema = z
  .object({ kind: z.literal("agent"), data: AgentResourceDataSchema })
  .strict()
  .readonly();
const SkillResourceSchema = z
  .object({ kind: z.literal("skill"), data: SkillResourceDataSchema })
  .strict()
  .readonly();
const McpResourceSchema = z
  .object({
    kind: z.literal("mcp"),
    data: z
      .object({
        name: z.string().trim().min(1),
        transport: McpTransportSchema,
        extensions: ExtensionsSchema,
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export const NormalizedResourceSchema = z.discriminatedUnion("kind", [
  RuleResourceSchema,
  AgentResourceSchema,
  SkillResourceSchema,
  McpResourceSchema,
]);
export type NormalizedResource = z.infer<typeof NormalizedResourceSchema>;
