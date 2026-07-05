import type { AdapterDiagnostic, AdapterSourceLocation } from "@ai-config-hub/core";

export function nativeDiagnostic(input: {
  readonly code: string;
  readonly severity?: AdapterDiagnostic["severity"];
  readonly message: string;
  readonly blocking?: boolean;
  readonly location?: AdapterSourceLocation;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly suggestedActions?: readonly string[];
}): AdapterDiagnostic {
  return {
    code: input.code,
    severity: input.severity ?? (input.blocking === true ? "error" : "warning"),
    message: input.message,
    ...(input.location === undefined ? {} : { location: input.location }),
    evidence: input.evidence ?? {},
    suggestedActions: input.suggestedActions ?? [
      "Review the native tool documentation and update the asset",
    ],
    blocking: input.blocking ?? false,
  };
}
