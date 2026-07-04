import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AssetSchema,
  ScopeSchema,
  type Asset,
  type AssetDisablementRecord,
  type DerivedIndexIncrementalReplacement,
  type DerivedIndexReplacement,
  type Diagnostic,
  type EffectiveConfig,
  type IndexRepository,
  type Page,
  type Scope,
} from "@ai-config-hub/core";
import {
  AbsolutePathSchema,
  AssetIdSchema,
  ContentHashSchema,
  IsoDateTimeSchema,
  ScopeIdSchema,
  ToolInstallationIdSchema,
  type AssetId,
  type ContentHash,
  type PaginationCursor,
} from "@ai-config-hub/shared";
import { afterEach, describe, expect, it } from "vitest";

import { AssetDisablementService } from "./asset-disablement-service.js";

const temporaryDirectories: string[] = [];
const NOW = IsoDateTimeSchema.parse("2026-07-04T08:00:00.000Z");
const HASH = ContentHashSchema.parse(`sha256:${"a".repeat(64)}`);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class MemoryIndexRepository implements IndexRepository {
  readonly disablements = new Map<string, AssetDisablementRecord>();
  readonly statuses = new Map<string, Asset["status"]>();
  failSave = false;
  beforeFailSave: (() => Promise<void>) | undefined;

  constructor(
    private asset: Asset,
    private readonly scope: Scope,
  ) {}

  setAsset(asset: Asset): void {
    this.asset = asset;
  }

  replaceDerivedIndex(
    _replacement: DerivedIndexReplacement,
  ): Promise<{ readonly revision: string }> {
    return Promise.resolve({ revision: "1" });
  }

  mergeIncrementalIndex(
    _replacement: DerivedIndexIncrementalReplacement,
  ): Promise<{ readonly revision: string }> {
    return Promise.resolve({ revision: "1" });
  }

  listAssets(): Promise<Page<Asset>> {
    return Promise.resolve({
      items: [this.withStatus(this.asset)],
      snapshotRevision: "1",
    });
  }

  getAsset(assetId: AssetId): Promise<Asset | undefined> {
    return Promise.resolve(
      assetId === this.asset.assetId ? this.withStatus(this.asset) : undefined,
    );
  }

  getAssetStatuses(assetIds: readonly AssetId[]): Promise<ReadonlyMap<AssetId, Asset["status"]>> {
    return Promise.resolve(
      new Map(assetIds.map((assetId) => [assetId, this.statuses.get(assetId) ?? "enabled"])),
    );
  }

  setAssetStatus(
    assetId: AssetId,
    status: Asset["status"],
  ): Promise<{
    readonly assetId: AssetId;
    readonly status: Asset["status"];
    readonly revision: string;
  }> {
    this.statuses.set(assetId, status);
    return Promise.resolve({ assetId, status, revision: "2" });
  }

  getAssetDisablement(assetId: AssetId): Promise<AssetDisablementRecord | undefined> {
    return Promise.resolve(this.disablements.get(assetId));
  }

  saveAssetDisablement(record: AssetDisablementRecord): Promise<void> {
    if (this.failSave) {
      return Promise.resolve(this.beforeFailSave?.()).then(() => {
        throw new Error("save failed");
      });
    }
    this.disablements.set(record.assetId, record);
    return Promise.resolve();
  }

  clearAssetDisablement(assetId: AssetId): Promise<void> {
    this.disablements.delete(assetId);
    return Promise.resolve();
  }

  getEffectiveConfig(
    _id: EffectiveConfig["effectiveConfigId"],
  ): Promise<EffectiveConfig | undefined> {
    return Promise.resolve(undefined);
  }

  listScopes(): Promise<readonly Scope[]> {
    return Promise.resolve([this.scope]);
  }

  listDiagnostics(_query: {
    readonly assetId?: AssetId;
    readonly severity?: readonly Diagnostic["severity"][];
    readonly cursor?: PaginationCursor;
    readonly limit: number;
  }): Promise<Page<Diagnostic>> {
    return Promise.resolve({ items: [], snapshotRevision: "1" });
  }

  getDiagnostic(_id: Diagnostic["diagnosticId"]): Promise<Diagnostic | undefined> {
    return Promise.resolve(undefined);
  }

  private withStatus(asset: Asset): Asset {
    return AssetSchema.parse({
      ...asset,
      status: this.statuses.get(asset.assetId) ?? asset.status,
    });
  }
}

function scope(toolId: Asset["toolId"]): Scope {
  return ScopeSchema.parse({
    scopeId: ScopeIdSchema.parse(`scope:${toolId}`),
    toolId,
    scopeKind: "project",
    canonicalRootPath: AbsolutePathSchema.parse("/project"),
    depth: 0,
    precedence: 100,
    discoveryEvidence: {
      installationId: ToolInstallationIdSchema.parse(`${toolId}:/project`),
    },
  });
}

function asset(input: {
  readonly id: string;
  readonly toolId: Asset["toolId"];
  readonly sourcePath: string;
  readonly locator: string;
  readonly sourceFormat: string;
  readonly resource: Asset["resource"];
  readonly scope: Scope;
  readonly contentHash?: ContentHash;
}): Asset {
  return AssetSchema.parse({
    assetId: AssetIdSchema.parse(input.id),
    toolId: input.toolId,
    resource: input.resource,
    scopeId: input.scope.scopeId,
    canonicalSourcePath: AbsolutePathSchema.parse(input.sourcePath),
    locator: input.locator,
    sourceFormat: input.sourceFormat,
    contentHash: input.contentHash ?? HASH,
    normalizedSchemaVersion: "1.0.0",
    adapterId: `builtin-${input.toolId}`,
    adapterVersion: "0.1.0",
    discoveredAt: NOW,
    references: [],
    diagnosticSummary: { info: 0, warning: 0, error: 0 },
  });
}

async function serviceFor(
  indexRepository: IndexRepository,
  root: string,
): Promise<AssetDisablementService> {
  const disabledAssetsRoot = AbsolutePathSchema.parse(join(root, "disabled-assets"));
  return new AssetDisablementService({
    indexRepository,
    disabledAssetsRoot,
    now: () => NOW,
  });
}

describe("AssetDisablementService", () => {
  it("sets and restores OpenCode native disable fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-disable-native-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "opencode.json");
    const originalText = JSON.stringify(
      { agent: { reviewer: { prompt: "Review code.", disable: false } } },
      null,
      2,
    );
    await writeFile(configPath, `${originalText}\n`, "utf8");
    const assetScope = scope("opencode");
    const index = new MemoryIndexRepository(
      asset({
        id: "asset-opencode-agent",
        toolId: "opencode",
        sourcePath: configPath,
        locator: "agent:reviewer",
        sourceFormat: "jsonc",
        scope: assetScope,
        resource: {
          kind: "agent",
          data: {
            name: "reviewer",
            instructions: "Review code.",
            allowedTools: [],
            extensions: {},
          },
        },
      }),
      assetScope,
    );
    const service = await serviceFor(index, root);

    await service.disable({
      assetId: AssetIdSchema.parse("asset-opencode-agent"),
      method: "native",
    });
    expect(JSON.parse(await readFile(configPath, "utf8")).agent.reviewer.disable).toBe(true);
    expect(index.disablements.get("asset-opencode-agent")?.restore.originalText).toBeUndefined();
    expect(index.disablements.get("asset-opencode-agent")?.restore.nativeField).toBe("disable");

    await service.enable({ assetId: AssetIdSchema.parse("asset-opencode-agent") });
    expect(await readFile(configPath, "utf8")).toBe(`${originalText}\n`);
  });

  it("removes and restores structured MCP config entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-disable-config-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "mcp.json");
    const originalText = JSON.stringify(
      {
        mcpServers: {
          docs: { command: "node", args: ["server.js"] },
          search: { url: "https://example.test/mcp" },
        },
      },
      null,
      2,
    );
    await writeFile(configPath, `${originalText}\n`, "utf8");
    const assetScope = scope("cursor");
    const index = new MemoryIndexRepository(
      asset({
        id: "asset-cursor-mcp",
        toolId: "cursor",
        sourcePath: configPath,
        locator: "mcp:docs",
        sourceFormat: "jsonc",
        scope: assetScope,
        resource: {
          kind: "mcp",
          data: {
            name: "docs",
            transport: {
              kind: "stdio",
              command: "node",
              args: [{ kind: "literal", value: "server.js", deployable: true }],
              env: {},
            },
            extensions: {},
          },
        },
      }),
      assetScope,
    );
    const service = await serviceFor(index, root);

    await service.disable({
      assetId: AssetIdSchema.parse("asset-cursor-mcp"),
      method: "remove_config_entry",
    });
    const disabled = JSON.parse(await readFile(configPath, "utf8"));
    expect(disabled.mcpServers.docs).toBeUndefined();
    expect(disabled.mcpServers.search).toBeDefined();
    expect(index.disablements.get("asset-cursor-mcp")?.restore.originalText).toBeUndefined();
    expect(index.disablements.get("asset-cursor-mcp")?.restore.originalEntry).toEqual({
      command: "node",
      args: ["server.js"],
    });

    await service.enable({ assetId: AssetIdSchema.parse("asset-cursor-mcp") });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(JSON.parse(originalText));
  });

  it("enables OpenCode native-disabled assets even when Hub has no disablement record", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-enable-native-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify(
        { mcp: { docs: { command: ["node", "server.js"], enabled: false } } },
        null,
        2,
      ),
      "utf8",
    );
    const assetScope = scope("opencode");
    const index = new MemoryIndexRepository(
      AssetSchema.parse({
        ...asset({
          id: "asset-opencode-mcp",
          toolId: "opencode",
          sourcePath: configPath,
          locator: "mcp:docs",
          sourceFormat: "jsonc",
          scope: assetScope,
          resource: {
            kind: "mcp",
            data: {
              name: "docs",
              transport: { kind: "stdio", command: "node", args: [], env: {} },
              extensions: {},
            },
          },
        }),
        status: "disabled",
      }),
      assetScope,
    );
    const service = await serviceFor(index, root);

    await service.enable({ assetId: AssetIdSchema.parse("asset-opencode-mcp") });

    expect(JSON.parse(await readFile(configPath, "utf8")).mcp.docs.enabled).toBe(true);
    expect(index.statuses.get("asset-opencode-mcp")).toBe("enabled");
  });

  it("rejects file movement and config-entry removal for OpenCode config agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-reject-config-agent-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify({ agent: { reviewer: { prompt: "Review." } } }),
      "utf8",
    );
    const assetScope = scope("opencode");
    const index = new MemoryIndexRepository(
      asset({
        id: "asset-opencode-agent",
        toolId: "opencode",
        sourcePath: configPath,
        locator: "agent:reviewer",
        sourceFormat: "jsonc",
        scope: assetScope,
        resource: {
          kind: "agent",
          data: {
            name: "reviewer",
            instructions: "Review.",
            allowedTools: [],
            extensions: {},
          },
        },
      }),
      assetScope,
    );
    const service = await serviceFor(index, root);

    await expect(
      service.disable({
        assetId: AssetIdSchema.parse("asset-opencode-agent"),
        method: "move_file",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      service.disable({
        assetId: AssetIdSchema.parse("asset-opencode-agent"),
        method: "remove_config_entry",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("does not overwrite a new file at the original path when restoring a moved asset", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-restore-conflict-"));
    temporaryDirectories.push(root);
    const sourcePath = join(root, "AGENTS.md");
    await writeFile(sourcePath, "Original instructions.\n", "utf8");
    const assetScope = scope("codex");
    const index = new MemoryIndexRepository(
      asset({
        id: "asset-codex-rule",
        toolId: "codex",
        sourcePath,
        locator: "rule:AGENTS",
        sourceFormat: "markdown",
        scope: assetScope,
        resource: {
          kind: "rule",
          data: {
            name: "AGENTS",
            instructions: "Original instructions.",
            globs: [],
            extensions: {},
          },
        },
      }),
      assetScope,
    );
    const service = await serviceFor(index, root);

    await service.disable({
      assetId: AssetIdSchema.parse("asset-codex-rule"),
      method: "move_file",
    });
    await writeFile(sourcePath, "New user file.\n", "utf8");

    await expect(
      service.enable({ assetId: AssetIdSchema.parse("asset-codex-rule") }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await readFile(sourcePath, "utf8")).toBe("New user file.\n");
    expect(index.disablements.has("asset-codex-rule")).toBe(true);
    expect(index.statuses.get("asset-codex-rule")).toBe("disabled");
  });

  it("rejects JSON config-entry removal when the scanned entry is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-stale-config-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { search: { command: "node" } } }),
      "utf8",
    );
    const assetScope = scope("cursor");
    const index = new MemoryIndexRepository(
      asset({
        id: "asset-stale-mcp",
        toolId: "cursor",
        sourcePath: configPath,
        locator: "mcp:docs",
        sourceFormat: "jsonc",
        scope: assetScope,
        resource: {
          kind: "mcp",
          data: {
            name: "docs",
            transport: { kind: "stdio", command: "node", args: [], env: {} },
            extensions: {},
          },
        },
      }),
      assetScope,
    );
    const service = await serviceFor(index, root);

    await expect(
      service.disable({
        assetId: AssetIdSchema.parse("asset-stale-mcp"),
        method: "remove_config_entry",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { docs: { command: "python" } } }),
      "utf8",
    );
    await expect(
      service.disable({
        assetId: AssetIdSchema.parse("asset-stale-mcp"),
        method: "remove_config_entry",
      }),
    ).rejects.toMatchObject({ code: "STALE_INDEX" });

    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { docs: { command: "node", args: ["changed.js"] } } }),
      "utf8",
    );
    await expect(
      service.disable({
        assetId: AssetIdSchema.parse("asset-stale-mcp"),
        method: "remove_config_entry",
      }),
    ).rejects.toMatchObject({ code: "STALE_INDEX" });

    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { docs: { command: "node", env: { TOKEN: "value" } } } }),
      "utf8",
    );
    await expect(
      service.disable({
        assetId: AssetIdSchema.parse("asset-stale-mcp"),
        method: "remove_config_entry",
      }),
    ).rejects.toMatchObject({ code: "STALE_INDEX" });
  });

  it("restores the source file when persistence fails after moving a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-disable-compensate-"));
    temporaryDirectories.push(root);
    const sourcePath = join(root, "AGENTS.md");
    await writeFile(sourcePath, "Original instructions.\n", "utf8");
    const assetScope = scope("codex");
    const index = new MemoryIndexRepository(
      asset({
        id: "asset-codex-rule",
        toolId: "codex",
        sourcePath,
        locator: "rule:AGENTS",
        sourceFormat: "markdown",
        scope: assetScope,
        resource: {
          kind: "rule",
          data: {
            name: "AGENTS",
            instructions: "Original instructions.",
            globs: [],
            extensions: {},
          },
        },
      }),
      assetScope,
    );
    index.failSave = true;
    const service = await serviceFor(index, root);

    await expect(
      service.disable({ assetId: AssetIdSchema.parse("asset-codex-rule"), method: "move_file" }),
    ).rejects.toThrow("save failed");
    expect(await readFile(sourcePath, "utf8")).toBe("Original instructions.\n");
    expect(index.disablements.size).toBe(0);
  });

  it("surfaces restore failures when compensating a failed disable", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-disable-compensate-conflict-"));
    temporaryDirectories.push(root);
    const sourcePath = join(root, "AGENTS.md");
    await writeFile(sourcePath, "Original instructions.\n", "utf8");
    const assetScope = scope("codex");
    const index = new MemoryIndexRepository(
      asset({
        id: "asset-codex-rule",
        toolId: "codex",
        sourcePath,
        locator: "rule:AGENTS",
        sourceFormat: "markdown",
        scope: assetScope,
        resource: {
          kind: "rule",
          data: {
            name: "AGENTS",
            instructions: "Original instructions.",
            globs: [],
            extensions: {},
          },
        },
      }),
      assetScope,
    );
    index.failSave = true;
    index.beforeFailSave = async () => {
      await writeFile(sourcePath, "Competing file.\n", "utf8");
    };
    const service = await serviceFor(index, root);

    await expect(
      service.disable({ assetId: AssetIdSchema.parse("asset-codex-rule"), method: "move_file" }),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      safeContext: {
        restoreError:
          "AppError: Cannot restore disabled asset because a file already exists at the original path",
        saveError: "Error: save failed",
      },
    });
    expect(await readFile(sourcePath, "utf8")).toBe("Competing file.\n");
    expect(index.statuses.get("asset-codex-rule")).toBe("disabled");
  });
});
