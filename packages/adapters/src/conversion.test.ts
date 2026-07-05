import { createHash } from "node:crypto";

import {
  AssetSchema,
  ConvertedOutputSchema,
  type ConvertedOutput,
  type NormalizedResource,
} from "@ai-config-hub/core";
import { AbsolutePathSchema, ContentHashSchema, type ContentHash } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { claudeCodeRegistration } from "./claude-code.js";
import { codexRegistration } from "./codex.js";
import { cursorRegistration } from "./cursor.js";
import { parseFrontmatter } from "./frontmatter.js";
import { opencodeRegistration } from "./opencode.js";
import { packageContentHash, sourceFile } from "./source-files.js";
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
  const canonicalSourcePath = AbsolutePathSchema.parse(`/project/${resource.kind}.config`);
  const sourceHash = hash(`${resource.kind}:source`);
  return AssetSchema.parse({
    assetId: `asset-${resource.kind}`,
    toolId: "claude-code",
    resource:
      extensions === undefined ? resource : { ...resource, data: { ...resource.data, extensions } },
    scopeId: "scope-project",
    canonicalSourcePath,
    locator: `${resource.kind}:fixture`,
    sourceFormat: "fixture",
    contentHash: sourceHash,
    sourceFiles: [
      sourceFile({
        path: canonicalSourcePath,
        relativePath: `${resource.kind}.config`,
        role: "primary",
        mediaType: "text/plain",
        isText: true,
        contentHash: sourceHash,
      }),
    ],
    nativeIdentity: {
      nativeId: `${resource.kind}:fixture`,
      displayName: `${resource.kind} fixture`,
    },
    normalizedSchemaVersion: "1.0.0",
    adapterId: "fixture-adapter",
    adapterVersion: "1.0.0",
    discoveredAt: "2026-06-21T08:00:00.000Z",
    references: [],
    diagnosticSummary: { info: 0, warning: 0, error: 0 },
  });
}

function generatedOutput(
  output: ConvertedOutput | undefined,
): Extract<ConvertedOutput, { readonly deploymentType: "generated_file" }> {
  if (output?.deploymentType !== "generated_file") throw new Error("expected generated output");
  return output;
}

function skillPackageAsset(input: {
  readonly name?: string;
  readonly description?: string;
  readonly binarySupport?: boolean;
}) {
  const root = "/project/.agents/skills/release";
  const primary = sourceFile({
    path: AbsolutePathSchema.parse(`${root}/SKILL.md`),
    relativePath: "SKILL.md",
    role: "primary",
    mediaType: "text/markdown",
    isText: true,
    contentHash: hash("Run release checks.\n"),
  });
  const support = sourceFile({
    path: AbsolutePathSchema.parse(`${root}/references/checklist.md`),
    relativePath: "references/checklist.md",
    role: "support",
    mediaType: "text/markdown",
    isText: true,
    contentHash: hash("Checklist.\n"),
  });
  const binary = sourceFile({
    path: AbsolutePathSchema.parse(`${root}/assets/logo.png`),
    relativePath: "assets/logo.png",
    role: "support",
    mediaType: "image/png",
    isText: false,
    contentHash: hash("png bytes"),
  });
  const files = input.binarySupport === true ? [primary, support, binary] : [primary, support];
  const name = input.name ?? "Release Guide";
  return AssetSchema.parse({
    assetId: "asset-skill-package",
    toolId: "codex",
    resource: {
      kind: "skill",
      data: {
        name,
        ...(input.description === undefined ? {} : { description: input.description }),
        instructions: "Run release checks.",
        references: ["references/checklist.md"],
        extensions: {},
      },
    },
    scopeId: "scope-project",
    canonicalSourcePath: primary.path,
    locator: `skill:${name}`,
    sourceFormat: "skill-package",
    contentHash: packageContentHash(files),
    sourceFiles: files,
    nativeIdentity: {
      nativeId: `skill:${name}`,
      displayName: name,
      directoryName: "release",
      invocationName: name,
    },
    normalizedSchemaVersion: "1.0.0",
    adapterId: "builtin-codex",
    adapterVersion: "0.1.0",
    discoveredAt: "2026-06-21T08:00:00.000Z",
    references: ["references/checklist.md"],
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
        expect(result.level, `${registration.toolId}/${resource.kind}`).not.toBe("unsupported");
        if (result.level === "unsupported") continue;
        expect(result.outputs).toHaveLength(1);
        expect(ConvertedOutputSchema.safeParse(result.outputs[0]).success).toBe(true);
        expect(result.outputs[0]?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        const rendered = generatedOutput(result.outputs[0]);
        if (rendered.mediaType === "application/json")
          expect(() => parseJsoncObject(rendered.text)).not.toThrow();
        if (rendered.mediaType === "application/toml")
          expect(() => parseTomlObject(rendered.text)).not.toThrow();
        if (rendered.text.startsWith("---\n"))
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
      droppedFields: ["/data/extensions/vendorFlag"],
      warnings: [expect.any(String)],
    });
  });

  it("reports all retained fields when a partial conversion drops extensions", async () => {
    const adapter = cursorRegistration.create({ logger: { debug() {}, warn() {} } });
    const result = await adapter.convert({
      asset: asset(resources[1], { vendorFlag: true }),
      target: { toolId: "cursor", resourceKind: "agent", targetSchemaVersion: "1.0.0" },
      signal: neverCancelled,
    });

    expect(result).toMatchObject({
      level: "partial",
      retainedFields: ["/data/name", "/data/instructions", "/data/model", "/data/allowedTools"],
      droppedFields: ["/data/extensions/vendorFlag"],
      transformedFields: [],
      warnings: [expect.any(String)],
    });
  });

  it("renders Codex agent descriptions and falls back partially when missing", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const withDescription = await adapter.convert({
      asset: asset({
        kind: "agent",
        data: {
          name: "reviewer",
          description: "Reviews risky changes",
          instructions: "Review carefully.",
          allowedTools: [],
          extensions: {},
        },
      }),
      target: { toolId: "codex", resourceKind: "agent", targetSchemaVersion: "1.0.0" },
      signal: neverCancelled,
    });
    if (withDescription.level === "unsupported") throw new Error("unexpected unsupported");
    expect(generatedOutput(withDescription.outputs[0]).text).toContain(
      'description = "Reviews risky changes"',
    );

    const withoutDescription = await adapter.convert({
      asset: asset(resources[1]),
      target: { toolId: "codex", resourceKind: "agent", targetSchemaVersion: "1.0.0" },
      signal: neverCancelled,
    });
    expect(withoutDescription).toMatchObject({
      level: "partial",
      droppedFields: expect.arrayContaining(["/data/description"]) as unknown,
      warnings: expect.arrayContaining([expect.stringContaining("description")]) as unknown,
    });
    if (withoutDescription.level === "unsupported") throw new Error("unexpected unsupported");
    expect(generatedOutput(withoutDescription.outputs[0]).text).toContain(
      'description = "Imported reviewer agent"',
    );
  });

  it("reports Codex agent tool restrictions as partial because they are not expressible", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const result = await adapter.convert({
      asset: asset(resources[1]),
      target: { toolId: "codex", resourceKind: "agent", targetSchemaVersion: "1.0.0" },
      signal: neverCancelled,
    });

    expect(result).toMatchObject({
      level: "partial",
      retainedFields: ["/data/name", "/data/instructions", "/data/model"],
      droppedFields: ["/data/allowedTools", "/data/description"],
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

  it("converts Skill packages to generated SKILL.md plus copy outputs for text support files", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });
    const source = skillPackageAsset({ description: "Release safely" });

    const result = await adapter.convert({
      asset: source,
      target: { toolId: "codex", resourceKind: "skill", targetSchemaVersion: "1.0.0" },
      signal: neverCancelled,
    });

    expect(result.level).toBe("full");
    if (result.level === "unsupported") throw new Error("unexpected unsupported conversion");
    expect(result.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deploymentType: "generated_file",
          relativePath: ".agents/skills/release/SKILL.md",
          mediaType: "text/markdown",
        }),
        expect.objectContaining({
          deploymentType: "copy",
          relativePath: ".agents/skills/release/references/checklist.md",
          sourcePath: "/project/.agents/skills/release/references/checklist.md",
          sourceHash: hash("Checklist.\n"),
          contentHash: hash("Checklist.\n"),
        }),
      ]),
    );
    const support = result.outputs.find((output) => output.deploymentType === "copy");
    expect(support).not.toHaveProperty("text");
  });

  it("copies binary Skill package files as part of full package conversion", async () => {
    const adapter = codexRegistration.create({ logger: { debug() {}, warn() {} } });

    const result = await adapter.convert({
      asset: skillPackageAsset({ description: "Release safely", binarySupport: true }),
      target: { toolId: "codex", resourceKind: "skill", targetSchemaVersion: "1.0.0" },
      signal: neverCancelled,
    });

    expect(result.level).toBe("full");
    if (result.level === "unsupported") throw new Error("unexpected unsupported conversion");
    expect(result.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deploymentType: "copy",
          relativePath: ".agents/skills/release/assets/logo.png",
          mediaType: "image/png",
          sourcePath: "/project/.agents/skills/release/assets/logo.png",
          sourceHash: hash("png bytes"),
          contentHash: hash("png bytes"),
        }),
      ]),
    );
  });

  it("uses target Skill naming rules for Cursor and OpenCode frontmatter and directories", async () => {
    for (const registration of [cursorRegistration, opencodeRegistration] as const) {
      const adapter = registration.create({ logger: { debug() {}, warn() {} } });
      const result = await adapter.convert({
        asset: skillPackageAsset({ name: "Release Guide", description: "Release safely" }),
        target: {
          toolId: registration.toolId,
          resourceKind: "skill",
          targetSchemaVersion: "1.0.0",
        },
        signal: neverCancelled,
      });

      expect(result.level).toBe("partial");
      if (result.level === "unsupported") throw new Error("unexpected unsupported conversion");
      const generated = result.outputs.find((output) => output.deploymentType === "generated_file");
      expect(generated?.relativePath).toBe(
        registration.toolId === "cursor"
          ? ".cursor/skills/release-guide/SKILL.md"
          : ".opencode/skills/release-guide/SKILL.md",
      );
      expect(parseFrontmatter(generated?.text ?? "").attributes["name"]).toBe("release-guide");
      if (result.level === "partial") {
        expect(result.transformedFields).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourceField: "/data/name",
              targetField: "/frontmatter/name",
            }),
          ]),
        );
      }
    }
  });

  it("truncates OpenCode Skill target names to at most 64 lower-hyphen characters", async () => {
    const adapter = opencodeRegistration.create({ logger: { debug() {}, warn() {} } });
    const result = await adapter.convert({
      asset: skillPackageAsset({
        name: "Release Guide With A Very Long Name That Must Fit OpenCode Skill Routing Limits",
        description: "Release safely",
      }),
      target: { toolId: "opencode", resourceKind: "skill", targetSchemaVersion: "1.0.0" },
      signal: neverCancelled,
    });

    expect(result.level).toBe("partial");
    if (result.level === "unsupported") throw new Error("unexpected unsupported conversion");
    const generated = result.outputs.find((output) => output.deploymentType === "generated_file");
    const frontmatterName = parseFrontmatter(generated?.text ?? "").attributes["name"];
    expect(typeof frontmatterName).toBe("string");
    expect((frontmatterName as string).length).toBeLessThanOrEqual(64);
    expect(generated?.relativePath).toBe(`.opencode/skills/${String(frontmatterName)}/SKILL.md`);
  });

  it("uses a deterministic fallback description when target Skill descriptions are required", async () => {
    const adapter = cursorRegistration.create({ logger: { debug() {}, warn() {} } });

    const result = await adapter.convert({
      asset: skillPackageAsset({ name: "release" }),
      target: { toolId: "cursor", resourceKind: "skill", targetSchemaVersion: "1.0.0" },
      signal: neverCancelled,
    });

    expect(result.level).toBe("partial");
    if (result.level === "unsupported") throw new Error("unexpected unsupported conversion");
    const generated = result.outputs.find((output) => output.deploymentType === "generated_file");
    expect(parseFrontmatter(generated?.text ?? "").attributes["description"]).toBe(
      "Imported release skill",
    );
    if (result.level === "partial") {
      expect(result.warnings.join("\n")).toContain("description");
    }
  });
});

function hash(text: string): ContentHash {
  return ContentHashSchema.parse(
    `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
  );
}
