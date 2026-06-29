import { describe, expect, it } from "vitest";

import { ContentHashSchema, IsoDateTimeSchema, ToolIdSchema } from "./primitives.js";

describe("shared primitives", () => {
  it("accepts built-in tool ids and safe custom kebab ids", () => {
    for (const toolId of ["claude-code", "cursor", "codex", "opencode", "my-tool", "tool2"]) {
      expect(ToolIdSchema.safeParse(toolId).success).toBe(true);
    }
  });

  it("rejects unsafe custom tool ids", () => {
    for (const toolId of ["", "My Tool", "my_tool", "-tool", "tool-", "two--dash", "tool.script"]) {
      expect(ToolIdSchema.safeParse(toolId).success).toBe(false);
    }
  });

  it("requires a prefixed SHA-256 hash", () => {
    expect(ContentHashSchema.safeParse(`sha256:${"a".repeat(64)}`).success).toBe(true);
    expect(ContentHashSchema.safeParse("a".repeat(64)).success).toBe(false);
    expect(ContentHashSchema.safeParse(`sha256:${"g".repeat(64)}`).success).toBe(false);
  });

  it("requires timezone-aware timestamps", () => {
    expect(IsoDateTimeSchema.safeParse("2026-06-21T10:00:00Z").success).toBe(true);
    expect(IsoDateTimeSchema.safeParse("2026-06-21T18:00:00+08:00").success).toBe(true);
    expect(IsoDateTimeSchema.safeParse("2026-06-21T10:00:00").success).toBe(false);
  });
});
