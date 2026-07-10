import type { AdapterDiagnostic, Diagnostic } from "@ai-config-hub/core";
import { DiagnosticSchema } from "@ai-config-hub/core";
import { DiagnosticIdSchema, ScanRunIdSchema } from "@ai-config-hub/shared";

import { stableId } from "./identity.js";

const diagnosticEvidenceIdentityKeys = ["field", "relativePath"] as const;

function diagnosticEvidenceIdentity(evidence: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    diagnosticEvidenceIdentityKeys.flatMap((key) => {
      const value = evidence[key];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [[key, value] as const]
        : [];
    }),
  );
}

function diagnosticIdentityParts(diagnostic: AdapterDiagnostic): readonly string[] {
  const toolId = diagnostic.evidence["toolId"];
  const toolInstallationId = diagnostic.evidence["toolInstallationId"];
  return [
    diagnostic.code,
    diagnostic.location?.path ?? "",
    String(diagnostic.location?.line ?? ""),
    String(diagnostic.location?.column ?? ""),
    diagnostic.location?.pointer ?? "",
    diagnostic.message,
    typeof toolId === "string" ? toolId : "",
    typeof toolInstallationId === "string" ? toolInstallationId : "",
    diagnosticEvidenceIdentity(diagnostic.evidence),
  ];
}

export function uniqueAdapterDiagnostics(
  diagnostics: readonly AdapterDiagnostic[],
): readonly AdapterDiagnostic[] {
  const seen = new Set<string>();
  const unique: AdapterDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = diagnosticIdentityParts(diagnostic).join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(diagnostic);
  }
  return unique;
}

export function normalizeAdapterDiagnostic(input: {
  readonly diagnostic: AdapterDiagnostic;
  readonly scanRunId: string;
  readonly createdAt: string;
}): Diagnostic {
  const { diagnostic } = input;
  const fingerprint = stableId("diagnostic", [
    input.scanRunId,
    ...diagnosticIdentityParts(diagnostic),
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
