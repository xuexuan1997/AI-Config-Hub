import type { AdapterDiagnostic } from "@ai-config-hub/core";
import { JsonPointerSchema } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { normalizeAdapterDiagnostic, uniqueAdapterDiagnostics } from "./diagnostics.js";

describe("adapter diagnostic identity", () => {
  it("keeps identical diagnostics from different tool installations distinct", () => {
    const diagnostic = (toolId: string, toolInstallationId: string): AdapterDiagnostic => ({
      code: "SKILL_NAME_REQUIRED",
      severity: "error",
      message: "Skill name is required",
      location: { path: "/project/.agents/skills/shared/SKILL.md" },
      evidence: { toolId, toolInstallationId },
      suggestedActions: ["Add the missing name"],
      blocking: true,
    });
    const diagnostics = [
      diagnostic("codex", "codex:/project"),
      diagnostic("opencode", "opencode:/project"),
    ];

    expect(uniqueAdapterDiagnostics(diagnostics)).toHaveLength(2);
    const ids = diagnostics.map(
      (item) =>
        normalizeAdapterDiagnostic({
          diagnostic: item,
          scanRunId: "scan-shared-skill",
          createdAt: "2026-07-10T00:00:00.000Z",
        }).diagnosticId,
    );
    expect(new Set(ids)).toHaveLength(2);
  });

  it("keeps diagnostics with different stable evidence or pointers distinct", () => {
    const diagnostic = (relativePath: string, pointer?: string): AdapterDiagnostic => ({
      code: "SKILL_MARKDOWN_LINK_UNRESOLVED",
      severity: "error",
      message: "SKILL_MARKDOWN_LINK_UNRESOLVED in Skill package",
      location: {
        path: "/project/.agents/skills/shared/SKILL.md",
        ...(pointer === undefined ? {} : { pointer: JsonPointerSchema.parse(pointer) }),
      },
      evidence: {
        toolId: "codex",
        toolInstallationId: "codex:/project",
        relativePath,
      },
      suggestedActions: ["Fix the unresolved link"],
      blocking: true,
    });
    const diagnostics = [
      diagnostic("references/a.md"),
      diagnostic("references/b.md"),
      diagnostic("references/shared.md", "/links/0"),
      diagnostic("references/shared.md", "/links/1"),
    ];

    expect(uniqueAdapterDiagnostics(diagnostics)).toHaveLength(4);
    const ids = diagnostics.map(
      (item) =>
        normalizeAdapterDiagnostic({
          diagnostic: item,
          scanRunId: "scan-distinct-details",
          createdAt: "2026-07-10T00:00:00.000Z",
        }).diagnosticId,
    );
    expect(new Set(ids)).toHaveLength(4);
  });
});
