import { createHash } from "node:crypto";

import type { DiagnosticSeverity } from "@ai-config-hub/shared";

import type { CommandResponse } from "./commands.js";

type DiagnosticExportResponse = CommandResponse<"diagnostics.export">;
type DiagnosticExportItem = DiagnosticExportResponse["items"][number];
type DiagnosticExportFilters = DiagnosticExportResponse["filters"];
type RedactionMarker = DiagnosticExportResponse["redactions"][number];

export interface DiagnosticReportInput {
  readonly format: DiagnosticExportResponse["format"];
  readonly generatedAt: string;
  readonly filters: DiagnosticExportFilters;
  readonly items: readonly DiagnosticExportItem[];
  readonly homeDirectory: string;
  readonly pathRoots?: readonly DiagnosticReportPathRoot[];
}

export interface DiagnosticReportPathRoot {
  readonly label: string;
  readonly path: string;
}

const secretPatterns = [
  {
    pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/gu,
    replacement: "[REDACTED]",
  },
  {
    pattern: /\bBearer\s+\S+/giu,
    replacement: "Bearer [REDACTED]",
  },
  {
    pattern:
      /(\b[A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|API[_-]?KEY|APIKEY|AUTHORIZATION|COOKIE|CREDENTIAL)[A-Z0-9_-]*\b\s*[:=]\s*)(?:"[^"]+"|'[^']+'|[^\s,;]+)/giu,
    replacement: "$1[REDACTED]",
  },
  {
    pattern:
      /(--?(?:token|secret|password|passwd|private[_-]?key|api[_-]?key|authorization|cookie|credential)[=\s]+)(?:"[^"]+"|'[^']+'|[^\s,;]+)/giu,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /((?:Authorization|Cookie)\s*:\s*)[^\n\r,;]+/giu,
    replacement: "$1[REDACTED]",
  },
  {
    pattern: /(https?:\/\/)[^:@/\s]+:[^@/\s]+@/giu,
    replacement: "$1[REDACTED]@",
  },
] as const;

export function createDiagnosticReport(input: DiagnosticReportInput): DiagnosticExportResponse {
  const redactions: RedactionMarker[] = [];
  const roots = pathShorteningRoots(input.homeDirectory, input.pathRoots ?? []);
  const items = input.items.map((item, index) => sanitizeItem(item, index, roots, redactions));
  const summary = summarize(items);
  const base = {
    format: input.format,
    generatedAt: input.generatedAt,
    filters: input.filters,
    summary,
    items,
    redactions,
  };
  return {
    ...base,
    content:
      input.format === "markdown" ? renderMarkdown(base) : `${JSON.stringify(base, null, 2)}\n`,
  };
}

function sanitizeItem(
  item: DiagnosticExportItem,
  index: number,
  roots: readonly PathShorteningRoot[],
  redactions: RedactionMarker[],
): DiagnosticExportItem {
  const message = sanitizeText(item.message, `/items/${index}/message`, roots, redactions);
  const suggestedAction = sanitizeText(
    item.suggestedAction,
    `/items/${index}/suggestedAction`,
    roots,
    redactions,
  );
  const location =
    item.location === undefined
      ? undefined
      : {
          ...item.location,
          pathDisplay: sanitizePath(
            item.location.pathDisplay,
            `/items/${index}/location/pathDisplay`,
            roots,
            redactions,
          ),
        };
  return {
    ...item,
    message,
    suggestedAction,
    ...(location === undefined ? {} : { location }),
  };
}

function sanitizePath(
  value: string,
  pointer: string,
  roots: readonly PathShorteningRoot[],
  redactions: RedactionMarker[],
): string {
  const shortened = shortenPath(value, roots);
  if (shortened.changed) redactions.push({ pointer, reason: "path" });
  return sanitizeText(shortened.value, pointer, roots, redactions);
}

interface PathShorteningRoot {
  readonly label: string;
  readonly variants: readonly string[];
}

function pathShorteningRoots(
  homeDirectory: string,
  roots: readonly DiagnosticReportPathRoot[],
): readonly PathShorteningRoot[] {
  const keyed = new Map<string, PathShorteningRoot>();
  for (const root of [{ label: "~", path: homeDirectory }, ...roots]) {
    const variants = pathVariants(root.path);
    if (variants.length === 0) continue;
    const key = `${root.label}\0${variants.join("\0")}`;
    keyed.set(key, { label: root.label, variants });
  }
  return [...keyed.values()].sort((left, right) => rootLength(right) - rootLength(left));
}

function rootLength(root: PathShorteningRoot): number {
  return root.variants[0]?.length ?? 0;
}

function pathVariants(path: string): readonly string[] {
  const variants = new Set<string>();
  const normalized = normalizePath(path);
  if (normalized.length === 0 || normalized === "/") return [];
  variants.add(normalized);
  if (normalized === "/var") variants.add("/private/var");
  else if (normalized.startsWith("/var/")) variants.add(`/private${normalized}`);
  else if (normalized === "/private/var") variants.add("/var");
  else if (normalized.startsWith("/private/var/"))
    variants.add(normalized.slice("/private".length));
  return [...variants].sort((left, right) => right.length - left.length);
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
}

function shortenPath(
  value: string,
  roots: readonly PathShorteningRoot[],
): {
  readonly value: string;
  readonly changed: boolean;
} {
  const normalized = normalizePath(value);
  for (const root of roots) {
    for (const variant of root.variants) {
      if (normalized === variant || normalized.startsWith(`${variant}/`)) {
        return {
          value:
            normalized === variant
              ? root.label
              : `${root.label}${normalized.slice(variant.length)}`,
          changed: true,
        };
      }
    }
  }
  if (isAbsolutePath(normalized)) {
    return { value: externalPathLabel(normalized), changed: true };
  }
  return { value, changed: false };
}

function sanitizeText(
  value: string,
  pointer: string,
  roots: readonly PathShorteningRoot[],
  redactions: RedactionMarker[],
): string {
  const knownRootResult = shortenKnownRootOccurrences(value, roots);
  let output = knownRootResult.value;
  const pathResult = shortenEmbeddedPaths(output, roots);
  output = pathResult.value;
  if (knownRootResult.changed || pathResult.changed) redactions.push({ pointer, reason: "path" });
  const beforeSecrets = output;
  for (const { pattern, replacement } of secretPatterns) {
    output = output.replace(pattern, replacement);
  }
  if (output !== beforeSecrets) redactions.push({ pointer, reason: "secret" });
  return output;
}

function shortenKnownRootOccurrences(
  value: string,
  roots: readonly PathShorteningRoot[],
): { readonly value: string; readonly changed: boolean } {
  let output = value;
  let changed = false;
  for (const root of roots) {
    for (const variant of root.variants) {
      if (!output.includes(variant)) continue;
      output = output.split(variant).join(root.label);
      changed = true;
    }
  }
  return { value: output, changed };
}

function shortenEmbeddedPaths(
  value: string,
  roots: readonly PathShorteningRoot[],
): {
  readonly value: string;
  readonly changed: boolean;
} {
  let changed = false;
  const output = value.replace(
    /(^|[\s([{"'=])((?:\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>)\]}]+)/gu,
    (_match, prefix: string, path: string) => {
      const trimmed = trimPathToken(path);
      const shortened = shortenPath(trimmed.path, roots);
      if (shortened.changed) changed = true;
      return `${prefix}${shortened.value}${trimmed.suffix}`;
    },
  );
  return { value: output, changed };
}

function trimPathToken(path: string): { readonly path: string; readonly suffix: string } {
  const match = /[.,;:!?]+$/u.exec(path);
  if (match === null) return { path, suffix: "" };
  return { path: path.slice(0, -match[0].length), suffix: match[0] };
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//u.test(value) || value.startsWith("//");
}

function externalPathLabel(path: string): string {
  return `<external>/${basename(path)}#${hashPath(path)}`;
}

function basename(path: string): string {
  const parts = normalizePath(path)
    .split("/")
    .filter((part) => part.length > 0);
  return parts.at(-1) ?? "path";
}

function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

function summarize(items: readonly { readonly severity: DiagnosticSeverity }[]) {
  const summary = { total: items.length, info: 0, warning: 0, error: 0 };
  for (const item of items) summary[item.severity] += 1;
  return summary;
}

function renderMarkdown(input: Omit<DiagnosticExportResponse, "content">): string {
  const lines = [
    "# Diagnostic report",
    "",
    `Generated: ${input.generatedAt}`,
    `Total: ${input.summary.total} (info ${input.summary.info}, warning ${input.summary.warning}, error ${input.summary.error})`,
    "",
  ];
  if (input.items.length === 0) {
    lines.push("No diagnostics matched the selected filters.");
  } else {
    for (const item of input.items) {
      const location = item.location;
      const path =
        location === undefined
          ? ""
          : ` ${location.pathDisplay}${location.line === undefined ? "" : `:${location.line}`}`;
      lines.push(`- ${item.severity} ${item.code}${path} ${item.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
