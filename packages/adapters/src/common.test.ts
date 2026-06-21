import type { AdapterRegistration, ToolAdapter } from "@ai-config-hub/core";
import {
  AdapterIdSchema,
  SemVerSchema,
  SemVerRangeSchema,
  type ToolId,
} from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { ConfigParseError, parseFrontmatter } from "./frontmatter.js";
import { createAdapterRegistry, createDefaultAdapterRegistry } from "./registry.js";
import { redactStructuredValue, toSecretAwareString } from "./secrets.js";
import { parseJsoncObject, parseTomlObject } from "./structured-config.js";

describe("bounded configuration parsers", () => {
  it("parses frontmatter, JSONC and TOML without evaluating content", () => {
    expect(
      parseFrontmatter("---\nname: reviewer\ntools: [Read]\n---\nReview carefully.\n"),
    ).toEqual({
      attributes: { name: "reviewer", tools: ["Read"] },
      body: "Review carefully.\n",
      bodyStartLine: 5,
    });
    expect(parseJsoncObject('{ /* comment */ "enabled": true, }')).toEqual({ enabled: true });
    expect(parseTomlObject('[mcp_servers.docs]\ncommand = "npx"\nargs = ["docs"]')).toEqual({
      mcp_servers: { docs: { command: "npx", args: ["docs"] } },
    });
  });

  it("returns a located parse error and rejects unbounded structures", () => {
    expect(() => parseFrontmatter("---\nname: broken\n")).toThrowError(
      expect.objectContaining<Partial<ConfigParseError>>({ line: 1, column: 1 }),
    );
    expect(() => parseJsoncObject('{ "a": }')).toThrowError(ConfigParseError);
    expect(() => parseJsoncObject(`{"value":"${"x".repeat(4 * 1024 * 1024)}"}`)).toThrowError(
      ConfigParseError,
    );
  });
});

describe("secret redaction", () => {
  it("removes secret keys, URL credentials, sensitive query values and env values", () => {
    const canary = "top-secret-canary";
    const redacted = redactStructuredValue({
      authorization: `Bearer ${canary}`,
      endpoint: `https://user:${canary}@example.test/mcp?apiKey=${canary}`,
      env: { SAFE_NAME: canary },
      nested: { password: canary },
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("user:");
    expect(serialized).toContain("$redacted");
  });

  it("keeps safe literals deployable and environment references symbolic", () => {
    expect(toSecretAwareString("safe-value")).toEqual({
      kind: "literal",
      value: "safe-value",
      deployable: true,
    });
    expect(toSecretAwareString("${DOCS_TOKEN}", "token")).toEqual({
      kind: "reference",
      expression: "${DOCS_TOKEN}",
      deployable: true,
    });
    expect(toSecretAwareString("literal-secret", "apiKey")).toMatchObject({
      kind: "redacted",
      deployable: false,
    });
  });
});

function registration(toolId: ToolId, adapterId = `${toolId}-adapter`): AdapterRegistration {
  const capabilities = {
    supportedToolVersions: SemVerRangeSchema.parse(">=1.0.0"),
    testedToolVersions: [SemVerSchema.parse("1.0.0")],
    readableSchemaVersions: [SemVerRangeSchema.parse("^1.0.0")],
    writtenSchemaVersion: SemVerSchema.parse("1.0.0"),
    resourceKinds: ["rule"] as const,
    scopeKinds: ["project"] as const,
    supportsNestedScopes: false,
    conversions: [],
  } as const;
  return {
    contractVersion: 1,
    adapterId: AdapterIdSchema.parse(adapterId),
    adapterVersion: SemVerSchema.parse("0.1.0"),
    toolId,
    capabilities,
    create: () =>
      ({
        adapterId: AdapterIdSchema.parse(adapterId),
        adapterVersion: SemVerSchema.parse("0.1.0"),
        toolId,
        capabilities,
      }) as unknown as ToolAdapter,
  };
}

describe("static adapter registry", () => {
  it("registers exactly the four built-in adapters without filesystem discovery", () => {
    expect(createDefaultAdapterRegistry().toolIds).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "opencode",
    ]);
  });

  it("indexes explicitly supplied registrations and creates identity-checked adapters", () => {
    const registry = createAdapterRegistry([registration("codex"), registration("cursor")]);
    expect(registry.toolIds).toEqual(["codex", "cursor"]);
    expect(registry.create("codex", { debug() {}, warn() {} }).toolId).toBe("codex");
  });

  it("rejects duplicate tools, duplicate adapter IDs and dishonest factories", () => {
    expect(() => createAdapterRegistry([registration("codex"), registration("codex")])).toThrow(
      "Duplicate tool registration",
    );
    expect(() =>
      createAdapterRegistry([
        registration("codex", "shared-adapter"),
        registration("cursor", "shared-adapter"),
      ]),
    ).toThrow("Duplicate adapter registration");

    const dishonest = registration("codex");
    const registry = createAdapterRegistry([
      {
        ...dishonest,
        create: () => ({
          ...dishonest.create({ logger: { debug() {}, warn() {} } }),
          toolId: "cursor",
        }),
      },
    ]);
    expect(() => registry.create("codex", { debug() {}, warn() {} })).toThrow(
      "Adapter factory identity mismatch",
    );
  });
});
