import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

import { AssetSchema, NormalizedResourceSchema, type Asset } from "@ai-config-hub/core";
import {
  ContentHashSchema,
  IsoDateTimeSchema,
  ResourceKindSchema,
  type ContentHash,
  type ResourceKind,
} from "@ai-config-hub/shared";
import { z } from "zod";

const MANIFEST_FILE = "manifest.json";
const APPLICATIONS_DIR = ".applications";
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RECOMMENDED_DIRECTORIES = ["rules", "agents", "skills", "mcp", "presets", "schemas"] as const;

const SafeIdSchema = z.string().refine((value) => isSafeId(value), {
  message: "Expected a safe id without path traversal characters",
});

export const CentralAssetIdSchema = z
  .string()
  .refine((value) => parseCentralAssetId(value) !== undefined, {
    message: "Expected a central asset id formatted as kind:logical-key",
  });
export type CentralAssetId = z.infer<typeof CentralAssetIdSchema>;

const SourceTrackingSchema = z
  .object({
    assetId: z.string().min(1),
    toolId: z.string().min(1),
    sourcePath: z.string().min(1),
    importedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();
export type SourceTracking = z.infer<typeof SourceTrackingSchema>;

export const CentralAssetSchema = z
  .object({
    id: CentralAssetIdSchema,
    kind: ResourceKindSchema,
    logicalKey: SafeIdSchema,
    filePath: z
      .string()
      .min(1)
      .refine((value) => !value.startsWith("/") && !value.includes("..")),
    contentHash: ContentHashSchema,
    resource: NormalizedResourceSchema,
    source: SourceTrackingSchema,
  })
  .strict()
  .readonly();
export type CentralAsset = z.infer<typeof CentralAssetSchema>;

const ManifestAssetSchema = z
  .object({
    id: CentralAssetIdSchema,
    kind: ResourceKindSchema,
    logicalKey: SafeIdSchema,
    filePath: z
      .string()
      .min(1)
      .refine((value) => !value.startsWith("/") && !value.includes("..")),
    contentHash: ContentHashSchema,
    source: SourceTrackingSchema,
  })
  .strict()
  .readonly();
type ManifestAsset = z.infer<typeof ManifestAssetSchema>;

const ManifestPresetSchema = z
  .object({
    id: SafeIdSchema,
    filePath: z
      .string()
      .min(1)
      .refine((value) => !value.startsWith("/") && !value.includes("..")),
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();

const ManifestSchema = z
  .object({
    version: z.literal(1),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    assets: z.array(ManifestAssetSchema),
    presets: z.array(ManifestPresetSchema),
  })
  .strict()
  .readonly();
type Manifest = z.infer<typeof ManifestSchema>;

export const PresetDefinitionSchema = z
  .object({
    id: SafeIdSchema,
    name: z.string().trim().min(1),
    description: z.string().min(1).optional(),
    assetIds: z.array(CentralAssetIdSchema),
  })
  .strict()
  .readonly();
export type PresetDefinition = z.infer<typeof PresetDefinitionSchema>;

const PresetActionSchema = z.enum(["create", "update", "delete", "unchanged", "incompatible"]);
export type PresetAction = z.infer<typeof PresetActionSchema>;

export const PresetPreviewChangeSchema = z
  .object({
    action: PresetActionSchema,
    assetId: CentralAssetIdSchema,
    sourceHash: ContentHashSchema.optional(),
    targetHash: ContentHashSchema.optional(),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .readonly();
export type PresetPreviewChange = z.infer<typeof PresetPreviewChangeSchema>;

export const PresetPreviewSchema = z
  .object({
    presetId: SafeIdSchema,
    changes: z.array(PresetPreviewChangeSchema),
  })
  .strict()
  .readonly();
export type PresetPreview = z.infer<typeof PresetPreviewSchema>;

export const PresetApplicationRecordSchema = z
  .object({
    id: SafeIdSchema,
    presetId: SafeIdSchema,
    appliedAt: IsoDateTimeSchema,
    preset: PresetDefinitionSchema,
    sourceAssetHashes: z.record(CentralAssetIdSchema, ContentHashSchema),
    changes: z.array(PresetPreviewChangeSchema),
    rollback: z
      .object({
        targetAssetHashes: z.record(CentralAssetIdSchema, ContentHashSchema),
        deploymentRecordIds: z.record(CentralAssetIdSchema, z.string().min(1)),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
export type PresetApplicationRecord = z.infer<typeof PresetApplicationRecordSchema>;

export interface AssetLibraryServiceOptions {
  readonly root: string;
  readonly now?: () => string;
}

export interface ImportAssetOptions {
  readonly logicalKey?: string;
  readonly importedAt?: string;
}

export interface PreviewPresetOptions {
  readonly targetAssetHashes: Readonly<Record<string, string>>;
  readonly supportedResourceKinds: readonly ResourceKind[];
}

export interface ApplyPresetOptions extends PreviewPresetOptions {
  readonly applicationId?: string;
  readonly deploymentRecordIds?: Readonly<Record<string, string>>;
}

export class AssetLibraryService {
  readonly #root: string;
  readonly #now: () => string;

  constructor(options: AssetLibraryServiceOptions) {
    this.#root = resolve(options.root);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async initialize(): Promise<Manifest> {
    await mkdir(this.#root, { recursive: true });
    await Promise.all(
      RECOMMENDED_DIRECTORIES.map((directory) => mkdir(this.path(directory), { recursive: true })),
    );

    try {
      return await this.readManifest();
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }

    const now = this.now();
    const manifest: Manifest = {
      version: 1,
      createdAt: now,
      updatedAt: now,
      assets: [],
      presets: [],
    };
    await this.writeJson(MANIFEST_FILE, manifest);
    return manifest;
  }

  async importAsset(assetInput: Asset, options: ImportAssetOptions = {}): Promise<CentralAsset> {
    const asset = AssetSchema.parse(assetInput);
    const logicalKey =
      options.logicalKey === undefined
        ? deriveLogicalKey(asset)
        : validateSafeId(options.logicalKey, "logical key");
    const kind = asset.resource.kind;
    const id = makeCentralAssetId(kind, logicalKey);
    const filePath = `${directoryForKind(kind)}/${logicalKey}.json`;
    const importedAt =
      options.importedAt === undefined ? this.now() : IsoDateTimeSchema.parse(options.importedAt);
    const centralAsset = CentralAssetSchema.parse({
      id,
      kind,
      logicalKey,
      filePath,
      contentHash: asset.contentHash,
      resource: asset.resource,
      source: {
        assetId: asset.assetId,
        toolId: asset.toolId,
        sourcePath: asset.canonicalSourcePath,
        importedAt,
      },
    });

    await this.writeJson(filePath, centralAsset);
    const manifest = await this.readManifest();
    const manifestAsset = ManifestAssetSchema.parse({
      id: centralAsset.id,
      kind: centralAsset.kind,
      logicalKey: centralAsset.logicalKey,
      filePath: centralAsset.filePath,
      contentHash: centralAsset.contentHash,
      source: centralAsset.source,
    });
    await this.writeManifest({
      ...manifest,
      assets: upsertById(manifest.assets, manifestAsset),
    });
    return centralAsset;
  }

  async listAssets(): Promise<CentralAsset[]> {
    const manifest = await this.readManifest();
    const assets = await Promise.all(
      manifest.assets
        .slice()
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((entry) => this.readAssetFile(entry)),
    );
    return assets;
  }

  async getAsset(id: string): Promise<CentralAsset | undefined> {
    const assetId = validateCentralAssetId(id);
    const manifest = await this.readManifest();
    const entry = manifest.assets.find((candidate) => candidate.id === assetId);
    return entry === undefined ? undefined : this.readAssetFile(entry);
  }

  async createPreset(input: PresetDefinition): Promise<PresetDefinition> {
    validateSafeId(input.id, "preset id");
    const preset = PresetDefinitionSchema.parse(input);
    const manifest = await this.readManifest();
    if (manifest.presets.some((entry) => entry.id === preset.id)) {
      throw new Error(`Preset already exists: ${preset.id}`);
    }
    await this.writePreset(preset, manifest);
    return preset;
  }

  async updatePreset(input: PresetDefinition): Promise<PresetDefinition> {
    validateSafeId(input.id, "preset id");
    const preset = PresetDefinitionSchema.parse(input);
    const manifest = await this.readManifest();
    if (!manifest.presets.some((entry) => entry.id === preset.id)) {
      throw new Error(`Preset does not exist: ${preset.id}`);
    }
    await this.writePreset(preset, manifest);
    return preset;
  }

  async previewPreset(id: string, options: PreviewPresetOptions): Promise<PresetPreview> {
    const preset = await this.readPreset(id);
    const assets = await this.assetsById();
    const supportedKinds = new Set(
      options.supportedResourceKinds.map((kind) => ResourceKindSchema.parse(kind)),
    );
    const targetAssetHashes = parseHashRecord(options.targetAssetHashes);
    const presetAssetIds = new Set(preset.assetIds);
    const changes: PresetPreviewChange[] = [];

    for (const assetId of preset.assetIds) {
      const asset = assets.get(assetId);
      if (asset === undefined) {
        throw new Error(`Preset ${preset.id} references missing asset: ${assetId}`);
      }

      const targetHash = targetAssetHashes[assetId];
      if (!supportedKinds.has(asset.kind)) {
        changes.push(
          PresetPreviewChangeSchema.parse({
            action: "incompatible",
            assetId,
            sourceHash: asset.contentHash,
            ...(targetHash === undefined ? {} : { targetHash }),
            reason: `Resource kind ${asset.kind} is not supported by the target tool.`,
          }),
        );
      } else if (targetHash === undefined) {
        changes.push(
          PresetPreviewChangeSchema.parse({
            action: "create",
            assetId,
            sourceHash: asset.contentHash,
          }),
        );
      } else if (targetHash === asset.contentHash) {
        changes.push(
          PresetPreviewChangeSchema.parse({
            action: "unchanged",
            assetId,
            sourceHash: asset.contentHash,
            targetHash,
          }),
        );
      } else {
        changes.push(
          PresetPreviewChangeSchema.parse({
            action: "update",
            assetId,
            sourceHash: asset.contentHash,
            targetHash,
          }),
        );
      }
    }

    const deleteChanges = Object.entries(targetAssetHashes)
      .filter(([assetId]) => !presetAssetIds.has(assetId))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([assetId, targetHash]) =>
        PresetPreviewChangeSchema.parse({
          action: "delete",
          assetId,
          targetHash,
        }),
      );

    return PresetPreviewSchema.parse({
      presetId: preset.id,
      changes: [...changes, ...deleteChanges],
    });
  }

  async applyPreset(id: string, options: ApplyPresetOptions): Promise<PresetApplicationRecord> {
    const preset = await this.readPreset(id);
    const preview = await this.previewPreset(id, options);
    const assets = await this.assetsById();
    const sourceAssetHashes = Object.fromEntries(
      preset.assetIds.map((assetId) => {
        const asset = assets.get(assetId);
        if (asset === undefined) {
          throw new Error(`Preset ${preset.id} references missing asset: ${assetId}`);
        }
        return [assetId, asset.contentHash];
      }),
    );
    const applicationId =
      options.applicationId === undefined
        ? defaultApplicationId(preset.id, this.now(), sourceAssetHashes)
        : validateSafeId(options.applicationId, "application id");
    const record = PresetApplicationRecordSchema.parse({
      id: applicationId,
      presetId: preset.id,
      appliedAt: this.now(),
      preset,
      sourceAssetHashes,
      changes: preview.changes,
      rollback: {
        targetAssetHashes: parseHashRecord(options.targetAssetHashes),
        deploymentRecordIds: parseDeploymentRecordIds(options.deploymentRecordIds ?? {}),
      },
    });

    await this.writeJson(`presets/${APPLICATIONS_DIR}/${preset.id}/${applicationId}.json`, record);
    return record;
  }

  async readManifest(): Promise<Manifest> {
    return ManifestSchema.parse(await this.readJson(MANIFEST_FILE));
  }

  path(...segments: readonly string[]): string {
    const resolved = resolve(this.#root, ...segments);
    if (!isInsideRoot(this.#root, resolved)) {
      throw new Error(`Unsafe path outside asset library root: ${segments.join("/")}`);
    }
    return resolved;
  }

  async readPreset(id: string): Promise<PresetDefinition> {
    const presetId = validateSafeId(id, "preset id");
    return PresetDefinitionSchema.parse(await this.readJson(`presets/${presetId}.json`));
  }

  async writePreset(preset: PresetDefinition, manifest: Manifest): Promise<void> {
    const now = this.now();
    const filePath = `presets/${preset.id}.json`;
    await this.writeJson(filePath, preset);
    const manifestPreset = ManifestPresetSchema.parse({ id: preset.id, filePath, updatedAt: now });
    await this.writeManifest({
      ...manifest,
      presets: upsertById(manifest.presets, manifestPreset),
    });
  }

  async writeManifest(manifest: Manifest): Promise<void> {
    await this.writeJson(
      MANIFEST_FILE,
      ManifestSchema.parse({ ...manifest, updatedAt: this.now() }),
    );
  }

  async readAssetFile(entry: ManifestAsset): Promise<CentralAsset> {
    return CentralAssetSchema.parse(await this.readJson(entry.filePath));
  }

  async assetsById(): Promise<Map<CentralAssetId, CentralAsset>> {
    const assets = await this.listAssets();
    return new Map(assets.map((asset) => [asset.id, asset]));
  }

  async readJson(relativePath: string): Promise<unknown> {
    return JSON.parse(await readFile(this.path(relativePath), "utf8"));
  }

  async writeJson(relativePath: string, value: unknown): Promise<void> {
    const path = this.path(relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  now(): string {
    return IsoDateTimeSchema.parse(this.#now());
  }
}

function isSafeId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value) && value !== "." && value !== ".." && !value.includes("..");
}

function validateSafeId(value: string, label: string): string {
  const result = SafeIdSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return result.data;
}

function parseCentralAssetId(
  value: string,
): { readonly kind: ResourceKind; readonly logicalKey: string } | undefined {
  const [kindCandidate, logicalKey, extra] = value.split(":");
  if (kindCandidate === undefined || logicalKey === undefined || extra !== undefined) {
    return undefined;
  }
  const kindResult = ResourceKindSchema.safeParse(kindCandidate);
  const keyResult = SafeIdSchema.safeParse(logicalKey);
  if (!kindResult.success || !keyResult.success) {
    return undefined;
  }
  return { kind: kindResult.data, logicalKey: keyResult.data };
}

function validateCentralAssetId(value: string): CentralAssetId {
  const result = CentralAssetIdSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Unsafe central asset id: ${value}`);
  }
  return result.data;
}

function makeCentralAssetId(kind: ResourceKind, logicalKey: string): CentralAssetId {
  return CentralAssetIdSchema.parse(`${kind}:${logicalKey}`);
}

function directoryForKind(kind: ResourceKind): (typeof RECOMMENDED_DIRECTORIES)[number] {
  switch (kind) {
    case "rule":
      return "rules";
    case "agent":
      return "agents";
    case "skill":
      return "skills";
    case "mcp":
      return "mcp";
  }
}

function deriveLogicalKey(asset: Asset): string {
  const name = "name" in asset.resource.data ? asset.resource.data.name : undefined;
  return toSafeLogicalKey(typeof name === "string" && name.length > 0 ? name : asset.locator);
}

function toSafeLogicalKey(value: string): string {
  const key = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 128);
  return validateSafeId(key.length === 0 ? shortHash(value) : key, "logical key");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function defaultApplicationId(
  presetId: string,
  appliedAt: string,
  sourceAssetHashes: Readonly<Record<string, string>>,
): string {
  return validateSafeId(
    `application-${shortHash(JSON.stringify({ presetId, appliedAt, sourceAssetHashes }))}`,
    "application id",
  );
}

function parseHashRecord(
  input: Readonly<Record<string, string>>,
): Record<CentralAssetId, ContentHash> {
  return Object.fromEntries(
    Object.entries(input).map(([assetId, contentHash]) => [
      validateCentralAssetId(assetId),
      ContentHashSchema.parse(contentHash),
    ]),
  );
}

function parseDeploymentRecordIds(
  input: Readonly<Record<string, string>>,
): Record<CentralAssetId, string> {
  return Object.fromEntries(
    Object.entries(input).map(([assetId, deploymentRecordId]) => [
      validateCentralAssetId(assetId),
      z.string().min(1).parse(deploymentRecordId),
    ]),
  );
}

function upsertById<T extends { readonly id: string }>(items: readonly T[], next: T): T[] {
  const filtered = items.filter((item) => item.id !== next.id);
  return [...filtered, next].sort((left, right) => left.id.localeCompare(right.id));
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const pathToCandidate = relative(rootPath, candidatePath);
  return (
    pathToCandidate === "" ||
    (!pathToCandidate.startsWith("..") && !pathToCandidate.includes(`..${sep}`))
  );
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export const recommendedAssetLibraryDirectories = RECOMMENDED_DIRECTORIES;

export function centralAssetBasename(asset: CentralAsset): string {
  return basename(asset.filePath);
}
