import {
  AbsolutePathSchema,
  ProjectIdSchema,
  ScopeIdSchema,
  ScopeKindSchema,
  ToolIdSchema,
} from "@ai-config-hub/shared";
import { z } from "zod";

import { ExtensionsSchema } from "./resource.js";

export const ScopeSchema = z
  .object({
    scopeId: ScopeIdSchema,
    toolId: ToolIdSchema,
    scopeKind: ScopeKindSchema,
    canonicalRootPath: AbsolutePathSchema,
    projectId: ProjectIdSchema.optional(),
    parentScopeId: ScopeIdSchema.optional(),
    depth: z.number().int().nonnegative(),
    precedence: z.number().int(),
    discoveryEvidence: ExtensionsSchema,
  })
  .strict()
  .readonly();
export type Scope = z.infer<typeof ScopeSchema>;

export const ScopeCandidateSchema = z
  .object({
    kind: ScopeKindSchema,
    canonicalRootPath: AbsolutePathSchema,
    projectRoot: AbsolutePathSchema.optional(),
    parentRoot: AbsolutePathSchema.optional(),
    depth: z.number().int().nonnegative(),
    precedence: z.number().int(),
  })
  .strict()
  .readonly();
export type ScopeCandidate = z.infer<typeof ScopeCandidateSchema>;
