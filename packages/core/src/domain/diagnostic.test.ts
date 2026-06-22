import { describe, expect, it } from "vitest";

import { DiagnosticSchema } from "./diagnostic.js";

const validDiagnostic = {
  diagnosticId: "diag-1",
  code: "ASSET_SHADOWED",
  severity: "warning",
  category: "conflict",
  message: "A higher-priority asset wins",
  subject: { kind: "asset", id: "asset-1" },
  impact: "The lower-priority instructions do not apply",
  evidence: { winningAssetId: "asset-2" },
  suggestedActions: ["Review the winning asset"],
  blocking: false,
  createdAt: "2026-06-21T10:00:00Z",
} as const;

describe("DiagnosticSchema", () => {
  it("parses an actionable and evidenced diagnostic", () => {
    expect(DiagnosticSchema.safeParse(validDiagnostic).success).toBe(true);
  });

  it("rejects generic diagnostics without evidence or actions", () => {
    expect(DiagnosticSchema.safeParse({ ...validDiagnostic, evidence: {} }).success).toBe(false);
    expect(DiagnosticSchema.safeParse({ ...validDiagnostic, suggestedActions: [] }).success).toBe(
      false,
    );
  });

  it("rejects unstable diagnostic codes", () => {
    expect(DiagnosticSchema.safeParse({ ...validDiagnostic, code: "asset-shadowed" }).success).toBe(
      false,
    );
  });
});
