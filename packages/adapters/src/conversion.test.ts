import { AssetSchema, ConvertedOutputSchema, type NormalizedResource } from "@ai-config-hub/core";
import { ContentHashSchema } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { claudeCodeRegistration } from "./claude-code.js";
import { codexRegistration } from "./codex.js";
import { cursorRegistration } from "./cursor.js";
import { parseFrontmatter } from "./frontmatter.js";
import { opencodeRegistration } from "./opencode.js";
import { parseJsoncObject, parseTomlObject } from "./structured-config.js";
import { neverCancelled } from "./test-support.js";

const resources = [
  {
    kind: "rule",
    data: {
      name: "strict-typescript",
      instructions: "Use strict TypeScript.",
      globs: [],
      extensions: {},
    },
  },
  {
    kind: "agent",
    data: {
      name: "reviewer",
      instructions: "Review carefully.",
      model: "gpt-5",
      allowedTools: ["Read", "Grep"],
      extensions: {},
    },
  },
  {
    kind: "skill",
    data: {
      name: "release",
      description: "Release safely",
      instructions: "Run checks.",
      references: ["checklist.md"],
      extensions: {},
    },
  },
  {
    kind: "mcp",
    data: {
      name: "docs",
      transport: {
        kind: "stdio",
        command: "npx",
        args: [{ kind: "literal", value: "docs", deployable: true }],
        env: { DOCS_TOKEN: { kind: "reference", expression: "$DOCS_TOKEN", deployable: true } },
      },
      extensions: {},
    },
  },
] as const;

function asset(resource: NormalizedResource, extensions?: Record<string, unknown>) {
  return AssetSchema.parse({
    assetId: `asset-${resource.kind}`,
    toolId: "claude-code",
    resource:
      extensions === undefined ? resource : { ...resource, data: { ...resource.data, extensions } },
    scopeId: "scope-project",
    canonicalSourcePath: `/project/${resource.kind}.config`,
    locator: `${resource.kind}:fixture`,
    sourceFormat: "fixture",
    contentHash: `sha256:${"a".repeat(64)}`,
    normalizedSchemaVersion: "1.0.0",
    adapterId: "fixture-adapter",
    adapterVersion: "1.0.0",
    discoveredAt: "2026-06-21T08:00:00.000Z",
    references: [],
    diagnosticSummary: { info: 0, warning: 0, error: 0 },
  });
}

const registrations = [
  claudeCodeRegistration,
  cursorRegistration,
  codexRegistration,
  opencodeRegistration,
];

describe("built-in conversion matrix", () => {
  it("renders every normalized resource kind for every target tool", async () => {
    for (const registration of registrations) {
      const adapter = registration.create({ logger: { debug() {}, warn() {} } });
      expect(
        adapter.capabilities.conversions.map(({ resourceKind }) => resourceKind).sort(),
      ).toEqual(["agent", "mcp", "rule", "skill"]);
      for (const resource of resources) {
        const result = await adapter.convert({
          asset: asset(resource),
          target: {
            toolId: registration.toolId,
            resourceKind: resource.kind,
            targetSchemaVersion: "1.0.0",
          },
          signal: neverCancelled,
        });
        expect(result.level, `${registration.toolId}/${resource.kind}`).toBe("full");
        if (result.level !== "full") continue;
        expect(result.outputs).toHaveLength(1);
        expect(ConvertedOutputSchema.safeParse(result.outputs[0]).success).toBe(true);
        expect(result.outputs[0]?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        const rendered = result.outputs[0];
        if (rendered?.mediaType === "application/json")
          expect(() => parseJsoncObject(rendered.text)).not.toThrow();
        if (rendered?.mediaType === "application/toml")
          expect(() => parseTomlObject(rendered.text)).not.toThrow();
        if (rendered?.text.startsWith("---\n"))
          expect(() => parseFrontmatter(rendered.text)).not.toThrow();
      }
    }
  });

  it("reports unknown extensions as partial rather than claiming lossless conversion", async () => {
    const adapter = cursorRegistration.create({ logger: { debug() {}, warn() {} } });
    const result = await adapter.convert({
      asset: asset(resources[0], { vendorFlag: true }),
      target: { toolId: "cursor", resourceKind: "rule", targetSchemaVersion: "1.0.0" },
      signal: neverCancelled,
    });
    expect(result).toMatchObject({
      level: "partial",
      droppedFields: ["/data/extensions"],
      warnings: [expect.any(String)],
    });
  });

  it("blocks non-deployable MCP secrets and emits no output", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const secretResource = {
      kind: "mcp" as const,
      data: {
        name: "secret-docs",
        transport: {
          kind: "stdio" as const,
          command: "npx",
          args: [
            {
              kind: "redacted" as const,
              digest: ContentHashSchema.parse(`sha256:${"f".repeat(64)}`),
              deployable: false as const,
            },
          ],
          env: {},
        },
        extensions: {},
      },
    };
    const result = await adapter.convert({
      asset: asset(secretResource),
      target: { toolId: "codex", resourceKind: "mcp", targetSchemaVersion: "1.0.0" },
      signal: neverCancelled,
    });
    expect(result).toMatchObject({ level: "unsupported", reasons: [expect.any(String)] });
    expect("outputs" in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain("top-secret-canary");
  });

  it("rejects mismatched target resource kinds", async () => {
    const adapter = opencodeRegistration.create({ logger: { debug() {}, warn() {} } });
    const result = await adapter.convert({
      asset: asset(resources[0]),
      target: {
        toolId: "opencode",
        resourceKind: "agent",
        targetSchemaVersion: "1.0.0",
      },
      signal: neverCancelled,
    });
    expect(result.level).toBe("unsupported");
  });
});
