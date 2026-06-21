import { describe, expect, it } from "vitest";

import { AssetSchema } from "./asset.js";
import { SecretAwareStringSchema } from "./secret-aware-string.js";

const validAsset = {
  assetId: "asset-1",
  toolId: "codex",
  resource: {
    kind: "mcp",
    data: {
      name: "docs",
      transport: {
        kind: "stdio",
        command: "node",
        args: [{ kind: "reference", expression: "${DOCS_TOKEN}", deployable: true }],
        env: {},
      },
      extensions: { "codex.timeout": 30 },
    },
  },
  scopeId: "scope-1",
  canonicalSourcePath: "/workspace/.codex/config.toml",
  locator: "/mcp/docs",
  sourceFormat: "toml",
  contentHash: `sha256:${"a".repeat(64)}`,
  normalizedSchemaVersion: "1.0.0",
  adapterId: "codex.builtin",
  adapterVersion: "1.0.0",
  discoveredAt: "2026-06-21T10:00:00Z",
  references: [],
  diagnosticSummary: { info: 0, warning: 0, error: 0 },
} as const;

describe("AssetSchema", () => {
  it("parses a normalized MCP asset without resolving its secret reference", () => {
    const result = AssetSchema.safeParse(validAsset);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resource.data.extensions).toEqual({ "codex.timeout": 30 });
    }
  });

  it("rejects relative source paths", () => {
    expect(
      AssetSchema.safeParse({ ...validAsset, canonicalSourcePath: ".codex/config.toml" }).success,
    ).toBe(false);
  });

  it("rejects undeclared top-level fields", () => {
    expect(AssetSchema.safeParse({ ...validAsset, rawSecret: "do-not-index" }).success).toBe(false);
  });

  it("uses the locator to distinguish multiple resources in one file", () => {
    const first = AssetSchema.parse(validAsset);
    const second = AssetSchema.parse({ ...validAsset, assetId: "asset-2", locator: "/mcp/search" });

    expect(first.locator).not.toBe(second.locator);
  });
});

describe("SecretAwareStringSchema", () => {
  it("rejects a redaction marked deployable", () => {
    expect(
      SecretAwareStringSchema.safeParse({
        kind: "redacted",
        digest: `sha256:${"b".repeat(64)}`,
        deployable: true,
      }).success,
    ).toBe(false);
  });
});
