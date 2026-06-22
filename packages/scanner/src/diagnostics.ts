import type { AdapterDiagnostic, Diagnostic } from "@ai-config-hub/core";
import { DiagnosticSchema } from "@ai-config-hub/core";
import { DiagnosticIdSchema, ScanRunIdSchema } from "@ai-config-hub/shared";

import { stableId } from "./identity.js";

export function normalizeAdapterDiagnostic(input: {
  readonly diagnostic: AdapterDiagnostic;
  readonly scanRunId: string;
  readonly createdAt: string;
}): Diagnostic {
  const { diagnostic } = input;
  const fingerprint = stableId("diagnostic", [
    input.scanRunId,
    diagnostic.code,
    diagnostic.location?.path ?? "",
    String(diagnostic.location?.line ?? ""),
    String(diagnostic.location?.column ?? ""),
    diagnostic.message,
  ]);
  return DiagnosticSchema.parse({
    diagnosticId: DiagnosticIdSchema.parse(fingerprint),
    code: /^[A-Z][A-Z0-9_]*$/.test(diagnostic.code) ? diagnostic.code : "ADAPTER_DIAGNOSTIC",
    severity: diagnostic.severity,
    category: diagnostic.code.includes("PARSE") ? "parsing" : "discovery",
    message: diagnostic.message,
    subject: { kind: "scan", id: ScanRunIdSchema.parse(input.scanRunId) },
    ...(diagnostic.location === undefined ? {} : { location: diagnostic.location }),
    impact: diagnostic.blocking
      ? "The affected configuration cannot be indexed safely"
      : "The configuration may require attention",
    evidence:
      Object.keys(diagnostic.evidence).length === 0 ? { source: "adapter" } : diagnostic.evidence,
    suggestedActions:
      diagnostic.suggestedActions.length === 0
        ? ["Review the configuration and scan again"]
        : diagnostic.suggestedActions,
    blocking: diagnostic.blocking,
    createdAt: input.createdAt,
  });
}
