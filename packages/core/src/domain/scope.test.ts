import { describe, expect, it } from "vitest";

import { ScopeSchema } from "./scope.js";

const validScope = {
  scopeId: "scope-1",
  toolId: "codex",
  scopeKind: "project",
  canonicalRootPath: "/workspace",
  projectId: "project-1",
  depth: 0,
  precedence: 100,
  discoveryEvidence: { source: "fixture" },
} as const;

describe("ScopeSchema", () => {
  it("parses an evidenced project scope", () => {
    expect(ScopeSchema.safeParse(validScope).success).toBe(true);
  });

  it("rejects relative roots and negative depth", () => {
    expect(ScopeSchema.safeParse({ ...validScope, canonicalRootPath: "workspace" }).success).toBe(
      false,
    );
    expect(ScopeSchema.safeParse({ ...validScope, depth: -1 }).success).toBe(false);
  });
});
