import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    replacement: DerivedIndexReplacement,
  ): Promise<{ readonly revision: string }> {
    void replacement;
    return Promise.resolve({ revision: "1" });
  }

  mergeIncrementalIndex(
    replacement: DerivedIndexIncrementalReplacement,
  ): Promise<{ readonly revision: string }> {
    void replacement;
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
    id: EffectiveConfig["effectiveConfigId"],
  ): Promise<EffectiveConfig | undefined> {
    void id;
    return Promise.resolve(undefined);
  }

  listScopes(): Promise<readonly Scope[]> {
    return Promise.resolve([this.scope]);
  }

  listDiagnostics(query: {
    readonly assetId?: AssetId;
    readonly severity?: readonly Diagnostic["severity"][];
    readonly cursor?: PaginationCursor;
    readonly limit: number;
  }): Promise<Page<Diagnostic>> {
    void query;
    return Promise.resolve({ items: [], snapshotRevision: "1" });
  }

  getDiagnostic(id: Diagnostic["diagnosticId"]): Promise<Diagnostic | undefined> {
    void id;
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
  const sourcePath = AbsolutePathSchema.parse(input.sourcePath);
  const contentHash = input.contentHash ?? HASH;
  return AssetSchema.parse({
    assetId: AssetIdSchema.parse(input.id),
    toolId: input.toolId,
    resource: input.resource,
    scopeId: input.scope.scopeId,
    canonicalSourcePath: sourcePath,
    locator: input.locator,
    sourceFormat: input.sourceFormat,
    contentHash,
    sourceFiles: [
      {
        path: sourcePath,
        relativePath: input.sourcePath.split(/[\\/]/).at(-1) ?? "source",
        role: "primary",
        mediaType: input.sourceFormat === "json" ? "application/json" : "text/markdown",
        isText: true,
        contentHash,
      },
    ],
    nativeIdentity: {
      nativeId: input.locator,
      displayName: input.locator,
    },
    normalizedSchemaVersion: "1.0.0",
    adapterId: `builtin-${input.toolId}`,
    adapterVersion: "0.1.0",
    discoveredAt: NOW,
    references: [],
    diagnosticSummary: { info: 0, warning: 0, error: 0 },
  });
}

function skillPackageAsset(input: {
  readonly id: string;
  readonly toolId: Asset["toolId"];
  readonly skillRoot: string;
  readonly scope: Scope;
}): Asset {
  const primaryPath = AbsolutePathSchema.parse(join(input.skillRoot, "SKILL.md"));
  return AssetSchema.parse({
    ...asset({
      id: input.id,
      toolId: input.toolId,
      sourcePath: primaryPath,
      locator: "skill:release",
      sourceFormat: "skill-package",
      scope: input.scope,
      resource: {
        kind: "skill",
        data: {
          name: "release",
          description: "Release safely",
          instructions: "Run release checks.",
          references: [],
          extensions: {},
        },
      },
    }),
    contentHash: HASH,
    sourceFiles: [
      {
        path: primaryPath,
        relativePath: "SKILL.md",
        role: "primary",
        mediaType: "text/markdown",
        isText: true,
        contentHash: HASH,
      },
      {
        path: AbsolutePathSchema.parse(join(input.skillRoot, "references", "checklist.md")),
        relativePath: "references/checklist.md",
        role: "support",
        mediaType: "text/markdown",
        isText: true,
        contentHash: HASH,
      },
      {
        path: AbsolutePathSchema.parse(join(input.skillRoot, "scripts", "ship.js")),
        relativePath: "scripts/ship.js",
        role: "support",
        mediaType: "text/javascript",
        isText: true,
        contentHash: HASH,
      },
    ],
    nativeIdentity: {
      nativeId: "skill:.agents/skills/release",
      displayName: "release",
      directoryName: "release",
      invocationName: "release",
    },
  });
}

function serviceFor(indexRepository: IndexRepository, root: string): AssetDisablementService {
  const disabledAssetsRoot = AbsolutePathSchema.parse(join(root, "disabled-assets"));
  return new AssetDisablementService({
    indexRepository,
    disabledAssetsRoot,
    now: () => NOW,
  });
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

describe("AssetDisablementService", () => {
  it("moves and restores an entire Skill package directory when disabling by file movement", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-config-hub-disable-skill-package-"));
    temporaryDirectories.push(root);
    const skillRoot = join(root, ".agents", "skills", "release");
    await mkdir(join(skillRoot, "references"), { recursive: true });
    await mkdir(join(skillRoot, "scripts"), { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: release\ndescription: Release safely\n---\nRun release checks.\n",
      "utf8",
    );
    await writeFile(join(skillRoot, "references", "checklist.md"), "Check version.\n", "utf8");
    await writeFile(join(skillRoot, "scripts", "ship.js"), "console.log('ship');\n", "utf8");
    const assetScope = scope("codex");
    const index = new MemoryIndexRepository(
      skillPackageAsset({
        id: "asset-codex-skill",
        toolId: "codex",
        skillRoot,
        scope: assetScope,
      }),
      assetScope,
    );
    const service = serviceFor(index, root);

    await service.disable({
      assetId: AssetIdSchema.parse("asset-codex-skill"),
      method: "move_file",
    });

    await expect(readFile(join(skillRoot, "SKILL.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(skillRoot, "references", "checklist.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await service.enable({ assetId: AssetIdSchema.parse("asset-codex-skill") });

    expect(await readFile(join(skillRoot, "SKILL.md"), "utf8")).toContain("Run release checks.");
    expect(await readFile(join(skillRoot, "references", "checklist.md"), "utf8")).toBe(
      "Check version.\n",
    );
    expect(await readFile(join(skillRoot, "scripts", "ship.js"), "utf8")).toBe(
      "console.log('ship');\n",
    );
  });

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
    const service = serviceFor(index, root);

    await service.disable({
      assetId: AssetIdSchema.parse("asset-opencode-agent"),
      method: "native",
    });
    const disabledConfig = parseJson<{
      readonly agent: { readonly reviewer: { readonly disable?: boolean } };
    }>(await readFile(configPath, "utf8"));
    expect(disabledConfig.agent.reviewer.disable).toBe(true);
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
    const service = serviceFor(index, root);

    await service.disable({
      assetId: AssetIdSchema.parse("asset-cursor-mcp"),
      method: "remove_config_entry",
    });
    const disabled = parseJson<{
      readonly mcpServers: {
        readonly docs?: unknown;
        readonly search?: unknown;
      };
    }>(await readFile(configPath, "utf8"));
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
    const service = serviceFor(index, root);

    await service.enable({ assetId: AssetIdSchema.parse("asset-opencode-mcp") });

    const enabledConfig = parseJson<{
      readonly mcp: { readonly docs: { readonly enabled: boolean } };
    }>(await readFile(configPath, "utf8"));
    expect(enabledConfig.mcp.docs.enabled).toBe(true);
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
    const service = serviceFor(index, root);

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
    const service = serviceFor(index, root);

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
    const service = serviceFor(index, root);

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
    const service = serviceFor(index, root);

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
    const service = serviceFor(index, root);

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
