import { describe, expect, it } from "vitest";

import { ContentHashSchema, IsoDateTimeSchema, ToolIdSchema } from "./primitives.js";

describe("shared primitives", () => {
  it("accepts only the four MVP tool ids", () => {
    expect(ToolIdSchema.options).toEqual(["claude-code", "cursor", "codex", "opencode"]);
    expect(ToolIdSchema.safeParse("other").success).toBe(false);
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
