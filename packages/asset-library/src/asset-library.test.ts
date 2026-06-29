import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssetSchema, type NormalizedResource } from "@ai-config-hub/core";
import { ContentHashSchema, IsoDateTimeSchema, type ContentHash } from "@ai-config-hub/shared";
import { describe, expect, it } from "vitest";

import { AssetLibraryService, PresetDefinitionSchema, type PresetDefinition } from "./index.js";

const NOW = IsoDateTimeSchema.parse("2026-06-29T04:00:00.000Z");

async function tempLibraryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "asset-library-"));
}

function hash(text: string): ContentHash {
  return ContentHashSchema.parse(`sha256:${createHash("sha256").update(text).digest("hex")}`);
}

function asset(
  id: string,
  resource: NormalizedResource = {
    kind: "rule",
    data: { name: id, instructions: `Instruction for ${id}.`, globs: [], extensions: {} },
  },
) {
  return AssetSchema.parse({
    assetId: id,
    toolId: "codex",
    resource,
    scopeId: "scope-user",
    canonicalSourcePath: `/source/${id}.md`,
    locator: `${resource.kind}:${id}`,
    sourceFormat: "markdown",
    contentHash: hash(`content:${id}`),
    normalizedSchemaVersion: "1.0.0",
    adapterId: "fixture-adapter",
    adapterVersion: "1.0.0",
    discoveredAt: NOW,
    references: [],
    diagnosticSummary: { info: 0, warning: 0, error: 0 },
  });
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("AssetLibraryService", () => {
  it("initializes the recommended personal library structure", async () => {
    const root = await tempLibraryRoot();
    const service = new AssetLibraryService({ root, now: () => NOW });

    await service.initialize();

    expect((await stat(join(root, "manifest.json"))).isFile()).toBe(true);
    for (const directory of ["rules", "agents", "skills", "mcp", "presets", "schemas"]) {
      expect((await stat(join(root, directory))).isDirectory()).toBe(true);
    }

    await expect(readJson(join(root, "manifest.json"))).resolves.toMatchObject({
      version: 1,
      assets: [],
      presets: [],
    });
  });

  it("imports, lists, and gets central assets with source tracking", async () => {
    const root = await tempLibraryRoot();
    const service = new AssetLibraryService({ root, now: () => NOW });
    const source = asset("repository-policy");

    await service.initialize();
    const imported = await service.importAsset(source, { logicalKey: "repository-policy" });

    expect(imported).toMatchObject({
      id: "rule:repository-policy",
      kind: "rule",
      logicalKey: "repository-policy",
      filePath: "rules/repository-policy.json",
      contentHash: source.contentHash,
      resource: source.resource,
      source: {
        assetId: source.assetId,
        toolId: source.toolId,
        sourcePath: source.canonicalSourcePath,
        importedAt: NOW,
      },
    });

    await expect(readJson(join(root, "rules", "repository-policy.json"))).resolves.toMatchObject({
      id: "rule:repository-policy",
      resource: source.resource,
    });

    await expect(service.listAssets()).resolves.toEqual([imported]);
    await expect(service.getAsset("rule:repository-policy")).resolves.toEqual(imported);
  });

  it("previews preset changes as create, update, delete, unchanged, and incompatible", async () => {
    const root = await tempLibraryRoot();
    const service = new AssetLibraryService({ root, now: () => NOW });
    await service.initialize();
    const createAsset = await service.importAsset(asset("new-rule"), { logicalKey: "new-rule" });
    const updateAsset = await service.importAsset(
      asset("team-skill", {
        kind: "skill",
        data: {
          name: "team-skill",
          instructions: "Use this skill.",
          references: [],
          extensions: {},
        },
      }),
      { logicalKey: "team-skill" },
    );
    const unchangedAsset = await service.importAsset(
      asset("search-mcp", {
        kind: "mcp",
        data: {
          name: "search-mcp",
          transport: { kind: "stdio", command: "search", args: [], env: {} },
          extensions: {},
        },
      }),
      { logicalKey: "search-mcp" },
    );
    const incompatibleAsset = await service.importAsset(
      asset("review-agent", {
        kind: "agent",
        data: {
          name: "review-agent",
          instructions: "Review code.",
          allowedTools: [],
          extensions: {},
        },
      }),
      { logicalKey: "review-agent" },
    );

    await service.createPreset({
      id: "engineering-base",
      name: "Engineering Base",
      assetIds: [createAsset.id, updateAsset.id, unchangedAsset.id, incompatibleAsset.id],
    });

    const preview = await service.previewPreset("engineering-base", {
      targetAssetHashes: {
        [updateAsset.id]: hash("old-skill"),
        [unchangedAsset.id]: unchangedAsset.contentHash,
        "rule:retired-rule": hash("retired"),
      },
      supportedResourceKinds: ["rule", "skill", "mcp"],
    });

    expect(preview.changes).toEqual([
      { action: "create", assetId: createAsset.id, sourceHash: createAsset.contentHash },
      {
        action: "update",
        assetId: updateAsset.id,
        sourceHash: updateAsset.contentHash,
        targetHash: hash("old-skill"),
      },
      {
        action: "unchanged",
        assetId: unchangedAsset.id,
        sourceHash: unchangedAsset.contentHash,
        targetHash: unchangedAsset.contentHash,
      },
      {
        action: "incompatible",
        assetId: incompatibleAsset.id,
        sourceHash: incompatibleAsset.contentHash,
        reason: "Resource kind agent is not supported by the target tool.",
      },
      { action: "delete", assetId: "rule:retired-rule", targetHash: hash("retired") },
    ]);
  });

  it("applies a preset by writing rollback and source-tracking application records", async () => {
    const root = await tempLibraryRoot();
    const service = new AssetLibraryService({ root, now: () => NOW });
    await service.initialize();
    const imported = await service.importAsset(asset("repository-policy"), {
      logicalKey: "repository-policy",
    });
    await service.createPreset({
      id: "engineering-base",
      name: "Engineering Base",
      assetIds: [imported.id],
    });

    const application = await service.applyPreset("engineering-base", {
      applicationId: "apply-001",
      targetAssetHashes: { [imported.id]: hash("previous-content") },
      supportedResourceKinds: ["rule"],
      deploymentRecordIds: { [imported.id]: "deployment-001" },
    });

    expect(application).toMatchObject({
      id: "apply-001",
      presetId: "engineering-base",
      appliedAt: NOW,
      sourceAssetHashes: { [imported.id]: imported.contentHash },
      rollback: {
        targetAssetHashes: { [imported.id]: hash("previous-content") },
        deploymentRecordIds: { [imported.id]: "deployment-001" },
      },
    });

    await expect(
      readJson(join(root, "presets", ".applications", "engineering-base", "apply-001.json")),
    ).resolves.toEqual(application);
  });

  it("rejects unsafe ids and path traversal attempts", async () => {
    const root = await tempLibraryRoot();
    const service = new AssetLibraryService({ root, now: () => NOW });
    await service.initialize();

    await expect(service.importAsset(asset("bad"), { logicalKey: "../outside" })).rejects.toThrow(
      /unsafe/i,
    );
    await expect(service.getAsset("../outside")).rejects.toThrow(/unsafe/i);
    await expect(
      service.createPreset({
        id: "../preset",
        name: "Bad Preset",
        assetIds: [],
      }),
    ).rejects.toThrow(/unsafe/i);
  });
});

describe("PresetDefinitionSchema", () => {
  it("validates preset definitions", () => {
    const preset: PresetDefinition = {
      id: "engineering-base",
      name: "Engineering Base",
      description: "Recommended project defaults.",
      assetIds: ["rule:repository-policy"],
    };

    expect(PresetDefinitionSchema.parse(preset)).toEqual(preset);
  });
});
