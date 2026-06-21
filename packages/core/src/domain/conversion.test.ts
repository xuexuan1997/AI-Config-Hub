import { describe, expect, it } from "vitest";

import { ConversionResultSchema } from "./conversion.js";

const base = {
  conversionResultId: "conversion-1",
  sourceAssetId: "asset-1",
  sourceContentHash: `sha256:${"a".repeat(64)}`,
  targetToolId: "cursor",
  targetResourceKind: "rule",
  targetSchemaVersion: "1.0.0",
  adapterId: "cursor.builtin",
  adapterVersion: "1.0.0",
  diagnostics: [],
} as const;

const output = {
  relativePath: ".cursor/rules/generated.mdc",
  mediaType: "text/markdown",
  text: "Use strict TypeScript",
  contentHash: `sha256:${"b".repeat(64)}`,
} as const;

describe("ConversionResultSchema", () => {
  it("parses full, partial, and unsupported results", () => {
    expect(
      ConversionResultSchema.safeParse({ ...base, level: "full", outputs: [output] }).success,
    ).toBe(true);
    expect(
      ConversionResultSchema.safeParse({
        ...base,
        level: "partial",
        outputs: [output],
        retainedFields: ["/instructions"],
        droppedFields: ["/globs"],
        transformedFields: [],
        warnings: ["Cursor cannot preserve the source glob semantics"],
      }).success,
    ).toBe(true);
    expect(
      ConversionResultSchema.safeParse({
        ...base,
        level: "unsupported",
        reasons: ["The target has no equivalent resource"],
      }).success,
    ).toBe(true);
  });

  it("rejects deployable output on unsupported results", () => {
    expect(
      ConversionResultSchema.safeParse({
        ...base,
        level: "unsupported",
        reasons: ["No safe conversion"],
        outputs: [output],
      }).success,
    ).toBe(false);
  });

  it("rejects partial results that hide their warning", () => {
    expect(
      ConversionResultSchema.safeParse({
        ...base,
        level: "partial",
        outputs: [output],
        retainedFields: [],
        droppedFields: ["/globs"],
        transformedFields: [],
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it("prevents output path traversal", () => {
    expect(
      ConversionResultSchema.safeParse({
        ...base,
        level: "full",
        outputs: [{ ...output, relativePath: "../outside.md" }],
      }).success,
    ).toBe(false);
  });
});
