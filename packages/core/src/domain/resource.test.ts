import { describe, expect, it } from "vitest";

import { NormalizedResourceSchema } from "./resource.js";

describe("NormalizedResourceSchema", () => {
  it.each([
    {
      kind: "rule",
      data: { instructions: "Use strict TypeScript", globs: ["**/*.ts"], extensions: {} },
    },
    {
      kind: "agent",
      data: {
        name: "reviewer",
        instructions: "Review changes",
        allowedTools: ["read"],
        extensions: {},
      },
    },
    {
      kind: "skill",
      data: {
        name: "release",
        description: "Prepare a release",
        instructions: "Run the release checklist",
        references: ["checklist.md"],
        extensions: {},
      },
    },
  ])("parses the $kind resource variant", (resource) => {
    expect(NormalizedResourceSchema.safeParse(resource).success).toBe(true);
  });

  it.each(["http", "sse"] as const)("parses the MCP %s transport", (kind) => {
    expect(
      NormalizedResourceSchema.safeParse({
        kind: "mcp",
        data: {
          name: `${kind}-server`,
          transport: {
            kind,
            endpoint: {
              baseUrl: { kind: "literal", value: "https://example.invalid", deployable: true },
              query: {},
            },
            headers: {
              authorization: { kind: "reference", expression: "${TOKEN}", deployable: true },
            },
          },
          extensions: {},
        },
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown resource kind", () => {
    expect(NormalizedResourceSchema.safeParse({ kind: "hook", data: {} }).success).toBe(false);
  });
});
